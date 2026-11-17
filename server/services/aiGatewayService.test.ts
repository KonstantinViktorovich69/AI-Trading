import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiGatewayService } from './aiGatewayService.ts';

describe('AiGatewayService', () => {
  let gateway: AiGatewayService;

  beforeEach(() => {
    gateway = new AiGatewayService({
      frontendTimeoutMs: 1000,
      workerTimeoutMs: 1000
    });
  });

  it('provides static fallbacks correctly based on prompt contents', () => {
    // Array expected fallback
    const arrayFallback = gateway.getStaticServerSideAiFallback({
      config: { responseSchema: { type: 'ARRAY' } }
    }, 'test');
    expect(arrayFallback.text).toBe('[]');

    // Retrospective prompt fallback
    const retroFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'getRetrospectivePrompt retrospectiveSummary' }] }]
    }, 'test');
    const retroJson = JSON.parse(retroFallback.text);
    expect(retroJson.retrospectiveSummary).toBe('ИИ недоступен, ретроспектива пропущена');
    expect(retroJson.winRate).toBeUndefined();
    expect(retroJson.expertModifications).toBe('');
    expect(retroJson.agentExchangeConversations).toEqual([]);
    expect(retroJson.isFallback).toBe(true);

    // Expert trader prompt fallback
    const expertFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'expertPrompt ИИ-Ведущий Трейдер' }] }]
    }, 'test');
    const expertJson = JSON.parse(expertFallback.text);
    expect(expertJson.action).toBe('HOLD');
    expect(expertJson.newSl).toBeNull();
    expect(expertJson.newTp).toBeNull();
    expect(expertJson.isFallback).toBe(true);

    // Trade evaluation prompt fallback
    const evalFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'getTradeEvaluationPrompt evaluate-closed-trade' }] }]
    }, 'test');
    const evalJson = JSON.parse(evalFallback.text);
    expect(evalJson.evaluation).toBe('ИИ недоступен для разбора сделки.');
    expect(evalJson.learnedRule).toBe('');
    expect(evalJson.isFallback).toBe(true);

    // Signal analysis prompt fallback
    const signalFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'techAnalyst riskManager getSignalAnalysisPrompt' }] }]
    }, 'test');
    const signalJson = JSON.parse(signalFallback.text);
    expect(signalJson.consensus).toBe('НЕТ ДАННЫХ');
    expect(signalJson.judgeDecision).toBe('NEUTRAL');
    expect(signalJson.approved).toBe(false);
    expect(signalJson.aiScore).toBe(0);
    expect(signalJson.action).toBe('HOLD');
    expect(signalJson.isFallback).toBe(true);

    // Verify counter
    expect(gateway.aiFallbackCount).toBe(5);
  });

  it('manages frontend task queues and completion', async () => {
    const taskPromise = gateway.addAndQueueFrontendTask({ contents: 'test-query' }, 'Testing Queue');
    const pending = gateway.getPendingAiTasks();
    expect(pending.size).toBe(1);

    const tasksToSend = gateway.getPendingTasksToSend(5);
    expect(tasksToSend.length).toBe(1);
    const taskId = tasksToSend[0].id;
    expect(tasksToSend[0].params.contents).toBe('test-query');

    // Complete task
    const completed = gateway.completeFrontendTask(taskId, { text: 'custom result' });
    expect(completed).toBe(true);

    const result = await taskPromise;
    expect(result.text).toBe('custom result');
    expect(gateway.getPendingAiTasks().size).toBe(0);
  });

  it('handles task timeout in frontend queue when no browser answers', async () => {
    const fastGateway = new AiGatewayService({ frontendTimeoutMs: 50 });
    const result = await fastGateway.addAndQueueFrontendTask({ contents: 'some prompt' }, 'Timeout Test');
    const json = JSON.parse(result.text);
    expect(json.action).toBe('HOLD');
    expect(json.consensus).toBe('АВТО-HOLD');
  });

  it('manages cached market news', () => {
    expect(gateway.getCachedMarketNews()).toBeNull();
    gateway.setCachedMarketNews({ text: 'Breaking News', timestamp: 12345 });
    expect(gateway.getCachedMarketNews()?.text).toBe('Breaking News');
    expect(gateway.getCachedMarketNews()?.timestamp).toBe(12345);
  });

  it('attempts fallback model when primary model is overloaded with 503', async () => {
    const generateContentMock = vi.fn()
      .mockRejectedValueOnce(new Error('{"error":{"code":503,"message":"This model is currently overloaded. Please try again later."}}'))
      .mockResolvedValueOnce({ text: '{"analysis":"fallback success"}' });

    const mockAiClient = {
      models: {
        generateContent: generateContentMock
      }
    } as any;

    gateway.setInternalServerGeminiClient(mockAiClient);

    const result = await gateway.runAiGeneration({
      contents: [{ parts: [{ text: 'analyze market' }] }]
    });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-4-hydrogen');
    expect(generateContentMock.mock.calls[1][0].model).toBe('gemini-flash-latest');
    expect(result.text).toBe('{"analysis":"fallback success"}');
  });

  it('enters cooldown and provides local static fallback when all models fail with 503', async () => {
    const generateContentMock = vi.fn()
      .mockRejectedValue(new Error('{"error":{"code":503,"message":"This model is currently overloaded. Please try again later."}}'));

    const mockAiClient = {
      models: {
        generateContent: generateContentMock
      }
    } as any;

    gateway.setInternalServerGeminiClient(mockAiClient);

    const result = await gateway.runAiGeneration({
      contents: [{ parts: [{ text: 'getTradeEvaluationPrompt evaluate-closed-trade' }] }]
    });

    // Should return fallback JSON
    const parsed = JSON.parse(result.text);
    expect(parsed.evaluation).toBeDefined();

    // Second call should immediately use cooldown fallback without hitting Gemini API again
    generateContentMock.mockClear();
    const result2 = await gateway.runAiGeneration({
      contents: [{ parts: [{ text: 'getTradeEvaluationPrompt evaluate-closed-trade' }] }]
    });

    expect(generateContentMock).not.toHaveBeenCalled();
    const parsed2 = JSON.parse(result2.text);
    expect(parsed2.evaluation).toBeDefined();
  });

  it('strips deprecated sampling parameters for gemini-4 models and enters cooldown on 404', async () => {
    const generateContentMock = vi.fn()
      .mockResolvedValueOnce({ text: '{"ok":true}' })
      .mockRejectedValueOnce(new Error('404 NOT_FOUND: model not found'));

    gateway.setInternalServerGeminiClient({
      models: { generateContent: generateContentMock }
    } as any);

    await gateway.runAiGeneration({
      model: 'gemini-3.7-flash',
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.3,
        topP: 0.9,
        topK: 40,
        candidateCount: 1
      }
    });

    expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-4-hydrogen');
    expect(generateContentMock.mock.calls[0][0].config).toEqual({
      responseMimeType: 'application/json'
    });

    const res404 = await gateway.runAiGeneration({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts: [{ text: 'test 404' }] }],
      config: { responseMimeType: 'application/json' }
    });
    expect(JSON.parse(res404.text).isFallback).toBe(true);

    generateContentMock.mockClear();
    const resCooldown = await gateway.runAiGeneration({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts: [{ text: 'after 404' }] }],
      config: { responseMimeType: 'application/json' }
    });
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(JSON.parse(resCooldown.text).isFallback).toBe(true);
  });

  it('uses GEMINI_MODEL override when provided in environment', async () => {
    const prevEnv = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-flash-latest';
    try {
      vi.resetModules();
      const { DEFAULT_AI_MODEL, getDefaultAiModel } = await import('../config/aiModels.ts');
      expect(DEFAULT_AI_MODEL).toBe('gemini-flash-latest');
      expect(getDefaultAiModel()).toBe('gemini-flash-latest');

      const generateContentMock = vi.fn().mockResolvedValueOnce({ text: '{"ok":true}' });
      gateway.setInternalServerGeminiClient({
        models: { generateContent: generateContentMock }
      } as any);

      await gateway.runAiGeneration({
        contents: [{ role: 'user', parts: [{ text: 'env test' }] }]
      });

      expect(generateContentMock).toHaveBeenCalledTimes(1);
      expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-flash-latest');
    } finally {
      if (prevEnv === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prevEnv;
      vi.resetModules();
    }
  });

  it('tracks 429 QUOTA in getHealth(), marks isFallback with reason QUOTA, does not switch model, and skips API during cooldown', async () => {
    const quotaErr: any = new Error(JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED'
      }
    }));
    quotaErr.status = 429;

    const generateContentMock = vi.fn().mockRejectedValue(quotaErr);
    gateway.setInternalServerGeminiClient({
      models: { generateContent: generateContentMock }
    } as any);

    const res1 = await gateway.runAiGeneration({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      config: { responseMimeType: 'application/json' }
    });

    // Must not auto-switch model on 429
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-4-hydrogen');

    const body1 = JSON.parse(res1.text);
    expect(body1.isFallback).toBe(true);
    expect(body1.fallbackReason).toBe('QUOTA');
    expect(res1.isFallback).toBe(true);
    expect(res1.fallbackReason).toBe('QUOTA');

    const health = gateway.getHealth();
    expect(health.lastError?.status).toBe(429);
    expect(health.lastError?.code).toBe('RESOURCE_EXHAUSTED');
    expect(health.lastError?.model).toBe('gemini-4-hydrogen');
    expect(health.errorCounts24h['429']).toBe(1);
    expect(health.errorCounts24h['404']).toBe(0);
    expect(health.errorCounts24h['403']).toBe(0);
    expect(health.errorCounts24h['NETWORK']).toBe(0);
    expect(health.cooldownActive).toBe(true);

    // Repeated call during cooldown must not call API and must still report QUOTA
    generateContentMock.mockClear();
    const res2 = await gateway.runAiGeneration({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts: [{ text: 'retry while cooled down' }] }],
      config: { responseMimeType: 'application/json' }
    });

    expect(generateContentMock).not.toHaveBeenCalled();
    const body2 = JSON.parse(res2.text);
    expect(body2.isFallback).toBe(true);
    expect(body2.fallbackReason).toBe('QUOTA');
  });

  it('distinguishes 403, 404, and network errors in getHealth().errorCounts24h', async () => {
    const mockCall = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('PERMISSION_DENIED 403'), { status: 403 }))
      .mockRejectedValueOnce(new Error('fetch failed ETIMEDOUT'));

    gateway.setInternalServerGeminiClient({
      models: { generateContent: mockCall }
    } as any);

    await gateway.runAiGeneration({ contents: [{ parts: [{ text: 'call1' }] }] });
    let health = gateway.getHealth();
    expect(health.lastError?.status).toBe(403);
    expect(health.errorCounts24h['403']).toBe(1);
    expect(health.errorCounts24h['429']).toBe(0);

    // Reset cooldown only by creating a second instance to test network error separately
    const gatewayNet = new AiGatewayService({ frontendTimeoutMs: 500, workerTimeoutMs: 500 });
    gatewayNet.setInternalServerGeminiClient({
      models: { generateContent: vi.fn().mockRejectedValueOnce(new Error('fetch failed ETIMEDOUT')) }
    } as any);
    await gatewayNet.runAiGeneration({ contents: [{ parts: [{ text: 'call2' }] }] });
    health = gatewayNet.getHealth();
    expect(health.lastError?.status).toBeNull();
    expect(health.lastError?.code).toBe('NETWORK_ERROR');
    expect(health.errorCounts24h['NETWORK']).toBe(1);
  });

  it('enforces daily UTC AI budget with priority shedding (3 cut first, 2 next, 1 allowed until exhaustion) and resets at 00:00 UTC (J5)', async () => {
    let fakeNow = Date.UTC(2026, 10, 16, 23, 50, 0); // 2026-11-16 23:50:00 UTC
    const budgetGateway = new AiGatewayService({
      frontendTimeoutMs: 500,
      workerTimeoutMs: 500,
      nowProvider: () => fakeNow,
      getBudgetSettings: () => ({ enabled: true, dailyLimit: 5 })
    });

    const generateContentMock = vi.fn().mockResolvedValue({ text: '{"ok":true}' });
    budgetGateway.setInternalServerGeminiClient({
      models: { generateContent: generateContentMock }
    } as any);

    // For dailyLimit = 5:
    // reserveForP1 = max(1, floor(5*0.2)) = 1 -> p2Max = 4
    // reserveForP1AndP2 = max(2, ceil(5*0.5)) = 3 -> p3Max = 2
    // Dispatch 2 background calls (priority 3) -> allowed
    await budgetGateway.runAiGeneration({ priority: 3, contents: [{ parts: [{ text: 'bg1' }] }] });
    await budgetGateway.runAiGeneration({ priority: 3, contents: [{ parts: [{ text: 'bg2' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(2);

    // 3rd background call (priority 3) must be shedded without API hit
    const shedBg = await budgetGateway.runAiGeneration({
      priority: 3,
      contents: [{ parts: [{ text: 'bg3' }] }],
      config: { responseMimeType: 'application/json' }
    });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(shedBg.isFallback).toBe(true);
    expect(shedBg.fallbackReason).toBe('BUDGET');

    // Closed-trade eval (priority 2) still passes up to p2Max=4 (2 more calls)
    await budgetGateway.runAiGeneration({ priority: 2, contents: [{ parts: [{ text: 'eval1' }] }] });
    await budgetGateway.runAiGeneration({ priority: 2, contents: [{ parts: [{ text: 'eval2' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(4);

    // Next priority 2 call hits reserve for manual calls -> BUDGET
    const shedEval = await budgetGateway.runAiGeneration({ priority: 2, contents: [{ parts: [{ text: 'eval3' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(4);
    expect(shedEval.fallbackReason).toBe('BUDGET');

    // Manual call (priority 1) passes for the final 5th slot
    const manualOk = await budgetGateway.runAiGeneration({ priority: 1, contents: [{ parts: [{ text: 'manual1' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(5);
    expect(manualOk.text).toBe('{"ok":true}');

    // 6th call (even priority 1) exceeds dailyLimit=5 -> BUDGET
    const manualCap = await budgetGateway.runAiGeneration({ priority: 1, contents: [{ parts: [{ text: 'manual2' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(5);
    expect(manualCap.fallbackReason).toBe('BUDGET');

    const healthDay1 = budgetGateway.getHealth();
    expect(healthDay1.dailyBudget.utcDate).toBe('2026-11-16');
    expect(healthDay1.dailyBudget.usedTotal).toBe(5);
    expect(healthDay1.dailyBudget.blockedTotal).toBe(3);

    // Advance across 00:00 UTC midnight -> 2026-11-17 00:00:05 UTC -> counter resets!
    fakeNow = Date.UTC(2026, 10, 17, 0, 0, 5);
    const resetCall = await budgetGateway.runAiGeneration({ priority: 3, contents: [{ parts: [{ text: 'bg next day' }] }] });
    expect(generateContentMock).toHaveBeenCalledTimes(6);
    expect(resetCall.text).toBe('{"ok":true}');
    expect(budgetGateway.getHealth().dailyBudget.utcDate).toBe('2026-11-17');
    expect(budgetGateway.getHealth().dailyBudget.usedTotal).toBe(1);
  });

  it('does not block any calls when aiDailyBudgetEnabled is false', async () => {
    const offGateway = new AiGatewayService({
      getBudgetSettings: () => ({ enabled: false, dailyLimit: 1 })
    });
    const mockCall = vi.fn().mockResolvedValue({ text: '{"ok":true}' });
    offGateway.setInternalServerGeminiClient({ models: { generateContent: mockCall } } as any);

    await offGateway.runAiGeneration({ priority: 3, contents: [{ parts: [{ text: '1' }] }] });
    await offGateway.runAiGeneration({ priority: 3, contents: [{ parts: [{ text: '2' }] }] });
    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(offGateway.getHealth().dailyBudget.enabled).toBe(false);
  });
});


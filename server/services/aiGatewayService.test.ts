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
});

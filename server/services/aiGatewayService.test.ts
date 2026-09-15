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
    expect(retroJson.retrospectiveSummary).toBeDefined();
    expect(retroJson.winRate).toBeGreaterThan(0);

    // Expert trader prompt fallback
    const expertFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'expertPrompt ИИ-Ведущий Трейдер' }] }]
    }, 'test');
    const expertJson = JSON.parse(expertFallback.text);
    expect(expertJson.action).toBe('UPDATE_SL');

    // Trade evaluation prompt fallback
    const evalFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'getTradeEvaluationPrompt evaluate-closed-trade' }] }]
    }, 'test');
    const evalJson = JSON.parse(evalFallback.text);
    expect(evalJson.evaluation).toBeDefined();

    // Signal analysis prompt fallback
    const signalFallback = gateway.getStaticServerSideAiFallback({
      contents: [{ parts: [{ text: 'techAnalyst riskManager getSignalAnalysisPrompt' }] }]
    }, 'test');
    const signalJson = JSON.parse(signalFallback.text);
    expect(signalJson.consensus).toBe('ПОДТВЕРЖДЕНО');
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
});

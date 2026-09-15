import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getStaticServerSideAiFallback,
  getInternalServerGeminiClient,
  pendingAiTasks,
  addAndQueueFrontendTask,
  runAiGeneration
} from './aiOrchestrator.ts';

describe('aiOrchestrator', () => {
  beforeEach(() => {
    pendingAiTasks.clear();
  });

  it('returns valid JSON fallback for array prompts', () => {
    const fallback = getStaticServerSideAiFallback({
      contents: [{ role: 'user', parts: [{ text: 'Return ONLY a JSON array of signals' }] }]
    }, 'Error');
    expect(fallback.text).toBe('[]');
  });

  it('returns valid JSON fallback for retrospective prompt', () => {
    const fallback = getStaticServerSideAiFallback({
      contents: [{ role: 'user', parts: [{ text: 'retrospectiveSummary and ИИ-Контур' }] }]
    }, 'Quota');
    const parsed = JSON.parse(fallback.text);
    expect(parsed.retrospectiveSummary).toBeDefined();
    expect(parsed.winRate).toBeGreaterThan(0);
    expect(Array.isArray(parsed.agentExchangeConversations)).toBe(true);
  });

  it('returns valid fallback for committee/signal analysis prompt', () => {
    const fallback = getStaticServerSideAiFallback({
      contents: [{ role: 'user', parts: [{ text: 'getSignalAnalysisPrompt and judgeDecision' }] }]
    }, 'Timeout');
    const parsed = JSON.parse(fallback.text);
    expect(parsed.approved).toBe(true);
    expect(parsed.action).toBe('EXECUTE');
    expect(parsed.judgeDecision).toBe('LONG');
  });

  it('queues frontend task when requested', async () => {
    const taskPromise = addAndQueueFrontendTask({ contents: 'test' }, 'No API Key');
    expect(pendingAiTasks.size).toBe(1);
    const taskId = Array.from(pendingAiTasks.keys())[0];
    const task = pendingAiTasks.get(taskId)!;
    expect(task.params.contents).toBe('test');
    
    // Resolve task manually simulating frontend response
    task.resolve({ text: '{"result": "ok"}' });
    const res = await taskPromise;
    expect(res.text).toBe('{"result": "ok"}');
  });
});

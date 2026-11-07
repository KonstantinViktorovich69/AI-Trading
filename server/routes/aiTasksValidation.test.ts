import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createAiRoutes, type AiRoutesContext } from './aiRoutes.ts';

function createMockAiApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const pendingTasks = new Map<string, any>();

  const defaultContext: Partial<AiRoutesContext> = {
    getPendingAiTasks: () => pendingTasks,
    safeJsonParse: (str: string, fallback: any) => {
      try { return JSON.parse(str); } catch { return fallback; }
    },
    getGlobalSettings: () => ({}),
    getVirtualTrades: () => [],
    getKnowledgeBase: () => [],
    getSocialSentiment: () => ({}),
    getSignalsCache: () => [],
    getBlacklistedPatterns: () => ({})
  };

  const router = createAiRoutes(defaultContext as AiRoutesContext);
  app.use('/api', router);

  return { app, pendingTasks };
}

describe('aiRoutes /api/ai-tasks/complete validation (T1.5)', () => {
  it('returns 400 when id is missing or not a string', async () => {
    const { app } = createMockAiApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: { text: '{}' } })
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid or missing task id');
    } finally {
      server.close();
    }
  });

  it('returns 404 when task is not in pending queue', async () => {
    const { app } = createMockAiApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nonexistent_task', result: { text: '{}' } })
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Task not found');
    } finally {
      server.close();
    }
  });

  it('returns 400 when payload exceeds 200 KB', async () => {
    const { app, pendingTasks } = createMockAiApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    const resolveMock = vi.fn();
    const rejectMock = vi.fn();
    pendingTasks.set('task_huge', {
      params: {},
      resolve: resolveMock,
      reject: rejectMock
    });

    const hugeText = 'A'.repeat(250 * 1024); // 250 KB

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task_huge', result: { text: hugeText } })
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('200 KB');
      expect(rejectMock).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('returns 400 when JSON task receives invalid non-JSON result', async () => {
    const { app, pendingTasks } = createMockAiApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    const resolveMock = vi.fn();
    const rejectMock = vi.fn();
    pendingTasks.set('task_json_expected', {
      params: { config: { responseMimeType: 'application/json' } },
      resolve: resolveMock,
      reject: rejectMock
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task_json_expected', result: { text: 'INVALID_NOT_JSON{{{' } })
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('JSON');
      expect(rejectMock).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('resolves task once and subsequent calls for same id return 404', async () => {
    const { app, pendingTasks } = createMockAiApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    const resolveMock = vi.fn();
    pendingTasks.set('task_once', {
      params: { config: { responseMimeType: 'application/json' } },
      resolve: resolveMock,
      reject: vi.fn()
    });

    try {
      // First attempt succeeds
      const res1 = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task_once', result: { text: '{"status":"ok"}' } })
      });
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(resolveMock).toHaveBeenCalledWith({ text: '{"status":"ok"}' });

      // Second attempt on same id must fail with 404
      const res2 = await fetch(`http://127.0.0.1:${port}/api/ai-tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task_once', result: { text: '{"status":"ok"}' } })
      });
      expect(res2.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

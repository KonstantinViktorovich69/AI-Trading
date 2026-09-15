import { describe, it, expect } from 'vitest';
import { processIncomingStateMessage, type StateMessage } from './stateSync.ts';

describe('StateSync - Versioned IPC & State Conflict Resolution', () => {
  it('accepts strictly higher revision messages', () => {
    const currentState = { stateRevision: 5, updatedAt: 1000, trades: [] };
    const msg: StateMessage<any> = {
      type: 'STATE_UPDATE',
      entity: 'trades',
      revision: 6,
      emittedAt: 1005,
      sender: 'worker_1',
      payload: { trades: [{ id: 'trade_101' }] }
    };

    const res = processIncomingStateMessage(currentState, msg);
    expect(res.accepted).toBe(true);
    expect(res.newRevision).toBe(6);
    expect(res.updatedState?.trades.length).toBe(1);
  });

  it('rejects stale or lower revision messages', () => {
    const currentState = { stateRevision: 10, updatedAt: 2000, trades: [] };
    const staleMsg: StateMessage<any> = {
      type: 'STATE_UPDATE',
      entity: 'trades',
      revision: 9, // Stale
      emittedAt: 1900,
      sender: 'worker_2',
      payload: { trades: [] }
    };

    const res = processIncomingStateMessage(currentState, staleMsg);
    expect(res.accepted).toBe(false);
    expect(res.newRevision).toBe(10);
    expect(res.reason).toContain('Out of order');
  });
});

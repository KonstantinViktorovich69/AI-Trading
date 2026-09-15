import { describe, it, expect, vi } from 'vitest';
import { EventStreamHub } from './eventStreamHub.ts';

describe('EventStreamHub', () => {
  it('manages agent logs and notifies listeners when events occur', () => {
    const mockDbData: any = {};
    const mockFlush = vi.fn();
    const hub = new EventStreamHub({
      getCachedDB: () => mockDbData,
      flushDB: mockFlush,
      maxLogsCount: 3
    });

    const listener = vi.fn();
    hub.on('signals_updated', listener);

    hub.logAgentExchange('SCANNER', 'ALL', 'Test Message', 'Details', 'info');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hub.getAgentExchangeLogs().length).toBe(1);
    expect(hub.getAgentExchangeLogs()[0].message).toBe('Test Message');
    expect(mockFlush).toHaveBeenCalled();

    // Verify limit trimming
    hub.logAgentExchange('EXPERT', 'RISK_MANAGER', 'Msg 2');
    hub.logAgentExchange('EXPERT', 'RISK_MANAGER', 'Msg 3');
    hub.logAgentExchange('EXPERT', 'RISK_MANAGER', 'Msg 4');

    expect(hub.getAgentExchangeLogs().length).toBe(3);
    expect(hub.getAgentExchangeLogs()[2].message).toBe('Msg 4');
  });
});

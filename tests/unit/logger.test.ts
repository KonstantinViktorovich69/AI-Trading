import { describe, it, expect } from 'vitest';
import { logStructured, getStructuredLogs, queryStructuredLogs } from '../../server/utils/logger';

describe('Structured Logger', () => {
  it('records logs with epochMs and ISO timestamp', () => {
    logStructured('info', 'TEST_COMP', 'Test log message', 'BTCUSDT', { testKey: 'val' });
    const logs = getStructuredLogs();
    expect(logs.length).toBeGreaterThan(0);
    const last = logs[logs.length - 1];
    expect(last.component).toBe('TEST_COMP');
    expect(last.message).toBe('Test log message');
    expect(last.symbol).toBe('BTCUSDT');
    expect(last.epochMs).toBeTypeOf('number');
  });

  it('filters and paginates logs accurately', () => {
    logStructured('error', 'ALERT_SYSTEM', 'Critical error simulation');
    const result = queryStructuredLogs({ component: 'ALERT_SYSTEM', level: 'error', limit: 10 });
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs[0].component).toBe('ALERT_SYSTEM');
    expect(result.logs[0].level).toBe('error');
  });
});

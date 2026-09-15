import { describe, it, expect } from 'vitest';
import { SystemMetricsCollector } from './systemMetricsCollector.ts';

describe('SystemMetricsCollector', () => {
  it('manages execution locks safely', () => {
    const collector = new SystemMetricsCollector();
    
    expect(collector.acquireExecutionLock('BTC/USDT')).toBe(true);
    // Second acquisition for the same symbol should be blocked
    expect(collector.acquireExecutionLock('BTC/USDT')).toBe(false);
    expect(collector.acquireExecutionLock('BTCUSDT')).toBe(false);

    // Another symbol should succeed
    expect(collector.acquireExecutionLock('ETH/USDT')).toBe(true);

    // Release lock
    collector.releaseExecutionLock('BTC/USDT');
    expect(collector.acquireExecutionLock('BTC/USDT')).toBe(true);

    collector.dispose();
  });

  it('tracks ping and history', async () => {
    const collector = new SystemMetricsCollector();
    expect(collector.getCurrentExchangePingMs()).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(collector.getExchangePingHistory())).toBe(true);
    
    const mockClient = {
      has: { fetchTime: true },
      fetchTime: async () => Date.now()
    } as any;

    const ping = await collector.pingExchange(mockClient);
    expect(ping).toBeTypeOf('number');
    expect(collector.getExchangePingHistory().length).toBeGreaterThan(0);

    collector.dispose();
  });
});

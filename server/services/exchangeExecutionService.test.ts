import { describe, it, expect, vi } from 'vitest';
import { ExchangeExecutionService } from './exchangeExecutionService.ts';

describe('ExchangeExecutionService', () => {
  it('initializes telemetry state and handles ping measurements safely', async () => {
    const mockDeps: any = {
      isRealTradingAllowed: () => false,
      getGlobalSettings: () => ({ exchangeApiConfig: { isEnabled: false } }),
      saveSettings: vi.fn(),
      autopilotFailedSymbols: new Set(),
      isWeexApiSupported: () => true,
      formatFuturesSymbol: (s: string) => s,
      enrichExchangeError: (e: any) => String(e),
      onTradePermissionDenied: vi.fn()
    };

    const service = new ExchangeExecutionService(mockDeps);
    expect(service.getCurrentExchangePingMs()).toBe(50);
    expect(service.getExchangePingHistory()).toEqual([]);

    await service.pingExchangeServer();
    expect(service.getCurrentExchangePingMs()).toBe(50);
  });
});

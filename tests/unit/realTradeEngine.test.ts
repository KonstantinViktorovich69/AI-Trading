import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAllConfiguredExchangeAccounts,
  getCcxtClient,
  resetCcxtClientPool,
  getCcxtClientConstructionCount,
  executeWithRetry
} from '../../server/services/realTradeEngine.ts';

describe('RealTradeEngine Service', () => {
  beforeEach(() => {
    resetCcxtClientPool();
    vi.restoreAllMocks();
  });

  describe('getAllConfiguredExchangeAccounts', () => {
    it('returns empty array when exchangeApiConfig is missing or disabled', () => {
      expect(getAllConfiguredExchangeAccounts({})).toEqual([]);
      expect(getAllConfiguredExchangeAccounts({ exchangeApiConfig: { isEnabled: false, apiKey: '123' } })).toEqual([]);
      expect(getAllConfiguredExchangeAccounts({ exchangeApiConfig: { isEnabled: true, apiKey: '' } })).toEqual([]);
    });

    it('extracts primary account and active multiAccounts correctly', () => {
      const settings = {
        exchangeApiConfig: {
          isEnabled: true,
          exchange: 'weex',
          apiKey: 'key_primary',
          apiSecret: 'sec_primary',
          password: 'pass_primary',
          name: 'Main WEEX',
          multiAccounts: [
            {
              isEnabled: true,
              exchange: 'bybit',
              apiKey: 'key_multi_1',
              apiSecret: 'sec_multi_1',
              name: 'Bybit Mirror'
            },
            {
              isEnabled: false,
              exchange: 'mexc',
              apiKey: 'key_disabled'
            }
          ]
        }
      };

      const accounts = getAllConfiguredExchangeAccounts(settings);
      expect(accounts).toHaveLength(2);
      expect(accounts[0].apiKey).toBe('key_primary');
      expect(accounts[0].exchange).toBe('weex');
      expect(accounts[0].id).toBe('primary');

      expect(accounts[1].apiKey).toBe('key_multi_1');
      expect(accounts[1].exchange).toBe('bybit');
      expect(accounts[1].name).toBe('Bybit Mirror');
    });

    it('avoids duplicate apiKeys across primary and multi accounts', () => {
      const settings = {
        exchangeApiConfig: {
          isEnabled: true,
          exchange: 'weex',
          apiKey: 'dup_key',
          apiSecret: 'sec',
          multiAccounts: [
            {
              isEnabled: true,
              exchange: 'weex',
              apiKey: 'dup_key'
            }
          ]
        }
      };

      const accounts = getAllConfiguredExchangeAccounts(settings);
      expect(accounts).toHaveLength(1);
    });
  });

  describe('getCcxtClient and pool', () => {
    it('returns null if real trading is not allowed', () => {
      const config = { exchange: 'binance', apiKey: 'abc', apiSecret: 'def' };
      const client = getCcxtClient(config, false);
      expect(client).toBeNull();
    });

    it('returns null if config or apiKey is missing', () => {
      expect(getCcxtClient(null as any, true)).toBeNull();
      expect(getCcxtClient({ exchange: 'binance', apiKey: '' }, true)).toBeNull();
    });

    it('creates and pools instance for supported exchange', () => {
      const config = { exchange: 'binance', apiKey: 'test_key_1', apiSecret: 'test_sec_1' };
      const client1 = getCcxtClient(config, true);
      expect(client1).not.toBeNull();
      expect(getCcxtClientConstructionCount()).toBe(1);

      const client2 = getCcxtClient(config, true);
      expect(client2).toBe(client1);
      expect(getCcxtClientConstructionCount()).toBe(1);
    });
  });

  describe('executeWithRetry', () => {
    it('returns successful result on first try', async () => {
      const mockFn = vi.fn().mockResolvedValue({ id: 'ord_123', status: 'closed' });
      const deps = {
        isRealTradingAllowed: () => true,
        getGlobalSettings: () => ({}),
        formatFuturesSymbol: (s: string) => s,
        enrichExchangeError: (e: any) => e.message
      };

      const res = await executeWithRetry(mockFn, 'testOrder', deps, 3, 10);
      expect(res).toEqual({ id: 'ord_123', status: 'closed' });
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('intercepts Weex false positive 200 success responses', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('weex {"code":"200","msg":"success"}'));
      const deps = {
        isRealTradingAllowed: () => true,
        getGlobalSettings: () => ({}),
        formatFuturesSymbol: (s: string) => s,
        enrichExchangeError: (e: any) => e.message
      };

      const res = await executeWithRetry(mockFn, 'createOrder for BTC/USDT', deps, 3, 10);
      expect(res).toEqual({ success: true, code: '200', msg: 'success' });
    });

    it('does not retry on insufficient funds error (-1054)', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('weex error -1054 margin available amount not enough'));
      const deps = {
        isRealTradingAllowed: () => true,
        getGlobalSettings: () => ({}),
        formatFuturesSymbol: (s: string) => s,
        enrichExchangeError: (e: any) => e.message
      };

      await expect(executeWithRetry(mockFn, 'order', deps, 3, 10)).rejects.toThrow('margin available amount not enough');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('blacklists coin when permission denied (-1058) occurs', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('weex error -1058 no permission'));
      const failedSymbols = new Set<string>();
      const onDenied = vi.fn();
      const deps = {
        isRealTradingAllowed: () => true,
        getGlobalSettings: () => ({}),
        autopilotFailedSymbols: failedSymbols,
        onTradePermissionDenied: onDenied,
        formatFuturesSymbol: (s: string) => s,
        enrichExchangeError: (e: any) => e.message
      };

      await expect(executeWithRetry(mockFn, 'createOrder for SOL/USDT', deps, 3, 10)).rejects.toThrow('no permission');
      expect(failedSymbols.has('SOL')).toBe(true);
      expect(onDenied).toHaveBeenCalledWith('SOL', expect.stringContaining('-1058'));
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  SUPPORTED_EXCHANGES,
  DEFAULT_EXCHANGE,
  normalizeExchangeId,
  resolveActiveExchange,
  guessExchangeFromApiKey,
  detectExchangeByCredentials
} from './activeExchange.ts';

describe('activeExchange module', () => {
  describe('normalizeExchangeId', () => {
    it('normalizes various inputs strictly to weex', () => {
      expect(normalizeExchangeId('mexc')).toBe('weex');
      expect(normalizeExchangeId('MEXC ')).toBe('weex');
      expect(normalizeExchangeId('binance')).toBe('weex');
      expect(normalizeExchangeId('bybit')).toBe('weex');
      expect(normalizeExchangeId('')).toBe('weex');
      expect(normalizeExchangeId(null)).toBe('weex');
      expect(normalizeExchangeId(undefined)).toBe('weex');
      expect(normalizeExchangeId(123)).toBe('weex');
      expect(normalizeExchangeId('weex')).toBe('weex');
      expect(normalizeExchangeId('WEEX')).toBe('weex');
    });
  });

  describe('resolveActiveExchange', () => {
    it('resolves active exchange from settings or fallback', () => {
      expect(resolveActiveExchange(undefined)).toBe('weex');
      expect(resolveActiveExchange({})).toBe('weex');
      expect(resolveActiveExchange({ exchangeApiConfig: {} })).toBe('weex');
      expect(resolveActiveExchange({ exchangeApiConfig: { exchange: 'mexc' } })).toBe('weex');
      expect(resolveActiveExchange({ exchangeApiConfig: { exchange: 'weex' } })).toBe('weex');
    });
  });

  describe('guessExchangeFromApiKey', () => {
    it('guesses weex for weex_ prefix and null otherwise', () => {
      expect(guessExchangeFromApiKey('weex_abc')).toBe('weex');
      expect(guessExchangeFromApiKey('WEEX_X')).toBe('weex');
      expect(guessExchangeFromApiKey('abc')).toBeNull();
      expect(guessExchangeFromApiKey('')).toBeNull();
      expect(guessExchangeFromApiKey(undefined)).toBeNull();
    });
  });

  describe('detectExchangeByCredentials', () => {
    it('does not call createClient and returns error if keys are empty', async () => {
      const createClient = vi.fn();
      const res1 = await detectExchangeByCredentials({ apiKey: '', apiSecret: '' }, { createClient });
      expect(res1.success).toBe(false);
      if ('error' in res1) {
        expect(res1.error).toContain('Не указан API-ключ или секрет');
      }
      expect(createClient).not.toHaveBeenCalled();

      const res2 = await detectExchangeByCredentials({ apiKey: 'key', apiSecret: '   ' }, { createClient });
      expect(res2.success).toBe(false);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('returns success on valid mock fetchBalance', async () => {
      const mockClient = {
        fetchBalance: vi.fn().mockResolvedValue({ total: { USDT: 100 } })
      };
      const createClient = vi.fn().mockReturnValue(mockClient);

      const res = await detectExchangeByCredentials(
        { apiKey: 'my_api_key', apiSecret: 'my_secret_key', password: 'pass' },
        { createClient, headers: { 'X-Custom': 'val' } }
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.exchange).toBe('weex');
      }
      expect(createClient).toHaveBeenCalledWith(
        'weex',
        { apiKey: 'my_api_key', apiSecret: 'my_secret_key', password: 'pass' },
        { headers: { 'X-Custom': 'val' } }
      );
      expect(mockClient.fetchBalance).toHaveBeenCalledWith({ type: 'swap' });
    });

    it('handles connection failure and redacts secrets in error message', async () => {
      const secret = 'super_secret_value_xyz';
      const key = 'api_key_12345';
      const mockClient = {
        fetchBalance: vi.fn().mockRejectedValue(new Error(`Failed with key ${key} and secret ${secret}`))
      };
      const createClient = vi.fn().mockReturnValue(mockClient);

      const res = await detectExchangeByCredentials(
        { apiKey: key, apiSecret: secret },
        { createClient }
      );

      expect(res.success).toBe(false);
      if ('error' in res) {
        expect(res.error).toContain('Ключ не подошёл ни к одной поддерживаемой бирже (WEEX)');
        expect(res.error).not.toContain(key);
        expect(res.error).not.toContain(secret);
        expect(res.error).toContain('***');
      }
    });

    it('handles timeout when fetchBalance hangs', async () => {
      const mockClient = {
        fetchBalance: vi.fn().mockImplementation(() => new Promise(() => {})) // hangs
      };
      const createClient = vi.fn().mockReturnValue(mockClient);

      const res = await detectExchangeByCredentials(
        { apiKey: 'some_key', apiSecret: 'some_secret' },
        { createClient, timeoutMs: 10 }
      );

      expect(res.success).toBe(false);
      if ('error' in res) {
        expect(res.error).toContain('Превышен таймаут');
      }
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KNOWLEDGE_BASE,
  DEFAULT_BASELINE_EXPERT_INSTRUCTIONS,
  WEEX_API_SUPPORTED_BASES,
  isWeexApiSupported,
  formatFuturesSymbol,
  enrichExchangeError
} from './defaultStrategyKnowledge.ts';

describe('defaultStrategyKnowledge', () => {
  it('contains valid default knowledge base rules', () => {
    expect(DEFAULT_KNOWLEDGE_BASE.length).toBeGreaterThan(20);
    expect(DEFAULT_KNOWLEDGE_BASE.some(r => r.id === 'def_1')).toBe(true);
    expect(DEFAULT_KNOWLEDGE_BASE.some(r => r.agent === 'LONG_MANAGER')).toBe(true);
  });

  it('contains baseline expert instructions for bidirectional scalping', () => {
    expect(DEFAULT_BASELINE_EXPERT_INSTRUCTIONS).toContain('ДВУСТОРОННИЙ КВАНТОВЫЙ СКАЛЬПИНГ');
    expect(DEFAULT_BASELINE_EXPERT_INSTRUCTIONS).toContain('LONG');
    expect(DEFAULT_BASELINE_EXPERT_INSTRUCTIONS).toContain('SHORT');
  });

  it('correctly checks supported Weex pairs', () => {
    expect(isWeexApiSupported('BTC/USDT:USDT')).toBe(true);
    expect(isWeexApiSupported('1000PEPE/USDT:USDT')).toBe(true);
    expect(isWeexApiSupported('UNKNOWN_COIN_XYZ/USDT')).toBe(false);
  });

  it('formats futures symbols for weex and mexc', () => {
    expect(formatFuturesSymbol('BTCUSDT', 'weex')).toBe('BTC/USDT:USDT');
    expect(formatFuturesSymbol('PEPE/USDT', 'weex')).toBe('1000PEPE/USDT:USDT');
    expect(formatFuturesSymbol('SOL/USDC', 'mexc')).toBe('SOL/USDC:USDC');
  });

  it('enriches exchange errors with helpful messages', () => {
    expect(enrichExchangeError(new Error('error -1058: no permission for this trading pair'))).toContain('WEEX -1058');
    expect(enrichExchangeError(new Error('permission denied'))).toContain('Permission Denied');
    expect(enrichExchangeError(new Error('invalid api key'))).toContain('Ошибка авторизации API ключа');
    expect(enrichExchangeError(new Error('socket hang up'))).toContain('Сетевой сбой связи');
  });
});

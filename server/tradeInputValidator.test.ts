import { describe, it, expect } from 'vitest';
import { validatePaperTradeInput } from './tradeInputValidator.ts';

describe('validatePaperTradeInput', () => {
  it('validates correct LONG trade with numeric strings and normalization', () => {
    const input = {
      entryPrice: '101.25',
      amount: '50',
      leverage: '10',
      side: 'LONG',
      takeProfit: '115.0',
      stopLoss: '95.0'
    };

    const result = validatePaperTradeInput(input);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({
        entryPrice: 101.25,
        amount: 50,
        leverage: 10,
        side: 'LONG',
        takeProfit: 115,
        stopLoss: 95
      });
    }
  });

  it('rejects non-numeric entryPrice', () => {
    const input = {
      entryPrice: 'bad-price',
      amount: 50,
      leverage: 10,
      side: 'SHORT'
    };

    const result = validatePaperTradeInput(input);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('entryPrice');
    }
  });

  it('rejects Infinity in amount', () => {
    const input = {
      entryPrice: 100,
      amount: Infinity,
      leverage: 10,
      side: 'SHORT'
    };

    const result = validatePaperTradeInput(input);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('amount');
    }
  });

  it('rejects zero or negative leverage', () => {
    const resultZero = validatePaperTradeInput({ entryPrice: 100, amount: 50, leverage: 0 });
    expect(resultZero.valid).toBe(false);

    const resultNegative = validatePaperTradeInput({ entryPrice: 100, amount: 50, leverage: -5 });
    expect(resultNegative.valid).toBe(false);
  });

  it('rejects side: INVALID', () => {
    const input = {
      entryPrice: 100,
      amount: 50,
      leverage: 5,
      side: 'INVALID'
    };

    const result = validatePaperTradeInput(input);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('side');
    }
  });

  it('rejects negative or invalid TP and SL', () => {
    const resultNegTp = validatePaperTradeInput({
      entryPrice: 100,
      amount: 50,
      leverage: 5,
      side: 'LONG',
      takeProfit: -10
    });
    expect(resultNegTp.valid).toBe(false);

    const resultBadSl = validatePaperTradeInput({
      entryPrice: 100,
      amount: 50,
      leverage: 5,
      side: 'LONG',
      stopLoss: 'bad-sl'
    });
    expect(resultBadSl.valid).toBe(false);
  });

  it('defaults to SHORT if side is missing or undefined', () => {
    const input = {
      entryPrice: 100,
      amount: 50,
      leverage: 5
    };

    const result = validatePaperTradeInput(input);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.side).toBe('SHORT');
    }
  });
});

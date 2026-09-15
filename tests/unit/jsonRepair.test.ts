import { describe, it, expect } from 'vitest';
import { cleanAndExtractJson, healJsonQuotesAndNewlines, repairJsonText, safeJsonParse } from '../../server/utils/jsonRepair';

describe('jsonRepair utilities', () => {
  it('extracts JSON from markdown code blocks', () => {
    const raw = "Here is the response:\n```json\n{\"symbol\": \"BTCUSDT\", \"score\": 90}\n```\nHope it helps!";
    expect(cleanAndExtractJson(raw)).toBe('{"symbol": "BTCUSDT", "score": 90}');
  });

  it('safely parses standard JSON and complex AI responses with comments', () => {
    const withComments = `
    // AI Decision result
    {
      "action": "BUY", // Take order
      "leverage": 5,
      /* multi-line comment */
      "confidence": 0.95
    }
    `;
    const parsed = safeJsonParse(withComments, {});
    expect(parsed.action).toBe("BUY");
    expect(parsed.leverage).toBe(5);
    expect(parsed.confidence).toBe(0.95);
  });

  it('heals unclosed JSON objects gracefully', () => {
    const truncated = '{"id": 1, "symbol": "ETHUSDT"';
    const parsed = safeJsonParse(truncated, {});
    expect(parsed.id).toBe(1);
    expect(parsed.symbol).toBe("ETHUSDT");
  });

  it('returns fallback on completely invalid input', () => {
    expect(safeJsonParse('', { status: 'fallback' })).toEqual({ status: 'fallback' });
  });
});

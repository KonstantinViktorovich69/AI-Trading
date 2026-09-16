import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { partitionTradesForArchive, appendTradesToArchive } from './tradeArchive.ts';

describe('tradeArchive', () => {
  describe('partitionTradesForArchive', () => {
    it('returns empty arrays when trades is empty or not an array', () => {
      expect(partitionTradesForArchive([])).toEqual({ keep: [], toArchive: [] });
      expect(partitionTradesForArchive(null as any)).toEqual({ keep: [], toArchive: [] });
      expect(partitionTradesForArchive(undefined as any)).toEqual({ keep: [], toArchive: [] });
    });

    it('archives CLOSED trades older than retentionDays', () => {
      const now = Date.now();
      const fortyDaysAgo = now - 40 * 24 * 60 * 60 * 1000;
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      const trades = [
        { id: '1', status: 'CLOSED', closeTime: fortyDaysAgo },
        { id: '2', status: 'CLOSED', closeTime: tenDaysAgo },
        { id: '3', status: 'CLOSED', closedAt: fortyDaysAgo }
      ];

      const result = partitionTradesForArchive(trades, 30);
      expect(result.toArchive).toHaveLength(2);
      expect(result.toArchive.map(t => t.id)).toEqual(['1', '3']);
      expect(result.keep).toHaveLength(1);
      expect(result.keep[0].id).toBe('2');
    });

    it('NEVER archives non-CLOSED statuses even if they are very old', () => {
      const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

      const trades = [
        { id: 'open_1', status: 'OPEN', closeTime: sixtyDaysAgo },
        { id: 'open_unk', status: 'OPEN_UNKNOWN', closeTime: sixtyDaysAgo },
        { id: 'pending', status: 'PENDING_OPEN', closeTime: sixtyDaysAgo },
        { id: 'cancelled', status: 'CANCELLED', closeTime: sixtyDaysAgo },
        { id: 'rejected', status: 'REJECTED', closeTime: sixtyDaysAgo },
        { id: 'custom', status: 'ANY_OTHER_STATUS', closeTime: sixtyDaysAgo }
      ];

      const result = partitionTradesForArchive(trades, 30);
      expect(result.toArchive).toHaveLength(0);
      expect(result.keep).toHaveLength(6);
      expect(result.keep.map(t => t.id)).toEqual([
        'open_1', 'open_unk', 'pending', 'cancelled', 'rejected', 'custom'
      ]);
    });

    it('preserves exact original order of kept trades', () => {
      const now = Date.now();
      const thirtyFiveDaysAgo = now - 35 * 24 * 60 * 60 * 1000;
      const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;

      const trades = [
        { id: 'first_open', status: 'OPEN' },
        { id: 'old_closed_1', status: 'CLOSED', closeTime: thirtyFiveDaysAgo },
        { id: 'second_open', status: 'OPEN' },
        { id: 'recent_closed', status: 'CLOSED', closeTime: fiveDaysAgo },
        { id: 'third_cancelled', status: 'CANCELLED' },
        { id: 'old_closed_2', status: 'CLOSED', closeTime: thirtyFiveDaysAgo }
      ];

      const result = partitionTradesForArchive(trades, 30);
      expect(result.keep.map(t => t.id)).toEqual([
        'first_open', 'second_open', 'recent_closed', 'third_cancelled'
      ]);
      expect(result.toArchive.map(t => t.id)).toEqual([
        'old_closed_1', 'old_closed_2'
      ]);
    });

    it('keeps CLOSED trades without a valid timestamp', () => {
      const trades = [
        { id: 'no_time', status: 'CLOSED' },
        { id: 'zero_time', status: 'CLOSED', closeTime: 0 }
      ];

      const result = partitionTradesForArchive(trades, 30);
      expect(result.toArchive).toHaveLength(0);
      expect(result.keep).toHaveLength(2);
    });
  });

  describe('appendTradesToArchive', () => {
    it('does nothing when entries is empty or not an array', () => {
      const spyAppend = vi.spyOn(fs.promises, 'appendFile');
      appendTradesToArchive([]);
      appendTradesToArchive(null as any);
      expect(spyAppend).not.toHaveBeenCalled();
      spyAppend.mockRestore();
    });

    it('calls appendFile and handles errors with console.error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spyAppend = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('Disk write failure'));

      appendTradesToArchive([{ id: 'trade_fail', status: 'CLOSED' }]);

      // Allow fire-and-forget promise to execute
      await new Promise(r => setTimeout(r, 20));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[TRADE-ARCHIVE ERROR]'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
      spyAppend.mockRestore();
    });
  });
});

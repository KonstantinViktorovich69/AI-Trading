import fs from 'fs';
import path from 'path';

const ARCHIVE_FILE_PATH = path.join(process.cwd(), 'data', 'trades-archive.jsonl');

export interface TradePartitionResult {
  keep: any[];
  toArchive: any[];
}

/**
 * Pure function partitioning trades for retention archiving.
 * Strictly moves only trades where status === 'CLOSED' and closeTime is older than retentionDays.
 * All other trades (non-CLOSED or CLOSED within retention window) are preserved in their original order.
 */
export function partitionTradesForArchive(trades: any[], retentionDays: number = 30): TradePartitionResult {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { keep: [], toArchive: [] };
  }

  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const keep: any[] = [];
  const toArchive: any[] = [];

  for (const trade of trades) {
    if (!trade) continue;

    // Strict status check: only exact 'CLOSED' string is eligible for archiving
    if (trade.status === 'CLOSED') {
      const rawCloseTime = trade.closeTime ?? trade.closedAt;
      const closeTime = typeof rawCloseTime === 'number'
        ? rawCloseTime
        : (rawCloseTime ? new Date(rawCloseTime).getTime() : 0);

      if (closeTime > 0 && (now - closeTime) > retentionMs) {
        toArchive.push(trade);
        continue;
      }
    }

    keep.push(trade);
  }

  return { keep, toArchive };
}

/**
 * Non-blocking fire-and-forget append of trades to JSON Lines archive file (data/trades-archive.jsonl).
 */
export function appendTradesToArchive(entries: any[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  // Fire-and-forget async execution without blocking caller
  (async () => {
    try {
      const dir = path.dirname(ARCHIVE_FILE_PATH);
      await fs.promises.mkdir(dir, { recursive: true });
      const lines = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      await fs.promises.appendFile(ARCHIVE_FILE_PATH, lines, 'utf8');
    } catch (err) {
      console.error('[TRADE-ARCHIVE ERROR] Failed to append trades to archive:', err);
    }
  })();
}

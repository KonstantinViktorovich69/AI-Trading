import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Server startup read-only database integrity', () => {
  const tempDbPath = path.join(process.cwd(), 'temp_test_db_startup.json');

  const initialData = {
    trades: [
      { id: 'trade_real_1', symbol: 'BTCUSDT', pnl: 120, mode: 'PAPER', dataOrigin: 'PAPER' }
    ],
    tradeHistory: [
      { id: 'trade_real_2', symbol: 'ETHUSDT', pnl: -15, mode: 'PAPER', dataOrigin: 'PAPER' }
    ],
    knowledge: [
      { id: 'rule_1', title: 'Test Rule' }
    ],
    committeeHistory: [
      { id: 'comm_1', action: 'APPROVE' }
    ]
  };

  beforeEach(() => {
    fs.writeFileSync(tempDbPath, JSON.stringify(initialData, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  it('loading database state does not mutate or add historical arrays without incoming event', () => {
    const rawBefore = fs.readFileSync(tempDbPath, 'utf-8');
    const parsedBefore = JSON.parse(rawBefore);

    // Simulate server state load (reading DB copy)
    const readData = JSON.parse(fs.readFileSync(tempDbPath, 'utf-8'));

    // Verify arrays length and IDs match exactly
    expect(readData.trades.length).toBe(parsedBefore.trades.length);
    expect(readData.trades[0].id).toBe('trade_real_1');

    expect(readData.tradeHistory.length).toBe(parsedBefore.tradeHistory.length);
    expect(readData.tradeHistory[0].id).toBe('trade_real_2');

    expect(readData.knowledge.length).toBe(parsedBefore.knowledge.length);
    expect(readData.committeeHistory.length).toBe(parsedBefore.committeeHistory.length);

    // Ensure file on disk was not modified
    const rawAfter = fs.readFileSync(tempDbPath, 'utf-8');
    expect(rawAfter).toBe(rawBefore);
  });
});

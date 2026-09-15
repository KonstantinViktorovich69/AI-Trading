const fs = require('fs');

const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
const trades = db.trades || [];
const closed = trades.filter(t => t.status === 'CLOSED');

// Sort by close timestamp descending
closed.sort((a, b) => {
  const timeA = a.closeTime || (a.history && a.history[a.history.length - 1]?.time) || a.time || 0;
  const timeB = b.closeTime || (b.history && b.history[b.history.length - 1]?.time) || b.time || 0;
  return timeB - timeA;
});

const last10 = closed.slice(0, 10);

console.log('Total closed trades found:', closed.length);
console.log('================================================================================');
console.log('                          LAST 10 CLOSED TRADES AUDIT                           ');
console.log('================================================================================\n');

let totalPnl = 0;
let winCount = 0;
let lossCount = 0;

last10.forEach((t, i) => {
  const openTime = t.time || (t.history && t.history[0]?.time) || 0;
  const closeTime = t.closeTime || (t.history && t.history[t.history.length - 1]?.time) || openTime;
  const durationSec = Math.round((closeTime - openTime) / 1000);
  const pnl = Number(t.pnl ?? t.profit ?? 0);
  const pnlPct = Number(t.pnlPercent ?? t.profitPercent ?? 0);
  totalPnl += pnl;
  if (pnl > 0) winCount++;
  else if (pnl < 0) lossCount++;

  console.log(`[TRADE #${i + 1}] ID: ${t.id || 'N/A'}`);
  console.log(`  Symbol: ${t.symbol} | Type/Side: ${t.side || t.type} | Mode: ${t.mode || 'N/A'} | isReal: ${Boolean(t.isReal)}`);
  console.log(`  Entry Price: ${t.entryPrice || t.price} | Close Price: ${t.closePrice || t.exitPrice}`);
  console.log(`  Amount/Margin: $${t.amount || t.initialAmount || 0} | Leverage: ${t.leverage || 1}x`);
  console.log(`  PnL: $${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%) | Outcome: ${pnl >= 0 ? 'WIN' : 'LOSS'}`);
  console.log(`  Open Time:  ${new Date(openTime).toISOString()}`);
  console.log(`  Close Time: ${new Date(closeTime).toISOString()} (Duration: ${durationSec}s)`);
  console.log(`  Exit Reason: ${t.exitReason || t.closeReason || 'N/A'}`);
  console.log(`  Matched Rules: ${JSON.stringify(t.matchedRules || t.matchedRuleIds || [])}`);
  console.log(`  Audit Fields: correlationId=${t.decisionCorrelationId || 'none'}, revision=${t.stateRevision ?? 'none'}`);
  console.log(`  Trade Details: ${JSON.stringify({
    stopLoss: t.stopLoss,
    virtualStopLoss: t.virtualStopLoss,
    takeProfit: t.takeProfit,
    tpStages: t.tpStages ? t.tpStages.map(s => ({ target: s.targetPrice, pct: s.targetPercent, executed: s.executed })) : 'none',
    gridOrders: t.gridOrders ? t.gridOrders.map(g => ({ price: g.price, amount: g.amount, executed: g.executed })) : 'none'
  })}`);
  console.log('--------------------------------------------------------------------------------');
});

console.log(`\nSUMMARY OF LAST 10:`);
console.log(`Wins: ${winCount} | Losses: ${lossCount} | Win Rate: ${((winCount / last10.length) * 100).toFixed(1)}%`);
console.log(`Total PnL of last 10: $${totalPnl.toFixed(4)}`);

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
const allLosses = closed.filter(t => (t.pnl ?? t.profit ?? 0) < 0);
const allWins = closed.filter(t => (t.pnl ?? t.profit ?? 0) > 0);

console.log('=== DEEP AUDIT: LOSS PATTERNS & ROOT CAUSES ===\n');

console.log('--- 1. LAST 10 TRADES DETAILED BREAKDOWN ---');
const last10Stats = {
  total: 10,
  wins: 0,
  losses: 0,
  totalPnl: 0,
  reasons: {},
  sides: { LONG: 0, SHORT: 0 },
  avgDurationWin: 0,
  avgDurationLoss: 0,
  lossReasons: {}
};

last10.forEach((t, i) => {
  const pnl = Number(t.pnl ?? t.profit ?? 0);
  const pnlPct = Number(t.pnlPercent ?? t.profitPercent ?? 0);
  const openTime = t.time || (t.history && t.history[0]?.time) || 0;
  const closeTime = t.closeTime || (t.history && t.history[t.history.length - 1]?.time) || openTime;
  const dur = (closeTime - openTime) / 1000;
  const side = t.side || t.type || 'UNKNOWN';
  const reason = t.exitReason || t.closeReason || 'UNKNOWN';

  last10Stats.sides[side] = (last10Stats.sides[side] || 0) + 1;
  last10Stats.totalPnl += pnl;

  if (pnl > 0) {
    last10Stats.wins++;
    last10Stats.avgDurationWin += dur;
  } else {
    last10Stats.losses++;
    last10Stats.avgDurationLoss += dur;
    last10Stats.lossReasons[reason] = (last10Stats.lossReasons[reason] || 0) + 1;
  }

  console.log(`[#${i+1}] ${t.symbol} | ${side} | PnL: $${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%) | Dur: ${Math.round(dur)}s | Reason: ${reason.slice(0, 80)}`);
});

if (last10Stats.wins > 0) last10Stats.avgDurationWin /= last10Stats.wins;
if (last10Stats.losses > 0) last10Stats.avgDurationLoss /= last10Stats.losses;

console.log('\nLast 10 Stats:', {
  wins: last10Stats.wins,
  losses: last10Stats.losses,
  winRate: `${((last10Stats.wins / 10) * 100).toFixed(1)}%`,
  totalPnl: `$${last10Stats.totalPnl.toFixed(4)}`,
  sides: last10Stats.sides,
  avgDurationWinSec: Math.round(last10Stats.avgDurationWin),
  avgDurationLossSec: Math.round(last10Stats.avgDurationLoss),
  lossReasons: last10Stats.lossReasons
});

console.log('\n--- 2. ALL HISTORICAL CLOSED TRADES LOSS PATTERN CLUSTERING ---');
const reasonClusters = {};
const sideClusters = { LONG: { count: 0, pnl: 0, wins: 0 }, SHORT: { count: 0, pnl: 0, wins: 0 } };

closed.forEach(t => {
  const pnl = Number(t.pnl ?? t.profit ?? 0);
  const side = t.side || t.type || 'UNKNOWN';
  if (sideClusters[side]) {
    sideClusters[side].count++;
    sideClusters[side].pnl += pnl;
    if (pnl > 0) sideClusters[side].wins++;
  }

  let cat = 'OTHER';
  const r = (t.exitReason || t.closeReason || '').toLowerCase();
  if (r.includes('pttp') || r.includes('фиксация')) cat = 'PTTP_TAKE_PROFIT';
  else if (r.includes('stagnation') || r.includes('флэт') || r.includes('flat')) cat = 'FLAT_STAGNATION_TIMEOUT';
  else if (r.includes('slow-bleeder') || r.includes('сползать')) cat = 'SLOW_BLEEDER_SHIELD';
  else if (r.includes('максимальное время') || r.includes('max_lifetime') || r.includes('время удержания')) cat = 'MAX_LIFETIME_TIMEOUT';
  else if (r.includes('стоп') || r.includes('sl') || r.includes('stop')) cat = 'STOP_LOSS';
  else if (r.includes('ликвид') || r.includes('liquidation')) cat = 'LIQUIDATION';

  if (!reasonClusters[cat]) reasonClusters[cat] = { count: 0, wins: 0, losses: 0, totalPnl: 0, avgPnl: 0 };
  reasonClusters[cat].count++;
  reasonClusters[cat].totalPnl += pnl;
  if (pnl > 0) reasonClusters[cat].wins++;
  else reasonClusters[cat].losses++;
});

Object.keys(reasonClusters).forEach(k => {
  reasonClusters[k].avgPnl = Number((reasonClusters[k].totalPnl / reasonClusters[k].count).toFixed(4));
  reasonClusters[k].winRate = `${((reasonClusters[k].wins / reasonClusters[k].count) * 100).toFixed(1)}%`;
});

console.log('Reason Clusters across all closed trades:', reasonClusters);
console.log('Side Clusters:', sideClusters);

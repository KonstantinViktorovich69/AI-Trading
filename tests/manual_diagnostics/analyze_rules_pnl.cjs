const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
if (!fs.existsSync(dbPath)) {
  console.log('database.json does not exist');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const trades = db.trades || [];

console.log('=== АНАЛИЗ БАЗЫ ТОРГОВЫХ СДЕЛОК ===');
console.log(`Всего сделок: ${trades.length}`);

const closedTrades = trades.filter(t => t.status === 'CLOSED');
const openTrades = trades.filter(t => t.status === 'OPEN');

console.log(`Закрытых сделок: ${closedTrades.length}`);
console.log(`Открытых сделок: ${openTrades.length}`);

// Group by Mode
const modeStats = {};
closedTrades.forEach(t => {
  const mode = t.mode || 'MANUAL';
  if (!modeStats[mode]) modeStats[mode] = { count: 0, win: 0, loss: 0, pnl: 0, pnlPctSum: 0 };
  const stats = modeStats[mode];
  stats.count++;
  const win = (t.pnlPercent || 0) > 0;
  if (win) stats.win++;
  else stats.loss++;
  stats.pnl += (t.pnl || 0);
  stats.pnlPctSum += (t.pnlPercent || 0);
});

console.log('\n--- СТАРИСТИКА ПО РЕЖИМАМ (MANUAL / AUTO / SEMI_AUTO) ---');
for (const [mode, stats] of Object.entries(modeStats)) {
  const wr = (stats.win / stats.count * 100).toFixed(1);
  const avgPnl = (stats.pnl / stats.count).toFixed(2);
  const avgPnlPct = (stats.pnlPctSum / stats.count).toFixed(2);
  console.log(`Режим: ${mode.padEnd(10)} | Сделок: ${stats.count} | WinRate: ${wr}% | Win: ${stats.win} / Low: ${stats.loss} | Net PnL: ${stats.pnl.toFixed(2)} USDT | Avg PnL: ${avgPnl} USDT (${avgPnlPct}%)`);
}

// Group by Real vs Virtual
const realStats = { count: 0, win: 0, loss: 0, pnl: 0 };
const virtStats = { count: 0, win: 0, loss: 0, pnl: 0 };
closedTrades.forEach(t => {
  const stats = t.isReal ? realStats : virtStats;
  stats.count++;
  if ((t.pnlPercent || 0) > 0) stats.win++;
  else stats.loss++;
  stats.pnl += (t.pnl || 0);
});

console.log('\n--- РЕАЛЬНЫЕ VS ВИРТУАЛЬНЫЕ ---');
console.log(`Реальные    | Сделок: ${realStats.count} | WinRate: ${(realStats.win / (realStats.count || 1) * 100).toFixed(1)}% | Net PnL: ${realStats.pnl.toFixed(2)} USDT`);
console.log(`Виртуальные | Сделок: ${virtStats.count} | WinRate: ${(virtStats.win / (virtStats.count || 1) * 100).toFixed(1)}% | Net PnL: ${virtStats.pnl.toFixed(2)} USDT`);

// Group by Symbol
const symStats = {};
closedTrades.forEach(t => {
  const sym = t.symbol;
  if (!symStats[sym]) symStats[sym] = { count: 0, win: 0, loss: 0, pnl: 0, pnlPctSum: 0 };
  const stats = symStats[sym];
  stats.count++;
  if ((t.pnlPercent || 0) > 0) stats.win++;
  else stats.loss++;
  stats.pnl += (t.pnl || 0);
  stats.pnlPctSum += (t.pnlPercent || 0);
});

console.log('\n--- ХУДШИЕ МОНЕТЫ (ПО ТАКТИЧЕСКОМУ PNL) ---');
const sortedSyms = Object.entries(symStats).sort((a,b) => a[1].pnl - b[1].pnl);
sortedSyms.slice(0, 10).forEach(([sym, stats]) => {
  console.log(`Монета: ${sym.padEnd(15)} | Сделок: ${stats.count} | WinRate: ${(stats.win / stats.count * 100).toFixed(1)}% | Net PnL: ${stats.pnl.toFixed(2)} USDT | Avg PnL: ${(stats.pnlPctSum / stats.count).toFixed(2)}%`);
});

console.log('\n--- ЛУЧШИЕ МОНЕТЫ (ПО ТАКТИЧЕСКОМУ PNL) ---');
sortedSyms.reverse().slice(0, 10).forEach(([sym, stats]) => {
  console.log(`Монета: ${sym.padEnd(15)} | Сделок: ${stats.count} | WinRate: ${(stats.win / stats.count * 100).toFixed(1)}% | Net PnL: ${stats.pnl.toFixed(2)} USDT | Avg PnL: ${(stats.pnlPctSum / stats.count).toFixed(2)}%`);
});

// Analyze matchedRules
const ruleStats = {};
closedTrades.forEach(t => {
  const rules = t.matchedRules || [];
  rules.forEach(ruleId => {
    if (!ruleStats[ruleId]) ruleStats[ruleId] = { count: 0, win: 0, loss: 0, pnl: 0, pnlPctSum: 0 };
    const stats = ruleStats[ruleId];
    stats.count++;
    if ((t.pnlPercent || 0) > 0) stats.win++;
    else stats.loss++;
    stats.pnl += (t.pnl || 0);
    stats.pnlPctSum += (t.pnlPercent || 0);
  });
});

console.log('\n--- АНАЛИЗ СТРАТЕГИЙ/ПРАВИЛ (MATCHED RULES) ---');
const sortedRules = Object.entries(ruleStats).sort((a,b) => a[1].pnl - b[1].pnl);
if (sortedRules.length === 0) {
  console.log('Нет сделок с привязанными ID правил (matchedRules).');
} else {
  console.log('Худшие правила по Net PnL:');
  sortedRules.slice(0, 10).forEach(([ruleId, stats]) => {
    const rulesText = db.aiKnowledgeBase ? db.aiKnowledgeBase.find(r => r.id === ruleId)?.text : '';
    console.log(`Правило: ${ruleId.padEnd(15)} | Сделок: ${stats.count} | WinRate: ${(stats.win / stats.count * 100).toFixed(1)}% | Net PnL: ${stats.pnl.toFixed(2)} USDT | Avg: ${(stats.pnlPctSum / stats.count).toFixed(2)}% | ${rulesText ? rulesText.substring(0, 60) + '...' : ''}`);
  });

  console.log('\nЛучшие правила по Net PnL:');
  sortedRules.reverse().slice(0, 10).forEach(([ruleId, stats]) => {
    const rulesText = db.aiKnowledgeBase ? db.aiKnowledgeBase.find(r => r.id === ruleId)?.text : '';
    console.log(`Правило: ${ruleId.padEnd(15)} | Сделок: ${stats.count} | WinRate: ${(stats.win / stats.count * 100).toFixed(1)}% | Net PnL: ${stats.pnl.toFixed(2)} USDT | Avg: ${(stats.pnlPctSum / stats.count).toFixed(2)}% | ${rulesText ? rulesText.substring(0, 60) + '...' : ''}`);
  });
}

// Side ratio
const longStats = { count: 0, win: 0, loss: 0, pnl: 0 };
const shortStats = { count: 0, win: 0, loss: 0, pnl: 0 };
closedTrades.forEach(t => {
  const stats = t.side === 'LONG' ? longStats : shortStats;
  stats.count++;
  if ((t.pnlPercent || 0) > 0) stats.win++;
  else stats.loss++;
  stats.pnl += (t.pnl || 0);
});
console.log('\n--- СРАВНЕНИЕ LONG VS SHORT ---');
console.log(`LONG  | Сделок: ${longStats.count} | WinRate: ${(longStats.win / (longStats.count || 1) * 100).toFixed(1)}% | Net PnL: ${longStats.pnl.toFixed(2)} USDT`);
console.log(`SHORT | Сделок: ${shortStats.count} | WinRate: ${(shortStats.win / (shortStats.count || 1) * 100).toFixed(1)}% | Net PnL: ${shortStats.pnl.toFixed(2)} USDT`);

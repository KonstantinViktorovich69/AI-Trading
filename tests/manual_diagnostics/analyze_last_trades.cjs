const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
if (!fs.existsSync(dbPath)) {
  console.log('database.json does not exist');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const trades = db.trades || [];

console.log('=== ОБЩАЯ СТАТИСТИКА ===');
console.log(`Всего сделок в базе: ${trades.length}`);

const realTrades = trades.filter(t => t.isReal);
const virtualTrades = trades.filter(t => !t.isReal);

console.log(`Реальных сделок: ${realTrades.length}`);
console.log(`Виртуальных сделок: ${virtualTrades.length}`);

console.log('\n=== ПОСЛЕДНИЕ 15 ВИРТУАЛЬНЫХ СДЕЛОК ===');
const lastVirtual = virtualTrades.sort((a,b) => (b.closeTime || b.openTime || 0) - (a.closeTime || a.openTime || 0)).slice(0, 15);
lastVirtual.forEach((t, i) => {
  console.log(`[${i+1}] ID: ${t.id} | ${t.symbol} | Mode: ${t.mode} | Status: ${t.status} | P&L: ${t.pnlPercent ? t.pnlPercent.toFixed(2) + '%' : 'N/A'} (${t.pnl ? t.pnl.toFixed(2) + ' USDT' : 'N/A'}) | Entry: ${t.entryPrice} | Exit: ${t.exitPrice || 'N/A'} | CloseReason: ${t.notes || t.notesClose || t.feedback || 'N/A'}`);
});

console.log('\n=== ПОСЛЕДНИЕ 15 РЕАЛЬНЫХ СДЕЛОК ===');
const lastReal = realTrades.sort((a,b) => (b.closeTime || b.openTime || 0) - (a.closeTime || a.openTime || 0)).slice(0, 15);
lastReal.forEach((t, i) => {
  console.log(`[${i+1}] ID: ${t.id} | ${t.symbol} | Mode: ${t.mode} | Status: ${t.status} | P&L: ${t.pnlPercent ? t.pnlPercent.toFixed(2) + '%' : 'N/A'} (${t.pnl ? t.pnl.toFixed(2) + ' USDT' : 'N/A'}) | Entry: ${t.entryPrice} | Exit: ${t.exitPrice || 'N/A'} | EntryAmount: ${t.amount || 'N/A'} | MaxLeverage: ${t.leverage || 'N/A'} | CloseReason: ${t.notes || t.notesClose || t.feedback || 'N/A'}`);
});

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const trades = db.trades || [];

// Отберем принудительно закрытые сделки при смене баланса
const forcedClosed = trades.filter(t => t.notes && t.notes.includes('при смене виртуального баланса'));

console.log(`=== ХРОНОЛОГИЯ ПРИНУДИТЕЛЬНО ЗАКРЫТЫХ СДЕЛОК ===`);
forcedClosed.forEach((t, i) => {
  const closeTimeStr = t.closeTime ? new Date(t.closeTime).toISOString() : 'N/A';
  console.log(`[${i+1}] ID: ${t.id} | ${t.symbol} | Closed At: ${closeTimeStr} (${t.closeTime}) | PnL: ${t.pnl} | Amount: ${t.amount}`);
});

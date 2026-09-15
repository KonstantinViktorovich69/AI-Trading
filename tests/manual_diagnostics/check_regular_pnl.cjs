const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const trades = db.trades || [];

let totalPnl = 0;
let count = 0;
trades.forEach(t => {
  if (!t.isAutoLearning) {
    count++;
    totalPnl += t.pnl || 0;
    console.log(`- Trade ${t.id}: ${t.symbol} | P&L: ${t.pnl || 0} | Amount: ${t.amount} | Status: ${t.status}`);
  }
});

console.log('Total regular trades:', count);
console.log('Total P&L of regular trades:', totalPnl);

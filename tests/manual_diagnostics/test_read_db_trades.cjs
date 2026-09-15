const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(process.cwd(), 'database.json');
if (!fs.existsSync(DB_FILE)) {
  console.log('database.json does not exist!');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
console.log('Database keys:', Object.keys(db));
console.log('Total trades in database.json:', db.trades ? db.trades.length : 0);

if (db.trades && db.trades.length > 0) {
  console.log('Sample trade fields:', Object.keys(db.trades[0]));
  console.log('Sample trade data:', JSON.stringify(db.trades[0], null, 2));

  const safeDate = (t) => {
    const timeVal = t.openTime || t.timestamp;
    if (!timeVal) return 'No TS';
    const d = new Date(timeVal);
    return isNaN(d.getTime()) ? 'Invalid date: ' + timeVal : d.toISOString();
  };

  const sortedTrades = [...db.trades].sort((a, b) => {
    const timeA = a.openTime ? new Date(a.openTime).getTime() : 0;
    const timeB = b.openTime ? new Date(b.openTime).getTime() : 0;
    return timeB - timeA;
  });
  console.log('\nLatest 10 trades:');
  sortedTrades.slice(0, 10).forEach(t => {
    console.log(`- Trade ID: ${t.id || t.tradeId}, Symbol: ${t.symbol}, Type: ${t.type || t.side}, Status: ${t.status}, Profit/Loss: ${t.realizedPnl || t.pnl || 0}, Date: ${safeDate(t)}`);
  });

  const tradesAfterJune7 = db.trades.filter(t => {
    const time = (t.openTime || t.timestamp) ? new Date(t.openTime || t.timestamp).getTime() : 0;
    return time >= new Date('2026-06-07T00:00:00Z').getTime();
  });
  console.log(`\nTrades after June 7, 2026: ${tradesAfterJune7.length}`);
  if (tradesAfterJune7.length > 0) {
    tradesAfterJune7.slice(0, 10).forEach(t => {
       console.log(`  - ID: ${t.id || t.tradeId}, Symbol: ${t.symbol}, Date: ${safeDate(t)}`);
    });
  }
} else {
  console.log('No trades found.');
}

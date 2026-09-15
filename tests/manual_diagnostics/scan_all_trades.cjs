const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const trades = db.trades || [];

console.log('Total trades:', trades.length);

const alTrades = trades.filter(t => t.id.startsWith('AL-'));
console.log('Total AL- trades:', alTrades.length);

const alWithoutAutoLearningFlag = alTrades.filter(t => !t.isAutoLearning);
console.log('AL- trades WITHOUT isAutoLearning flag:', alWithoutAutoLearningFlag.length);
if (alWithoutAutoLearningFlag.length > 0) {
  console.log('First 5 AL- trades without flag:');
  alWithoutAutoLearningFlag.slice(0, 5).forEach(t => {
    console.log(`- ${t.id}: ${t.symbol} | isAutoLearning: ${t.isAutoLearning} | status: ${t.status}`);
  });
}

const regularTrades = trades.filter(t => t.id.startsWith('VT-'));
console.log('Total VT- trades:', regularTrades.length);

const vtWithAutoLearningFlag = regularTrades.filter(t => t.isAutoLearning);
console.log('VT- trades WITH isAutoLearning flag:', vtWithAutoLearningFlag.length);

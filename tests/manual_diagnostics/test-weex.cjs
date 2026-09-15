const ccxt = require('ccxt');
const ex = new ccxt.weex({ enableRateLimit: true });
ex.options['defaultType'] = 'swap';
console.log('Attempting to load markets for weex...');
ex.loadMarkets().then(() => {
  console.log('Markets loaded successfully!');
  console.log('Attempting to fetch OHLCV for BTC/USDT:USDT in 15m...');
  return ex.fetchOHLCV('BTC/USDT:USDT', '15m', undefined, 100);
}).then(d => {
  console.log("OHLCV length:", d.length);
  if (d.length > 0) {
    console.log("First candles:", d.slice(0, 2));
    console.log("Last candle:", d[d.length - 1]);
  }
}).catch(e => {
  console.error("Failed:", e.message || e);
});


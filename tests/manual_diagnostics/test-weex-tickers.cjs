const ccxt = require('ccxt');
const ex = new ccxt.weex({ enableRateLimit: true });
ex.options['defaultType'] = 'swap';
console.log('Attempting to fetch tickers for weex...');
ex.fetchTickers().then(tickers => {
  const keys = Object.keys(tickers);
  console.log('WEEX tickers fetched successfully! Count:', keys.length);
  if (keys.length > 0) {
    console.log('Sample keys:', keys.slice(0, 5));
    console.log('Sample ticker (first):', tickers[keys[0]]);
  }
}).catch(e => {
  console.error("Failed to fetch WEEX tickers:", e.message || e);
});

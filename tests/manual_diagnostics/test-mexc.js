const ccxt = require('ccxt');
const ex = new ccxt.mexc();
ex.options['defaultType'] = 'swap';
ex.fetchTickers().then(d => {
  console.log("Tickers length:", Object.keys(d).length);
  console.log("Sample:", Object.keys(d).slice(0, 5));
}).catch(e => console.error(e));

const http = require('http');

const endpoints = [
  '/api/debug-ohlcv',
  '/api/market/all-tickers',
  '/api/debug/cache',
  '/api/debug/state'
];

function fetchEndpoint(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${url}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ url, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ url, status: res.statusCode, error: 'Failed to parse JSON: ' + data.substring(0, 100) });
        }
      });
    }).on('error', (err) => resolve({ url, error: err.message }));
  });
}

async function run() {
  for (const url of endpoints) {
    console.log(`\n=================== Fetching ${url} ===================`);
    const res = await fetchEndpoint(url);
    if (res.error) {
      console.log(`Error: ${res.error}`);
    } else {
      console.log(`Status: ${res.status}`);
      if (url === '/api/debug-ohlcv') {
        console.log(`OHLCV debug data keys:`, Object.keys(res.data));
        console.log(`Total count of historical candle tokens:`, res.data.total);
        console.log(`Sample token:`, res.data.sample);
        console.log(`Sample token OHLCV attributes:`, res.data.sampleData ? Object.keys(res.data.sampleData) : 'none');
        if (res.data.sampleData) {
          console.log(`- Last Price:`, res.data.sampleData.price);
          console.log(`- VWAP:`, res.data.sampleData.vwap);
          console.log(`- RSI:`, res.data.sampleData.rsi1h);
          console.log(`- EMA 200 1h:`, res.data.sampleData.ema200_1h);
          console.log(`- Sweep confirmation:`, res.data.sampleData.isLiquiditySweep);
          console.log(`- Wicks topPct:`, res.data.sampleData.wicks ? res.data.sampleData.wicks.topPct : 'none');
        }
      } else if (url === '/api/market/all-tickers') {
        console.log(`Tickers summary - success: ${res.data.success}`);
        if (res.data.exchanges) {
          console.log(`Exchanges count:`, Object.keys(res.data.exchanges).length);
          for (const ex in res.data.exchanges) {
            console.log(`- ${ex}:`, res.data.exchanges[ex]);
          }
        }
      } else if (url === '/api/debug/cache') {
        console.log(`Cache summary:`, JSON.stringify(res.data, null, 2));
      } else if (url === '/api/debug/state') {
        console.log(`State summary:`, JSON.stringify(res.data, null, 2));
      }
    }
  }
}

run();

const http = require('http');

const endpoints = [
  '/api/debug-ohlcv',
  '/api/market/all-tickers',
  '/api/market/indicator-summary',
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
      if (url === '/api/debug/state') {
        console.log(`State keys:`, Object.keys(res.data));
        console.log(`State summary - isCircuitBreakerActive: ${res.data.isCircuitBreakerActive}, isBtcShockLock: ${res.data.isBtcShockLock}`);
        console.log(`State summary - total trades: ${res.data.tradesCount || (res.data.virtualTrades ? res.data.virtualTrades.length : 'unknown')}`);
      } else if (url === '/api/debug/cache') {
        console.log(`Cache data:`, JSON.stringify(res.data, null, 2));
      } else if (url === '/api/debug/state') {
        console.log(`State data:`, JSON.stringify(res.data, null, 2));
      } else if (url === '/api/market/all-tickers') {
        console.log(`Tickers length:`, res.data.length || Object.keys(res.data).length);
        console.log(`Exchanges in tickers:`, Object.keys(res.data));
        for (const ex in res.data) {
          console.log(`- ${ex}: ${res.data[ex] ? Object.keys(res.data[ex]).length : 0} tickers`);
        }
      } else if (url === '/api/debug/cache') {
        console.log(`Cache keys:`, Object.keys(res.data));
        if (res.data.signals) {
          console.log(`Signals count:`, res.data.signals.data ? res.data.signals.data.length : 'none');
          console.log(`Signals metadata - marketHealth: ${res.data.signals.marketHealth}, marketRegime: ${res.data.signals.marketRegime}`);
        }
      } else if (url === '/api/market/indicator-summary') {
        console.log(`Indicator summary keys:`, Object.keys(res.data));
        console.log(`Sample indicators length:`, res.data.length || Object.keys(res.data.indicatorStates || {}).length);
      } else {
        console.log(`Keys:`, Object.keys(res.data));
      }
    }
  }
}

run();

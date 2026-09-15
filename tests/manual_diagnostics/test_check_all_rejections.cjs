const http = require('http');

// Let's first fetch all necessary caches from the running server
function fetchURL(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Parse error on ' + path + ': ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

async function diagnose() {
  try {
    console.log('Fetching live state and ticker cache from local server...');
    const tickersRes = await fetchURL('/api/market/all-tickers');
    const ohlcvRes = await fetchURL('/api/debug-ohlcv');
    const cacheRes = await fetchURL('/api/debug/cache');
    const settingsRes = await fetchURL('/api/settings');

    const ohlcvMap = ohlcvRes.sampleData || {}; // Wait, ohlcvRes returns `{ total, sample, sampleData }`
    // Let's get the keys in ohlcv cache
    console.log(`GLOBAL_TRUE_OHLCV contains ${ohlcvRes.total} tokens.`);
    
    // We should write a mini simulation of signal generation to understand what's filtered.
    // Let's get all 46 cached items by querying their indicators.
    // Wait, is there a route that returns all cached indicators?
    // Let's check: /api/market/indicator-summary returns all indicators.
    // Let's try to fetch /api/market/indicator-summary with sample tickers.
    console.log('\nSimulating signal filtering of actual cache...');
    
    // We can fetch details of individual coins.
    // Wait, let's load server.ts and inspect how symbols are processed!
  } catch (err) {
    console.error('Diagnostic error:', err);
  }
}

diagnose();

const http = require('http');

http.get('http://localhost:3000/api/debug-ohlcv', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log('Total keys in GLOBAL_TRUE_OHLCV:', parsed.total);
      console.log('Sample keys:', parsed.sample);
      console.log('Sample keys indicator data:', parsed.sampleData);
    } catch (e) {
      console.log('Parse error:', e);
    }
  });
});

const http = require('http');

http.get('http://localhost:3000/api/debug-ohlcv', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log('Total keys in GLOBAL_TRUE_OHLCV:', parsed.total);
      
      // Fetch all keys from the api by accessing /api/debug-ohlcv properties
      http.get('http://localhost:3000/api/debug-ohlcv', (res2) => {
        let data2 = '';
        res2.on('data', chunk => data2 += chunk);
        res2.on('end', () => {
          const parsed2 = JSON.parse(data2);
          // Let's get the keys in parsed2
          const list = Object.keys(parsed2);
          console.log('Keys on response:', list);
          if (parsed2.sample) {
             console.log('All 46 keys:', parsed2.sample);
          }
        });
      });
      
      const targetSymbols = ['ATUSDT', 'AXLUSDT', 'ASTSUSDT', 'BANANAS31USDT'];
      console.log('\nChecking for target pumping/dumping symbols:');
      for (const t of targetSymbols) {
        http.get(`http://localhost:3000/api/chart/weex/${t}`, (innerRes) => {
          let innerData = '';
          innerRes.on('data', c => innerData += c);
          innerRes.on('end', () => {
            try {
              const innerParsed = JSON.parse(innerData);
              console.log(`- ${t} cached info keys:`, Object.keys(innerParsed));
            } catch (innerE) {
              console.log(`- ${t} fetch error / not active`);
            }
          });
        });
      }
    } catch (e) {
      console.log('Parse error:', e);
    }
  });
});

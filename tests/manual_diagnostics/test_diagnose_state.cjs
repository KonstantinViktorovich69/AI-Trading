const http = require('http');

function fetchEndpoint(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    const res = await fetchEndpoint('http://localhost:3000/api/debug/diagnose-signals');
    if (res.diagnostics) {
       const list = res.diagnostics;
       const targets = ['SKYAIUSDT', 'TRUMPUSDT', 'GWEIUSDT'];
       for (const coin of list) {
         if (targets.includes(coin.symbol)) {
           console.log(`\n================= COIN: ${coin.symbol} =================`);
           console.log(JSON.stringify(coin, null, 2));
         }
       }
    } else {
       console.log('No diagnostics key', res);
    }
  } catch (err) {
    console.error('Error fetching data:', err.message);
  }
}

main();

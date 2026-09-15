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
    if (res.diagnostics && res.diagnostics.length > 0) {
      const matched = res.diagnostics.filter(d => d.matchedPattern !== 'None');
      console.log(`Matched Coins Indicators details (${matched.length} coins):`);
      matched.forEach(d => {
        console.log(`\n=== Coin: ${d.symbol} ===`);
        console.log(`Price: ${d.price}`);
        console.log(`Change 24h: ${d.change24h}%`);
        console.log(`Volatility: ${d.volatility}%`);
        console.log(`Matched Pattern: ${d.matchedPattern}`);
        console.log(`Indicators:`, JSON.stringify(d.indicators, null, 2));
        console.log(`Filters status:`, JSON.stringify(d.filters, null, 2));
        console.log(`Summary: ${d.summary}`);
      });
    } else {
      console.log("Diagnostics empty.");
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();

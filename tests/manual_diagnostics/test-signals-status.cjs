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
    console.log("Fetching diagnose-signals endpoint...");
    const res = await fetchEndpoint('http://localhost:3000/api/debug/diagnose-signals');
    console.log("SUCCESS!");
    console.log("Timestamp:", res.timestamp);
    console.log("Total Coins Calculated:", res.totalCoinsCalculated);
    
    if (res.diagnostics && res.diagnostics.length > 0) {
      console.log("\nSample Coins (first 10):");
      res.diagnostics.slice(0, 10).forEach(d => {
        console.log(`- ${d.symbol}: Price=${d.price}, Change24h=${d.change24h}%, Volatility=${d.volatility}%, MatchedPattern=${d.matchedPattern}, Summary: ${d.summary}`);
      });
      
      const matched = res.diagnostics.filter(d => d.matchedPattern !== 'None');
      console.log(`\nMatched Patterns Count: ${matched.length} / ${res.diagnostics.length}`);
      if (matched.length > 0) {
        console.log("Matched Coins detail:");
        matched.forEach(d => {
          console.log(`  * ${d.symbol} -> ${d.matchedPattern}. Summary: ${d.summary}`);
        });
      }
    } else {
      console.log("Diagnostics array is empty.");
    }
    
    console.log("\nFetching debug-ohlcv endpoint...");
    const ohlcvRes = await fetchEndpoint('http://localhost:3000/api/debug-ohlcv');
    console.log("Total Coins in GLOBAL_TRUE_OHLCV:", ohlcvRes.total);
    console.log("Sample keys:", ohlcvRes.sample);
    console.log("Sample Data format (first coin):", JSON.stringify(ohlcvRes.sampleData, null, 2));

    console.log("\nFetching active signals from /api/signals...");
    const signalsRes = await fetchEndpoint('http://localhost:3000/api/signals');
    console.log("Total Active Signals:", signalsRes.data?.length || 0);
    if (signalsRes.data && signalsRes.data.length > 0) {
      signalsRes.data.forEach((s, idx) => {
        console.log(`[${idx + 1}] Symbol: ${s.symbol}, Signal: ${s.signal}, Score: ${s.aiScore}, Pattern: ${s.type}`);
      });
    } else {
      console.log("No active signals in cache.");
    }


  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();

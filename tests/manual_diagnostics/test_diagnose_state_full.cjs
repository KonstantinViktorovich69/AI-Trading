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
    console.log('Diagnostic keys:', Object.keys(res));
    if (res.diagnostics && Array.isArray(res.diagnostics)) {
       console.log(`Total diagnostics items: ${res.diagnostics.length}`);
       
       const sample = res.diagnostics.slice(0, 3);
       console.log('Sample diagnostics items:', JSON.stringify(sample, null, 2));
       
       // Calculate stats
       let withSignals = res.diagnostics.filter(d => d.signal && d.signal !== 'NEUTRAL');
       console.log(`With non-neutral signals: ${withSignals.length}`);
       
       let buySignals = withSignals.filter(d => d.signal.includes('BUY') || d.signal.includes('LONG'));
       let sellSignals = withSignals.filter(d => d.signal.includes('SELL') || d.signal.includes('SHORT'));
       
       console.log(`Buy/Long Signals: ${buySignals.length}`);
       console.log(`Sell/Short Signals: ${sellSignals.length}`);
       
       if (buySignals.length > 0) {
         console.log('Sample Buy/Long Signals:', JSON.stringify(buySignals.slice(0, 5), null, 2));
       }
    } else {
       console.log('Response format is different:', res);
    }
  } catch (err) {
    console.error('Error fetching data:', err.message);
  }
}

main();

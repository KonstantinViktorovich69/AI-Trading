const http = require('http');

http.get('http://localhost:3000/api/debug/diagnose-signals', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (!parsed.success) {
        console.log('Server rejected diagnostics request:', parsed.error);
        return;
      }
      console.log(`\n=================== DIAGNOSTICS RESULTS ===================`);
      console.log(`Timestamp: ${parsed.timestamp}`);
      console.log(`Total Coins in Cache: ${parsed.totalCoinsCalculated}`);
      
      const coinsWithPatterns = parsed.diagnostics.filter(d => d.matchedPattern && d.matchedPattern !== 'None');
      console.log(`Coins matching a technical pump/dump pattern: ${coinsWithPatterns.length}`);
      
      if (coinsWithPatterns.length > 0) {
        console.log('\nDetailed patterns vs locks:');
        for (const coin of coinsWithPatterns) {
          console.log(`- Coin: # ${coin.symbol} (current price: $${coin.price}, 24h change: ${coin.change24h.toFixed(1)}%)`);
          console.log(`  Pattern: ${coin.matchedPattern}`);
          console.log(`  Active locks:`, JSON.stringify(coin.filters));
          console.log(`  Summary: ${coin.summary}`);
        }
      } else {
        console.log('\nNo hot tokens have fully matched our trading patterns yet on this scan.');
        console.log('Sample inactive coins state:');
        parsed.diagnostics.slice(0, 5).forEach(coin => {
          console.log(`- ${coin.symbol} (change: ${coin.change24h.toFixed(1)}%): ${coin.summary}`);
        });
      }
    } catch (e) {
      console.log('Error parsing JSON response:', e.message);
    }
  });
}).on('error', (err) => console.log('HTTP request error:', err.message));

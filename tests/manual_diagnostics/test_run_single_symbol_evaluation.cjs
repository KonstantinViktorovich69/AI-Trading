const http = require('http');

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

async function run() {
  try {
    console.log('Fetching tickers from running server...');
    const tickersRes = await fetchURL('/api/market/all-tickers');
    const stateRes = await fetchURL('/api/debug/state');
    
    // Let's find WEEX tickers
    // Wait, all-tickers returns standard exchange list
    // Let's find some volatile tickers on WEEX
    console.log('State response exchanges:', stateRes.exchanges);
    const weexTickers = tickersRes.success ? (tickersRes.exchanges?.weex || tickersRes) : {};
    
    // Let's analyze AT/USDT:USDT or AXL/USDT:USDT
    const candidateSymbols = ['AT/USDT:USDT', 'AXL/USDT:USDT', 'SOL/USDT:USDT'];
    
    for (const sym of candidateSymbols) {
      console.log(`\n=================== ANALYZING ${sym} ===================`);
      // Get the cleaner symbol name
      const cleanSymbol = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
      console.log(`Clean symbol: ${cleanSymbol}`);
      
      // Let's query their chart indicator data
      try {
        const indicators = await fetchURL(`/api/chart/weex/${cleanSymbol}`);
        if (!indicators || !indicators.success) {
          console.log(`No indicators calculated for ${cleanSymbol}`);
          continue;
        }
        
        const data = indicators.data || {};
        console.log(`Indicators fetched successfully! keys:`, Object.keys(data));
        console.log(`- Price: ${data.price}`);
        console.log(`- rsi1h: ${data.rsi1h}`);
        console.log(`- psarStatus: ${data.psarStatus}`);
        console.log(`- psarStatus1m: ${data.psarStatus1m}`);
        console.log(`- isLiquiditySweep: ${data.isLiquiditySweep}`);
        console.log(`- hasFvgAbove: ${data.hasFvgAbove}`);
        console.log(`- hasBullishFvgBelow: ${data.hasBullishFvgBelow}`);
        console.log(`- wicks:`, JSON.stringify(data.wicks));
        
        // Let's check why signal might not be SELL/STRONG_SELL
        const isQuickLocalSpike = false; // assumed
        const change = data.change24h || 0;
        console.log(`- change24h: ${change}%`);
        
        const isSarBearishFlipped1m = data.isSarBearishFlipped1m || false;
        console.log(`- isSarBearishFlipped1m: ${isSarBearishFlipped1m}`);
        
        // Check patterns:
        const pattern1 = (change >= 7) && isSarBearishFlipped1m;
        console.log(`- Pattern 1 (change >= 7 && isSarBearishFlipped1m) match: ${pattern1}`);
        
        const pattern2 = data.wicks && data.wicks.topPct > 0.55 && change > 3 && data.psarStatus1m === 'BEARISH';
        console.log(`- Pattern 2 (topWick > 0.55 && change > 3 && PSAR1m BEARISH) match: ${pattern2}`);
        
        const pattern3 = change >= 8 && isSarBearishFlipped1m && data.wicks && data.wicks.topPct > 0.4;
        console.log(`- Pattern 3 (change >= 8 && isSarBearishFlipped1m && topWick > 0.4) match: ${pattern3}`);
      } catch (innerErr) {
        console.log(`Failed to fetch indicators for ${cleanSymbol}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('Core error:', err);
  }
}

run();

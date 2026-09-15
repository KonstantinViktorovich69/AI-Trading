async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/debug/diagnose-signals');
    const diagnostics = await res.json();
    const list = diagnostics.diagnostics || [];
    
    console.log('Total Diagnostics Checked:', list.length);
    const withPatterns = list.filter((d: any) => d.matchedPattern && d.matchedPattern !== 'None');
    console.log('Matched Patterns count:', withPatterns.length);
    
    for (const d of withPatterns) {
      console.log(`\nSymbol: ${d.symbol} | Pattern: ${d.matchedPattern}`);
      console.log(`Price: ${d.price} | Change: ${d.change24h}% | Volatility: ${d.volatility}%`);
      console.log(`Indicators:`, JSON.stringify(d.indicators, null, 2));
      console.log(`Locks/Filters:`, JSON.stringify(d.filters, null, 2));
    }
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

main();

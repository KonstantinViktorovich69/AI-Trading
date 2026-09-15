async function main() {
  const url = 'http://localhost:3000/api/debug/cache';
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(url);
      const cache = await res.json();
      console.log(`Poll ${i}: History=${cache.historyCount}, Indicators=${cache.indicatorsCount}, Signals=${cache.signalsCount}, Non-Neutral=${cache.nonNeutral}`);
      if (cache.signalsCount > 0 || cache.nonNeutral > 0) {
        console.log('SIGNAL DETECTED! CACHE STATE:', JSON.stringify(cache, null, 2));
        
        // Fetch active signals
        const sigRes = await fetch('http://localhost:3000/api/signals');
        const sigs = await sigRes.json();
        console.log('Active Non-Neutral Signals:', sigs.data.filter((s: any) => s.signal !== 'NEUTRAL').slice(0, 5));
        return;
      }
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main();

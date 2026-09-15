async function main() {
  try {
    console.log('Manually running signals cache update...');
    const startTime = Date.now();
    const res = await fetch('http://localhost:3000/api/debug/run-signals');
    const data = await res.json();
    console.log(`Finished in ${Date.now() - startTime}ms`);
    console.log('Response status:', data.success);
    console.log('Signals generated count:', data.signalsCount);
    
    // Now fetch /api/signals to see the generated signals!
    const resS = await fetch('http://localhost:3000/api/signals');
    const sigs = await resS.json();
    const signals = sigs.data || [];
    console.log('Total signals in cache:', signals.length);
    const longSignals = signals.filter(s => s.signal.includes('BUY'));
    const shortSignals = signals.filter(s => s.signal.includes('SELL'));
    console.log('Long signals count:', longSignals.length);
    console.log('Short signals count:', shortSignals.length);
    if (longSignals.length > 0) {
      console.log('Sample Long signals:', longSignals.slice(0, 3).map(s => ({ symbol: s.symbol, signal: s.signal, type: s.patternType || s.type, score: s.aiScore })));
    }
    if (shortSignals.length > 0) {
      console.log('Sample Short signals:', shortSignals.slice(0, 3).map(s => ({ symbol: s.symbol, signal: s.signal, type: s.patternType || s.type, score: s.aiScore })));
    }
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

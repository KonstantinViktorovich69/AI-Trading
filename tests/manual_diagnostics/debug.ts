async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/debug/state');
    const state = await res.json();
    console.log('DEBUG STATE:', JSON.stringify(state, null, 2));
    
    // We can also check if we can query an endpoint that returns tickers or look at the database.
    // Let's print some tickers keys if possible, or fetch /api/signals
    const signalsRes = await fetch('http://localhost:3000/api/signals');
    const signals = await signalsRes.json();
    console.log('SIGNALS:', JSON.stringify(signals, null, 2));
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

main();

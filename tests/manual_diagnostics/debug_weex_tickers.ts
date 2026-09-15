async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/market/all-tickers');
    const tickersObj = await res.json();
    const weex = tickersObj.exchanges?.weex || [];
    console.log('WEEX tickers count:', weex.length);
    console.log('Sample tickers:', weex.slice(0, 5));
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

main();

async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/market/all-tickers');
    const tickersObj = await res.json();
    console.log('Exchanges available:', Object.keys(tickersObj.exchanges || {}));
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

main();

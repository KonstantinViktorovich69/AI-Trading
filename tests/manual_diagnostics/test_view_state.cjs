async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/debug/state');
    const state = await res.json();
    console.log('State keys:', Object.keys(state));
    console.log('Exchanges:', state.exchanges);
    console.log('WEEX tickers count:', state.weexTickersCount);
    console.log('Indicators count:', state.indicatorsCount);
    console.log('History data count:', state.historyDataCount);
    console.log('Ticker samples:', state.tickerSamples);
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

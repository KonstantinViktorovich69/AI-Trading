import ccxt from 'ccxt';

async function main() {
  try {
    const exchange = new ccxt.weex();
    console.log('Initiating WEEX fetchTickers...');
    const tickers = await exchange.fetchTickers();
    const keys = Object.keys(tickers);
    console.log('Successfully fetched WEEX tickers!');
    console.log('Total tickers:', keys.length);
    console.log('Sample symbols:', keys.slice(0, 10));
  } catch (err: any) {
    console.error('FAILED fetching WEEX tickers:', err.message || err);
  }
}

main();

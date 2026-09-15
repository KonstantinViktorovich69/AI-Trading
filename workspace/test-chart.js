const ccxt = require('ccxt');

(async () => {
    const ex = new ccxt.mexc();
    ex.options['defaultType'] = 'swap';
    try {
        await ex.loadMarkets();
        const ohlcv = await ex.fetchOHLCV('BTC/USDT:USDT', '15m', undefined, 2);
        console.log('BTC/USDT:USDT success');
    } catch(e) {
        console.error("BTC/USDT:USDT Error:", e.message);
    }
    
    try {
        const ohlcv = await ex.fetchOHLCV('BTC/USDT', '15m', undefined, 2);
        console.log('BTC/USDT success');
    } catch(e) {
        console.error("BTC/USDT Error:", e.message);
    }
})();

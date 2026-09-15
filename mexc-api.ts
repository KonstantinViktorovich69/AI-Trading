import https from 'https';

export async function fetchMexcTickers(): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    https.get('https://contract.mexc.com/api/v1/contract/ticker', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && json.success && json.data) {
             const result: Record<string, any> = {};
             json.data.forEach((t: any) => {
                const symbol = t.symbol.replace('_', '/') + ':USDT';
                result[symbol] = {
                   symbol: symbol,
                   last: t.lastPrice,
                   bid: t.bid1,
                   ask: t.ask1,
                   baseVolume: t.volume24,
                   quoteVolume: t.amount24,
                   percentage: t.riseFallRate * 100, // riseFallRate is probably decimal? Let's check
                   change: t.riseFallRate * 100,
                   high: t.highPrice,
                   low: t.lowPrice,
                };
             });
             resolve(result);
          } else {
             reject(new Error("MEXC API error"));
          }
        } catch(e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

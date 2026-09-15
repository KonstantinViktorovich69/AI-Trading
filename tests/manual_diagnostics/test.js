import fetch from 'node-fetch';

async function test() {
  const rs = await fetch('http://localhost:3000/api/paper-trade/ai-analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: "BTC/USDT",
      exchange: "binance",
      price: 60000,
      change24h: 1,
      volatility: 1,
      volume: 1000,
      rsi: 50,
      macd: 0,
      bbStatus: "NORMAL"
    })
  });
  console.log(await rs.text());
}
test();

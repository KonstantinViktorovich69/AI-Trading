async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/telemetry');
    const tele = await res.json();
    console.log('Telemetry keys:', Object.keys(tele));
    console.log('weexTickersCount:', tele.weexTickersCount);
    console.log('ohlcvCount:', tele.ohlcvCount);
    console.log('indicatorsCount:', tele.indicatorsCount);
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

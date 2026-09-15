async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/debug-ohlcv');
    const data = await res.json();
    console.log('debug-ohlcv fields:', Object.keys(data));
    console.log('Sample symbols:', data.sample);
    console.log('Total:', data.total);
    console.log('All ohlcv symbols in debug-ohlcv:', data.sample || []);
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

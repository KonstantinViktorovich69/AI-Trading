async function main() {
  try {
    console.log('Manually invoking run-ohlcv...');
    const startTime = Date.now();
    const res = await fetch('http://localhost:3000/api/debug/run-ohlcv');
    const data = await res.json();
    console.log(`Finished in ${Date.now() - startTime}ms`);
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

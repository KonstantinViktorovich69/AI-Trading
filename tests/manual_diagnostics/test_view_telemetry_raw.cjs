async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/telemetry');
    const tele = await res.json();
    console.log('Telemetry response:', JSON.stringify(tele, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

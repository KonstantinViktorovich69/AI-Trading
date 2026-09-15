async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/debug/state');
    const state = await res.json();
    console.log('State fields:', JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}
main();

import fetch from 'node-fetch';
async function test() {
  try {
    const ping = await fetch('http://localhost:3000/api/debug-env');
    console.log(await ping.text());
  } catch(e) {
    console.error(e);
  }
}
test();

import fetch from 'node-fetch';
async function test() {
  const rs = await fetch('http://localhost:3000/api/debug-env');
  console.log(await rs.text());
}
test();

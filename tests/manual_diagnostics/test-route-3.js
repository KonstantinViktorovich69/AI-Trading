import fetch from 'node-fetch';
async function test() {
  try {
    const res = await fetch('http://localhost:3000/api/ai-analyze-signal', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal: "test" })
    });
    console.log(res.status);
    console.log(await res.text());
  } catch(e) {
    console.log("Error:", e);
  }
}
test();

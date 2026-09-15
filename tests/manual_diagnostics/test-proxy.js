import 'dotenv/config';
import fetch from 'node-fetch';
async function test() {
  try {
    const res = await fetch('http://localhost:8000/v1beta/models/gemini-1.5-flash:generateContent', {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer MY_GEMINI_API_KEY" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] })
    });
    console.log(res.status);
    console.log(await res.text());
  } catch(e) {
    console.log("Error:", e);
  }
}
test();

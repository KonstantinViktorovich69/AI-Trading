import 'dotenv/config';
import fetch from 'node-fetch';
async function test() {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] })
    });
    console.log(res.status);
    console.log(await res.text());
  } catch(e) {
    console.log("Error:", e);
  }
}
test();

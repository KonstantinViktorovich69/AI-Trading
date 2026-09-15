import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function testModel(m) {
  try {
    const res = await ai.models.generateContent({
      model: m,
      contents: "Hello"
    });
    console.log(`Model ${m} YES:`, res.text);
  } catch(e) {
    console.log(`Model ${m} NO:`, e.status, e.message);
  }
}
async function run() {
  await testModel('gemini-2.0-flash-lite');
  await testModel('gemini-2.0-flash-lite-001');
  await testModel('gemini-3-flash-preview');
  await testModel('gemini-3.1-flash-lite-preview');
}
run();

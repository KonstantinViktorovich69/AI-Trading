import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  try {
     const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GEMINI_API_KEY);
     const data = await response.json();
     console.log(data.models?.map(m => m.name).filter(m => m.includes('flash')).join('\n'));
  } catch(e) {
     console.error(e);
  }
}
run();

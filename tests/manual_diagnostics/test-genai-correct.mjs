import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
ai.models.generateContent({
  model: 'gemini-1.5-flash',
  contents: 'Hello'
}).then(res => console.log("SUCCESS:", res.text))
  .catch(err => console.error("Error:", err));

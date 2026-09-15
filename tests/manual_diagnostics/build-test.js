import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({});
ai.models.generateContent({
  model: 'gemini-1.5-flash',
  contents: 'Hello'
}).then(res => console.log(res.text))
  .catch(err => console.error("Error:", err));

import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({});
try {
  await ai.models.generateContent({ model: "gemini-1.5-flash", contents: "Hello" });
} catch(e) {
  console.log(e.message);
}

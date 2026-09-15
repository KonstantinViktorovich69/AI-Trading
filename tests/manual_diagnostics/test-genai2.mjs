import { GoogleGenAI } from "@google/genai";
try {
  const ai = new GoogleGenAI({ apiKey: "" });
  ai.models.generateContent({ model: "gemini-1.5-flash", contents: "Hello" }).then(res => console.log(res.text)).catch(e => console.error(e.message));
} catch(e) {
  console.error(e);
}

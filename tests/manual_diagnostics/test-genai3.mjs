import { GoogleGenAI } from "@google/genai";
try {
  const ai = new GoogleGenAI({ apiKey: "1234invalidkey" });
  ai.models.generateContent({ model: "gemini-1.5-flash", contents: "Hello" }).then(res => console.log(JSON.stringify(res.text))).catch(e => console.error(JSON.stringify(e)));
} catch(e) {
  console.error(e);
}

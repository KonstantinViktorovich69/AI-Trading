import { GoogleGenAI } from "@google/genai";
try {
  let opts = {};
  const ai = new GoogleGenAI(opts);
  ai.models.generateContent({ model: "gemini-1.5-flash", contents: "Hello" }).then(res => console.log(JSON.stringify(res.text))).catch(e => console.error(JSON.stringify(e)));
} catch(e) {
  console.error(e.message);
}

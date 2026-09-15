import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({});
async function testModel(name) {
  try {
    await ai.models.generateContent({ model: name, contents: [{role: 'user', parts: [{text: 'hi'}]}]});
    console.log(name, 'WORKS');
  } catch(e) {
    console.log(name, 'ERROR:', e.message);
  }
}
await testModel('gemini-2.0-flash');
await testModel('gemini-3.1-flash');
await testModel('gemini-3.1-flash-lite-preview');
await testModel('gemini-3-flash-preview');
await testModel('gemini-1.5-flash');

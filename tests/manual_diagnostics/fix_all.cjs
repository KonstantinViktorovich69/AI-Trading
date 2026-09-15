const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// 1. Fix /api/settings/ai-auditor (remove the duplicated messed up lines)
const audStart = content.indexOf("app.post('/api/settings/ai-auditor'");
const audEnd = content.indexOf("// Защита от prompt injection: ИИ через этот чат-канал не может менять критичные/секретные поля,", audStart);

if (audStart !== -1 && audEnd !== -1) {
  const correctAuditor = `app.post('/api/settings/ai-auditor', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: "Сообщение отсутствует." });
  }

  try {
    const currentSettingsString = JSON.stringify(globalSettings, null, 2);
    
    const systemPrompt = getSettingsOptimizerPrompt(currentSettingsString, message);

    const response = await runAiGeneration({
      contents: [
        { role: 'system', parts: [{ text: systemPrompt }] },
        { role: 'user', parts: [{ text: \`Обработай команду: "\${message}" и выведи СТРОГО JSON с обязательным непустым полем "explanation".\` }] }
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.3
      }
    });

    let resultJson: any = { explanation: "", updatedSettings: {} };
    try {
      if (response && response.text) {
        const rawText = response.text.trim();
        console.log(\`[AI-AUDITOR] Output from model:\\n\${rawText}\\n---\`);
        
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const jsonMatch = rawText.match(/\\{[\\s\\S]*\\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0].trim());
            } catch (err: any) {
              console.error(\`[AI-AUDITOR] Regex matched JSON parse failed:\`, err);
            }
          }
        }

        if (parsed && typeof parsed === 'object') {
          // Extract explanation from various possible keys
          const explanationCandidate = parsed.explanation || parsed.Explanation || parsed.message || parsed.comment || parsed.analysis || parsed.explanation_ru || parsed.briefing;
          if (explanationCandidate && typeof explanationCandidate === 'string' && explanationCandidate.trim().length > 0) {
            resultJson.explanation = explanationCandidate.trim();
          }
          
          if (parsed.updatedSettings && typeof parsed.updatedSettings === 'object') {
            resultJson.updatedSettings = parsed.updatedSettings;
          } else {
            // Check if settings are specified directly flat in the parsed JSON
            const flatSettings: any = {};
            const knownSettingsKeys = [
              'btcShockThreshold', 'aiMinConfidenceThreshold', 'isVolatilityBrakeEnabled',
              'maxVolatilityLimit', 'fundingShieldLimit', 'dcaMultiplierFactor',
              'autopilotAggressiveness', 'isAiExpertTraderEnabled', 'isAiPartialCloseRealEnabled',
              'tradingMode', 'aiExpertTraderInstructions'
            ];
            for (const key of knownSettingsKeys) {
              if (parsed[key] !== undefined) {
                flatSettings[key] = parsed[key];
              }
            }
            if (Object.keys(flatSettings).length > 0) {
              resultJson.updatedSettings = flatSettings;
            }
          }
        }

        // Extremely safe fallback: if parsed structure missed description or failed, set the explanation to the cleaned raw text!
        if (!resultJson.explanation || resultJson.explanation.trim() === "") {
          let cleanStr = rawText;
          if (cleanStr.startsWith('\`\`\`json')) {
            cleanStr = cleanStr.substring(7);
          } else if (cleanStr.startsWith('\`\`\`')) {
            cleanStr = cleanStr.substring(3);
          }
          if (cleanStr.endsWith('\`\`\`')) {
            cleanStr = cleanStr.substring(0, cleanStr.length - 3);
          }
          cleanStr = cleanStr.trim();
          
          // Verify if it is still some JSON-like string, if so try to extract strings inside
          if (cleanStr.startsWith('{') && cleanStr.includes('"explanation"')) {
            // Fallback parsing failed to set it, we will just use cleanStr
            resultJson.explanation = "ИИ-Ревизор подготовил отчет, но формат ответа содержал технические ошибки. Ответ:\\n" + cleanStr;
          } else {
            resultJson.explanation = cleanStr;
          }
        }
      } else {
        resultJson.explanation = "ИИ-Ревизор временно недоступен (модель вернула пустой ответ).";
      }
    } catch (parserError: any) {
      console.error(\`[AI-AUDITOR] Parser block crashed:\`, parserError);
      resultJson = { explanation: response?.text || "Извините, не удалось распознать ответ от ИИ-Ревизора.", updatedSettings: {} };
    }

    `;
  content = content.substring(0, audStart) + correctAuditor + content.substring(audEnd);
  console.log("Auditor endpoint cleanly replaced!");
}

// 2. Fix the extra brace before "} else if (isBuySignal) {"
const badSocialShieldEnd = `                if (aggressiveness !== 'aggressive' && (socialSentimentData.score >= 80 || socialSentimentData.trend === 'PUMP_HYPE') && !isExtremeOverbought) {
                    console.log(\`[PASSIVE RISK LOCK] Short signal for \${cleanSymbol} bypassed by SOCIAL SENTIMENT SHIELD: extreme Twitter/Telegram hype detected (Score: \${socialSentimentData.score}, Trend: \${socialSentimentData.trend})\`);
                    continue;
                }
                }
            } else if (isBuySignal) {`;

const goodSocialShieldEnd = `                if (aggressiveness !== 'aggressive' && (socialSentimentData.score >= 80 || socialSentimentData.trend === 'PUMP_HYPE') && !isExtremeOverbought) {
                    console.log(\`[PASSIVE RISK LOCK] Short signal for \${cleanSymbol} bypassed by SOCIAL SENTIMENT SHIELD: extreme Twitter/Telegram hype detected (Score: \${socialSentimentData.score}, Trend: \${socialSentimentData.trend})\`);
                    continue;
                }
            } else if (isBuySignal) {`;

if (content.includes(badSocialShieldEnd)) {
  content = content.replace(badSocialShieldEnd, goodSocialShieldEnd);
  console.log("Social shield extra brace fixed!");
}

// 3. Fix the extra closing brace in updateSignalsCache
const badScannerEnd = `       console.log(\`[SCANNER LOG] Exchange \${exName}: tested \${testedCount} USDT pairs, collected \${signalsData.length} signals.\`);
       }
     }
     
     CACHE.signals = {`;

const goodScannerEnd = `       console.log(\`[SCANNER LOG] Exchange \${exName}: tested \${testedCount} USDT pairs, collected \${signalsData.length} signals.\`);
     }
     
     CACHE.signals = {`;

if (content.includes(badScannerEnd)) {
  content = content.replace(badScannerEnd, goodScannerEnd);
  console.log("Scanner end extra brace fixed!");
}

fs.writeFileSync('server.ts', content, 'utf8');
console.log("server.ts written successfully!");

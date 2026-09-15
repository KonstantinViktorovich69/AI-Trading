/**
 * Robust JSON extraction and repair utilities for AI responses and malformed payloads.
 */

export function cleanAndExtractJson(text: string): string {
  if (!text) return "";
  let cleaned = text.trim();

  // 1. If it has markdown code fences, extract the content inside the first code fence.
  const fenceStartMatch = cleaned.match(/```(?:json)?\s*/i);
  if (fenceStartMatch && fenceStartMatch.index !== undefined) {
    const startIdx = fenceStartMatch.index + fenceStartMatch[0].length;
    const nextFence = cleaned.indexOf('```', startIdx);
    if (nextFence !== -1) {
      cleaned = cleaned.slice(startIdx, nextFence).trim();
    } else {
      cleaned = cleaned.slice(startIdx).trim();
    }
  }

  // 2. Find the first '{' or '[' to scan forward
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  
  if (firstBrace === -1 && firstBracket === -1) {
    return cleaned;
  }
  
  let startIdx = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
  } else {
    startIdx = firstBracket;
  }
  
  let depth = 0;
  let inString: string | null = null; // Track single or double quotes
  let escape = false;
  let endIdx = -1;
  
  for (let i = startIdx; i < cleaned.length; i++) {
    const char = cleaned[i];
    
    if (escape) {
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      escape = true;
      continue;
    }
    
    if (char === '"' || char === "'") {
      if (inString === char) {
        inString = null;
      } else if (inString === null) {
        inString = char;
      }
      continue;
    }
    
    if (!inString) {
      if (char === '{' || char === '[') {
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }
  
  if (endIdx !== -1) {
    return cleaned.slice(startIdx, endIdx + 1);
  }
  
  return cleaned.slice(startIdx).trim();
}

export function healJsonQuotesAndNewlines(str: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let expectingValue = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (escape) {
      result += char;
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      result += char;
      escape = true;
      continue;
    }
    
    if (char === '"') {
      if (!inString) {
        inString = true;
        result += char;
      } else {
        let isClosing = false;
        let j = i + 1;
        while (j < str.length) {
          const nextChar = str[j];
          if (nextChar === ' ' || nextChar === '\t' || nextChar === '\n' || nextChar === '\r') {
            j++;
            continue;
          }
          if (expectingValue) {
            if (nextChar === ',' || nextChar === '}' || nextChar === ']' || (nextChar === '/' && str[j+1] === '/')) {
              isClosing = true;
            }
          } else {
            if (nextChar === ':') {
              isClosing = true;
            }
          }
          break;
        }
        if (j >= str.length) {
          isClosing = true;
        }
        
        if (isClosing) {
          inString = false;
          result += char;
        } else {
          result += '\\"';
        }
      }
      continue;
    }
    
    if (!inString) {
      if (char === ':' || char === '=') {
        expectingValue = true;
      } else if (char === ',' || char === '{' || char === '[') {
        expectingValue = false;
      }
    }
    
    if (inString && char === '\n') {
      result += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      result += '\\r';
      continue;
    }
    
    result += char;
  }
  
  return result;
}

export function repairJsonText(str: string, defaultFallback?: any): string {
  if (!str) return "";
  let cleaned = cleanAndExtractJson(str);

  // 1. Remove inline comments and block comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.split('\n').map(line => {
    const idx = line.indexOf('//');
    if (idx !== -1) {
      const before = line.slice(0, idx);
      const openQuotes = (before.match(/"/g) || []).length;
      if (openQuotes % 2 === 0 && !before.endsWith('http:') && !before.endsWith('https:')) {
        return before;
      }
    }
    return line;
  }).join('\n').trim();

  // 2. Convert single-quoted strings to double-quoted strings safely
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escape = false;
  let singleQuoteConverted = '';
  
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    
    if (escape) {
      singleQuoteConverted += char;
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      singleQuoteConverted += char;
      escape = true;
      continue;
    }
    
    if (char === '"') {
      if (!inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      }
      singleQuoteConverted += char;
      continue;
    }
    
    if (char === "'") {
      if (!inDoubleQuote) {
        if (!inSingleQuote) {
          inSingleQuote = true;
          singleQuoteConverted += '"';
        } else {
          inSingleQuote = false;
          singleQuoteConverted += '"';
        }
      } else {
        singleQuoteConverted += char;
      }
      continue;
    }
    
    if (char === '"' && inSingleQuote) {
      singleQuoteConverted += '\\"';
      continue;
    }
    
    singleQuoteConverted += char;
  }
  cleaned = singleQuoteConverted;

  // 3. Fix unquoted keys (e.g. { name: "Value" } -> { "name": "Value" })
  cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_\-]*)\s*:/g, '$1"$2":');

  // 4. Heal unescaped double quotes and real newlines inside string values
  cleaned = healJsonQuotesAndNewlines(cleaned);

  // 5. Escape single backslashes that are not part of valid escape sequences
  let backslashHealed = '';
  inDoubleQuote = false;
  escape = false;
  
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    
    if (inDoubleQuote) {
      if (char === '\\') {
        if (i + 1 < cleaned.length) {
          const nextChar = cleaned[i + 1];
          const isValidEscape = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(nextChar) || 
                                (nextChar === 'u' && /^[0-9a-fA-F]{4}$/.test(cleaned.slice(i + 2, i + 6)));
          if (isValidEscape) {
            backslashHealed += '\\';
            backslashHealed += nextChar;
            i++;
          } else {
            backslashHealed += '\\\\';
          }
        } else {
          backslashHealed += '\\\\';
        }
        continue;
      }
      if (char === '"') {
        inDoubleQuote = false;
        backslashHealed += char;
        continue;
      }
      backslashHealed += char;
    } else {
      if (char === '"') {
        inDoubleQuote = true;
      }
      backslashHealed += char;
    }
  }
  cleaned = backslashHealed;

  // 6. Fix trailing commas
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  // 7. Fix missing commas between properties on adjacent lines
  cleaned = cleaned.replace(/(["\d\w\-\+\]}])\s*\n\s*(")/g, '$1,\n$2');

  // 8. Handle truncated JSON by tracking brackets and escaping control chars
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeChar = false;
  let reprocessed = '';

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escapeChar) {
      reprocessed += char;
      escapeChar = false;
      continue;
    }
    if (char === '\\') {
      reprocessed += char;
      escapeChar = true;
      continue;
    }
    if (char === '"') {
      reprocessed += char;
      inString = !inString;
      continue;
    }
    if (inString) {
      const code = char.charCodeAt(0);
      if (code < 32) {
        if (char === '\n') reprocessed += '\\n';
        else if (char === '\r') reprocessed += '\\r';
        else if (char === '\t') reprocessed += '\\t';
        else {
          reprocessed += '\\u' + code.toString(16).padStart(4, '0');
        }
      } else {
        reprocessed += char;
      }
    } else {
      reprocessed += char;
      if (char === '{') openBraces++;
      else if (char === '}') {
        if (openBraces > 0) openBraces--;
      } else if (char === '[') openBrackets++;
      else if (char === ']') {
        if (openBrackets > 0) openBrackets--;
      }
    }
  }

  if (inString) {
    reprocessed += '"';
  }
  cleaned = reprocessed;

  // Clean trailing comma right before closing if any
  cleaned = cleaned.trim().replace(/,\s*$/, '');

  // Close unclosed braces
  while (openBraces > 0) {
    cleaned += '}';
    openBraces--;
  }
  while (openBrackets > 0) {
    cleaned += ']';
    openBrackets--;
  }

  // Wrap with brackets if missing outer brackets
  const trimmed = cleaned.trim();
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    if (defaultFallback && Array.isArray(defaultFallback)) {
      cleaned = '[' + cleaned + ']';
    } else {
      cleaned = '{' + cleaned + '}';
    }
  }

  return cleaned;
}

export function safeJsonParse(text: string, defaultFallback: any) {
  if (!text || !text.trim()) return defaultFallback;
  
  const extracted = cleanAndExtractJson(text);
  if (!extracted) return defaultFallback;

  try {
    // Trial 1: Standard trim & Parse on extracted JSON block
    return JSON.parse(extracted);
  } catch (e1) {
    // Trial 2: Robust cleanup and repair on extracted block
    try {
      const repaired = repairJsonText(extracted, defaultFallback);
      return JSON.parse(repaired);
    } catch (e2) {
      // Trial 3: Fallback cleanup on original text
      try {
        const repairedOriginal = repairJsonText(text, defaultFallback);
        return JSON.parse(repairedOriginal);
      } catch (e3) {
        console.error("Safe JSON parse failed. Returning fallback.", e3);
        return defaultFallback;
      }
    }
  }
}

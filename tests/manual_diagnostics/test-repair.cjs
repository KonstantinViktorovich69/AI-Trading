const fs = require('fs');

function cleanAndExtractJson(text) {
  if (!text) return "";
  let cleaned = text.trim();

  // 1. If it has markdown code fences, let's extract the content inside the first code fence.
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
  let inString = null; // Track single or double quotes
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

function healJsonQuotesAndNewlines(str) {
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

function repairJsonText(str, defaultFallback) {
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

  // 3. Fix unquoted keys
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

  cleaned = cleaned.trim().replace(/,\s*$/, '');

  while (openBraces > 0) {
    cleaned += '}';
    openBraces--;
  }
  while (openBrackets > 0) {
    cleaned += ']';
    openBrackets--;
  }

  return cleaned;
}


// Test cases
const test1 = `{
  "aiAdvice": "Позиция LONG по APPUSDT находится в просадке на -3.01% (PnL -15.07%), что укладывается в рамки допустимого рыночного шума."
}`;

const test2 = `{
  "id": "1",
  "text": "Hello, this is a test: check it out"
}`;

console.log("Original test1 parses:", typeof JSON.parse(test1));
console.log("Repaired test1:", repairJsonText(test1));
try {
  JSON.parse(repairJsonText(test1));
  console.log("Repaired test1 parses: YES");
} catch(e) {
  console.log("Repaired test1 parses: NO", e);
}

console.log("\nOriginal test2 parses:", typeof JSON.parse(test2));
console.log("Repaired test2:", repairJsonText(test2));
try {
  JSON.parse(repairJsonText(test2));
  console.log("Repaired test2 parses: YES");
} catch(e) {
  console.log("Repaired test2 parses: NO", e);
}

const test3 = `{
  "id": "2",
  "text": "This is a prompt, result: ok"
}`;

console.log("\nOriginal test3 parses:", typeof JSON.parse(test3));
console.log("Repaired test3:", repairJsonText(test3));
try {
  JSON.parse(repairJsonText(test3));
  console.log("Repaired test3 parses: YES");
} catch(e) {
  console.log("Repaired test3 parses: NO", e);
}

const test4 = `{
  'id': '3',
  'text': 'It\\\'s a beautiful day, status: ok'
}`;

console.log("\nOriginal test4 is single-quoted JSON.");
console.log("Repaired test4:", repairJsonText(test4));
try {
  JSON.parse(repairJsonText(test4));
  console.log("Repaired test4 parses: YES");
} catch(e) {
  console.log("Repaired test4 parses: NO", e);
}

const test5 = `{
  "id": "4",
  "reason": "The system output was: {pattern: 'bullish', confidence: 0.9}"
}`;

console.log("\nOriginal test5 parses:", typeof JSON.parse(test5));
console.log("Repaired test5:", repairJsonText(test5));
try {
  JSON.parse(repairJsonText(test5));
  console.log("Repaired test5 parses: YES");
} catch(e) {
  console.log("Repaired test5 parses: NO", e);
}

const test6 = `{
  "id": "5",
  "explanation": "Линия 1\\nЛиния 2 с \\"кавычками\\"\\nЛиния 3"
}`;

const test6RawNewlines = `{
  "id": "5",
  "explanation": "Линия 1
Линия 2 с \\"кавычками\\"
Линия 3"
}`;

console.log("\nOriginal test6 (escaped) parses:", typeof JSON.parse(test6));
console.log("Repaired test6RawNewlines:", repairJsonText(test6RawNewlines));
try {
  JSON.parse(repairJsonText(test6RawNewlines));
  console.log("Repaired test6RawNewlines parses: YES");
} catch(e) {
  console.log("Repaired test6RawNewlines parses: NO", e);
}

const test7RawNewlinesUnescaped = `{
  "id": "5",
  "explanation": "Линия 1
Линия 2 с "кавычками"
Линия 3"
}`;

console.log("\nRepaired test7RawNewlinesUnescaped:", repairJsonText(test7RawNewlinesUnescaped));
try {
  JSON.parse(repairJsonText(test7RawNewlinesUnescaped));
  console.log("Repaired test7RawNewlinesUnescaped parses: YES");
} catch(e) {
  console.log("Repaired test7RawNewlinesUnescaped parses: NO", e);
}






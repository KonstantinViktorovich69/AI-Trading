import fs from 'fs';

const content = fs.readFileSync('src/components/TradingTerminal.tsx', 'utf8');
const lines = content.split('\n');

let stack = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  const matches = line.matchAll(/<(div(\s|>)|(\/div>))|(\()|(\))/g);
  for (const match of matches) {
      const text = match[0];
      if (text === '(') {
          stack.push({ type: 'paren', line: i+1 });
      } else if (text === ')') {
          if (stack.length > 0) {
              stack.pop();
          }
      } else if (text.startsWith('</')) {
          if (stack.length > 0) {
              stack.pop();
          }
      } else {
          stack.push({ type: 'div', line: i+1 });
      }
  }
  
  if (i >= 2200 && i <= 2235) {
      console.log(`L${i+1} | StackLen: ${stack.length} | Stack: ${stack.map(s => s.line).join(',')} | ${line.trim()}`);
  }
}

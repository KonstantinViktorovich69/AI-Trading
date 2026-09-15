const fs = require('fs');
const content = fs.readFileSync('src/components/TradingTerminal.tsx', 'utf8');
const opens = (content.match(/<div/g) || []).length;
const closes = (content.match(/<\/div>/g) || []).length;
console.log(`Opens: ${opens}, Closes: ${closes}`);

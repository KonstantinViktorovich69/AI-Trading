const fs = require('fs');
const content = fs.readFileSync('server.ts', 'utf8');
const lines = content.split('\n');
lines[214] = 'let userApiKeys: UserApiKey[] = [];'; // 215th line is at index 214
fs.writeFileSync('server.ts', lines.join('\n'));

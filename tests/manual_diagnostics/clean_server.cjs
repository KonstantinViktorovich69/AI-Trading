const fs = require('fs');
try {
  const content = fs.readFileSync('server.ts', 'utf8');
  const lines = content.split('\n');
  lines[214] = 'let userApiKeys: UserApiKey[] = [];'; 
  fs.writeFileSync('server.ts', lines.join('\n'));
  console.log('Successfully cleaned server.ts');
} catch (e) {
  console.error('Error cleaning server.ts:', e);
  process.exit(1);
}

const { execSync } = require('child_process');
console.log(execSync('git log -p -1 server.ts').toString());

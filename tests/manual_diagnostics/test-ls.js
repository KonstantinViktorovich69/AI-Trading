import fs from 'fs';
console.log(fs.readdirSync('.'));
if (fs.existsSync('.env')) {
  console.log(".env:", fs.readFileSync('.env', 'utf-8'));
}

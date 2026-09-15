const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(process.cwd(), 'database.json');
if (!fs.existsSync(DB_FILE)) {
  console.log('database.json does not exist!');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
console.log('== SETTINGS ==');
console.log(JSON.stringify(db.settings, null, 2));

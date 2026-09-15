import fs from 'fs';
import path from 'path';
fs.writeFileSync(path.resolve('./env_dump.json'), JSON.stringify(process.env, null, 2));

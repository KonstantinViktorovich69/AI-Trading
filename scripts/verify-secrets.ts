import fs from 'fs';
import path from 'path';

const SUSPECT_PATTERNS = [
  { category: 'API Key Pattern', pattern: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
  { category: 'Secret Key Pattern', pattern: /secret[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
  { category: 'Bearer Token Pattern', pattern: /bearer\s+[a-zA-Z0-9_\-\.]{30,}/i },
  { category: 'Database Connection String', pattern: /postgres:\/\/[^:]+:[^@]+@/i },
  { category: 'MongoDB Connection String', pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/i },
  { category: 'Private Key PEM Header', pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PRIVATE)\s+KEY-----/i }
];

const DENYLIST_FILENAMES = [
  'firebase-service-account.json',
  'env_dump.json',
  'my_env.json',
  'key_debug.txt',
  'id_rsa',
  'id_ed25519'
];

const DENYLIST_EXTENSIONS = ['.pem', '.p12', '.key'];
const EXCLUDED_DIRS = ['node_modules', 'dist', '.git', '.cache'];

function scanDirectoryForSecrets(dir: string): string[] {
  const violations: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return violations;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(entry.name)) {
        violations.push(...scanDirectoryForSecrets(fullPath));
      }
    } else if (entry.isFile()) {
      // 1. Check denylisted filenames (unless ending in .example)
      if (DENYLIST_FILENAMES.includes(lowerName) && !lowerName.endsWith('.example')) {
        violations.push(`Denylisted credential file detected: ${fullPath} [Category: Denylisted Filename]`);
        continue;
      }

      // 2. Check denylisted extensions
      const ext = path.extname(lowerName);
      if (DENYLIST_EXTENSIONS.includes(ext) && !lowerName.endsWith('.example')) {
        violations.push(`Forbidden certificate/key extension: ${fullPath} [Category: Key Extension]`);
        continue;
      }

      // 3. Scan file contents
      if (!lowerName.endsWith('.example')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const { category, pattern } of SUSPECT_PATTERNS) {
            if (pattern.test(content)) {
              violations.push(`Potential credential match in ${fullPath} [Category: ${category}]`);
              break;
            }
          }
        } catch (_) {}
      }
    }
  }

  return violations;
}

function verifySecrets() {
  console.log('=== VERIFYING SECRETS SECURITY (Source & Package Surface) ===\n');
  const violations = scanDirectoryForSecrets(process.cwd());

  if (violations.length === 0) {
    console.log('✅ SECRETS CHECK PASSED: No exposed API keys, private keys, or denylisted files detected.');
    process.exit(0);
  } else {
    console.error('❌ SECRETS CHECK FAILED: Found potential security violations:');
    violations.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }
}

verifySecrets();


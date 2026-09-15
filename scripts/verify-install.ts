import { execSync } from 'child_process';

function verifyInstall() {
  console.log('=== VERIFYING DEPENDENCY LOCKFILE SYNC ===\n');
  try {
    execSync('npm ci --ignore-scripts --dry-run', { stdio: 'inherit' });
    console.log('\n✅ DEPENDENCY SYNC VERIFIED: package-lock.json is synchronized with package.json');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ DEPENDENCY SYNC FAILED: package-lock.json is out of sync or invalid');
    process.exit(1);
  }
}

verifyInstall();

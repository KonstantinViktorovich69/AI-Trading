const { execSync } = require('child_process');
try {
  console.log('Running checkout...');
  execSync('git checkout server.ts', { stdio: 'inherit' });
  console.log('Successfully restored server.ts!');
} catch (e) {
  console.error('Error:', e.message);
}

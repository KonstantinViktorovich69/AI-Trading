const { execSync } = require('child_process');
try {
  console.log("Running git checkout...");
  const out = execSync('git checkout server.ts', { encoding: 'utf8' });
  console.log("Success:", out);
} catch (e) {
  console.error("Error:", e.message);
}

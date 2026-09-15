import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import http from 'http';

async function verifyRuntimeBundle() {
  console.log('=== VERIFYING RUNTIME BUNDLE (dist/server.cjs) ===\n');

  const bundlePath = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(bundlePath)) {
    console.log('📦 dist/server.cjs not found. Running build...');
    execSync('npm run build', { stdio: 'inherit' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-runtime-test-'));
  const tmpDbPath = path.join(tmpDir, 'database.json');
  fs.writeFileSync(tmpDbPath, JSON.stringify({
    stateRevision: 1,
    trades: [],
    knowledge: [],
    settings: { main: { virtualBalance: 1000 } }
  }, null, 2));

  const PORT = 3039;
  const API_KEY = 'test-key-999';

  console.log(`🚀 Spawning node dist/server.cjs on port ${PORT}...`);
  const serverProcess = spawn('node', [bundlePath], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      AUTH_MODE: 'api-key',
      API_ACCESS_KEY: API_KEY,
      ENABLE_REAL_TRADING: 'false',
      ATOMIC_DB_PATH: tmpDbPath
    },
    stdio: 'pipe'
  });

  let serverOutput = '';
  serverProcess.stdout?.on('data', (data) => {
    serverOutput += data.toString();
  });
  serverProcess.stderr?.on('data', (data) => {
    serverOutput += data.toString();
  });

  const cleanup = () => {
    try {
      serverProcess.kill('SIGKILL');
    } catch (_) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  };

  const makeRequest = (reqPath: string, headers: Record<string, string> = {}, method = 'GET', body?: any): Promise<{ statusCode: number; data: any }> => {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: PORT,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      };

      const req = http.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            parsed = raw;
          }
          resolve({ statusCode: res.statusCode || 500, data: parsed });
        });
      });

      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  };

  // Wait for server readiness
  let isReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const ping = await makeRequest('/health');
      if (ping.statusCode === 200) {
        isReady = true;
        break;
      }
    } catch (_) {}
  }

  if (!isReady) {
    console.error('❌ Server failed to start within 15s timeout!');
    console.error('Server Log Output:\n', serverOutput);
    cleanup();
    process.exit(1);
  }

  console.log('✅ Server started and listening on port', PORT);
  let failures = 0;

  try {
    // 1. Health check
    console.log('Checking GET /health...');
    const resHealth = await makeRequest('/health');
    if (resHealth.statusCode === 200) {
      console.log('  ✅ GET /health returned 200 OK');
    } else {
      console.error(`  ❌ GET /health expected 200, got ${resHealth.statusCode}`);
      failures++;
    }

    // 2. System status unauthenticated -> minimal fields
    console.log('Checking GET /api/system/status (unauthenticated)...');
    const resUnauthStatus = await makeRequest('/api/system/status');
    if (resUnauthStatus.statusCode === 200 && resUnauthStatus.data?.success === true && resUnauthStatus.data?.status === 'ONLINE') {
      if (resUnauthStatus.data?.realTradingEnabled === undefined) {
        console.log('  ✅ Unauthenticated /api/system/status returned minimal online status without sensitive internals');
      } else {
        console.warn('  ⚠️ Unauthenticated /api/system/status returned non-minimal details:', resUnauthStatus.data);
      }
    } else {
      console.error(`  ❌ GET /api/system/status unauthenticated expected 200 minimal, got ${resUnauthStatus.statusCode}`, resUnauthStatus.data);
      failures++;
    }

    // 3. System status authenticated -> full diagnostics
    console.log('Checking GET /api/system/status (authenticated)...');
    const resAuthStatus = await makeRequest('/api/system/status', { 'X-API-Key': API_KEY });
    if (resAuthStatus.statusCode === 200 && resAuthStatus.data?.success === true && resAuthStatus.data?.authMode) {
      console.log('  ✅ Authenticated /api/system/status returned full status diagnostics');
    } else {
      console.error(`  ❌ GET /api/system/status authenticated expected 200 full, got ${resAuthStatus.statusCode}`, resAuthStatus.data);
      failures++;
    }

    // 4. Protected route unauthenticated -> 401 Unauthorized
    console.log('Checking GET /api/signals (unauthenticated)...');
    const resUnauthTrades = await makeRequest('/api/signals');
    if (resUnauthTrades.statusCode === 401 || resUnauthTrades.statusCode === 403) {
      console.log(`  ✅ Unauthenticated GET /api/signals correctly rejected with ${resUnauthTrades.statusCode}`);
    } else {
      console.error(`  ❌ Unauthenticated GET /api/signals expected 401/403, got ${resUnauthTrades.statusCode}`);
      failures++;
    }

    // 5. Protected route authenticated -> 200 OK
    console.log('Checking GET /api/signals (authenticated)...');
    const resAuthTrades = await makeRequest('/api/signals', { 'X-API-Key': API_KEY });
    if (resAuthTrades.statusCode === 200 && resAuthTrades.data?.success === true) {
      console.log('  ✅ Authenticated GET /api/signals returned 200 OK');
    } else {
      console.error(`  ❌ Authenticated GET /api/signals expected 200, got ${resAuthTrades.statusCode}`, resAuthTrades.data);
      failures++;
    }

    // 6. Real trading guard -> 403 Forbidden
    console.log('Checking POST /api/real-trade/open (ENABLE_REAL_TRADING=false)...');
    const resRealTrade = await makeRequest('/api/real-trade/open', { 'X-API-Key': API_KEY }, 'POST', { symbol: 'BTCUSDT', amount: 100 });
    if (resRealTrade.statusCode === 403 && resRealTrade.data?.success === false) {
      console.log('  ✅ Real trading attempt correctly blocked with 403 when ENABLE_REAL_TRADING=false');
    } else {
      console.error(`  ❌ Real trade expected 403, got ${resRealTrade.statusCode}`, resRealTrade.data);
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during runtime assertions:', err.message);
    failures++;
  } finally {
    cleanup();
  }

  console.log('\n========================================');
  if (failures === 0) {
    console.log('🎉 RUNTIME BUNDLE VERIFICATION PASSED!');
    process.exit(0);
  } else {
    console.error(`❌ RUNTIME BUNDLE VERIFICATION FAILED WITH ${failures} ERRORS.`);
    process.exit(1);
  }
}

verifyRuntimeBundle();

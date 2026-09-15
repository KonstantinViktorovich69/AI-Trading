#!/usr/bin/env node
/**
 * scripts/create-release-candidate.mjs
 * Deterministic, fail-closed release candidate packaging pipeline.
 * Built with Node.js built-in modules only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync, spawnSync } from 'node:child_process';

const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function calculateCrc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function getSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getFileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return getSha256(buf);
}

// Deterministic Zip Writer (pure Node.js built-in)
export function createDeterministicZip(fileEntries, zipFilePath) {
  // fileEntries: Array of { relativePath: string, buffer: Buffer }
  // Sort deterministically by POSIX path
  fileEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const localHeaders = [];
  const centralDirectoryHeaders = [];
  let currentOffset = 0;

  // Normalized DOS timestamp: 2026-01-01 00:00:00 -> Date: (2026-1980)<<9 | 1<<5 | 1 = 0x5C21, Time: 0
  const dosTime = 0x0000;
  const dosDate = 0x5C21;

  const chunks = [];

  for (const entry of fileEntries) {
    const rawData = entry.buffer;
    const uncompressedSize = rawData.length;
    const crc32Val = calculateCrc32(rawData);

    // Deflate compression using raw deflate
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = compressedData.length < uncompressedSize;
    const finalData = useDeflate ? compressedData : rawData;
    const compressionMethod = useDeflate ? 8 : 0;
    const compressedSize = finalData.length;

    const pathBuf = Buffer.from(entry.relativePath.replace(/\\/g, '/'), 'utf8');
    const pathLen = pathBuf.length;

    // Local file header (30 bytes + pathLen)
    const localHeader = Buffer.alloc(30 + pathLen);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);          // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);      // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(compressionMethod, 8); // Compression method
    localHeader.writeUInt16LE(dosTime, 10);    // Mod time
    localHeader.writeUInt16LE(dosDate, 12);    // Mod date
    localHeader.writeUInt32LE(crc32Val, 14);   // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18); // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(pathLen, 26);    // File name length
    localHeader.writeUInt16LE(0, 28);          // Extra field length
    pathBuf.copy(localHeader, 30);

    const localHeaderOffset = currentOffset;
    chunks.push(localHeader);
    chunks.push(finalData);
    currentOffset += localHeader.length + finalData.length;

    // Central directory header (46 bytes + pathLen)
    const cdHeader = Buffer.alloc(46 + pathLen);
    cdHeader.writeUInt32LE(0x02014b50, 0);     // Central dir signature
    cdHeader.writeUInt16LE(0x0314, 4);         // Version made by (UNIX 2.0)
    cdHeader.writeUInt16LE(20, 6);             // Version needed
    cdHeader.writeUInt16LE(0x0800, 8);         // General purpose flag (UTF-8)
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc32Val, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(pathLen, 28);
    cdHeader.writeUInt16LE(0, 30);             // Extra field len
    cdHeader.writeUInt16LE(0, 32);             // File comment len
    cdHeader.writeUInt16LE(0, 34);             // Disk number start
    cdHeader.writeUInt16LE(0, 36);             // Internal file attr
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);// External file attr (UNIX regular file rw-r--r--)
    cdHeader.writeUInt32LE(localHeaderOffset, 42); // Relative offset of local header
    pathBuf.copy(cdHeader, 46);

    centralDirectoryHeaders.push(cdHeader);
  }

  const cdOffset = currentOffset;
  let cdSize = 0;
  for (const cdHeader of centralDirectoryHeaders) {
    chunks.push(cdHeader);
    cdSize += cdHeader.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // EOCD signature
  eocd.writeUInt16LE(0, 4);                    // Number of this disk
  eocd.writeUInt16LE(0, 6);                    // Disk with CD
  eocd.writeUInt16LE(fileEntries.length, 8);   // Total entries this disk
  eocd.writeUInt16LE(fileEntries.length, 10);  // Total entries in CD
  eocd.writeUInt32LE(cdSize, 12);              // Size of CD
  eocd.writeUInt32LE(cdOffset, 16);            // Offset of CD
  eocd.writeUInt16LE(0, 20);                   // Comment length

  chunks.push(eocd);

  const fullZipBuffer = Buffer.concat(chunks);
  fs.writeFileSync(zipFilePath, fullZipBuffer);
  return fullZipBuffer;
}

// Exclusion Checker
function isExcluded(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const basename = path.basename(norm);

  if (norm.startsWith('node_modules/') || norm === 'node_modules') {
    return { excluded: true, reason: 'FORBIDDEN_DEPENDENCY_DIR (node_modules)' };
  }
  if (norm.startsWith('dist/') || norm === 'dist') {
    return { excluded: true, reason: 'BUILD_ARTIFACT (dist)' };
  }
  if (norm.startsWith('coverage/') || norm === 'coverage') {
    return { excluded: true, reason: 'TEST_COVERAGE_DIR (coverage)' };
  }
  if (norm.startsWith('.git/') || norm === '.git') {
    return { excluded: true, reason: 'VCS_INTERNAL (.git)' };
  }
  if (norm.startsWith('logs/') || norm === 'logs' || norm.endsWith('.log')) {
    return { excluded: true, reason: 'RUNTIME_LOGS' };
  }
  if (norm.includes('temp_test_') || norm.includes('temp_') || norm.includes('.bak_') || norm.includes('.backup_')) {
    return { excluded: true, reason: 'TEMPORARY_TEST_DATABASE_OR_BACKUP' };
  }
  if (norm.includes('audit-pristine-') || norm.includes('audit-baseline-')) {
    return { excluded: true, reason: 'AUDIT_INTERNAL_MUTATION' };
  }
  if (norm.endsWith('.zip')) {
    return { excluded: true, reason: 'ARCHIVE_RECURSION_RISK (*.zip)' };
  }
  if (norm === '.env' || (norm.startsWith('.env.') && norm !== '.env.example')) {
    return { excluded: true, reason: 'POTENTIAL_SECRET_ENV_FILE' };
  }
  if (basename === 'release-manifest.sha256' || basename === 'release-inventory.tsv' || basename === 'release-state-provenance.json' || basename === 'release-gates.tsv' || basename === 'release-package-verification.json' || basename === 'release-receipt.json') {
    return { excluded: true, reason: 'GENERATED_RELEASE_EVIDENCE_REPLACED_IN_STAGING' };
  }

  return { excluded: false };
}

// Main Release Pipeline
export async function runReleasePipeline(options = {}) {
  const sourceRoot = path.resolve(options.source || '.');
  const defaultOut = path.resolve(sourceRoot, '../release-output');
  const outputDir = path.resolve(options.out || defaultOut);

  console.log(`=== DETERMINISTIC RELEASE CANDIDATE PIPELINE ===`);
  console.log(`Source Root : ${sourceRoot}`);
  console.log(`Output Dir  : ${outputDir}`);

  // Safety checks on paths
  if (outputDir === sourceRoot || outputDir.startsWith(sourceRoot + path.sep)) {
    throw new Error(`FAIL-CLOSED: Output directory (${outputDir}) must NOT be inside source root (${sourceRoot})`);
  }

  const dbPath = path.join(sourceRoot, 'database.json');
  const settingsPath = path.join(sourceRoot, 'settings.json');

  if (!fs.existsSync(dbPath) || !fs.existsSync(settingsPath)) {
    throw new Error(`FAIL-CLOSED: Authoritative database.json or settings.json missing from source root`);
  }

  const initialDbBuf = fs.readFileSync(dbPath);
  const initialSettingsBuf = fs.readFileSync(settingsPath);

  if (initialDbBuf.length === 0 || initialSettingsBuf.length === 0) {
    throw new Error(`FAIL-CLOSED: Authoritative state files cannot be 0 bytes`);
  }

  let dbParsed, settingsParsed;
  try {
    dbParsed = JSON.parse(initialDbBuf.toString('utf8'));
    settingsParsed = JSON.parse(initialSettingsBuf.toString('utf8'));
  } catch (err) {
    throw new Error(`FAIL-CLOSED: Authoritative state files contain invalid JSON: ${err.message}`);
  }

  const initialDbSha256 = getSha256(initialDbBuf);
  const initialSettingsSha256 = getSha256(initialSettingsBuf);

  console.log(`Authoritative State Initial Hashes:`);
  console.log(`- database.json : ${initialDbBuf.length} bytes, SHA-256: ${initialDbSha256}`);
  console.log(`- settings.json : ${initialSettingsBuf.length} bytes, SHA-256: ${initialSettingsSha256}`);

  // Clean staging & output directory setup (Non-destructive: fail if non-empty)
  if (fs.existsSync(outputDir)) {
    const existingEntries = fs.readdirSync(outputDir);
    if (existingEntries.length > 0) {
      throw new Error(`FAIL-CLOSED: output directory already exists and is non-empty (${outputDir}); choose a new empty path or provide a clean label`);
    }
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const stagingDir = path.join(outputDir, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Stage candidate application files
  console.log(`\n[1/5] Staging candidate files...`);
  const excludedFiles = [];
  const stagedRelativePaths = [];

  function copyCandidateTree(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relPath = path.relative(sourceRoot, fullPath).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        const check = isExcluded(relPath);
        if (check.excluded) {
          excludedFiles.push({ path: relPath, reason: check.reason });
          continue;
        }
        copyCandidateTree(fullPath);
      } else {
        const check = isExcluded(relPath);
        if (check.excluded) {
          excludedFiles.push({ path: relPath, reason: check.reason });
          continue;
        }
        // Copy file preserving relative path and bytes
        const destPath = path.join(stagingDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(fullPath, destPath);
        stagedRelativePaths.push(relPath);
      }
    }
  }

  copyCandidateTree(sourceRoot);
  console.log(`Staged ${stagedRelativePaths.length} candidate files into staging.`);
  console.log(`Excluded ${excludedFiles.length} unwanted/temporary paths.`);

  // Verify exactly one root database.json and settings.json in staging
  const stagedDbPath = path.join(stagingDir, 'database.json');
  const stagedSettingsPath = path.join(stagingDir, 'settings.json');
  if (!fs.existsSync(stagedDbPath) || !fs.existsSync(stagedSettingsPath)) {
    throw new Error(`FAIL-CLOSED: Missing root database.json or settings.json in staging`);
  }

  // 2. Execute Release Gates in a disposable test copy
  console.log(`\n[2/5] Running gate evidence sequence in isolated disposable test copy...`);
  const disposableTestDir = path.join(outputDir, 'disposable-gate-run');
  fs.mkdirSync(disposableTestDir, { recursive: true });

  // Copy candidate staging to disposable test dir
  function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const d = path.join(dst, entry);
      if (fs.statSync(s).isDirectory()) {
        copyDirRecursive(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
  copyDirRecursive(stagingDir, disposableTestDir);

  // Link node_modules into disposable dir to avoid re-downloading
  if (fs.existsSync(path.join(sourceRoot, 'node_modules'))) {
    try {
      fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(disposableTestDir, 'node_modules'), 'junction');
    } catch {
      // If symlink fails, continue
    }
  }

  const gateCommands = [
    { name: 'npm run verify:install', cmd: 'npm run verify:install' },
    { name: 'npm run lint', cmd: 'npm run lint' },
    { name: 'npm test', cmd: 'npm test' },
    { name: 'npm run build', cmd: 'npm run build' },
    { name: 'npm run test:integration', cmd: 'npm run test:integration', env: { OFFLINE_MODE: '1', TEST_MODE: '1', ENABLE_REAL_TRADING: 'false' } },
    { name: 'npm run verify:integration-wiring', cmd: 'npm run verify:integration-wiring' },
    { name: 'npm run test:e2e:offline', cmd: 'npm run test:e2e:offline', env: { OFFLINE_MODE: '1', TEST_MODE: '1', ENABLE_REAL_TRADING: 'false' } },
    { name: 'npm run test:production-path:offline', cmd: 'npm run test:production-path:offline', env: { OFFLINE_MODE: '1', TEST_MODE: '1', ENABLE_REAL_TRADING: 'false' } },
    { name: 'npm run verify:secrets', cmd: 'npm run verify:secrets' },
    { name: 'npm run test:runtime', cmd: 'npm run test:runtime', env: { OFFLINE_MODE: '1', TEST_MODE: '1', ENABLE_REAL_TRADING: 'false' } },
    { name: 'npm audit --omit=dev --audit-level=high', cmd: 'npm audit --omit=dev --audit-level=high' }
  ];

  const gateResults = [];
  for (const gate of gateCommands) {
    const startTime = Date.now();
    try {
      const execEnv = {
        ...process.env,
        ...(gate.env || {}),
        ATOMIC_DB_PATH: path.join(disposableTestDir, 'temp_isolated_db.json'),
        ATOMIC_SETTINGS_PATH: path.join(disposableTestDir, 'temp_isolated_settings.json')
      };
      execSync(gate.cmd, {
        cwd: disposableTestDir,
        env: execEnv,
        stdio: 'pipe'
      });
      const durationMs = Date.now() - startTime;
      gateResults.push({ command: gate.name, exitCode: 0, status: 'PASS', durationMs });
      console.log(`  ✅ GATE PASS: ${gate.name} (${durationMs}ms)`);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const exitCode = err.status || 1;
      gateResults.push({ command: gate.name, exitCode, status: 'FAIL', durationMs, error: err.message });
      console.error(`  ❌ GATE FAIL: ${gate.name} (exit: ${exitCode})`);
      throw new Error(`FAIL-CLOSED: Gate failed: ${gate.name}`);
    }
  }

  // Cleanup disposable test copy
  try {
    fs.rmSync(disposableTestDir, { recursive: true, force: true });
  } catch {}

  // Verify source database.json and settings.json were NOT mutated by gates
  const postGateDbBuf = fs.readFileSync(dbPath);
  const postGateSettingsBuf = fs.readFileSync(settingsPath);
  const postGateDbSha256 = getSha256(postGateDbBuf);
  const postGateSettingsSha256 = getSha256(postGateSettingsBuf);

  if (postGateDbSha256 !== initialDbSha256 || postGateSettingsSha256 !== initialSettingsSha256) {
    throw new Error(`FAIL-CLOSED: Source state mutation detected during gate execution!`);
  }
  console.log(`Source state byte-identical verification: PASS`);

  // 3. Generate Staged Evidence Files
  console.log(`\n[3/5] Generating staged evidence files...`);

  // Structural trade counts
  const totalTrades = Array.isArray(dbParsed.trades) ? dbParsed.trades.length : 0;
  const activeTrades = Array.isArray(dbParsed.trades)
    ? dbParsed.trades.filter(t => t.status === 'OPEN' || t.status === 'PENDING_OPEN' || t.status === 'OPEN_UNKNOWN').length
    : 0;
  const historyTrades = totalTrades - activeTrades;

  // A. release-state-provenance.json
  const stateProvenance = {
    schemaVersion: 1,
    historicalProvenanceStatus: 'OPERATOR_SUPPLIED_BASELINE',
    database: {
      path: 'database.json',
      bytes: initialDbBuf.length,
      sha256: initialDbSha256,
      jsonValid: true,
      tradeCount: totalTrades,
      activeCount: activeTrades,
      historyCount: historyTrades
    },
    settings: {
      path: 'settings.json',
      bytes: initialSettingsBuf.length,
      sha256: initialSettingsSha256,
      jsonValid: true
    },
    preGateState: {
      databaseSha256: initialDbSha256,
      settingsSha256: initialSettingsSha256
    },
    postGateState: {
      databaseSha256: postGateDbSha256,
      settingsSha256: postGateSettingsSha256,
      byteIdentical: true
    },
    operatorAttestationRequiredBeforeActivation: true
  };
  fs.writeFileSync(path.join(stagingDir, 'release-state-provenance.json'), JSON.stringify(stateProvenance, null, 2) + '\n');

  // B. release-gates.tsv
  let gatesTsv = `command\texit_code\tstatus\tduration_ms\n`;
  for (const r of gateResults) {
    gatesTsv += `${r.command}\t${r.exitCode}\t${r.status}\t${r.durationMs}\n`;
  }
  fs.writeFileSync(path.join(stagingDir, 'release-gates.tsv'), gatesTsv);

  // Helper to gather all files currently in staging
  function getAllStagedFiles() {
    const list = [];
    function scan(dir) {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const rel = path.relative(stagingDir, full).replace(/\\/g, '/');
        if (fs.statSync(full).isDirectory()) {
          scan(full);
        } else {
          list.push(rel);
        }
      }
    }
    scan(stagingDir);
    return list.sort();
  }

  // C. release-inventory.tsv (all files except manifest and inventory itself)
  const stagedFilesForInventory = getAllStagedFiles().filter(f => f !== 'release-manifest.sha256' && f !== 'release-inventory.tsv');
  let inventoryTsv = `relative_path\tbyte_size\tsha256\n`;
  for (const rel of stagedFilesForInventory) {
    const full = path.join(stagingDir, rel);
    const buf = fs.readFileSync(full);
    inventoryTsv += `${rel}\t${buf.length}\t${getSha256(buf)}\n`;
  }
  fs.writeFileSync(path.join(stagingDir, 'release-inventory.tsv'), inventoryTsv);

  // D. release-package-verification.json
  const verificationJson = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    status: 'PASS',
    historicalProvenanceStatus: 'OPERATOR_SUPPLIED_BASELINE',
    operatorAttestationRequiredBeforeActivation: true,
    realTradingDisabled: true,
    gateSummary: {
      totalGates: gateResults.length,
      passedGates: gateResults.filter(g => g.status === 'PASS').length,
      failedGates: 0
    },
    stateValidation: {
      databaseSha256: initialDbSha256,
      settingsSha256: initialSettingsSha256,
      databaseBytes: initialDbBuf.length,
      settingsBytes: initialSettingsBuf.length,
      byteIdenticalPostGate: true,
      tradeStructuralCounts: {
        total: totalTrades,
        active: activeTrades,
        history: historyTrades
      }
    },
    manifestPolicy: {
      selfExclusion: true,
      comment: 'release-manifest.sha256 intentionally does not hash itself to avoid circular hash dependency'
    },
    securityAudit: {
      secretsPresent: false,
      forbiddenPathsPresent: false
    }
  };
  fs.writeFileSync(path.join(stagingDir, 'release-package-verification.json'), JSON.stringify(verificationJson, null, 2) + '\n');

  // E. release-manifest.sha256 (sha256sum-compatible format for every staged file except itself)
  const stagedFilesForManifest = getAllStagedFiles().filter(f => f !== 'release-manifest.sha256');
  let manifestText = '';
  for (const rel of stagedFilesForManifest) {
    const full = path.join(stagingDir, rel);
    const buf = fs.readFileSync(full);
    manifestText += `${getSha256(buf)}  ${rel}\n`;
  }
  fs.writeFileSync(path.join(stagingDir, 'release-manifest.sha256'), manifestText);

  // 4. Create Deterministic ZIP Package
  console.log(`\n[4/5] Building deterministic release ZIP archive...`);
  const finalStagedFiles = getAllStagedFiles();
  const fileEntries = finalStagedFiles.map(rel => {
    const full = path.join(stagingDir, rel);
    return {
      relativePath: rel,
      buffer: fs.readFileSync(full)
    };
  });

  const zipPath = path.join(outputDir, 'release-candidate.zip');
  const zipBuffer = createDeterministicZip(fileEntries, zipPath);
  const zipSha256 = getSha256(zipBuffer);

  // Sidecar checksum
  const sidecarPath = path.join(outputDir, 'release-candidate.zip.sha256');
  fs.writeFileSync(sidecarPath, `${zipSha256}  release-candidate.zip\n`);

  // Release receipt
  const receiptPath = path.join(outputDir, 'release-receipt.json');
  const receipt = {
    schemaVersion: 1,
    packagedAt: new Date().toISOString(),
    archiveFile: 'release-candidate.zip',
    archiveSha256: zipSha256,
    archiveBytes: zipBuffer.length,
    sourceRoot,
    stagingDir,
    outputDir,
    totalIncludedFiles: finalStagedFiles.length,
    totalExcludedFiles: excludedFiles.length,
    historicalProvenanceStatus: 'OPERATOR_SUPPLIED_BASELINE',
    operatorAttestationRequiredBeforeActivation: true,
    realTradingDisabled: true,
    database: {
      bytes: initialDbBuf.length,
      sha256: initialDbSha256
    },
    settings: {
      bytes: initialSettingsBuf.length,
      sha256: initialSettingsSha256
    },
    gateResults,
    excludedFiles
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  console.log(`\n[5/5] Release package complete!`);
  console.log(`- Archive Path   : ${zipPath}`);
  console.log(`- Archive Bytes  : ${zipBuffer.length}`);
  console.log(`- Archive SHA256 : ${zipSha256}`);
  console.log(`- Sidecar Path   : ${sidecarPath}`);
  console.log(`- Receipt Path   : ${receiptPath}`);

  return {
    success: true,
    outputDir,
    zipPath,
    zipSha256,
    receiptPath,
    sidecarPath
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let source = '.';
  let out = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) {
      source = args[++i];
    } else if (args[i].startsWith('--source=')) {
      source = args[i].slice('--source='.length);
    } else if (args[i] === '--out' && args[i + 1]) {
      out = args[++i];
    } else if (args[i].startsWith('--out=')) {
      out = args[i].slice('--out='.length);
    }
  }

  runReleasePipeline({ source, out })
    .then(() => {
      console.log(`\n✅ Release packaging finished successfully.`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n❌ Release packaging failed: ${err.message}`);
      process.exit(1);
    });
}

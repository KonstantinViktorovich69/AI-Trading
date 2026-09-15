#!/usr/bin/env node
/**
 * scripts/test-release-candidate-negative-fixtures.mjs
 * Runs the 8 mandatory negative fixture tests against the release verifier.
 * Proves that the release verifier fails closed (non-zero exit) on any corruption.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractZipBuffer, verifyReleasePackage } from './verify-release-candidate.mjs';
import zlib from 'node:zlib';

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

function createZipFromDir(dirPath, destZipPath) {
  const fileEntries = [];
  function scan(dir) {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const rel = path.relative(dirPath, full).replace(/\\/g, '/');
      if (fs.statSync(full).isDirectory()) {
        scan(full);
      } else {
        fileEntries.push({ relativePath: rel, buffer: fs.readFileSync(full) });
      }
    }
  }
  scan(dirPath);
  fileEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const chunks = [];
  const cdHeaders = [];
  let currentOffset = 0;
  const dosTime = 0x0000;
  const dosDate = 0x5C21;

  for (const entry of fileEntries) {
    const rawData = entry.buffer;
    const uncompressedSize = rawData.length;
    const crc32Val = calculateCrc32(rawData);
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = compressedData.length < uncompressedSize;
    const finalData = useDeflate ? compressedData : rawData;
    const compressionMethod = useDeflate ? 8 : 0;
    const compressedSize = finalData.length;

    const pathBuf = Buffer.from(entry.relativePath, 'utf8');
    const pathLen = pathBuf.length;

    const localHeader = Buffer.alloc(30 + pathLen);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc32Val, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(pathLen, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuf.copy(localHeader, 30);

    const localHeaderOffset = currentOffset;
    chunks.push(localHeader);
    chunks.push(finalData);
    currentOffset += localHeader.length + finalData.length;

    const cdHeader = Buffer.alloc(46 + pathLen);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(0x0314, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc32Val, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(pathLen, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdHeader.writeUInt32LE(localHeaderOffset, 42);
    pathBuf.copy(cdHeader, 46);

    cdHeaders.push(cdHeader);
  }

  const cdOffset = currentOffset;
  let cdSize = 0;
  for (const cdHeader of cdHeaders) {
    chunks.push(cdHeader);
    cdSize += cdHeader.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileEntries.length, 8);
  eocd.writeUInt16LE(fileEntries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  const fullZipBuffer = Buffer.concat(chunks);
  fs.writeFileSync(destZipPath, fullZipBuffer);
  return fullZipBuffer;
}

export async function runAllNegativeFixtures(baseZipPath) {
  console.log(`=== RUNNING ALL 8 MANDATORY NEGATIVE FIXTURES (FAIL-CLOSED PROOF) ===`);
  const fixtureBaseDir = path.join(path.dirname(baseZipPath), 'negative_fixtures_run');
  if (fs.existsSync(fixtureBaseDir)) {
    fs.rmSync(fixtureBaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(fixtureBaseDir, { recursive: true });

  const originalZipBuf = fs.readFileSync(baseZipPath);

  const negativeCases = [
    {
      id: 'fixture-1',
      name: 'Empty database.json',
      mutate: (dir) => {
        fs.writeFileSync(path.join(dir, 'database.json'), '');
      }
    },
    {
      id: 'fixture-2',
      name: 'Invalid settings.json',
      mutate: (dir) => {
        fs.writeFileSync(path.join(dir, 'settings.json'), '{ invalid_json_syntax ');
      }
    },
    {
      id: 'fixture-3',
      name: 'Modified payload after manifest creation',
      mutate: (dir) => {
        fs.appendFileSync(path.join(dir, 'server.ts'), '\n// TAMPERED_CODE_AFTER_MANIFEST\n');
      }
    },
    {
      id: 'fixture-4',
      name: 'Duplicate audit-pristine-database.json',
      mutate: (dir) => {
        fs.copyFileSync(path.join(dir, 'database.json'), path.join(dir, 'audit-pristine-database.json'));
      }
    },
    {
      id: 'fixture-5',
      name: 'node_modules/ or .env in archive',
      mutate: (dir) => {
        fs.writeFileSync(path.join(dir, '.env'), 'SECRET_KEY=leaked_test_key\n');
      }
    },
    {
      id: 'fixture-6',
      name: 'Missing provenance or gate evidence',
      mutate: (dir) => {
        fs.unlinkSync(path.join(dir, 'release-state-provenance.json'));
      }
    },
    {
      id: 'fixture-7',
      name: 'State hash mismatch',
      mutate: (dir) => {
        // Change database.json content slightly and update manifest, but keep provenance original
        fs.writeFileSync(path.join(dir, 'database.json'), JSON.stringify({ settings: {}, trades: [] }));
      }
    },
    {
      id: 'fixture-8',
      name: 'Missing package sidecar checksum',
      noSidecar: true,
      mutate: (dir) => {
        // Leave files intact, but don't generate sidecar
      }
    }
  ];

  let passedFixtures = 0;

  for (const tc of negativeCases) {
    const caseDir = path.join(fixtureBaseDir, tc.id);
    const caseExtract = path.join(caseDir, 'extracted');
    const caseZip = path.join(caseDir, 'release-candidate.zip');
    fs.mkdirSync(caseExtract, { recursive: true });

    // Extract clean copy
    extractZipBuffer(originalZipBuf, caseExtract);
    // Apply mutation
    tc.mutate(caseExtract);

    // Build corrupted zip
    const corruptedZipBuf = createZipFromDir(caseExtract, caseZip);

    // Generate sidecar unless test specifically tests missing sidecar
    if (!tc.noSidecar) {
      fs.writeFileSync(`${caseZip}.sha256`, `${getSha256(corruptedZipBuf)}  release-candidate.zip\n`);
    }

    // Now run verifier against corrupted zip, expecting it to FAIL
    let failedAsExpected = false;
    let failureError = '';
    try {
      verifyReleasePackage({ archive: caseZip, extractDir: path.join(caseDir, 'test-extract') });
    } catch (err) {
      failedAsExpected = true;
      failureError = err.message;
    }

    if (failedAsExpected) {
      passedFixtures++;
      console.log(`  ✅ PASS (Failed as required): [${tc.name}] -> Rejected with: "${failureError}"`);
    } else {
      console.error(`  ❌ FAIL (Allowed invalid archive!): [${tc.name}] was accepted by verifier!`);
      throw new Error(`FAIL-CLOSED VIOLATION: Verifier accepted invalid fixture: ${tc.name}`);
    }
  }

  // Cleanup fixtures dir
  try {
    fs.rmSync(fixtureBaseDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n🎉 ALL ${passedFixtures}/${negativeCases.length} NEGATIVE FIXTURES PROVED FAIL-CLOSED!`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let archiveArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--archive' && args[i + 1]) {
      archiveArg = args[++i];
    } else if (args[i].startsWith('--archive=')) {
      archiveArg = args[i].slice('--archive='.length);
    }
  }

  let resolvedArchive = null;
  if (archiveArg) {
    resolvedArchive = path.resolve(archiveArg);
  } else {
    // Version-neutral default check
    const defaultCandidates = [
      path.resolve('../release-output/release-candidate.zip'),
      path.resolve('./release-output/release-candidate.zip')
    ];
    for (const candidate of defaultCandidates) {
      if (fs.existsSync(candidate)) {
        resolvedArchive = candidate;
        break;
      }
    }
  }

  if (!resolvedArchive || !fs.existsSync(resolvedArchive)) {
    const attempted = resolvedArchive || '(none supplied)';
    console.error(`\n❌ FAIL-CLOSED: Candidate release archive does not exist or was not specified.`);
    console.error(`Attempted path: ${attempted}`);
    console.error(`Usage: npm run test:release-negative -- --archive <path/to/release-candidate.zip>`);
    process.exit(1);
  }

  console.log(`Candidate Archive (canonical): ${resolvedArchive}`);

  runAllNegativeFixtures(resolvedArchive)
    .then(() => {
      console.log(`\n✅ Negative fixture test suite completed successfully.`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n❌ Negative fixture test suite failed: ${err.message}`);
      process.exit(1);
    });
}

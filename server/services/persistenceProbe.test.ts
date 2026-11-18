import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writePersistenceProbeSnapshot,
  resetPersistenceProbeForTest
} from './persistenceProbe.ts';

describe('persistenceProbe dual probe (tracked + gitignored)', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetPersistenceProbeForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-l1-'));
    fs.mkdirSync(path.join(tmpDir, 'data', 'backups'), { recursive: true });
  });

  afterEach(() => {
    resetPersistenceProbeForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('writes both _persistence_probe.json and _persistence_probe_ignored.json and captures both on next boot', () => {
    const t1 = 1_795_000_000_000;
    const snap1 = writePersistenceProbeSnapshot(tmpDir, t1, t1);
    expect(snap1.counter).toBe(1);
    expect(snap1.previousProbeOnBoot?.found).toBe(false);
    expect(snap1.previousProbeOnBoot?.ignoredFound).toBe(false);
    expect(snap1.previousProbeOnBoot?.ignoredCounter).toBeNull();

    const mainPath = path.join(tmpDir, 'data', '_persistence_probe.json');
    const ignoredPath = path.join(tmpDir, 'data', '_persistence_probe_ignored.json');
    expect(fs.existsSync(mainPath)).toBe(true);
    expect(fs.existsSync(ignoredPath)).toBe(true);

    // Tick 2 in same process increments both
    const snap2 = writePersistenceProbeSnapshot(tmpDir, t1, t1 + 60_000);
    expect(snap2.counter).toBe(2);
    const ignoredAfterTick2 = JSON.parse(fs.readFileSync(ignoredPath, 'utf-8'));
    expect(ignoredAfterTick2.counter).toBe(2);
    expect(ignoredAfterTick2.timestamp).toBe(t1 + 60_000);

    // Simulate process restart where main probe was overwritten to counter 1, while ignored probe survived at 42
    fs.writeFileSync(
      mainPath,
      JSON.stringify({ counter: 1, timestamp: t1, iso: new Date(t1).toISOString(), startedAt: t1, pid: 100 }),
      'utf-8'
    );
    fs.writeFileSync(
      ignoredPath,
      JSON.stringify({ counter: 42, timestamp: t1 + 120_000, iso: new Date(t1 + 120_000).toISOString(), startedAt: t1, pid: 100 }),
      'utf-8'
    );

    resetPersistenceProbeForTest();
    const bootSnap = writePersistenceProbeSnapshot(tmpDir, t1 + 300_000, t1 + 300_000);
    expect(bootSnap.previousProbeOnBoot).toMatchObject({
      found: true,
      counter: 1,
      timestamp: t1,
      iso: new Date(t1).toISOString(),
      ignoredFound: true,
      ignoredCounter: 42,
      ignoredTimestamp: t1 + 120_000,
      ignoredIso: new Date(t1 + 120_000).toISOString()
    });
    expect(bootSnap.counter).toBe(2);
    const ignoredAfterBoot = JSON.parse(fs.readFileSync(ignoredPath, 'utf-8'));
    expect(ignoredAfterBoot.counter).toBe(43);
  });

  it('keeps data/_persistence_probe_ignored.json in .gitignore without adding database.json or settings.json', () => {
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf-8')
      .split(/\r?\n/)
      .map(l => l.trim());
    expect(gitignore).toContain('data/_persistence_probe_ignored.json');
    expect(gitignore).not.toContain('database.json');
    expect(gitignore).not.toContain('settings.json');
    expect(gitignore).not.toContain('data/trades-archive.jsonl');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AtomicStateStore } from './atomicDbSaver.ts';

describe('AtomicStateStore', () => {
  const tempFile = path.join(process.cwd(), 'temp_test_atomic_store.json');

  beforeEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  afterEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    // Cleanup backups
    const dir = path.dirname(tempFile);
    const base = path.basename(tempFile);
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.startsWith(`${base}.bak_`) || f.startsWith(`${base}.tmp_`) || f.startsWith(`${base}.corrupt_`)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  });

  it('saves state atomically with monotonic stateRevision', async () => {
    const store = new AtomicStateStore(tempFile);
    const data = { trades: [], knowledge: [] };

    await store.saveState(data);
    let loaded = store.loadState<any>({});
    expect(loaded.stateRevision).toBe(1);

    await store.saveState(loaded);
    loaded = store.loadState<any>({});
    expect(loaded.stateRevision).toBe(2);
  });

  it('handles 100+ concurrent saves without corrupting JSON or losing stateRevision sequence', async () => {
    const store = new AtomicStateStore(tempFile);
    let state = { counter: 0, trades: [], knowledge: [] };

    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(store.saveState({ ...state, counter: i + 1 }));
    }

    await Promise.all(promises);
    await store.flush();

    const loaded = store.loadState<any>({});
    expect(loaded.stateRevision).toBe(100);
    expect(loaded.counter).toBe(100);
  }, 15000);

  it('recovers from corrupt JSON using latest backup', async () => {
    const store = new AtomicStateStore(tempFile);
    const validData = { trades: [{ id: 'trade_valid' }], knowledge: [] };

    // Step 1: Save valid data (creates initial file and backup on second write)
    await store.saveState(validData);
    await store.saveState({ ...validData, updated: true });

    // Step 2: Intentionally corrupt main file
    fs.writeFileSync(tempFile, 'CORRUPTED_{INVALID_JSON_CONTENT');

    // Step 3: Attempt load -> should restore from backup
    const loaded = store.loadState<any>({ fallback: true });
    expect(loaded.trades).toBeDefined();
    expect(loaded.trades[0].id).toBe('trade_valid');
  });

  it('recovers from missing or 0-byte file using latest backup', async () => {
    const store = new AtomicStateStore(tempFile);
    const validData = { trades: [{ id: 'trade_after_reboot' }], knowledge: [] };

    // Step 1: Save state twice to establish a backup
    await store.saveState(validData);
    await store.saveState({ ...validData, revision2: true });

    // Step 2: Simulate catastrophic reboot loss: delete main file
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    // Step 3: Load state -> should auto-heal and restore from backup
    const loaded = store.loadState<any>({ fallback: true });
    expect(loaded.trades).toBeDefined();
    expect(loaded.trades[0].id).toBe('trade_after_reboot');
    expect(fs.existsSync(tempFile)).toBe(true);
  });
});

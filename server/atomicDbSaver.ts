import fs from 'fs';
import path from 'path';

export interface AtomicStoreOptions {
  maxBackups?: number;
  indent?: number;
}

export interface DurableCommitResult {
  success: boolean;
  stateRevision: number;
  filePath: string;
  timestamp: number;
  correlationId?: string;
  tradeId?: string;
  error?: string;
}

export type DurablePersistenceResult = DurableCommitResult;

export type TransactionOutcome<T> =
  | { kind: 'COMMIT'; state: unknown; result: T }
  | { kind: 'ABORT'; result: T };

export interface RuntimePaths {
  dbPath: string;
  settingsPath: string;
}

export interface RuntimeStateStores {
  dbStore: AtomicStateStore;
  settingsStore: AtomicStateStore;
  paths: RuntimePaths;
}

export function resolveRuntimePaths(env: Record<string, string | undefined> = process.env): RuntimePaths {
  let dbPath = env.ATOMIC_DB_PATH;
  let settingsPath = env.ATOMIC_SETTINGS_PATH;

  if (dbPath && !settingsPath) {
    const dir = path.dirname(path.resolve(dbPath));
    settingsPath = path.join(dir, 'settings.json');
  } else if (!dbPath && settingsPath) {
    const dir = path.dirname(path.resolve(settingsPath));
    dbPath = path.join(dir, 'database.json');
  } else if (!dbPath && !settingsPath) {
    dbPath = path.join(process.cwd(), 'database.json');
    settingsPath = path.join(process.cwd(), 'settings.json');
  }

  return {
    dbPath: path.resolve(dbPath!),
    settingsPath: path.resolve(settingsPath!)
  };
}

export function createRuntimeStateStores(paths?: Partial<RuntimePaths>): RuntimeStateStores {
  const resolved = {
    ...resolveRuntimePaths(),
    ...(paths?.dbPath ? { dbPath: path.resolve(paths.dbPath) } : {}),
    ...(paths?.settingsPath ? { settingsPath: path.resolve(paths.settingsPath) } : {})
  };

  return {
    dbStore: new AtomicStateStore(resolved.dbPath),
    settingsStore: new AtomicStateStore(resolved.settingsPath),
    paths: resolved
  };
}

export class AtomicStateStore {
  private filePath: string;
  private maxBackups: number;
  private indent: number;
  private writeQueue: Promise<any> = Promise.resolve();

  private currentRevision: number = 0;

  constructor(filePath: string, options: AtomicStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxBackups = options.maxBackups || 15;
    this.indent = options.indent || 2;
    this.cleanStaleTempFiles();
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public getRevision(): number {
    return this.currentRevision;
  }

  /**
   * Enqueues a save operation so concurrent writes are serialized in order.
   * Accepts an object or a producer function (prevState) => newState.
   * Rejects if disk persistence fails (Fail-Propagating).
   */
  public async saveState(dataOrFn: any | ((prev: any) => any)): Promise<DurablePersistenceResult> {
    const operation = this.writeQueue.then(async () => {
      let data = dataOrFn;
      if (typeof dataOrFn === 'function') {
        const current = this.loadState<any>({});
        data = dataOrFn(current);
      }
      return this.writeDirect(data);
    });

    // Keep queue alive for subsequent callers even if this operation rejects
    this.writeQueue = operation.catch(() => {});

    // Propagate result or error to caller
    return operation;
  }

  /**
   * Executes a transactional state mutation.
   * If the transaction returns { kind: 'COMMIT', state, result }:
   *   Performs exactly ONE writeDirect with state, incrementing revision and creating backup.
   * If the transaction returns { kind: 'ABORT', result }:
   *   Performs ZERO disk writes, ZERO revision increments, ZERO backup creation, leaving file pristine.
   */
  public async runTransaction<T>(
    fn: (state: any) => Promise<TransactionOutcome<T>> | TransactionOutcome<T>
  ): Promise<{ outcome: TransactionOutcome<T>; commitResult?: DurableCommitResult }> {
    const operation = this.writeQueue.then(async () => {
      const current = this.loadState<any>({});
      const clone = JSON.parse(JSON.stringify(current));
      const outcome = await fn(clone);
      if (outcome.kind === 'COMMIT') {
        const commitResult = this.writeDirect(outcome.state);
        return { outcome, commitResult };
      } else {
        return { outcome };
      }
    });

    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  /**
   * Performs the atomic write, backup, fsync, and revision increment.
   * Returns DurablePersistenceResult on success, throws on failure.
   */
  public writeDirect(data: any): DurablePersistenceResult {
    if (!data || typeof data !== 'object') {
      const err = new Error(`[ATOMIC STORE] Invalid data object provided for ${this.filePath}`);
      console.error(err.message);
      throw err;
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.currentRevision = Math.max(this.currentRevision + 1, (data.stateRevision || 0) + 1);
    data.stateRevision = this.currentRevision;
    data.updatedAt = Date.now();

    // Safety Guard: Prevent overwriting populated database with empty or wiped collections
    if (fs.existsSync(this.filePath)) {
      try {
        const fileStats = fs.statSync(this.filePath);
        if (fileStats.size > 200 && !data._allowDangerousShrink) {
          const rawOnDisk = fs.readFileSync(this.filePath, 'utf-8');
          const existingData = JSON.parse(rawOnDisk);
          if (existingData && typeof existingData === 'object') {
            const diskTrades = Array.isArray(existingData.trades) ? existingData.trades.length : 0;
            const newTrades = Array.isArray(data.trades) ? data.trades.length : 0;
            const diskHistory = Array.isArray(existingData.history) ? existingData.history.length : 0;
            const newHistory = Array.isArray(data.history) ? data.history.length : 0;
            const diskKb = Array.isArray(existingData.knowledge) ? existingData.knowledge.length : 0;
            const newKb = Array.isArray(data.knowledge) ? data.knowledge.length : 0;

            const totalDisk = diskTrades + diskHistory;
            const totalNew = newTrades + newHistory;

            if (totalDisk > 5 && totalNew === 0) {
              console.error(`[ATOMIC STORE GUARD] ⚠️ Blocked accidental wipeout: disk has ${totalDisk} total trades, new data has 0.`);
              throw new Error(`ACCIDENTAL_WIPEOUT_PREVENTED: total trades dropped from ${totalDisk} to 0`);
            }
            if (diskKb > 5 && newKb === 0) {
              console.error(`[ATOMIC STORE GUARD] ⚠️ Blocked accidental wipeout: disk has ${diskKb} knowledge rules, new data has 0.`);
              throw new Error(`ACCIDENTAL_WIPEOUT_PREVENTED: knowledge rules dropped from ${diskKb} to 0`);
            }
          }
        }
      } catch (guardErr: any) {
        if (guardErr.message?.startsWith('ACCIDENTAL_WIPEOUT_PREVENTED')) {
          throw guardErr;
        }
        // If file on disk was corrupted or unreadable, continue to allow healing write
      }

      this.rotateBackups();
    }

    const tempPath = `${this.filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const jsonStr = JSON.stringify(data, null, this.indent);

    try {
      // Write to temp file & sync
      const fd = fs.openSync(tempPath, 'w');
      fs.writeFileSync(fd, jsonStr, 'utf8');
      try {
        fs.fsyncSync(fd);
      } catch (e) {
        // fsync may not be available on all filesystems, ignore if unsupported
      }
      fs.closeSync(fd);

      // Atomic rename
      fs.renameSync(tempPath, this.filePath);

      // Maintain golden copy in data/known_good periodically
      this.maintainGoldenCopy(data);

      return {
        success: true,
        stateRevision: this.currentRevision,
        filePath: this.filePath,
        timestamp: data.updatedAt
      };
    } catch (err: any) {
      console.error(`[ATOMIC STORE] Error during atomic save for ${this.filePath}:`, err);
      // Clean up temp file if exists
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Safely loads state. If file is missing, empty, or corrupted, initiates multi-tier self-healing recovery.
   */
  public loadState<T>(fallback: T): T {
    let isMissingOrEmpty = false;
    try {
      if (!fs.existsSync(this.filePath)) {
        isMissingOrEmpty = true;
      } else {
        const stats = fs.statSync(this.filePath);
        if (stats.size < 10) {
          isMissingOrEmpty = true;
        }
      }
    } catch {
      isMissingOrEmpty = true;
    }

    if (isMissingOrEmpty) {
      console.warn(`[ATOMIC STORE] ⚠️ Target state file ${this.filePath} is missing or 0 bytes on startup. Triggering auto-recovery...`);
      const recovered = this.tryRecoverFromBackups<T>();
      if (recovered !== null) {
        return recovered;
      }
      return fallback;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data.stateRevision === 'number') {
        this.currentRevision = Math.max(this.currentRevision, data.stateRevision);
      }
      return data as T;
    } catch (err) {
      console.error(`[ATOMIC STORE] Corrupted JSON detected at ${this.filePath}. Triggering recovery...`, err);

      // Preserve corrupt file for diagnostics
      const corruptPath = `${this.filePath}.corrupt_${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, corruptPath);
      } catch (e) {}

      const recovered = this.tryRecoverFromBackups<T>();
      if (recovered !== null) {
        return recovered;
      }

      console.warn(`[ATOMIC STORE] Returning fallback state for ${this.filePath}`);
      return fallback;
    }
  }

  /**
   * Multi-tier self-healing recovery: checks versioned backups, data/backups/, and data/known_good/
   */
  private tryRecoverFromBackups<T>(): T | null {
    // Tier 1: Attempt recovery from latest backup file
    const latestBackup = this.getLatestBackup();
    if (latestBackup) {
      try {
        console.log(`[ATOMIC STORE] 🛡️ Restoring state from backup: ${latestBackup}`);
        const backupRaw = fs.readFileSync(latestBackup, 'utf-8');
        const restored = JSON.parse(backupRaw) as T;
        if (restored && typeof restored === 'object') {
          this.writeDirect(restored);
          console.log(`[ATOMIC STORE] 🛡️ Successfully auto-healed and restored ${this.filePath} from backup!`);
          return restored;
        }
      } catch (backupErr) {
        console.error(`[ATOMIC STORE] Failed to restore from backup ${latestBackup}:`, backupErr);
      }
    }

    // Tier 2: Check data/known_good directory for permanent golden copies
    const baseName = path.basename(this.filePath);
    const knownGoodDirs = [
      path.join(process.cwd(), 'data', 'known_good'),
      path.join(path.dirname(this.filePath), 'data', 'known_good')
    ];

    for (const kgDir of knownGoodDirs) {
      let kgFile: string | null = null;
      if (baseName === 'database.json') {
        kgFile = path.join(kgDir, 'known-good-database-copy');
      } else if (baseName === 'settings.json') {
        kgFile = path.join(kgDir, 'known-good-settings-copy');
      }

      if (kgFile && fs.existsSync(kgFile)) {
        try {
          const stats = fs.statSync(kgFile);
          if (stats.size > 20) {
            console.log(`[ATOMIC STORE] 🛡️ Restoring state from golden copy: ${kgFile}`);
            const kgRaw = fs.readFileSync(kgFile, 'utf-8');
            const restored = JSON.parse(kgRaw) as T;
            if (restored && typeof restored === 'object') {
              this.writeDirect(restored);
              console.log(`[ATOMIC STORE] 🛡️ Successfully auto-healed and restored ${this.filePath} from golden copy!`);
              return restored;
            }
          }
        } catch (kgErr) {
          console.error(`[ATOMIC STORE] Failed to restore from golden copy ${kgFile}:`, kgErr);
        }
      }
    }

    return null;
  }

  private lastGoldenCopyTime: number = 0;

  private maintainGoldenCopy(data: any): void {
    const now = Date.now();
    if (now - this.lastGoldenCopyTime < 60000) return; // Throttle to max once per minute

    try {
      const baseName = path.basename(this.filePath);
      const kgDir = path.join(process.cwd(), 'data', 'known_good');
      if (!fs.existsSync(kgDir)) {
        fs.mkdirSync(kgDir, { recursive: true });
      }

      if (baseName === 'database.json' && validateDbIntegrity(data)) {
        const target = path.join(kgDir, 'known-good-database-copy');
        fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
        this.lastGoldenCopyTime = now;
      } else if (baseName === 'settings.json' && data && typeof data === 'object') {
        const target = path.join(kgDir, 'known-good-settings-copy');
        fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
        this.lastGoldenCopyTime = now;
      }
    } catch {}
  }

  private cleanStaleTempFiles(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        if (f.startsWith(`${baseName}.tmp_`)) {
          const fullPath = path.join(dir, f);
          try {
            const stats = fs.statSync(fullPath);
            if (now - stats.mtimeMs > 30000) {
              fs.unlinkSync(fullPath);
            }
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * Rotates and manages limited versioned backups.
   */
  private rotateBackups(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stats = fs.statSync(this.filePath);
      if (stats.size < 10) return; // Never backup empty or corrupt 0-byte file

      const backupPath = `${this.filePath}.bak_${Date.now()}`;
      fs.copyFileSync(this.filePath, backupPath);

      // Also maintain a backup in data/backups/
      try {
        const dataBackupDir = path.join(process.cwd(), 'data', 'backups');
        if (!fs.existsSync(dataBackupDir)) {
          fs.mkdirSync(dataBackupDir, { recursive: true });
        }
        const dataBackupFile = path.join(dataBackupDir, `${path.basename(this.filePath)}.bak_latest.json`);
        fs.copyFileSync(this.filePath, dataBackupFile);
      } catch {}

      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      const backups = fs.readdirSync(dir)
        .filter(f => f.startsWith(`${baseName}.bak_`))
        .map(f => path.join(dir, f))
        .sort();

      // Retain maxBackups (default 15 files), remove oldest exceeding limit
      while (backups.length > this.maxBackups) {
        const oldest = backups.shift();
        if (oldest && fs.existsSync(oldest)) {
          try {
            fs.unlinkSync(oldest);
          } catch {}
        }
      }
    } catch (e) {
      console.error(`[ATOMIC STORE] Error during backup rotation:`, e);
    }
  }

  private getLatestBackup(): string | null {
    try {
      const candidates: string[] = [];
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);

      // Search in file's directory
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
          .filter(f => f.startsWith(`${baseName}.bak_`) || f.startsWith(`${baseName}.backup_`))
          .map(f => path.join(dir, f));
        candidates.push(...files);
      }

      // Also search in data/backups directory
      const dataBackupDir = path.join(process.cwd(), 'data', 'backups');
      if (fs.existsSync(dataBackupDir)) {
        const files = fs.readdirSync(dataBackupDir)
          .filter(f => f.endsWith('.json') && f.includes(baseName))
          .map(f => path.join(dataBackupDir, f));
        candidates.push(...files);
      }

      if (candidates.length === 0) return null;

      // Sort by file modification time (newest first)
      candidates.sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

      // Find first non-empty, parseable JSON file
      for (const cand of candidates) {
        try {
          const stats = fs.statSync(cand);
          if (stats.size > 50) {
            JSON.parse(fs.readFileSync(cand, 'utf-8'));
            return cand;
          }
        } catch {}
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Waits for pending writes to finish during process shutdown.
   */
  public async flush(): Promise<boolean> {
    return this.writeQueue;
  }
}

// Global runtime state store instances initialized via runtime configuration
export const runtimeStateStores: RuntimeStateStores = createRuntimeStateStores();
export const dbAtomicStore: AtomicStateStore = runtimeStateStores.dbStore;
export const settingsAtomicStore: AtomicStateStore = runtimeStateStores.settingsStore;

export function atomicWriteJson(filePath: string, data: any, indent: number = 2): boolean {
  try {
    const store = new AtomicStateStore(filePath, { indent });
    return Boolean(store.writeDirect(data)?.success);
  } catch {
    return false;
  }
}

export function validateDbIntegrity(dbData: any): boolean {
  if (!dbData || typeof dbData !== 'object') return false;
  if (!Array.isArray(dbData.trades)) return false;
  if (!Array.isArray(dbData.knowledge)) return false;
  return true;
}

export function getAtomicStoreRevision(): number {
  return dbAtomicStore.getRevision();
}

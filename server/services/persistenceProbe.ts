import fs from 'fs';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { atomicWriteJson } from '../atomicDbSaver.ts';
import { safeJsonParse } from '../utils/jsonRepair.ts';

export interface PersistenceProbeState {
  counter: number;
  timestamp: number;
  iso: string;
  startedAt: number;
  pid: number;
  previousProbeOnBoot?: {
    found: boolean;
    counter: number | null;
    timestamp: number | null;
    iso: string | null;
    startedAt: number | null;
    copyFound: boolean;
    copyCounter: number | null;
    ignoredFound: boolean;
    ignoredCounter: number | null;
    ignoredTimestamp: number | null;
    ignoredIso: string | null;
  } | null;
}

let probeTimer: NodeJS.Timeout | null = null;
let probeCounter = 0;
let ignoredProbeCounter = 0;
let bootPreviousProbeCaptured: PersistenceProbeState['previousProbeOnBoot'] | undefined;

export function resetPersistenceProbeForTest(): void {
  stopPersistenceProbeTimer();
  probeCounter = 0;
  ignoredProbeCounter = 0;
  bootPreviousProbeCaptured = undefined;
}

export function writePersistenceProbeSnapshot(
  baseDir = process.cwd(),
  startedAt = Date.now(),
  now = Date.now()
): PersistenceProbeState {
  const probePath = path.join(baseDir, 'data', '_persistence_probe.json');
  const copyPath = path.join(baseDir, 'data', 'backups', '_persistence_probe_copy.json');
  const ignoredProbePath = path.join(baseDir, 'data', '_persistence_probe_ignored.json');

  if (bootPreviousProbeCaptured === undefined) {
    let prevMain: any = null;
    let prevCopy: any = null;
    let prevIgnored: any = null;
    try {
      if (fs.existsSync(probePath)) {
        prevMain = safeJsonParse(fs.readFileSync(probePath, 'utf-8'), null);
      }
    } catch {}
    try {
      if (fs.existsSync(copyPath)) {
        prevCopy = safeJsonParse(fs.readFileSync(copyPath, 'utf-8'), null);
      }
    } catch {}
    try {
      if (fs.existsSync(ignoredProbePath)) {
        prevIgnored = safeJsonParse(fs.readFileSync(ignoredProbePath, 'utf-8'), null);
      }
    } catch {}
    bootPreviousProbeCaptured = {
      found: Boolean(prevMain),
      counter: typeof prevMain?.counter === 'number' ? prevMain.counter : null,
      timestamp: typeof prevMain?.timestamp === 'number' ? prevMain.timestamp : null,
      iso: typeof prevMain?.iso === 'string' ? prevMain.iso : null,
      startedAt: typeof prevMain?.startedAt === 'number' ? prevMain.startedAt : null,
      copyFound: Boolean(prevCopy),
      copyCounter: typeof prevCopy?.counter === 'number' ? prevCopy.counter : null,
      ignoredFound: Boolean(prevIgnored),
      ignoredCounter: typeof prevIgnored?.counter === 'number' ? prevIgnored.counter : null,
      ignoredTimestamp: typeof prevIgnored?.timestamp === 'number' ? prevIgnored.timestamp : null,
      ignoredIso: typeof prevIgnored?.iso === 'string' ? prevIgnored.iso : null
    };
    if (prevMain && typeof prevMain.counter === 'number' && Number.isFinite(prevMain.counter)) {
      probeCounter = prevMain.counter;
    }
    if (prevIgnored && typeof prevIgnored.counter === 'number' && Number.isFinite(prevIgnored.counter)) {
      ignoredProbeCounter = prevIgnored.counter;
    }
  }

  probeCounter += 1;
  ignoredProbeCounter += 1;
  const iso = new Date(now).toISOString();
  const payload: PersistenceProbeState = {
    counter: probeCounter,
    timestamp: now,
    iso,
    startedAt,
    pid: process.pid,
    previousProbeOnBoot: bootPreviousProbeCaptured
  };
  const ignoredPayload: PersistenceProbeState = {
    counter: ignoredProbeCounter,
    timestamp: now,
    iso,
    startedAt,
    pid: process.pid,
    previousProbeOnBoot: bootPreviousProbeCaptured
  };

  atomicWriteJson(probePath, payload);
  atomicWriteJson(copyPath, payload);
  atomicWriteJson(ignoredProbePath, ignoredPayload);
  return payload;
}

export function startPersistenceProbeTimer(intervalMs = 60000, startedAt = Date.now()): NodeJS.Timeout | null {
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
  if (!isMainThread || isTest) return null;
  if (probeTimer) return probeTimer;

  try {
    const initial = writePersistenceProbeSnapshot(process.cwd(), startedAt, Date.now());
    console.log(
      `[PERSISTENCE PROBE] initialized counter=${initial.counter} iso=${initial.iso} prevFound=${Boolean(initial.previousProbeOnBoot?.found)} prevCounter=${initial.previousProbeOnBoot?.counter ?? 'none'} ignoredFound=${Boolean(initial.previousProbeOnBoot?.ignoredFound)} ignoredCounter=${initial.previousProbeOnBoot?.ignoredCounter ?? 'none'}`
    );
  } catch (err: any) {
    console.warn('[PERSISTENCE PROBE] Initial write failed:', err?.message || err);
  }

  probeTimer = setInterval(() => {
    try {
      writePersistenceProbeSnapshot(process.cwd(), startedAt, Date.now());
    } catch (err: any) {
      console.warn('[PERSISTENCE PROBE] Tick write failed:', err?.message || err);
    }
  }, intervalMs);

  return probeTimer;
}

export function stopPersistenceProbeTimer(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

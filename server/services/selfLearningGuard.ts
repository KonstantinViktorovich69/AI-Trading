import fs from 'fs';
import path from 'path';

export const MAX_EXPERT_MODIFICATION_LENGTH = 600;
export const EXPERT_INSTRUCTIONS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const EXPERT_INSTRUCTIONS_HISTORY_LIMIT = 20;
export const KB_MIN_RETENTION_RATIO = 0.3;

export const SECTION_5_HEADER = '### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)';
export const LEGACY_SECTION_4_HEADER = '### 4. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)';

export const FORBIDDEN_EXPERT_INSTRUCTION_MARKERS: readonly string[] = [
  'отключить стоп',
  'отключи стоп',
  'отключать стоп',
  'отключение стоп',
  'убрать стоп',
  'убери стоп',
  'игнорировать стоп',
  'игнорируй стоп',
  'без стоп-лосс',
  'без стопа',
  'удалить стоп',
  'disable stop',
  'remove stop',
  'ignore stop',
  'without stop',
  'закрывать в +0.1%',
  'закрывать при +0.1%',
  'закрытие в +0.1%',
  'тейк +0.1%',
  'close at +0.1%',
  'отключить защиту',
  'убрать защиту',
  'отключить риск',
  'отключить circuit breaker',
  'игнорировать sl'
];

export interface ExpertInstructionVersion {
  id: string;
  timestamp: number;
  instructions: string;
  author: string;
  reason: string;
}

export interface ExpertValidationResult {
  valid: boolean;
  reason?: string;
  matchedMarker?: string;
}

export function writeJsonAtomically(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.fsyncSync(fd);
    } catch {}
    fs.closeSync(fd);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function extractAdaptiveSectionBody(instructions: string): string {
  if (!instructions) return '';
  const header = instructions.includes(SECTION_5_HEADER)
    ? SECTION_5_HEADER
    : (instructions.includes(LEGACY_SECTION_4_HEADER) ? LEGACY_SECTION_4_HEADER : null);
  if (!header) return '';
  const parts = instructions.split(header);
  const combinedAfterFirst = parts.slice(1).join('\n');
  // Stop only at a DIFFERENT markdown section header (not another ### 5. / ### 4. header)
  const otherSectionRegex = /\n###\s+(?!5\.\s+АДАПТИВНЫЕ|4\.\s+АДАПТИВНЫЕ)/;
  const nextIdx = combinedAfterFirst.search(otherSectionRegex);
  return (nextIdx !== -1 ? combinedAfterFirst.substring(0, nextIdx) : combinedAfterFirst).trim();
}

export function findForbiddenExpertInstructionMarker(text: string): string | null {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  for (const marker of FORBIDDEN_EXPERT_INSTRUCTION_MARKERS) {
    if (normalized.includes(marker.toLowerCase())) {
      return marker;
    }
  }
  return null;
}

export function validateExpertInstructionModification(
  modificationText: string,
  opts: {
    lastRetrospectiveUpdateAt?: number;
    nowTs?: number;
    bypassCooldown?: boolean;
  } = {}
): ExpertValidationResult {
  const trimmed = (modificationText || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'EMPTY_MODIFICATION' };
  }

  if (trimmed.length > MAX_EXPERT_MODIFICATION_LENGTH) {
    return {
      valid: false,
      reason: `LENGTH_EXCEEDED: ${trimmed.length} > ${MAX_EXPERT_MODIFICATION_LENGTH}`
    };
  }

  const matchedMarker = findForbiddenExpertInstructionMarker(trimmed);
  if (matchedMarker) {
    return {
      valid: false,
      reason: `FORBIDDEN_MARKER: "${matchedMarker}"`,
      matchedMarker
    };
  }

  if (!opts.bypassCooldown && opts.lastRetrospectiveUpdateAt && opts.lastRetrospectiveUpdateAt > 0) {
    const now = opts.nowTs ?? Date.now();
    const elapsed = now - opts.lastRetrospectiveUpdateAt;
    if (elapsed >= 0 && elapsed < EXPERT_INSTRUCTIONS_COOLDOWN_MS) {
      const remainingHrs = ((EXPERT_INSTRUCTIONS_COOLDOWN_MS - elapsed) / (3600 * 1000)).toFixed(1);
      return {
        valid: false,
        reason: `COOLDOWN_ACTIVE: ${remainingHrs}h remaining of 24h cooldown`
      };
    }
  }

  return { valid: true };
}

export function getExpertInstructionsHistoryPath(reportsDir?: string): string {
  const dir = reportsDir || path.resolve(process.cwd(), 'reports');
  return path.join(dir, 'expert_instructions_history.json');
}

export function loadExpertInstructionsHistory(historyFilePath?: string): ExpertInstructionVersion[] {
  const target = historyFilePath || getExpertInstructionsHistoryPath();
  try {
    if (fs.existsSync(target)) {
      const raw = fs.readFileSync(target, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[SELF-LEARNING GUARD] Failed reading expert instructions history file:', err);
  }
  return [];
}

export function syncExpertInstructionsHistoryFile(
  history: ExpertInstructionVersion[],
  historyFilePath?: string
): ExpertInstructionVersion[] {
  const target = historyFilePath || getExpertInstructionsHistoryPath();
  const capped = (Array.isArray(history) ? history : []).slice(-EXPERT_INSTRUCTIONS_HISTORY_LIMIT);
  try {
    writeJsonAtomically(target, capped);
  } catch (err) {
    console.warn('[SELF-LEARNING GUARD] Failed writing expert instructions history file:', err);
  }
  return capped;
}

export function saveKnowledgeSnapshot(
  knowledgeBase: any[],
  opts: { reportsDir?: string; timestamp?: number } = {}
): string | null {
  try {
    const dir = opts.reportsDir || path.resolve(process.cwd(), 'reports');
    const ts = opts.timestamp ?? Date.now();
    const filePath = path.join(dir, `kb_snapshot_${ts}.json`);
    writeJsonAtomically(filePath, knowledgeBase);
    return filePath;
  } catch (err) {
    console.warn('[SELF-LEARNING GUARD] Failed saving knowledge snapshot:', err);
    return null;
  }
}

export function validateKnowledgeRebalanceSize(
  newRulesCount: number,
  activeRulesCount: number,
  minRatio: number = KB_MIN_RETENTION_RATIO
): { allowed: boolean; ratio: number; reason?: string } {
  if (activeRulesCount <= 0) {
    return { allowed: true, ratio: 1 };
  }
  const ratio = newRulesCount / activeRulesCount;
  if (ratio < minRatio) {
    return {
      allowed: false,
      ratio: Number(ratio.toFixed(4)),
      reason: `KB_SHRINKAGE_BLOCKED: newRules=${newRulesCount} < ${(minRatio * 100).toFixed(0)}% of active=${activeRulesCount}`
    };
  }
  return { allowed: true, ratio: Number(ratio.toFixed(4)) };
}

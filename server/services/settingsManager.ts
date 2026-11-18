import fs from 'fs';
import path from 'path';
import { DEFAULT_BASELINE_EXPERT_INSTRUCTIONS } from '../data/defaultStrategyKnowledge.ts';
import { sanitizeExpertInstructions as quantSanitizeExpertInstructions } from '../quant.ts';
import { atomicWriteJson } from '../atomicDbSaver.ts';
import { safeJsonParse } from '../utils/jsonRepair.ts';
import { DEFAULT_EXCHANGE, normalizeExchangeId } from './activeExchange.ts';
import {
  extractAdaptiveSectionBody,
  findForbiddenExpertInstructionMarker,
  validateExpertInstructionModification,
  syncExpertInstructionsHistoryFile,
  loadExpertInstructionsHistory,
  getExpertInstructionsHistoryPath
} from './selfLearningGuard.ts';

export interface TelegramBotConfig {
  id: string;
  botToken: string;
  chatId: string;
  isEnabled: boolean;
  name?: string;
  muteWatchdog?: boolean;
}

export interface DiscordWebhookConfig {
  id: string;
  webhookUrl: string;
  isEnabled: boolean;
  name?: string;
}

export interface ExchangeApiConfig {
  exchange: string;
  apiKey: string;
  apiSecret: string;
  password?: string;
  isEnabled: boolean;
}

export interface GlobalSettings {
  virtualBalance: number;
  startOfDayBalance: number;
  telegramBots: TelegramBotConfig[];
  discordWebhooks: DiscordWebhookConfig[];
  exchangeApiConfig: ExchangeApiConfig;
  btcShockThreshold: number;
  failedAutopilotSymbols: string[];
  modelWeights: any;
  autopilotAggressiveness: 'conservative' | 'moderate' | 'aggressive';
  isAiExpertTraderEnabled: boolean;
  aiExpertTraderInterval: number;
  aiExpertTraderInstructions: string;
  tradingMode: 'virtual' | 'real';
  aiMinConfidenceThreshold: number;
  isVolatilityBrakeEnabled: boolean;
  maxVolatilityLimit: number;
  fundingShieldLimit: number;
  isDcaEnabled: boolean;
  dcaMultiplierFactor: number;
  timeoutStagnationHours: number;
  isAiPartialCloseRealEnabled: boolean;
  isEma200FilterEnabled: boolean;
  isFvgAboveFilterEnabled: boolean;
  isFvgSupportBelowFilterEnabled: boolean;
  isLiquiditySweepFilterEnabled: boolean;
  isLateShortFilterEnabled: boolean;
  liquiditySweepWickThreshold: number;
  allowedTradingDirections: 'SHORT_ONLY' | 'LONG_ONLY' | 'BOTH';
  activeStrategy: 'SHORT_PUMP_FADE' | 'TREND_FOLLOWING' | 'RANGE_MEAN_REVERSION' | 'ADAPTIVE_DYNAMIC';
  isAutopilotEnabled: boolean;
  isSymmetricConfidenceFilterEnabled: boolean;
  isCommitteeConsensusCheckEnabled: boolean;
  isOteEntryEnabled?: boolean;
  maxActivePositionsVirtual: number;
  maxActivePositionsReal: number;
  maxSameDirectionPositions: number;
  tradingExecutionMode: 'auto' | 'semi_auto' | 'manual';
  tradingMarketMode: 'HYBRID' | 'FUTURES' | 'SPOT';
  maxSpotAllocationPct: number;
  uiStatsResetTimestamp?: number;
  isSessionFilterEnabled?: boolean;
  allowedSessions?: string[];
  costModel?: {
    feeRatePerSide: number;
    slippageRoundTrip: number;
    version: number;
  };
  slippageTierModelEnabled?: boolean;
  blockedHoursUtc?: number[];
  sessionAdaptiveScoreBoost?: boolean;
  exitTrailingTriggerPct?: number;
  exitTrailingDistancePct?: number;
  exitEnableTrailingStop?: boolean;
  exitMinPttpActivationNetPnlPct?: number;
  exitMinPttpPeakNetPnlPct?: number;
  exitPttpTrailingDropPct?: number;
  exitBypassProfitFloorForPrimaryTp?: boolean;
  exitBypassProfitFloorForMultiTp?: boolean;
  exitMinNormalAutoCloseNetPnlPct?: number;
  exitTimeoutProfitHours?: number;
  exitMinTimeoutProfitNetPnlPct?: number;
  exitEnableStagnationTimeout?: boolean;
  exitMaxStagnationPnlPct?: number;
  strictLiquidityGate?: boolean;
  allowBrowserAiPoller?: boolean;
  realTradingEvidenceGateEnabled?: boolean;
  evidenceGateOverride?: boolean;
  evidenceGateMinTrades?: number;
  evidenceGateMinDays?: number;
  evidenceGateMaxDrawdownPct?: number;
  staleDataPauseSec?: number;
  regimeUsesRealBtcCandles?: boolean;
  blockEntriesOnEstimatedFeatures?: boolean;
  modelSideAwareFeatures?: boolean;
  requireModelMaturity?: boolean;
  modelMinSamplesForAdjustment?: number;
  kbDedupeCap?: boolean;
  exchangeWsObserveOnly?: boolean;
  btcFreshnessFastLoopEnabled?: boolean;
  aiDailyBudgetEnabled?: boolean;
  aiDailyBudgetCalls?: number;
  evidenceUsesArchive?: boolean;
  disabledPatterns?: string[];
}

export function createDefaultGlobalSettings(instructions = DEFAULT_BASELINE_EXPERT_INSTRUCTIONS): GlobalSettings {
  return {
    virtualBalance: 1000.0,
    startOfDayBalance: 1000.0,
    telegramBots: [],
    discordWebhooks: [],
    exchangeApiConfig: { exchange: DEFAULT_EXCHANGE, apiKey: '', apiSecret: '', password: '', isEnabled: false },
    btcShockThreshold: 1.5,
    failedAutopilotSymbols: [],
    modelWeights: null,
    autopilotAggressiveness: 'conservative',
    isAiExpertTraderEnabled: true,
    aiExpertTraderInterval: 120000,
    aiExpertTraderInstructions: instructions,
    tradingMode: 'virtual',
    aiMinConfidenceThreshold: 0.75,
    isVolatilityBrakeEnabled: false,
    maxVolatilityLimit: 12.0,
    fundingShieldLimit: -0.15,
    isDcaEnabled: false,
    dcaMultiplierFactor: 1.0,
    timeoutStagnationHours: 8.0,
    isAiPartialCloseRealEnabled: true,
    isEma200FilterEnabled: true,
    isFvgAboveFilterEnabled: true,
    isFvgSupportBelowFilterEnabled: true,
    isLiquiditySweepFilterEnabled: true,
    isLateShortFilterEnabled: true,
    liquiditySweepWickThreshold: 0.30,
    allowedTradingDirections: 'BOTH',
    activeStrategy: 'SHORT_PUMP_FADE',
    isAutopilotEnabled: false,
    isSymmetricConfidenceFilterEnabled: true,
    isCommitteeConsensusCheckEnabled: false,
    isOteEntryEnabled: false,
    maxActivePositionsVirtual: 5,
    maxActivePositionsReal: 5,
    maxSameDirectionPositions: 3,
    tradingExecutionMode: 'auto',
    tradingMarketMode: 'HYBRID',
    maxSpotAllocationPct: 10,
    isSessionFilterEnabled: false,
    allowedSessions: ['ASIAN', 'LONDON', 'OVERLAP_LONDON_NY', 'NEW_YORK', 'PACIFIC_OFF_HOURS'],
    blockedHoursUtc: [],
    sessionAdaptiveScoreBoost: false,
    costModel: {
      feeRatePerSide: 0.0006,
      slippageRoundTrip: 0.0004,
      version: 2
    },
    slippageTierModelEnabled: false,
    strictLiquidityGate: false,
    allowBrowserAiPoller: false,
    realTradingEvidenceGateEnabled: true,
    evidenceGateOverride: false,
    evidenceGateMinTrades: 150,
    evidenceGateMinDays: 14,
    evidenceGateMaxDrawdownPct: 15,
    staleDataPauseSec: 300,
    kbDedupeCap: true,
    exchangeWsObserveOnly: false,
    btcFreshnessFastLoopEnabled: false,
    aiDailyBudgetEnabled: false,
    aiDailyBudgetCalls: 20,
    evidenceUsesArchive: false,
    disabledPatterns: []
  };
}

export interface SettingsManagerContext {
  settingsFilePath?: string;
  dbFilePath?: string;
  expertHistoryFilePath?: string;
  getCachedDB: () => any;
  flushDB: () => Promise<void>;
  syncToFirebase?: (dbData: any) => Promise<void>;
  isFirebaseFirestoreDisabled?: boolean;
  getDbInstance?: () => any;
  getModelStatus?: () => { totalLearnedTrades: number; lastRetrained: number };
  getModelWeights?: () => any;
  setModelWeights?: (weights: any) => void;
  isMainThread?: boolean;
}

export class SettingsManager {
  private settings: GlobalSettings;
  private ctx: SettingsManagerContext;
  private lastSanitizationStatus: { sanitized: boolean; reason: string } = { sanitized: false, reason: '' };
  private autopilotFailedSymbols: Set<string> = new Set();
  private settingsFile: string;
  private dbFile: string;
  private expertHistoryFile: string;
  private lastRetrospectiveUpdateAt: number = 0;

  constructor(ctx: SettingsManagerContext) {
    this.ctx = ctx;
    this.settings = createDefaultGlobalSettings();
    this.settingsFile = ctx.settingsFilePath || path.join(process.cwd(), 'settings.json');
    this.dbFile = ctx.dbFilePath || path.join(process.cwd(), 'db.json');
    this.expertHistoryFile = ctx.expertHistoryFilePath || getExpertInstructionsHistoryPath();
    const existingHistory = loadExpertInstructionsHistory(this.expertHistoryFile);
    const latestRetro = [...existingHistory].reverse().find(h => h && h.author === 'RETROSPECTIVE');
    if (latestRetro && typeof latestRetro.timestamp === 'number') {
      this.lastRetrospectiveUpdateAt = latestRetro.timestamp;
    }
    this.load();
  }

  public getLastRetrospectiveUpdateAt(): number {
    return this.lastRetrospectiveUpdateAt;
  }

  public getExpertHistoryFilePath(): string {
    return this.expertHistoryFile;
  }

  public getSettings(): GlobalSettings {
    return this.settings;
  }

  public setSettings(newSettings: GlobalSettings): void {
    this.settings = newSettings;
  }

  public getAutopilotFailedSymbols(): Set<string> {
    return this.autopilotFailedSymbols;
  }

  public getLastSanitizationStatus(): { sanitized: boolean; reason: string } {
    return this.lastSanitizationStatus;
  }

  public load(): void {
    try {
      let loaded: any = null;
      if (fs.existsSync(this.settingsFile) && fs.statSync(this.settingsFile).size > 10) {
        loaded = safeJsonParse(fs.readFileSync(this.settingsFile, 'utf-8'), null);
      }

      // Self-healing recovery if settings.json is missing, 0 bytes, or corrupted
      if (!loaded) {
        console.warn(`[SETTINGS_MANAGER] ⚠️ ${this.settingsFile} is missing or empty. Attempting auto-recovery from golden copy...`);
        const kgFile = path.join(process.cwd(), 'data', 'known_good', 'known-good-settings-copy');
        if (fs.existsSync(kgFile)) {
          try {
            loaded = safeJsonParse(fs.readFileSync(kgFile, 'utf-8'), null);
            if (loaded) {
              console.log(`[SETTINGS_MANAGER] 🛡️ Successfully auto-healed settings from golden copy: ${kgFile}`);
              atomicWriteJson(this.settingsFile, loaded);
            }
          } catch (e: any) {
            console.error('[SETTINGS_MANAGER] Failed to load golden copy:', e.message);
          }
        }
      }
      let dbData: any = null;
      try {
        if (fs.existsSync(this.dbFile)) {
          dbData = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
        }
      } catch (e) {}

      if (dbData?.settings?.globalConfig) {
        if (!loaded || (loaded.exchangeApiConfig && !loaded.exchangeApiConfig.apiKey && dbData.settings.globalConfig.exchangeApiConfig?.apiKey)) {
          loaded = { ...loaded, ...dbData.settings.globalConfig };
        }
      }

      if (loaded) {
        this.settings = { ...this.settings, ...loaded };

        // Instructions migration logic
        const currentInstr = this.settings.aiExpertTraderInstructions || '';
        const isBidirectionalTemplate = currentInstr.includes('ДВУСТОРОННИЙ СКАЛЬПИНГ И ФЕЙДИНГ ИМПУЛЬСОВ') || currentInstr.includes('ДВУНАПРАВЛЕННЫЙ');
        if (currentInstr && !isBidirectionalTemplate) {
          const legacySectionHeader = '### 4. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)';
          let adaptivePart = '';
          if (currentInstr.includes(legacySectionHeader)) {
            adaptivePart = currentInstr.split(legacySectionHeader)[1] || '';
          }
          const newSectionHeader = '### 4. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)';
          const migratedInstructions = adaptivePart.trim()
            ? DEFAULT_BASELINE_EXPERT_INSTRUCTIONS.split(newSectionHeader)[0].trim() + '\n\n' + newSectionHeader + '\n' + adaptivePart.trim()
            : DEFAULT_BASELINE_EXPERT_INSTRUCTIONS;
          this.setExpertInstructions(migratedInstructions, 'RETROSPECTIVE', 'Автоматическая миграция на актуальный двунаправленный (SHORT+LONG) базовый шаблон стратегии');
        }

        if (loaded.modelWeights && this.ctx.setModelWeights) {
          this.ctx.setModelWeights(loaded.modelWeights);
        }

        if (Array.isArray(loaded.failedAutopilotSymbols)) {
          this.autopilotFailedSymbols.clear();
          loaded.failedAutopilotSymbols.forEach((s: string) => this.autopilotFailedSymbols.add(s));
        }
      }

      if (this.settings.exchangeApiConfig) {
        const rawExchange = this.settings.exchangeApiConfig.exchange;
        const normalized = normalizeExchangeId(rawExchange);
        if (rawExchange !== normalized) {
          console.log(`[SETTINGS_MANAGER] Normalized exchangeApiConfig.exchange from "${rawExchange}" to "${normalized}"`);
          this.settings.exchangeApiConfig.exchange = normalized;
        }
      }
    } catch (e) {
      console.error('[SETTINGS_MANAGER] Failed to load settings', e);
    }
  }

  public setExpertInstructions(newInstructions: string, author: 'USER' | 'RETROSPECTIVE' | 'AI_CHAT', reason?: string): { sanitized: boolean; reason: string } {
    const current = this.settings.aiExpertTraderInstructions || '';
    const isMigration = Boolean(reason && reason.includes('Автоматическая миграция'));

    if ((author === 'RETROSPECTIVE' || author === 'AI_CHAT') && !isMigration) {
      const fullForbidden = findForbiddenExpertInstructionMarker(newInstructions);
      if (fullForbidden) {
        const rejectReason = `FORBIDDEN_MARKER: "${fullForbidden}"`;
        console.warn(`[SELF-LEARNING GUARD] Rejected ${author} expert instructions update: ${rejectReason}`);
        this.lastSanitizationStatus = {
          sanitized: true,
          reason: rejectReason
        };
        return this.lastSanitizationStatus;
      }

      const adaptiveBody = extractAdaptiveSectionBody(newInstructions) || newInstructions;
      if (author === 'RETROSPECTIVE') {
        const validation = validateExpertInstructionModification(adaptiveBody, {
          lastRetrospectiveUpdateAt: this.lastRetrospectiveUpdateAt
        });
        if (!validation.valid) {
          console.warn(`[SELF-LEARNING GUARD] Rejected retrospective expert instructions update: ${validation.reason}`);
          this.lastSanitizationStatus = {
            sanitized: true,
            reason: validation.reason || 'Отклонено защитой самообучения'
          };
          return this.lastSanitizationStatus;
        }
      }
    }

    const sanitized = quantSanitizeExpertInstructions(newInstructions);

    const wasSanitized = sanitized.trim() !== newInstructions.trim();
    if (wasSanitized) {
      this.lastSanitizationStatus = {
        sanitized: true,
        reason: 'Обнаружена попытка удалить защитные правила, восстановлены значения по умолчанию'
      };
    } else {
      this.lastSanitizationStatus = {
        sanitized: false,
        reason: ''
      };
    }

    if (current !== sanitized) {
      const dbData = this.ctx.getCachedDB();
      const historyEntry = {
        id: `inst_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        instructions: current,
        author,
        reason: reason || (author === 'USER' ? 'Ручное изменение пользователем' : author === 'RETROSPECTIVE' ? 'Автоматическая ретроспектива' : 'Изменение ИИ-ассистентом')
      };

      let historyList: any[];
      if (dbData) {
        dbData.aiExpertTraderInstructionsHistory = dbData.aiExpertTraderInstructionsHistory || [];
        dbData.aiExpertTraderInstructionsHistory.push(historyEntry);
        if (dbData.aiExpertTraderInstructionsHistory.length > 20) {
          dbData.aiExpertTraderInstructionsHistory.shift();
        }
        historyList = dbData.aiExpertTraderInstructionsHistory;
      } else {
        historyList = [...loadExpertInstructionsHistory(this.expertHistoryFile), historyEntry].slice(-20);
      }

      const isVitestDefaultPath = (process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined) && !this.ctx.expertHistoryFilePath;
      if (!isVitestDefaultPath) {
        syncExpertInstructionsHistoryFile(historyList, this.expertHistoryFile);
      }

      if (author === 'RETROSPECTIVE' && !isMigration) {
        this.lastRetrospectiveUpdateAt = historyEntry.timestamp;
      }

      this.settings.aiExpertTraderInstructions = sanitized;
      this.saveSettings().catch((err) => console.error('[SETTINGS_MANAGER] Error saving after instruction update:', err));
      console.log(`[EXPERT INSTRUCTIONS] Updated successfully by ${author}. Previous saved to history.`);
    }

    return this.lastSanitizationStatus;
  }

  public async saveSettings(): Promise<void> {
    try {
      this.settings.failedAutopilotSymbols = Array.from(this.autopilotFailedSymbols);
      const modelStatus = this.ctx.getModelStatus?.() || { totalLearnedTrades: 0, lastRetrained: 0 };
      const modelWeights = this.ctx.getModelWeights?.() || null;

      const dataToSave = {
        ...this.settings,
        modelWeights,
        modelStatusMetadata: {
          totalLearnedTrades: modelStatus.totalLearnedTrades,
          lastRetrained: modelStatus.lastRetrained
        }
      };

      atomicWriteJson(this.settingsFile, dataToSave);

      // Periodically update golden copy in data/known_good for disaster recovery (never from tests/custom temp paths)
      const isTestOrCustomPath = Boolean(this.ctx.settingsFilePath) || process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
      if (!isTestOrCustomPath) {
        try {
          const kgDir = path.join(process.cwd(), 'data', 'known_good');
          if (!fs.existsSync(kgDir)) fs.mkdirSync(kgDir, { recursive: true });
          fs.writeFileSync(path.join(kgDir, 'known-good-settings-copy'), JSON.stringify(dataToSave, null, 2), 'utf-8');
        } catch {}
      }

      const dbData = this.ctx.getCachedDB();
      if (dbData) {
        if (!dbData.settings) dbData.settings = {};
        dbData.settings.globalConfig = dataToSave;
        if (!dbData.settings.main) dbData.settings.main = {};
        dbData.settings.main.updatedAt = Date.now();

        await this.ctx.flushDB();

        const dbInstance = this.ctx.getDbInstance?.();
        if (dbInstance && !this.ctx.isFirebaseFirestoreDisabled && this.ctx.syncToFirebase) {
          this.ctx.syncToFirebase(dbData).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[SETTINGS_MANAGER] Failed to save settings', e);
      throw e;
    }
  }
}

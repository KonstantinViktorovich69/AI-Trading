import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const PROCESS_STARTED_AT = Date.now();

export const BUILD_FILES: readonly string[] = [
  'server/services/autoPilotEngine.ts',
  'server/services/virtualTradeEngine.ts',
  'server/services/exitPolicy.ts',
  'server/services/structuralExitLevels.ts',
  'server/services/marketSignalScanner.ts',
  'server/services/signalEngine.ts',
  'server/services/quantRiskEngine.ts',
  'server/services/decisionTraceService.ts',
  'server/services/oteEntryCalculator.ts'
] as const;

export const TRADING_SETTINGS_WHITELIST: readonly string[] = [
  'activeStrategy',
  'aiExpertTraderInterval',
  'aiMinConfidenceThreshold',
  'allowedTradingDirections',
  'allowEmergencyMaxLifetime',
  'autopilotAggressiveness',
  'btcShockThreshold',
  'dcaMultiplierFactor',
  'excludeBinanceCrossListed',
  'fundingShieldLimit',
  'isAiExpertTraderEnabled',
  'isAiPartialCloseRealEnabled',
  'isAutopilotEnabled',
  'isCommitteeConsensusCheckEnabled',
  'isDcaEnabled',
  'isEma200FilterEnabled',
  'isFvgAboveFilterEnabled',
  'isFvgSupportBelowFilterEnabled',
  'isLateShortFilterEnabled',
  'isLiquiditySweepFilterEnabled',
  'isOteEntryEnabled',
  'isParallelAutoLearningEnabled',
  'isSymmetricConfidenceFilterEnabled',
  'isVolatilityBrakeEnabled',
  'liquiditySweepWickThreshold',
  'maxActivePositionsReal',
  'maxActivePositionsVirtual',
  'maxLifetimeHours',
  'maxSameDirectionPositions',
  'maxSpotAllocationPct',
  'maxVolatilityLimit',
  'timeoutProfitHours',
  'timeoutStagnationHours',
  'tradingExecutionMode',
  'tradingMarketMode',
  'tradingMode'
] as const;

let cachedBuildId: string | null = null;

export function getBuildId(): string {
  if (cachedBuildId) return cachedBuildId;
  try {
    const hash = crypto.createHash('sha1');
    let hasContent = false;
    for (const relPath of BUILD_FILES) {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath);
        hash.update(content);
        hasContent = true;
      }
    }
    if (!hasContent) {
      cachedBuildId = 'nobuild';
      return cachedBuildId;
    }
    cachedBuildId = hash.digest('hex').substring(0, 8);
    return cachedBuildId;
  } catch {
    cachedBuildId = 'nobuild';
    return cachedBuildId;
  }
}

export function resetBuildIdCacheForTest(): void {
  cachedBuildId = null;
}

export function getSettingsHash(settings: any): string {
  try {
    if (!settings || typeof settings !== 'object') return 'noset000';
    const picked: Record<string, any> = {};
    for (const key of TRADING_SETTINGS_WHITELIST) {
      if (key in settings && settings[key] !== undefined) {
        picked[key] = settings[key];
      }
    }
    const sortedKeys = Object.keys(picked).sort();
    const sortedObj: Record<string, any> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = picked[k];
    }
    const jsonStr = JSON.stringify(sortedObj);
    return crypto.createHash('sha1').update(jsonStr).digest('hex').substring(0, 8);
  } catch {
    return 'errset00';
  }
}

export function getConfigVersion(settings: any): string {
  return `${getBuildId()}-${getSettingsHash(settings)}`;
}

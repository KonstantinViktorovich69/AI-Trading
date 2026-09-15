import fs from 'fs';
import path from 'path';
import { inferDataOrigin, inferDecisionSource, inferCloseReasonCode, TradeAuditFields } from '../server/services/tradeSchema.ts';

export function runTradeMigration(options: { dbPath?: string; apply?: boolean; backupDir?: string; force?: boolean } = {}) {
  const dbPath = options.dbPath || path.join(process.cwd(), 'database.json');
  const apply = options.apply === true;
  const force = options.force === true;

  if (!fs.existsSync(dbPath)) {
    console.log(`[MIGRATION] Database file not found at ${dbPath}`);
    return { success: false, reason: 'File not found' };
  }

  const raw = fs.readFileSync(dbPath, 'utf-8');
  const dbData = JSON.parse(raw);

  const trades = dbData.trades || [];
  const history = dbData.tradeHistory || [];

  let migratedTradesCount = 0;
  let alreadyValidCount = 0;
  const originCounts: Record<string, number> = {
    LIVE: 0,
    PAPER: 0,
    SEED: 0,
    FORCED_RESET: 0,
    MANUAL_IMPORT: 0,
    LEGACY_UNKNOWN: 0
  };

  let legacyUnlinkedCount = 0;
  let newlyCompliantCount = 0;
  let invalidNewRecordsCount = 0;

  function migrateRecord(trade: any): { modified: boolean; record: any } {
    const origin = (trade.dataOrigin && trade.dataOrigin !== 'LEGACY_UNKNOWN' && !force) ? trade.dataOrigin : inferDataOrigin(trade);
    const decisionSource = (trade.decisionSource && !force) ? trade.decisionSource : inferDecisionSource(trade);
    const closeReasonCode = (trade.closeReasonCode && trade.closeReasonCode !== 'UNKNOWN' && !force) ? trade.closeReasonCode : inferCloseReasonCode(trade);

    originCounts[origin] = (originCounts[origin] || 0) + 1;

    const hasFullLineage = Boolean(
      trade.signalId &&
      trade.correlationId &&
      (trade.committeeDecisionId || trade.hunterDecisionId) &&
      trade.agentDecisionIds &&
      trade.agentDecisionIds.length > 0
    );

    // Identify if this is a new automatic trade record (created after canonical policy introduction or marked as AUTO/LIVE/PAPER)
    const isNewAutoRecord = trade.decisionSource === 'AUTOPILOT_CANONICAL' ||
      trade.decisionSource === 'COMMITTEE' ||
      (trade.mode === 'AUTO' && (trade.dataOrigin === 'LIVE' || trade.dataOrigin === 'PAPER'));

    if (isNewAutoRecord && !hasFullLineage) {
      invalidNewRecordsCount++;
    }

    const lineageStatus = hasFullLineage ? 'COMPLIANT' : 'LEGACY_UNLINKED';
    if (lineageStatus === 'LEGACY_UNLINKED') {
      legacyUnlinkedCount++;
    } else {
      newlyCompliantCount++;
    }

    const isAlreadyValid =
      !force &&
      trade.dataOrigin !== undefined &&
      trade.decisionSource !== undefined &&
      (trade.status !== 'CLOSED' || (trade.closeReasonCode !== undefined && trade.closeReasonCode !== 'UNKNOWN'));

    if (isAlreadyValid) {
      alreadyValidCount++;
      return { modified: false, record: { ...trade, lineageStatus } };
    }

    migratedTradesCount++;

    const auditFields: TradeAuditFields & { lineageStatus: string } = {
      dataOrigin: origin,
      decisionSource: decisionSource,
      strategyId: trade.strategyId || 'CANONICAL_QUANT_SCALP_V2',
      strategyVersion: trade.strategyVersion || '2.1.0',
      signalId: trade.signalId || undefined,
      correlationId: trade.correlationId || undefined,
      matchedRuleIds: trade.matchedRuleIds || [],
      committeeDecisionId: trade.committeeDecisionId || undefined,
      agentDecisionIds: trade.agentDecisionIds || [],
      closeReasonCode: closeReasonCode,
      closeReasonText: trade.closeReason || trade.closeReasonText || trade.learnedRule || trade.aiEvaluation,
      stateRevision: trade.stateRevision || 1,
      createdAt: trade.timestamp || trade.createdAt || trade.openTime || Date.now(),
      updatedAt: trade.updatedAt || trade.closedAt || trade.closeTime || Date.now(),
      lineageStatus
    };

    return {
      modified: true,
      record: {
        ...trade,
        ...auditFields
      }
    };
  }

  const newTrades = trades.map((t: any) => migrateRecord(t).record);
  const newHistory = history.map((t: any) => migrateRecord(t).record);

  console.log('=== TRADE AUDIT MIGRATION SUMMARY ===');
  console.log(`Mode: ${apply ? 'APPLY (Mutating)' : 'DRY-RUN (Read-Only)'}`);
  console.log(`Total active trades checked: ${trades.length}`);
  console.log(`Total history trades checked: ${history.length}`);
  console.log(`Already valid records: ${alreadyValidCount}`);
  console.log(`Records to migrate/migrated: ${migratedTradesCount}`);
  console.log(`Legacy unlinked records: ${legacyUnlinkedCount}`);
  console.log(`Newly compliant records: ${newlyCompliantCount}`);
  console.log(`Invalid new records: ${invalidNewRecordsCount}`);
  console.log('Origin counts breakdown:', originCounts);

  if (apply) {
    const ts = Date.now();
    const backupPath = `${dbPath}.backup_${ts}`;
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[MIGRATION] Created backup at ${backupPath}`);

    dbData.trades = newTrades;
    dbData.tradeHistory = newHistory;
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf-8');
    console.log(`[MIGRATION] Successfully updated ${dbPath}`);
  } else {
    console.log('[MIGRATION] Dry-run complete. Pass --apply to write changes to disk.');
  }

  return {
    success: true,
    dryRun: !apply,
    migratedTradesCount,
    alreadyValidCount,
    originCounts
  };
}

// CLI Execution Entry Point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate-trade-audit-fields.ts')) {
  const isApply = process.argv.includes('--apply');
  const isForce = process.argv.includes('--force');
  runTradeMigration({ apply: isApply, force: isForce });
}

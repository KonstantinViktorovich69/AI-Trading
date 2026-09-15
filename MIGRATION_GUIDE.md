# Trade Schema & System Architecture Migration Guide

This guide details the structural updates made to trade records, database persistence, authentication, and execution safeguards.

## 1. Trade Record Schema Enhancements

To support strict operational reporting, auditability, and RL backtesting without contamination from seed data, all trade objects now include standard tracking fields:

```typescript
export interface TradeAuditFields {
  dataOrigin: 'REAL' | 'PAPER' | 'SEED';
  decisionSource: 'RULE_ENGINE' | 'AI_COMMITTEE' | 'MANUAL_USER' | 'MOCK_INJECT';
  closeReasonCode: CloseReasonCode;
  stateRevision: number;
  strategyId: string;
  strategyVersion: string;
}
```

### Automatic Schema Migration Script
Execute the provided migration script to migrate existing `database.json` files:

```bash
npm run migrate:trades
```

---

## 2. Atomic Database Storage (`AtomicStateStore`)

Legacy `fs.writeFileSync` calls on `database.json` have been migrated to `AtomicStateStore` (`/server/atomicDbSaver.ts`).

### Key Architecture Features:
- **Sequential Queue (`writeQueue`):** Prevents race conditions during high-frequency signal processing.
- **Atomic File Rename (`renameSync` + `fsyncSync`):** Ensures file writes are zero-corruption compliant even during power outages or unexpected crashes.
- **Automated Backup Rotation:** Rotates pre-write snapshots (`database.json.bak_*`) keeping up to 5 versioned backups.
- **Corrupt JSON Auto-Recovery:** Automatically detects invalid JSON syntax, moves corrupt file to `.corrupt_<timestamp>`, and restores state from the latest intact backup.

---

## 3. Strict Execution Guard (`ENABLE_REAL_TRADING`)

Live exchange trade orders are guarded by `ENABLE_REAL_TRADING`:
- Set `ENABLE_REAL_TRADING=true` in environment settings to allow live orders on WEEX.
- If set to `false` (default), live trading routes reject orders with HTTP 403 Forbidden.

---

## 4. API Authentication (`auth.ts`)

API endpoints support three operational security modes via `AUTH_MODE`:
- `STRICT`: Requires valid `X-API-Key` or `Authorization: Bearer <key>` header on protected `/api/*` routes.
- `OPTIONAL`: Validates API keys if present, allows unauthenticated requests if key is omitted.
- `DISABLED`: Bypasses authorization (development mode only).

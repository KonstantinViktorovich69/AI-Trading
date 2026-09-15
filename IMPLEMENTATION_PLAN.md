# IMPLEMENTATION PLAN: Remediation & Hardening of Crypto Trading System

## Executive Summary
This plan details the step-by-step remediation of the crypto trading bot according to the safety prompt requirements. All changes are additive, backward-compatible, and zero-loss for analytics and trading state.

## Matrix of Defect -> File -> Change -> Test -> Compatibility Risk

| # | Defect / Task | Target File(s) | Planned Change | Test & Verification | Compatibility Risk & Mitigation |
|---|---|---|---|---|---|
| 1.1 | Additive Trade Audit & Provenance Schema | `server/services/tradeSchema.ts`, `server/services/tradeMetrics.ts` | Define `DataOrigin`, `DecisionSource`, `CloseReasonCode`, `TradeAuditFields` and `isOperationalTrade()` helper. | Unit test filtering logic in `tradeMetrics.test.ts`. | **Low**: Additive interface fields with defaults for legacy records. |
| 1.2 | Data Provenance Migration CLI | `scripts/migrate-trade-audit-fields.ts` | Migration script with `--dry-run` (default) and `--apply`. Tags `SEED`, `FORCED_RESET`, `PAPER`, `LIVE`, `LEGACY_UNKNOWN`. | Test migration idempotency, dry-run, and backup creation in `migrate.test.ts`. | **Zero**: No change to financial values (pnl, prices, timestamps, IDs). |
| 1.3 | Disable Auto-Seeding on Server Startup | `server.ts`, `scripts/seed-demo-data.ts` | Remove startup synthetic trade/data injection. Move demo seeding to explicit dev script requiring `--confirm-demo-data`. | Integration test verifying server startup on temp DB does not mutate historical arrays. | **Low**: Demo data only generated when explicitly requested. |
| 2.1 | Atomic State Store for `database.json` | `server/atomicDbSaver.ts`, `server.ts` | Unified queue-based atomic JSON saver for `database.json` and `settings.json` with backups and fsync. | Unit test race condition / concurrent write safety in `atomicDbSaver.test.ts`. | **Zero**: Uses existing verified atomic write pattern. |
| 2.2 | Production API Auth & Protection | `server.ts`, `server/middleware/auth.ts` | Configurable `AUTH_MODE` (`disabled` in dev, `session` / `api-key` in prod). Public allowlist for `/health`, `/api/ping`, assets. | Integration tests for public allowlist and 401/403 for unauthorized mutating routes. | **Low**: Dev mode remains `disabled` for local UI dev compatibility. |
| 2.3 | Secrets in `.gitignore` & Security Setup | `.gitignore`, `.env.example`, `SECURITY_SETUP.md` | Add secret patterns (`firebase-service-account.json`, `env_dump.json`, etc.) to `.gitignore`. Document security setup without printing keys. | Audit test checking repository files for tracked secrets. | **Zero**: Purely additive security documentation and git rules. |
| 3.1 | Canonical Strategy Engine | `server/services/strategyEngine.ts`, `server.ts` | Unified entry point for signal generation (`SPOT`, `FUTURES`, `HYBRID`). Connect or deprecate short/spot branches cleanly. | Unit test `strategyEngine.test.ts` for signal decisions and completeness checks. | **Low**: Preserves existing UI signal response structure. |
| 3.2 | Fail Closed & Symmetric Risk Gates | `server/services/strategyEngine.ts`, `server.ts` | Return `NO_TRADE` with `DATA_INCOMPLETE` when OHLCV/orderbook is missing. Enforce symmetric gates for LONG/SHORT and bounded `aggressive` mode. | Unit tests for symmetric LONG/SHORT gates and hard safety limits. | **Zero**: Enhances risk safety without altering valid signals. |
| 4.1 | Unified Exit Policy State Machine | `server/services/exitPolicy.ts`, `server.ts` | Deterministic exit policy handling PTTP, timeouts, trailing stop, emergency stop, and profit protection. | Comprehensive unit tests in `exitPolicy.test.ts` for all exit scenarios. | **Low**: Protects profits while preserving SL/TP and emergency stops. |
| 4.2 | Minimum Net PnL Protection | `server/services/exitPolicy.ts`, `server.ts` | Configurable `minNormalAutoCloseNetPnlPct` (4.0%), `minPttpActivationNetPnlPct` (4.0%), etc., applied only to normal auto profit closes. | Tests in `exitPolicy.test.ts` ensuring normal profit closes do not exit below threshold. | **Zero**: Does not block hard SL, emergency stop, or manual close. |
| 5.1 | Agent & Committee Decision Envelopes | `server/services/agentEngine.ts`, `server.ts` | Structural `AgentDecisionEnvelope` linking `signalId` -> `committeeDecisionId` -> `tradeId` -> `closeReasonCode`. | Unit test decision envelope creation and tracing. | **Zero**: Additive metadata fields. |
| 5.2 | AI Fallback & Degraded Mode | `src/components/TradingTerminal.tsx`, `server.ts` | Fallback returns `NO_TRADE` or `HOLD` on missing key/error without fake positive text/winrates. Complete tasks cleanly for poller. | Integration test for AI fallback without infinite polling. | **Zero**: Prevents browser errors and infinite loops. |
| 6.1 | Versioned IPC & State Synchronization | `server.ts`, `server/services/stateSync.ts` | `StateMessage<T>` with `revision` and `emittedAt`. Single writer queue in main process. Out-of-order message rejection. | Unit test for state sync revision ordering and deletion propagation. | **Zero**: Ensures state integrity across processes. |
| 7.1 | Expanded Input Validation & Observability | `server/tradeInputValidator.ts`, `server.ts` | Complete validation for symbols, exchanges, DCA grid ratios, TP/SL geometry, and `/api/system/status` endpoint. | Unit tests for trade validator and status endpoint. | **Zero**: Backward-compatible with valid input payloads. |

## Work Phases
1. **Phase 1**: Baseline Audit, Provenance Schema, Migration Script & Auto-Seeding Removal (Section 4).
2. **Phase 2**: Atomic State Store, API Security / Auth, Secrets Setup & Supply Chain (Section 5).
3. **Phase 3**: Canonical Strategy Engine, Symmetric Risk Gates & Fail-Closed Logic (Section 6).
4. **Phase 4**: Unified Exit State Machine & Minimum Net PnL Protection (Section 7).
5. **Phase 5**: Agents, Committee & AI Fallback Tracing (Section 8).
6. **Phase 6**: Versioned IPC & External Sync Hardening (Section 9).
7. **Phase 7**: Validation, System Status Endpoint & Final Documentation (Section 10, 11, 12, 13).

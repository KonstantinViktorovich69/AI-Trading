# Remediation Changelog

## [2.1.0] - 2026-08-14

### Added
- Automated verification scripts: `scripts/verify-install.ts`, `scripts/verify-integration.ts`, `scripts/verify-integration-wiring.ts`, `scripts/verify-runtime-bundle.ts`, `scripts/verify-secrets.ts`.
- Structured documentation: `REMEDIATION_REPORT.md`, `CHANGELOG_REMEDIATION.md`, `DEPLOYMENT_RUNBOOK.md`, `ROLLBACK_RUNBOOK.md`, `MIGRATION_GUIDE.md`, `INTEGRATION_MANIFEST.json`.
- Strict authentication middleware (`authMiddleware`) enforcement across all `/api` routes in `server.ts`.

### Changed
- Refactored `server.ts` to use `dbAtomicStore` for all state persistence operations.
- Updated `npm run test:runtime` to execute process-isolated testing against `dist/server.cjs`.
- Standardized trade audit schema fields (`dataOrigin`, `decisionSource`, `closeReasonCode`, `stateRevision`).

### Fixed
- Fixed lockfile desynchronization between `package.json` and `package-lock.json`.
- Removed startup database mutations (synthetic `aiCommitteeHistory` generation).
- Reinforced real-trading execution guard (`ENABLE_REAL_TRADING=false` returns 403 Forbidden).

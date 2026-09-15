# Rollback Runbook (Emergency Recovery Procedure)

This runbook describes step-by-step instructions to recover the application in case of critical failures, severe drawdowns, memory leaks, or corrupted state.

## 1. Immediate Safety Interventions (Circuit Breaker)

If live trading anomalies or unexpected drawdowns occur:

1. **Disable Live Trading Instantly:**
   Update environment variable:
   ```bash
   ENABLE_REAL_TRADING=false
   ```
   Restart server or issue process signal. This immediately blocks `/api/paper-trade/open` and exchange order creation routes.

2. **Trigger Emergency Circuit Breaker Endpoint:**
   Issue POST request to trigger automated position closing and order cancellations:
   ```bash
   curl -X POST -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/circuit-breaker/trigger
   ```

---

## 2. Database Corruption & Backup Recovery

The `AtomicStateStore` maintains automatic versioned backups in `data/backups/` and `database.json.bak_*`.

### Standard Atomic Restore Procedure:

1. Stop the application server:
   ```bash
   pkill -f "node dist/server.cjs" || pkill -f "tsx server.ts"
   ```

2. Locate the latest valid backup file:
   ```bash
   ls -lt data/backups/
   # or
   ls -lt database.json.bak_*
   ```

3. Restore database file safely:
   ```bash
   cp database.json.bak_LATEST database.json
   ```

4. Verify restored state integrity:
   ```bash
   npm run test:integration
   ```

5. Restart server:
   ```bash
   npm start
   ```

---

## 3. Code Rollback Procedure

If a deployed release introduces regression errors:

1. Revert to previous release build artifact or Git commit:
   ```bash
   git checkout PREVIOUS_STABLE_TAG
   npm run build
   ```

2. Re-run schema migration check:
   ```bash
   npm run migrate:trades
   ```

3. Start application and verify health:
   ```bash
   npm start
   curl http://localhost:3000/api/system/status
   ```

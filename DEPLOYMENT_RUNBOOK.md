# Deployment & Release Runbook (Production Release Procedure)

This document outlines the standard operating procedures for release packaging, operator attestation, and deploying the Quantitative Trading System into production environments.

---

## 1. Release Stages & Governance

The release process is partitioned into strictly separated stages with designated decision authorities:

| Stage | Required Artifact | Who Decides |
|---|---|---|
| **Build candidate** | Candidate ZIP, sidecar checksum, release receipt | Automated pipeline |
| **Verify candidate** | Embedded manifest / inventory / re-extraction verification result | Automated verifier + independent auditor |
| **Review supplied state** | State provenance + operator release attestation (`release/operator-release-attestation.template.json`) | Authorized human operator |
| **Technical final audit** | Audit report and release candidate artifacts | Independent auditor |
| **Future activation decision** | Separate authorization, outside this patch | Authorized operator / change process |

> **Completion of packaging, verification and attestation does not enable real trading. Real trading remains disabled until a separate authorized activation decision.**

> **Notice:** Do not use the source project ZIP as the release candidate if it lacks embedded fresh manifest / inventory / provenance / gate evidence. Always generate the candidate via `npm run package:release`.

---

## 2. Deterministic Release Candidate Packaging & Verification Workflow

Execute the full deterministic packaging and verification sequence using a fresh, empty output directory outside the source tree:

```bash
# 1. Clean installation check
npm ci --ignore-scripts

# 2. Package release candidate to a version-neutral clean output directory
npm run package:release -- --source . --out ../release-output-<label>

# 3. Verify the generated candidate archive fail-closed against embedded manifest & state provenance
npm run verify:release-package -- --archive ../release-output-<label>/release-candidate.zip

# 4. Verify negative failure fixtures (proves fail-closed rejection on corrupted archives)
npm run test:release-negative -- --archive ../release-output-<label>/release-candidate.zip

# 5. Verify external archive sidecar SHA-256
sha256sum -c ../release-output-<label>/release-candidate.zip.sha256
```

---

## 3. Pre-Deployment Verification Checklist

Execute all automated verification scripts prior to initiating deployment:

```bash
# 1. Type Safety & Compilation Check
npm run lint

# 2. Integration & Gate Verification Tests
npm run test:integration

# 3. Structural Integration Wiring Check
npm run verify:integration-wiring

# 4. Secrets & Credentials Leak Verification
npm run verify:secrets

# 5. Full Production Build Verification
npm run build
```

Do not proceed with deployment if any step fails.

---

## 2. Environment Variables & Secret Configuration

Ensure the following environment variables are securely set in Cloud Run / hosting control panel:

| Variable | Recommended Production Setting | Description |
|---|---|---|
| `NODE_ENV` | `production` | Enables production mode and static asset serving |
| `ENABLE_REAL_TRADING` | `true` (or `false` for paper) | Mandatory execution guard for live exchange API orders |
| `AUTH_MODE` | `STRICT` | Requires valid `X-API-Key` headers on `/api` routes |
| `API_KEY` | Secret Key (32+ chars) | Security key for client API requests |
| `WEEX_API_KEY` | Secret | Exchange API Key |
| `WEEX_SECRET_KEY` | Secret | Exchange Secret |
| `WEEX_PASSPHRASE` | Secret | Exchange API Passphrase |

---

## 3. Database Migration & Integrity Checks

Before starting the server, run trade schema audit field migration:

```bash
npm run migrate:trades
```

This ensures all historical records conform to the schema with `dataOrigin`, `decisionSource`, `closeReasonCode`, and `stateRevision`.

---

## 4. Server Launch & Health Monitoring

1. **Launch Server:**
   ```bash
   npm start
   ```

2. **Verify System Status Endpoint:**
   ```bash
   curl -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/system/status
   ```
   *Expected Response:*
   ```json
   {
     "success": true,
     "status": "HEALTHY",
     "realTradingEnabled": false,
     "authMode": "STRICT",
     "atomicDb": {
       "revision": 12,
       "healthy": true
     }
   }
   ```

3. **Verify Quantitative Metrics Endpoint:**
   ```bash
   curl -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/system/quant-metrics
   ```

---

## 5. Post-Deployment Verification

- Confirm WebSocket connections (WEEX, Binance, Bybit) show `wsWatchdog` active logs without stalled reconnection loops.
- Monitor `serverEventLoopLagMs` metrics under `/api/system/quant-metrics`.
- Ensure no unexpected error rates occur on `/api/signals` and `/api/stream`.

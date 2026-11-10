import { isCleanLearningTrade, netReturnPct, bootstrapExpectancyCI95 } from './learningCells.ts';

export interface EvidenceGateResult {
  passed: boolean;
  rawPassed: boolean;
  enabled: boolean;
  overrideActive: boolean;
  reason: string;
  cleanTradesCount: number;
  eligibleTradesCount: number;
  minTrades: number;
  spanDays: number;
  minDays: number;
  avgNetReturnPct: number;
  ci95: { lo: number; hi: number };
  maxDrawdownPct: number;
  maxAllowedDrawdownPct: number;
  profitFactor: number | null;
  requiredCostModelVersion: number;
  requiredFeaturesVersion: number;
  checks: {
    minTradesOk: boolean;
    minDaysOk: boolean;
    ciPositiveOk: boolean;
    maxDrawdownOk: boolean;
  };
}

export function evaluateEvidenceGate(
  trades: any[],
  settings: any = {},
  _nowTs?: number
): EvidenceGateResult {
  const s = settings || {};
  const enabled = s.realTradingEvidenceGateEnabled !== false;
  const overrideActive = s.evidenceGateOverride === true;
  const minTrades = typeof s.evidenceGateMinTrades === 'number' && s.evidenceGateMinTrades > 0
    ? s.evidenceGateMinTrades
    : 150;
  const minDays = typeof s.evidenceGateMinDays === 'number' && s.evidenceGateMinDays > 0
    ? s.evidenceGateMinDays
    : 14;
  const maxAllowedDrawdownPct = typeof s.evidenceGateMaxDrawdownPct === 'number' && s.evidenceGateMaxDrawdownPct >= 0
    ? s.evidenceGateMaxDrawdownPct
    : 15;

  const modelSideAware = s.modelSideAwareFeatures === true;
  const requiredCostModelVersion = 2;
  const requiredFeaturesVersion = modelSideAware ? 2 : 1;

  const safeTrades = Array.isArray(trades) ? trades : [];
  const cleanTrades = safeTrades.filter(isCleanLearningTrade);

  const eligible = cleanTrades.filter((t: any) => {
    const cmv = typeof t.costModelVersion === 'number' ? t.costModelVersion : 1;
    if (cmv < requiredCostModelVersion) return false;
    if (modelSideAware) {
      const fv = typeof t.featuresVersion === 'number' ? t.featuresVersion : 1;
      if (fv < requiredFeaturesVersion) return false;
    }
    return true;
  });

  // Sort chronologically for drawdown & calendar span
  eligible.sort((a: any, b: any) => {
    const ta = a.closeTime || a.closedAt || a.openTime || a.createdAt || 0;
    const tb = b.closeTime || b.closedAt || b.openTime || b.createdAt || 0;
    return ta - tb;
  });

  const n = eligible.length;
  const returns: number[] = new Array(n);
  const weights: number[] = new Array(n);

  let sumRet = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let cumRet = 0;
  let peakCum = 0;
  let maxDd = 0;

  let minTs = Infinity;
  let maxTs = -Infinity;

  for (let i = 0; i < n; i++) {
    const t = eligible[i];
    const r = netReturnPct(t);
    returns[i] = r;
    weights[i] = 1;
    sumRet += r;

    if (r > 0) grossProfit += r;
    else if (r < 0) grossLoss += Math.abs(r);

    cumRet += r;
    if (cumRet > peakCum) peakCum = cumRet;
    const dd = peakCum - cumRet;
    if (dd > maxDd) maxDd = dd;

    const ts = t.closeTime || t.closedAt || t.openTime || t.createdAt || 0;
    if (typeof ts === 'number' && ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }

  const spanDays = (minTs < Infinity && maxTs > -Infinity && maxTs >= minTs)
    ? Number(((maxTs - minTs) / (24 * 60 * 60 * 1000)).toFixed(2))
    : 0;

  const avgNetReturnPct = n > 0 ? Number((sumRet / n).toFixed(4)) : 0;
  const maxDrawdownPct = Number(maxDd.toFixed(2));
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? 10.0 : null)
    : Number(Math.min(10.0, grossProfit / grossLoss).toFixed(3));

  const ci95 = bootstrapExpectancyCI95(returns, weights, 'evidence-gate', 500);

  const minTradesOk = n >= minTrades;
  const minDaysOk = spanDays >= minDays;
  const ciPositiveOk = n >= 20 && ci95.lo > 0;
  const maxDrawdownOk = maxDrawdownPct <= maxAllowedDrawdownPct;

  const rawPassed = minTradesOk && minDaysOk && ciPositiveOk && maxDrawdownOk;
  const passed = (!enabled || overrideActive) ? true : rawPassed;

  let reason: string;
  if (rawPassed) {
    reason = `EVIDENCE_GATE: PASSED (n=${n}, days=${spanDays.toFixed(1)}, lo=${ci95.lo}, dd=${maxDrawdownPct}%)`;
  } else {
    const summary = `n=${n}/${minTrades}, days=${spanDays.toFixed(1)}/${minDays}, lo=${ci95.lo}, dd=${maxDrawdownPct}%/${maxAllowedDrawdownPct}%`;
    if (overrideActive) {
      reason = `EVIDENCE_GATE_OVERRIDE: ${summary}`;
    } else if (!enabled) {
      reason = `EVIDENCE_GATE_DISABLED: ${summary}`;
    } else {
      reason = `EVIDENCE_GATE: ${summary}`;
    }
  }

  return {
    passed,
    rawPassed,
    enabled,
    overrideActive,
    reason,
    cleanTradesCount: cleanTrades.length,
    eligibleTradesCount: n,
    minTrades,
    spanDays,
    minDays,
    avgNetReturnPct,
    ci95,
    maxDrawdownPct,
    maxAllowedDrawdownPct,
    profitFactor,
    requiredCostModelVersion,
    requiredFeaturesVersion,
    checks: {
      minTradesOk,
      minDaysOk,
      ciPositiveOk,
      maxDrawdownOk
    }
  };
}

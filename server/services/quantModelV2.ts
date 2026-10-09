import path from 'path';
import fs from 'fs';
import { isCleanLearningTrade, netReturnPct } from './learningCells.ts';
import { computeQuantFeaturesV2 } from './quantFeaturesV2.ts';

const MODEL_V2_FILE = path.resolve(process.cwd(), 'data/quant-model-v2.json');

export interface QuantModelV2Metrics {
  auc: number;
  logLoss: number;
  brier: number;
  baseRateTrain: number;
  baseLogLossVal: number;
  logLossImprovement: number;
}

export interface QuantModelV2State {
  status: 'INSUFFICIENT_DATA' | 'REJECTED' | 'ACCEPTED';
  weights: number[]; // 12 elements (bias + 11 features)
  mean: number[];    // 11 elements
  std: number[];     // 11 elements
  trainedAt: number;
  nTrain: number;
  nVal: number;
  metrics: QuantModelV2Metrics | null;
  accepted: boolean;
}

let cachedModelV2: QuantModelV2State | null = null;
let lastTrainCount = 0;
let retrainDebounceTimer: NodeJS.Timeout | null = null;

function ensureDataDir(): void {
  const dir = path.dirname(MODEL_V2_FILE);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

function writeAtomicJson(filePath: string, data: any): void {
  ensureDataDir();
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    console.warn('[QUANT MODEL V2] Failed saving model file:', err);
  }
}

function loadSavedModelV2(): QuantModelV2State | null {
  try {
    if (fs.existsSync(MODEL_V2_FILE)) {
      const raw = fs.readFileSync(MODEL_V2_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as QuantModelV2State;
      }
    }
  } catch (err) {
    console.warn('[QUANT MODEL V2] Could not load quant-model-v2.json:', err);
  }
  return null;
}

// Initial load
try {
  cachedModelV2 = loadSavedModelV2();
} catch {}

/**
 * Calculates Area Under ROC Curve (AUC) using trapezoidal rule / Wilcoxon rank sum.
 */
export function calculateAuc(labels: number[], predictions: number[]): number {
  if (labels.length !== predictions.length || labels.length === 0) return 0.5;

  const pairs = labels.map((y, i) => ({ y, p: predictions[i] }));
  // Sort descending by predicted probability
  pairs.sort((a, b) => b.p - a.p);

  let nPos = 0;
  let nNeg = 0;
  for (const item of pairs) {
    if (item.y === 1) nPos++;
    else nNeg++;
  }

  if (nPos === 0 || nNeg === 0) return 0.5;

  let rankSumPos = 0;
  let i = 0;
  const n = pairs.length;

  while (i < n) {
    let j = i;
    while (j < n - 1 && pairs[j].p === pairs[j + 1].p) {
      j++;
    }
    // Rank range: (i + 1) to (j + 1), 1-based ranks from bottom (n - (average rank) + 1)
    // In descending sort: items with highest score have rank n, lowest score rank 1
    const avgRank = n - (i + j) / 2;
    for (let k = i; k <= j; k++) {
      if (pairs[k].y === 1) {
        rankSumPos += avgRank;
      }
    }
    i = j + 1;
  }

  const u = rankSumPos - (nPos * (nPos + 1)) / 2;
  return Number((u / (nPos * nNeg)).toFixed(4));
}

/**
 * Calculates Binary Log-Loss.
 */
export function calculateLogLoss(labels: number[], predictions: number[]): number {
  if (labels.length === 0) return 0;
  const eps = 1e-15;
  let sumLoss = 0;
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i];
    const p = Math.max(eps, Math.min(1 - eps, predictions[i]));
    sumLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return Number((sumLoss / labels.length).toFixed(5));
}

/**
 * Calculates Brier score: mean squared difference.
 */
export function calculateBrierScore(labels: number[], predictions: number[]): number {
  if (labels.length === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < labels.length; i++) {
    const diff = predictions[i] - labels[i];
    sumDiff += diff * diff;
  }
  return Number((sumDiff / labels.length).toFixed(5));
}

/**
 * Calculates prediction probability p for a single standardized feature vector.
 */
export function predictProbabilityV2(xStd: number[], weights: number[]): number {
  let z = weights[0]; // intercept
  for (let j = 0; j < 11; j++) {
    z += weights[j + 1] * (xStd[j] || 0);
  }
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/**
 * Trains logistic regression with L2 regularization on standardized dataset.
 */
export function fitLogisticRegressionL2(
  X: number[][],
  y: number[],
  opts: { iterations?: number; learningRate?: number; l2Lambda?: number } = {}
): number[] {
  const iterations = opts.iterations ?? 300;
  const lr = opts.learningRate ?? 0.05;
  const lambda = opts.l2Lambda ?? 0.01;
  const n = X.length;
  const numFeatures = 11;

  // weights[0] = bias, weights[1..11] = features
  const w = new Array(numFeatures + 1).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(numFeatures + 1).fill(0);

    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = w[0];
      for (let j = 0; j < numFeatures; j++) {
        z += w[j + 1] * xi[j];
      }
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const err = p - y[i];

      grad[0] += err;
      for (let j = 0; j < numFeatures; j++) {
        grad[j + 1] += err * xi[j];
      }
    }

    // Gradient step with L2 regularization (do not regularize intercept w[0])
    w[0] -= lr * (grad[0] / n);
    for (let j = 0; j < numFeatures; j++) {
      const reg = lambda * w[j + 1];
      w[j + 1] -= lr * (grad[j + 1] / n + reg);
    }
  }

  return w.map(v => Number(v.toFixed(5)));
}

/**
 * Filters clean trades that possess valid featuresV2.
 */
export function getEligibleTradesForModelV2(trades: any[]): any[] {
  if (!Array.isArray(trades)) return [];
  return trades.filter(t => {
    return isCleanLearningTrade(t) && t.entryDiagnostics?.featuresV2HadIndicators === true;
  });
}

/**
 * Trains Quant Model V2.
 */
export function trainQuantModelV2(trades: any[]): QuantModelV2State {
  const eligible = getEligibleTradesForModelV2(trades);

  if (eligible.length < 200) {
    const insufficientState: QuantModelV2State = {
      status: 'INSUFFICIENT_DATA',
      weights: new Array(12).fill(0),
      mean: new Array(11).fill(0),
      std: new Array(11).fill(1),
      trainedAt: Date.now(),
      nTrain: 0,
      nVal: 0,
      metrics: null,
      accepted: false
    };
    cachedModelV2 = insufficientState;
    writeAtomicJson(MODEL_V2_FILE, insufficientState);
    return insufficientState;
  }

  // Chronological sort strictly by openTime / createdAt
  eligible.sort((a, b) => (a.openTime || a.createdAt || 0) - (b.openTime || b.createdAt || 0));

  // Extract raw features and labels (label: netReturnPct > 0)
  const samples = eligible.map(t => {
    const rawX = t.entryDiagnostics.featuresV2;
    const feats = Array.isArray(rawX) && rawX.length === 11 ? rawX : new Array(11).fill(0);
    const ret = netReturnPct(t);
    const label = (ret > 0 || t.outcome === 1 || t.outcome === 'WIN') ? 1 : 0;
    return { x: feats, y: label };
  });

  // 70/30 chronological split
  const trainSize = Math.floor(samples.length * 0.7);
  const trainSamples = samples.slice(0, trainSize);
  const valSamples = samples.slice(trainSize);

  // Compute z-score mean and std strictly on train set
  const mean = new Array(11).fill(0);
  const std = new Array(11).fill(0);

  for (const s of trainSamples) {
    for (let j = 0; j < 11; j++) {
      mean[j] += s.x[j];
    }
  }
  for (let j = 0; j < 11; j++) {
    mean[j] /= trainSize;
  }

  for (const s of trainSamples) {
    for (let j = 0; j < 11; j++) {
      const diff = s.x[j] - mean[j];
      std[j] += diff * diff;
    }
  }
  for (let j = 0; j < 11; j++) {
    const variance = std[j] / Math.max(1, trainSize - 1);
    std[j] = Math.sqrt(variance);
    if (std[j] < 1e-6) {
      std[j] = 1.0; // avoid div by zero on constant features
    }
  }

  // Standardize datasets
  const standardize = (x: number[]) => {
    return x.map((val, j) => (val - mean[j]) / std[j]);
  };

  const XTrain = trainSamples.map(s => standardize(s.x));
  const yTrain = trainSamples.map(s => s.y);

  const XVal = valSamples.map(s => standardize(s.x));
  const yVal = valSamples.map(s => s.y);

  // Train weights on train set
  const weights = fitLogisticRegressionL2(XTrain, yTrain, { iterations: 300, learningRate: 0.05, l2Lambda: 0.01 });

  // Evaluate on validation set
  const valPreds = XVal.map(xStd => predictProbabilityV2(xStd, weights));

  // Compute baseline metrics on val using train base rate
  const trainPosCount = yTrain.filter(y => y === 1).length;
  const baseRateTrain = Number((trainPosCount / trainSize).toFixed(4));
  const baseValPreds = new Array(valSamples.length).fill(Math.max(0.01, Math.min(0.99, baseRateTrain)));

  const auc = calculateAuc(yVal, valPreds);
  const logLoss = calculateLogLoss(yVal, valPreds);
  const brier = calculateBrierScore(yVal, valPreds);
  const baseLogLossVal = calculateLogLoss(yVal, baseValPreds);
  const logLossImprovement = Number((baseLogLossVal - logLoss).toFixed(5));

  // Acceptance criteria: AUC >= 0.55 AND logLoss improved by at least 0.005 vs baseline
  const isAccepted = auc >= 0.55 && logLossImprovement >= 0.005;

  const resultState: QuantModelV2State = {
    status: isAccepted ? 'ACCEPTED' : 'REJECTED',
    weights,
    mean: mean.map(m => Number(m.toFixed(5))),
    std: std.map(s => Number(s.toFixed(5))),
    trainedAt: Date.now(),
    nTrain: trainSize,
    nVal: valSamples.length,
    metrics: {
      auc,
      logLoss,
      brier,
      baseRateTrain,
      baseLogLossVal,
      logLossImprovement
    },
    accepted: isAccepted
  };

  cachedModelV2 = resultState;
  lastTrainCount = eligible.length;
  writeAtomicJson(MODEL_V2_FILE, resultState);

  return resultState;
}

/**
 * Evaluates probability quantPV2 for a trade at entry if model is accepted.
 */
export function calculateProbabilityV2IfAccepted(
  featuresV2: number[],
  hadIndicators: boolean
): number | null {
  if (!hadIndicators || !cachedModelV2 || !cachedModelV2.accepted) {
    return null;
  }

  const { weights, mean, std } = cachedModelV2;
  if (!weights || weights.length !== 12 || !mean || !std) {
    return null;
  }

  const xStd = featuresV2.map((val, j) => (val - (mean[j] || 0)) / (std[j] || 1));
  const p = predictProbabilityV2(xStd, weights);
  return Number(p.toFixed(4));
}

/**
 * Checks if model should retrain (after every 25 new clean trades with featuresV2).
 */
export function scheduleModelV2RetrainIfNeeded(
  getTrades: () => any[]
): void {
  try {
    const trades = getTrades();
    const eligibleCount = getEligibleTradesForModelV2(trades).length;

    // Retrain if first time (lastTrainCount === 0 and >= 200) or count difference >= 25
    if (eligibleCount >= 200 && (lastTrainCount === 0 || eligibleCount - lastTrainCount >= 25)) {
      if (retrainDebounceTimer) {
        clearTimeout(retrainDebounceTimer);
      }
      retrainDebounceTimer = setTimeout(() => {
        try {
          trainQuantModelV2(getTrades());
        } catch (err) {
          console.warn('[QUANT MODEL V2] Retrain failed:', err);
        }
      }, 5000);
    }
  } catch (err) {
    console.warn('[QUANT MODEL V2] Check retrain failed:', err);
  }
}

/**
 * Returns current model state.
 */
export function getQuantModelV2Status(trades?: any[]): {
  model: QuantModelV2State | null;
  totalTrades: number;
  eligibleTrades: number;
  recent200CoveragePct: number;
} {
  const allTrades = trades || [];
  const eligible = getEligibleTradesForModelV2(allTrades);
  const recent200 = allTrades.slice(-200);
  const recentWithIndicators = recent200.filter(t => t.entryDiagnostics?.featuresV2HadIndicators === true).length;
  const recent200CoveragePct = recent200.length > 0 ? Number(((recentWithIndicators / recent200.length) * 100).toFixed(1)) : 0;

  return {
    model: cachedModelV2,
    totalTrades: allTrades.length,
    eligibleTrades: eligible.length,
    recent200CoveragePct
  };
}

/**
 * Generates shadow report comparing quantPV2 against old quantP.
 */
export function getQuantModelV2ShadowReport(trades: any[]): {
  evaluatedTrades: number;
  aucV2: number | null;
  aucV1: number | null;
  decilesV2: Array<{ decile: number; n: number; winRate: number; avgNetPct: number }>;
} {
  if (!Array.isArray(trades)) {
    return { evaluatedTrades: 0, aucV2: null, aucV1: null, decilesV2: [] };
  }

  const cleanWithPV2 = trades.filter(t => {
    return isCleanLearningTrade(t) && typeof t.entryDiagnostics?.quantPV2 === 'number';
  });

  if (cleanWithPV2.length === 0) {
    return { evaluatedTrades: 0, aucV2: null, aucV1: null, decilesV2: [] };
  }

  const labels = cleanWithPV2.map(t => {
    const ret = netReturnPct(t);
    return (ret > 0 || t.outcome === 1 || t.outcome === 'WIN') ? 1 : 0;
  });

  const pV2List = cleanWithPV2.map(t => t.entryDiagnostics.quantPV2);
  const aucV2 = calculateAuc(labels, pV2List);

  // Compare with old quantP where available
  let aucV1: number | null = null;
  const withV1 = cleanWithPV2.filter(t => typeof t.entryDiagnostics?.quantP === 'number');
  if (withV1.length > 0) {
    const yV1 = withV1.map(t => {
      const ret = netReturnPct(t);
      return (ret > 0 || t.outcome === 1 || t.outcome === 'WIN') ? 1 : 0;
    });
    const pV1 = withV1.map(t => t.entryDiagnostics.quantP);
    aucV1 = calculateAuc(yV1, pV1);
  }

  // Decile table for V2
  const deciles: Array<{ decile: number; n: number; winRate: number; avgNetPct: number }> = [];
  for (let d = 0; d < 10; d++) {
    const minP = d / 10;
    const maxP = (d + 1) / 10;
    const inDecile = cleanWithPV2.filter(t => {
      const p = t.entryDiagnostics.quantPV2;
      return d === 9 ? (p >= minP && p <= maxP) : (p >= minP && p < maxP);
    });

    const n = inDecile.length;
    let wins = 0;
    let sumNet = 0;
    for (const t of inDecile) {
      const ret = netReturnPct(t);
      sumNet += ret;
      if (ret > 0 || t.outcome === 1 || t.outcome === 'WIN') wins++;
    }

    deciles.push({
      decile: d + 1,
      n,
      winRate: n > 0 ? Number((wins / n).toFixed(4)) : 0,
      avgNetPct: n > 0 ? Number((sumNet / n).toFixed(4)) : 0
    });
  }

  return {
    evaluatedTrades: cleanWithPV2.length,
    aucV2,
    aucV1,
    decilesV2: deciles
  };
}

/**
 * Resets memory state (for testing).
 */
export function resetQuantModelV2ForTest(): void {
  cachedModelV2 = null;
  lastTrainCount = 0;
  if (retrainDebounceTimer) {
    clearTimeout(retrainDebounceTimer);
    retrainDebounceTimer = null;
  }
}

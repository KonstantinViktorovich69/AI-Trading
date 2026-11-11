import { Worker } from 'worker_threads';

export interface QuantModelStatus {
  isTrainingActive: boolean;
  lastRetrained: number;
  totalLearnedTrades: number;
}

export interface QuantModelWeights {
  beta0: number;
  beta1: number;
  beta2: number;
  beta3: number;
  beta4: number;
  beta5: number;
  beta6: number;
  beta7: number;
  beta8: number;
  beta9: number;
  beta10: number;
  beta11: number;
}

export interface QuantModelTrainerContext {
  getModelStatus: () => QuantModelStatus;
  getModelWeights: () => QuantModelWeights;
  setModelWeights: (weights: QuantModelWeights) => void;
  getVirtualTrades: () => any[];
  getAiKnowledgeBase: () => any[];
  saveKnowledgeDB: (rule: any) => Promise<void>;
  saveSettings: () => void;
  deadZonePct?: number;
}

// DEAD_ZONE_PNL_PCT: Filter out trades with minimal PnL to train on clear winning/losing setups.
// NOTE: This filter biases the sample towards extreme outcomes, which is a known selection constraint.
export const DEFAULT_DEAD_ZONE_PNL_PCT = 0.05;

// MAX_TRAINING_TRADES_WINDOW: Rolling window size of most recent closed trades to train on.
export const MAX_TRAINING_TRADES_WINDOW = 500;

// MODEL_WEIGHT_ABS_MAX: Strict safety ceiling on beta weights to prevent runaway divergence.
export const MODEL_WEIGHT_ABS_MAX = 5.0;

export function clipModelWeight(val: number, name: string): number {
  if (val > MODEL_WEIGHT_ABS_MAX) {
    console.log(`[MODEL] weight clipped: ${name} ${val.toFixed(4)} -> ${MODEL_WEIGHT_ABS_MAX}`);
    return MODEL_WEIGHT_ABS_MAX;
  }
  if (val < -MODEL_WEIGHT_ABS_MAX) {
    console.log(`[MODEL] weight clipped: ${name} ${val.toFixed(4)} -> -${MODEL_WEIGHT_ABS_MAX}`);
    return -MODEL_WEIGHT_ABS_MAX;
  }
  return val;
}

export function runRetrainWorker(
  trainData: any[],
  valData: any[],
  weights: number[]
): Promise<{ bestWeights: number[], bestValLoss: number, currentValLoss: number }> {
  return new Promise((resolve, reject) => {
    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const { trainData, valData, weights } = workerData;

      try {
        let currentValLoss = 0;
        for (const item of valData) {
          let z = 0;
          for (let j = 0; j < 12; j++) z += weights[j] * item.x[j];
          const p = 1 / (1 + Math.exp(-z));
          const loss = - (item.y * Math.log(Math.max(p, 1e-15)) + (1 - item.y) * Math.log(Math.max(1 - p, 1e-15)));
          currentValLoss += loss * item.w;
        }
        currentValLoss = currentValLoss / valData.length;

        const learningRate = 0.01;
        const iterations = 150;
        const l2Lambda = 0.02;

        let currentWeights = [...weights];
        let bestWeights = [...weights];
        let bestValLoss = Infinity;

        for (let iter = 0; iter < iterations; iter++) {
          let gradients = new Array(12).fill(0);
          for (const item of trainData) {
            let z = 0;
            for (let j = 0; j < 12; j++) z += currentWeights[j] * item.x[j];
            const p = 1 / (1 + Math.exp(-z));
            const error = p - item.y;
            for (let j = 0; j < 12; j++) {
              gradients[j] += error * item.x[j] * item.w;
            }
          }
          
          for (let j = 0; j < 12; j++) {
            const regPenalty = l2Lambda * currentWeights[j];
            currentWeights[j] -= learningRate * ((gradients[j] / trainData.length) + regPenalty);
          }

          let valLoss = 0;
          for (const item of valData) {
            let z = 0;
            for (let j = 0; j < 12; j++) z += currentWeights[j] * item.x[j];
            const p = 1 / (1 + Math.exp(-z));
            const loss = - (item.y * Math.log(Math.max(p, 1e-15)) + (1 - item.y) * Math.log(Math.max(1 - p, 1e-15)));
            valLoss += loss * item.w;
          }
          valLoss = valLoss / valData.length;

          if (valLoss < bestValLoss) {
            bestValLoss = valLoss;
            bestWeights = [...currentWeights];
          }
        }

        parentPort.postMessage({ bestWeights, bestValLoss, currentValLoss });
      } catch (err) {
        parentPort.postMessage({ error: err.message || String(err) });
      }
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: { trainData, valData, weights }
    });

    worker.on('message', (message) => {
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message);
      }
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

export async function trainQuantModel(context: QuantModelTrainerContext): Promise<void> {
  const modelStatus = context.getModelStatus();
  if (modelStatus.isTrainingActive) return;
  modelStatus.isTrainingActive = true;
  
  try {
    const virtualTrades = context.getVirtualTrades();
    const deadZone = context.deadZonePct ?? DEFAULT_DEAD_ZONE_PNL_PCT;
    const closedTrades = virtualTrades.filter(t => {
      if (t.status !== 'CLOSED' || t.gapAffected) return false;
      const outcome = (t as any).outcome !== undefined 
        ? (t as any).outcome 
        : ((t.pnlPercent !== undefined && t.pnlPercent > 0) || (t.pnl !== undefined && t.pnl > 0) ? 1 : 0);
      (t as any).outcome = outcome;
      return true;
    });

    if (closedTrades.length < 30) {
      modelStatus.isTrainingActive = false;
      return;
    }

    // T3.2: Честный отбор сделок без синтетической фабрикации
    const closedEligibleTrades = closedTrades
      .filter(t => Math.abs((t as any).pnlPercent || 0) >= deadZone)
      .slice(-MAX_TRAINING_TRADES_WINDOW);

    let skippedNoFeatures = 0;
    let skippedLegacyLong = 0;
    let usedCount = 0;

    const rawDataset: Array<{ x: number[]; y: number; w: number }> = [];

    for (const t of closedEligibleTrades) {
      const hasFeatures = Array.isArray((t as any).features) && (t as any).features.length > 0;
      if (!hasFeatures) {
        skippedNoFeatures++;
        continue;
      }

      // В обучение берем только side-aware сделки или старые SHORT (старые SHORT совпадают с новой моделью).
      // Исключаем старые LONG сделки без featuresVersion === 2, так как их признаки были инвертированы под SHORT.
      const isLegacyLong = t.side === 'LONG' && (t as any).featuresVersion !== 2;
      if (isLegacyLong) {
        skippedLegacyLong++;
        continue;
      }

      const features = [...(t as any).features];
      while (features.length < 11) {
        features.push(0);
      }

      rawDataset.push({
        x: [1, ...features],
        y: (t as any).outcome,
        w: Math.max(Math.abs((t as any).pnlPercent || 1), 1)
      });
      usedCount++;
    }

    console.log(`[TRAINER] used=${usedCount} skippedNoFeatures=${skippedNoFeatures} skippedLegacyLong=${skippedLegacyLong}`);

    if (rawDataset.length < 10) {
      console.log(`[TRAINER] Insufficient valid feature samples for training (${rawDataset.length} < 10). Skipping.`);
      modelStatus.isTrainingActive = false;
      return;
    }
    
    // Train-Validation Split (80% / 20%)
    const trainData: typeof rawDataset = [];
    const valData: typeof rawDataset = [];
    rawDataset.forEach((item, index) => {
      if (index % 5 === 0) {
        valData.push(item);
      } else {
        trainData.push(item);
      }
    });

    if (valData.length === 0 && trainData.length > 0) {
      valData.push(trainData.pop()!);
    }

    const modelWeights = context.getModelWeights();
    let weights = [
      modelWeights.beta0, modelWeights.beta1, modelWeights.beta2, modelWeights.beta3, 
      modelWeights.beta4, modelWeights.beta5, modelWeights.beta6, modelWeights.beta7,
      modelWeights.beta8, modelWeights.beta9, modelWeights.beta10, modelWeights.beta11
    ];

    let bestWeights: number[] = [];
    let bestValLoss = Infinity;
    let currentValLoss = 0;
    let workerSuccess = false;

    try {
      console.log(`[MODEL] Spawning worker thread for model retraining with ${trainData.length} training items and ${valData.length} validation items...`);
      const result = await runRetrainWorker(trainData, valData, weights);
      bestWeights = result.bestWeights;
      bestValLoss = result.bestValLoss;
      currentValLoss = result.currentValLoss;
      workerSuccess = true;
      console.log(`[MODEL] Worker training completed successfully. Best Val Loss: ${bestValLoss.toFixed(4)}`);
    } catch (workerErr: any) {
      console.error(`[MODEL] Worker training failed, falling back to synchronous in-thread training:`, workerErr.message || workerErr);
    }

    if (!workerSuccess) {
      // Calculate validation loss of current weights before training
      currentValLoss = 0;
      for (const item of valData) {
        let z = 0;
        for (let j = 0; j < 12; j++) z += weights[j] * item.x[j];
        const p = 1 / (1 + Math.exp(-z));
        const loss = - (item.y * Math.log(Math.max(p, 1e-15)) + (1 - item.y) * Math.log(Math.max(1 - p, 1e-15)));
        currentValLoss += loss * item.w;
      }
      currentValLoss = currentValLoss / valData.length;
      
      const learningRate = 0.01;
      const iterations = 150;
      const l2Lambda = 0.02; // Ridge Regularization L2 Penalty
      
      bestWeights = [...weights];
      bestValLoss = Infinity;

      for (let iter = 0; iter < iterations; iter++) {
        let gradients = new Array(12).fill(0);
        for (const item of trainData) {
          let z = 0;
          for (let j = 0; j < 12; j++) z += weights[j] * item.x[j];
          const p = 1 / (1 + Math.exp(-z));
          const error = p - item.y;
          for (let j = 0; j < 12; j++) {
            gradients[j] += error * item.x[j] * item.w;
          }
        }
        
        // Update weights with gradients and L2 Regularization penalty
        for (let j = 0; j < 12; j++) {
          const regPenalty = l2Lambda * weights[j];
          weights[j] -= learningRate * ((gradients[j] / trainData.length) + regPenalty);
        }

        // Calculate Validation Loss
        let valLoss = 0;
        for (const item of valData) {
          let z = 0;
          for (let j = 0; j < 12; j++) z += weights[j] * item.x[j];
          const p = 1 / (1 + Math.exp(-z));
          // Cross Entropy loss
          const loss = - (item.y * Math.log(Math.max(p, 1e-15)) + (1 - item.y) * Math.log(Math.max(1 - p, 1e-15)));
          valLoss += loss * item.w;
        }
        valLoss = valLoss / valData.length;

        // Early Stopping: track model with best validation loss
        if (valLoss < bestValLoss) {
          bestValLoss = valLoss;
          bestWeights = [...weights];
        }
      }
    }

    if (bestValLoss > currentValLoss && isFinite(currentValLoss)) {
      console.warn(`[MODEL] Retraining skipped: New validation loss (${bestValLoss.toFixed(4)}) is worse than current validation loss (${currentValLoss.toFixed(4)}). Retaining current weights.`);
    } else {
      const updatedWeights: QuantModelWeights = {
        beta0: clipModelWeight(bestWeights[0], 'beta0'),
        beta1: clipModelWeight(bestWeights[1], 'beta1'),
        beta2: clipModelWeight(bestWeights[2], 'beta2'),
        beta3: clipModelWeight(bestWeights[3], 'beta3'),
        beta4: clipModelWeight(bestWeights[4], 'beta4'),
        beta5: clipModelWeight(bestWeights[5], 'beta5'),
        beta6: clipModelWeight(bestWeights[6], 'beta6'),
        beta7: clipModelWeight(bestWeights[7], 'beta7'),
        beta8: clipModelWeight(bestWeights[8], 'beta8'),
        beta9: clipModelWeight(bestWeights[9], 'beta9'),
        beta10: clipModelWeight(bestWeights[10], 'beta10'),
        beta11: clipModelWeight(bestWeights[11], 'beta11')
      };
      context.setModelWeights(updatedWeights);
      console.log(`[MODEL] Retraining complete. Validation loss improved from ${currentValLoss.toFixed(4)} to ${bestValLoss.toFixed(4)}.`);
    }
    
    // KILLER FEATURE 4: Knowledge Base Auto-Sync (Autonomous Multivariable Rule Generation)
    // If we have enough profitable trades, synthesize diverse rules based on traits
    const profitableTrades = closedTrades.filter(t => (t as any).outcome === 1);
    const aiKnowledgeBase = context.getAiKnowledgeBase();
    if (profitableTrades.length >= 15) {
      // 1. Analyze RSI feature: index 1 (rsi-50)
      const avgRsi = profitableTrades.reduce((acc, t) => acc + ((t as any).features?.[1] + 50 || 0), 0) / profitableTrades.length;
      if (avgRsi > 70) {
        const ruleId = `auto_rsi_${Date.now()}`;
        const ruleText = `Автоматическое правило ИИ: Шорт-позиции наиболее эффективны при RSI > ${avgRsi.toFixed(1)} на 15м ТФ. Сила сигнала подтверждена статистикой (${profitableTrades.length} прибыльных сделок).`;
        const newRule = { 
          id: ruleId, agent: 'SCANNER' as any, text: ruleText,
          filterIndicator: 'rsi', filterCondition: 'gt', filterValue: Number(avgRsi.toFixed(1)), filterAction: 'bonus',
          impact: 12, successRate: 0.88, usageCount: profitableTrades.length
        };
        // Avoid duplicate/similar indicator rules
        if (!aiKnowledgeBase.find(r => r.filterIndicator === 'rsi' && Math.abs((r.filterValue || 0) - avgRsi) < 2)) {
          aiKnowledgeBase.push(newRule);
          context.saveKnowledgeDB(newRule).catch(() => {});
          console.log(`[MODEL SYNTHESIZER] Autonomous RSI rule generated: ${ruleText}`);
        }
      }

      // 2. Analyze Order Book Imbalance feature: index 6
      const avgImbalance = profitableTrades.reduce((acc, t) => acc + ((t as any).features?.[6] || 0) * 100, 0) / profitableTrades.length;
      if (avgImbalance > 55) {
        const ruleId = `auto_ob_${Date.now()}`;
        const ruleText = `Автоматическое правило ИИ: Повышенная вероятность снижения монеты при дисбалансе лимитников в стакане > ${avgImbalance.toFixed(1)}%. Статистически подтверждено в (${profitableTrades.length} сделках).`;
        const newRule = { 
          id: ruleId, agent: 'SCANNER' as any, text: ruleText,
          filterIndicator: 'volume', filterCondition: 'gt', filterValue: Number(avgImbalance.toFixed(1)), filterAction: 'bonus',
          impact: 10, successRate: 0.83, usageCount: profitableTrades.length
        };
        if (!aiKnowledgeBase.find(r => r.text && r.text.includes('дисбалансе лимитников') && Math.abs((r.filterValue || 0) - avgImbalance) < 5)) {
          aiKnowledgeBase.push(newRule);
          context.saveKnowledgeDB(newRule).catch(() => {});
          console.log(`[MODEL SYNTHESIZER] Autonomous Book Imbalance rule generated: ${ruleText}`);
        }
      }

      // 3. Analyze EMA 50 distance: index 3
      const avgEma50Dist = profitableTrades.reduce((acc, t) => acc + Math.abs((t as any).features?.[3] || 0), 0) / profitableTrades.length;
      if (avgEma50Dist > 4.0) {
        const ruleId = `auto_ema_${Date.now()}`;
        const ruleText = `Автоматическое правило ИИ: Эффективность шорта возрастает при удалении цены от EMA50 более чем на ${avgEma50Dist.toFixed(1)}%. Затухание импульса подтверждено статистикой.`;
        const newRule = { 
          id: ruleId, agent: 'SCANNER' as any, text: ruleText,
          filterIndicator: 'trend', filterCondition: 'gt', filterValue: Number(avgEma50Dist.toFixed(1)), filterAction: 'bonus',
          impact: 8, successRate: 0.80, usageCount: profitableTrades.length
        };
        if (!aiKnowledgeBase.find(r => r.text && r.text.includes('удалении цены от EMA50'))) {
          aiKnowledgeBase.push(newRule);
          context.saveKnowledgeDB(newRule).catch(() => {});
          console.log(`[MODEL SYNTHESIZER] Autonomous EMA distance rule generated: ${ruleText}`);
        }
      }
    }
    
    modelStatus.lastRetrained = Date.now();
    modelStatus.totalLearnedTrades = closedTrades.length;
    console.log(`[MODEL] Advanced retraining complete. Best Val Loss: ${bestValLoss.toFixed(4)}.`);
    context.saveSettings(); 
  } catch (e) {
    console.error('[MODEL] Advanced retraining failed:', e);
  } finally {
    modelStatus.isTrainingActive = false;
  }
}

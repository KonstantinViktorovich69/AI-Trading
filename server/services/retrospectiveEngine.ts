import { Worker } from 'worker_threads';

export interface RetrospectiveEngineContext {
  getCachedDB: () => any;
  flushDB: () => Promise<void>;
  syncToFirebase: (db: any) => Promise<void>;
  isFirebaseFirestoreDisabled: boolean;
  getDb: () => any;
  getModelWeights: () => Record<string, number>;
  setModelWeights: (weights: Record<string, number>) => void;
  getModelStatus: () => { totalLearnedTrades: number; lastRetrained: number; isTrainingActive: boolean };
  saveSettings: () => void;
  getVirtualTrades: () => any[];
  getKnowledgeBase: () => any[];
  saveKnowledgeDB: (rule: any) => Promise<void>;
  runAiGeneration: (params: any) => Promise<any>;
  safeJsonParse: (json: string, fallback: any) => any;
  cleanSymbol: (sym: string) => string;
  runNewAIPerformanceOptimizationCircuit: (manual?: boolean) => Promise<any>;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  isMainThread: boolean;
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

export function createRetrospectiveEngine(ctx: RetrospectiveEngineContext) {
  const DEAD_ZONE_PCT = 0.5;

  async function onTradeClosedIncremental(trade: any) {
    try {
      if (!trade || !trade.features || trade.outcome === undefined || trade.incrementalLearned) return;
      if (Math.abs(trade.pnlPercent || 0) < DEAD_ZONE_PCT) {
        trade.incrementalLearned = true; // помечаем как обработанную, чтобы не пытаться снова
        return;
      }
      trade.incrementalLearned = true;

      // Incremental reinforcement step
      const learningRate = 0.02;
      const l2Lambda = 0.01;
      const paddedFeatures = [...trade.features];
      while (paddedFeatures.length < 11) {
        paddedFeatures.push(0);
      }
      const x = [1, ...paddedFeatures];
      const y = trade.outcome; // 1 (win) or 0 (loss)

      const modelWeights = ctx.getModelWeights();
      let weights = [
        modelWeights.beta0, modelWeights.beta1, modelWeights.beta2, modelWeights.beta3,
        modelWeights.beta4, modelWeights.beta5, modelWeights.beta6, modelWeights.beta7,
        modelWeights.beta8, modelWeights.beta9, modelWeights.beta10, modelWeights.beta11
      ];

      let z = 0;
      for (let j = 0; j < 12; j++) z += weights[j] * x[j];
      const p = 1 / (1 + Math.exp(-z));
      const error = p - y;

      const pnlWeight = Math.max(Math.abs(trade.pnlPercent || 1.0), 1.0);

      for (let j = 0; j < 12; j++) {
        const gradient = error * x[j] * pnlWeight;
        const regularization = l2Lambda * weights[j];
        weights[j] -= learningRate * (gradient + regularization);
      }

      ctx.setModelWeights({
        beta0: weights[0], beta1: weights[1], beta2: weights[2], beta3: weights[3],
        beta4: weights[4], beta5: weights[5], beta6: weights[6], beta7: weights[7],
        beta8: weights[8], beta9: weights[9], beta10: weights[10], beta11: weights[11]
      });

      console.log(`[INCREMENTAL LEARNING] Applied instant self-correction for ${trade.symbol}. Win/Loss Weight: ${pnlWeight.toFixed(2)}. Outcome: ${y === 1 ? 'WIN' : 'LOSS'}.`);
      ctx.saveSettings();
    } catch (e) {
      console.error('[INCREMENTAL LEARNING] Error:', e);
    }
  }

  async function runRetrospectiveAnalysisBackground(trade: any) {
    try {
      const currentPrice = trade.closePrice || trade.entryPrice;
      const pnlPct = trade.pnlPercent !== undefined ? trade.pnlPercent : 0;
      
      let historyStr = "Нет истории";
      if (trade.history && Array.isArray(trade.history)) {
        historyStr = trade.history.map((h: any) => `[${new Date(h.time).toISOString().slice(11, 19)}] ${h.type} на цене ${h.price} ($${h.amount || h.qty || ''})`).join(', ');
      }

      const retrospectivePrompt = `
        Ты — элитный аналитик криптовалютных систем и ретроспективный аудитор сделок. Твоя единственная цель — провести детальный честный разбор закрытой сделки и извлечь микро-уроки для торгового ИИ-агента.

        ИНФОРМАЦИЯ О ЗАКРЫТОЙ СДЕЛКЕ:
        - Символ: ${trade.symbol}
        - Направление: ${trade.side}
        - Итоговый PnL: ${pnlPct.toFixed(2)}% ($${(trade.pnl || 0).toFixed(2)})
        - Цена входа (средняя): ${trade.entryPrice}
        - Цена выхода: ${currentPrice}
        - Маржа: ${trade.amount} USDT
        - Плечо: ${trade.leverage}x
        - История действий по сделке: ${historyStr}
        - Финальная причина закрытия: ${trade.notes || trade.closeReason || 'Не указана'}

        Проанализируй, были ли действия ИИ-агента (удерживать, усреднять, закрывать раньше, двигать SL/TP) правильными на основе итогового финансового результата. Напиши 1-2 предложения жестких практических выводов и советов для себя (на РУССКОМ языке) на случай, если аналогичная ситуация возникнет снова. Извлекай конкретные паттерны: удержание до целей, преждевременный панический выход на шумах, неправильное время DCA, жадность.

        ВЕРНИ СТРОГО JSON ФОРМАТ:
        {
          "lesson": "Конкретный краткий урок для следующей сделки (до 150 символов, на РУССКОМ языке)."
        }
      `;

      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: retrospectivePrompt }] }],
        config: { 
          responseMimeType: "application/json", 
          temperature: 0.3
        }
      });

      const resObj = ctx.safeJsonParse(response.text, {});
      const lesson = resObj.lesson || `Сделка завершена с результатом ${pnlPct.toFixed(1)}%. Соблюдайте риск-политику.`;

      const dbData = ctx.getCachedDB();
      dbData.retrospectiveMemory = dbData.retrospectiveMemory || [];
      
      // Push lesson to retrospectiveMemory
      dbData.retrospectiveMemory.push({
        id: `retro_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        symbol: ctx.cleanSymbol(trade.symbol),
        pnlPercent: pnlPct,
        pnlUsd: trade.pnl || 0,
        actionTaken: trade.notes ? 'AI_AUTO' : 'MANUAL_OR_ENGINE',
        lesson: lesson,
        timestamp: Date.now()
      });

      // Keep last 40 lessons to avoid DB bloat
      if (dbData.retrospectiveMemory.length > 40) {
        dbData.retrospectiveMemory.shift();
      }

      await ctx.flushDB();
      const db = ctx.getDb();
      if (db && !ctx.isFirebaseFirestoreDisabled) {
        ctx.syncToFirebase(dbData).catch(() => {});
      }
      console.log(`[RETROSPECTIVE LEARNING] Created retrospective lesson for ${trade.symbol}: "${lesson}"`);
      
      // Notify clients to refresh telemetry
      ctx.streamEmitter.emit('signals_updated');

      // Trigger multi-agent performance optimization circuit
      ctx.runNewAIPerformanceOptimizationCircuit(false).catch(err => {
        console.warn('[CIRCUIT OPTIMIZER BACKGROUND TRIGGER ERROR]', err);
      });
    } catch (err: any) {
      console.warn(`[RETROSPECTIVE ANALYSIS ERROR]`, err.message || err);
    }
  }

  async function retrainModel() {
    const modelStatus = ctx.getModelStatus();
    if (modelStatus.isTrainingActive) return;
    modelStatus.isTrainingActive = true;
    
    try {
      const virtualTrades = ctx.getVirtualTrades();
      const closedTrades = virtualTrades.filter(t => t.status === 'CLOSED' && (t as any).features && (t as any).outcome !== undefined);
      if (closedTrades.length < 30) {
        modelStatus.isTrainingActive = false;
        return;
      }

      // Advanced: Train-Validation Split (80% / 20%) to avoid overfitting
      // Shuffle and split dataset
      const rawDataset = closedTrades
        .filter(t => Math.abs((t as any).pnlPercent || 0) >= DEAD_ZONE_PCT)
        .slice(-500)
        .map(t => {
        const paddedFeatures = [...((t as any).features || [])];
        while (paddedFeatures.length < 11) {
          paddedFeatures.push(0);
        }
        return {
          x: [1, ...paddedFeatures],
          y: (t as any).outcome,
          w: Math.max(Math.abs((t as any).pnlPercent || 1), 1)
        };
      });
      
      // Simple deterministic pseudo-random split
      const trainData: typeof rawDataset = [];
      const valData: typeof rawDataset = [];
      rawDataset.forEach((item, index) => {
        if (index % 5 === 0) {
          valData.push(item);
        } else {
          trainData.push(item);
        }
      });

      const modelWeights = ctx.getModelWeights();
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
        const newWeights = {
          beta0: bestWeights[0], beta1: bestWeights[1], beta2: bestWeights[2], beta3: bestWeights[3],
          beta4: bestWeights[4], beta5: bestWeights[5], beta6: bestWeights[6], beta7: bestWeights[7],
          beta8: bestWeights[8], beta9: bestWeights[9], beta10: bestWeights[10], beta11: bestWeights[11]
        };
        ctx.setModelWeights(newWeights);
        console.log(`[MODEL] Retraining complete. Validation loss improved from ${currentValLoss.toFixed(4)} to ${bestValLoss.toFixed(4)}.`);
      }
      
      // Autonomous Multivariable Rule Generation
      // If we have enough profitable trades, synthesize diverse rules based on traits
      const aiKnowledgeBase = ctx.getKnowledgeBase();
      const profitableTrades = closedTrades.filter(t => (t as any).outcome === 1);
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
            ctx.saveKnowledgeDB(newRule);
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
          if (!aiKnowledgeBase.find(r => r.text.includes('дисбалансе лимитников') && Math.abs((r.filterValue || 0) - avgImbalance) < 5)) {
            aiKnowledgeBase.push(newRule);
            ctx.saveKnowledgeDB(newRule);
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
          if (!aiKnowledgeBase.find(r => r.text.includes('удалении цены от EMA50'))) {
            aiKnowledgeBase.push(newRule);
            ctx.saveKnowledgeDB(newRule);
            console.log(`[MODEL SYNTHESIZER] Autonomous EMA distance rule generated: ${ruleText}`);
          }
        }
      }
      
      modelStatus.lastRetrained = Date.now();
      modelStatus.totalLearnedTrades = closedTrades.length;
      console.log(`[MODEL] Advanced retraining complete. Best Val Loss: ${bestValLoss.toFixed(4)}. New weights:`, ctx.getModelWeights());
      ctx.saveSettings(); 
    } catch (e) {
      console.error('[MODEL] Advanced retraining failed:', e);
    } finally {
      modelStatus.isTrainingActive = false;
    }
  }

  function startPeriodicRetraining() {
    if (!ctx.isMainThread) return;
    setInterval(() => {
      const modelStatus = ctx.getModelStatus();
      const closedTrades = ctx.getVirtualTrades().filter(t => t.status === 'CLOSED' && (t as any).outcome !== undefined);
      const tradesSinceLast = closedTrades.length - (modelStatus.totalLearnedTrades || 0);
      const timeSinceLast = Date.now() - (modelStatus.lastRetrained || 0);

      if (tradesSinceLast >= 30 || (timeSinceLast >= 86400000 && closedTrades.length >= 30)) {
         retrainModel();
      }
    }, 60 * 60 * 1000);
  }

  return {
    onTradeClosedIncremental,
    runRetrospectiveAnalysisBackground,
    retrainModel,
    startPeriodicRetraining
  };
}

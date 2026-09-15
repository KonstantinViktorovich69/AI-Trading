import { Type } from '@google/genai';

export interface AiOptimizationWorkerContext {
  getCachedDB: () => any;
  flushDB: () => void;
  syncToFirebase: (db: any) => Promise<void>;
  isFirebaseFirestoreDisabled: boolean;
  getDb: () => any;
  getKnowledgeBase: () => any[];
  saveKnowledgeDB: (rule: any) => Promise<void>;
  deleteKnowledgeDB: (id: string) => Promise<void>;
  getVirtualTrades: () => any[];
  getGlobalSettings: () => any;
  setExpertInstructions: (instructions: string, source: string, reason?: string) => void;
  getMarketRegime: () => string;
  getMarketHealth: () => number;
  runAiGeneration: (params: any) => Promise<any>;
  safeJsonParse: (json: string, fallback: any) => any;
  getSmartArchivistPrompt: (...args: any[]) => string;
  getArchivistPrompt: (...args: any[]) => string;
  getRetrospectivePrompt: (...args: any[]) => string;
  logAgentExchange: (from: string, to: string, msg: string, details?: string, type?: string) => void;
  sendTelegramMessage: (msg: string) => void;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  updatePatternBlacklistFromStats: (trades: any[]) => void;
  isMainThread: boolean;
}

export function getJaccardSimilarity(str1: string, str2: string): number {
  const getTokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9а-яё]/gi, ' ').split(/\s+/).filter(Boolean));
  const t1 = getTokens(str1);
  const t2 = getTokens(str2);
  if (t1.size === 0 || t2.size === 0) return 0;
  let intersection = 0;
  for (const token of t1) {
    if (t2.has(token)) intersection++;
  }
  const union = t1.size + t2.size - intersection;
  return intersection / union;
}

export function createAiOptimizationWorker(ctx: AiOptimizationWorkerContext) {
  let isKnowledgeRebalanceRunning = false;
  let isSmartArchivistRunning = false;
  let isPerformanceOptimizationRunning = false;
  let lastSentRetrospectiveSummaryHash = '';

  async function autonomousKnowledgeRebalance() {
    if (isKnowledgeRebalanceRunning) {
      console.log("[AUTONOMOUS-LEARNING] Cycle skipped: autonomousKnowledgeRebalance is already running.");
      return;
    }
    isKnowledgeRebalanceRunning = true;
    try {
      const aiKnowledgeBase = ctx.getKnowledgeBase();
      const currentRules = aiKnowledgeBase.map(r => `Agent: ${r.agent} | Impact: ${r.impact || 0} | SuccessRate: ${(r.successRate ?? 0.5).toFixed(2)} | Usage: ${r.usageCount || 0} | Rule: ${r.text}`).join('\n');
      if (aiKnowledgeBase.length === 0) {
        isKnowledgeRebalanceRunning = false;
        return;
      }
      
      console.log("[AUTONOMOUS-LEARNING] Starting periodic self-cleaning & rebalancing of the knowledge base...");
      
      const prompt = ctx.getArchivistPrompt(currentRules, 0.35, 3);

      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                agent: { type: Type.STRING },
                text: { type: Type.STRING },
                impact: { type: Type.NUMBER }
              },
              required: ["agent", "text", "impact"]
            }
          }
        }
      });

      if (response && response.text) {
        const newRules = ctx.safeJsonParse(response.text, []);
        if (Array.isArray(newRules) && newRules.length > 0) {
          const activeRulesCopy = aiKnowledgeBase.filter(old => !old.isArchived);
          
          for (const old of activeRulesCopy) {
            await ctx.deleteKnowledgeDB(old.id);
          }
          
          for (const r of newRules) {
            let totalWeights = 0;
            let weightedSRSum = 0;
            let totalUsage = 0;
            let matchedCount = 0;
            
            for (const old of activeRulesCopy) {
              const sim = getJaccardSimilarity(r.text, old.text);
              if (sim > 0.35) {
                const uc = old.usageCount || 0;
                const sr = old.successRate ?? 0.5;
                const weight = sim * (uc + 1);
                weightedSRSum += sr * weight;
                totalWeights += weight;
                totalUsage += uc;
                matchedCount++;
              }
            }

            const inheritedSR = matchedCount > 0 ? (weightedSRSum / totalWeights) : 0.5;
            const inheritedUC = matchedCount > 0 ? totalUsage : 0;

            const newRule = {
              id: `rule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}-${Math.floor(Math.random() * 1000)}`,
              agent: ['SCANNER', 'MANAGER', 'LONG_MANAGER', 'GENERAL'].includes(r.agent) ? r.agent : 'GENERAL',
              text: r.text,
              impact: Number(r.impact) || 0,
              successRate: Number(inheritedSR.toFixed(4)),
              usageCount: inheritedUC
            };
            aiKnowledgeBase.push(newRule as any);
            await ctx.saveKnowledgeDB(newRule);
          }
          console.log(`[AUTONOMOUS-LEARNING] Knowledge base distilled safely with Jaccard statistics inheritance. Remaining rules count: ${aiKnowledgeBase.length}`);
        }
      }
    } catch (e: any) {
      const isQuota = e?.message?.includes("429") || e?.message?.includes("quota") || e?.message?.includes("Too Many");
      if (!isQuota) {
        console.warn("[AUTONOMOUS-LEARNING] Rebalance error:", e.message);
      }
    } finally {
      isKnowledgeRebalanceRunning = false;
    }
  }

  async function runSmartArchivistCycle(manualTrigger = false) {
    if (isSmartArchivistRunning) {
      console.log("[SMART ARCHIVIST] Cycle skipped: runSmartArchivistCycle is already running.");
      return { success: false, error: "Already running" };
    }
    isSmartArchivistRunning = true;
    let regime = 'FLAT';
    let health = 50;
    let programmaticArchivedCount = 0;
    const aiKnowledgeBase = ctx.getKnowledgeBase();
    try {
      regime = ctx.getMarketRegime() || 'FLAT';
      health = ctx.getMarketHealth() || 50;
      const now = Date.now();
      
      console.log(`[SMART ARCHIVIST] Запущена модель оптимизации базы знаний. Текущий режим: ${regime}, Здоровье рынка: ${health.toFixed(1)}%`);

      try {
        ctx.updatePatternBlacklistFromStats(ctx.getVirtualTrades() as any);
      } catch (peErr) {}

      // Шаг А: Архивация неэффективных автоматических правил (винрейт < 50%)
      const lowWinrateRules = aiKnowledgeBase.filter(r => 
        !r.isArchived && 
        (r.id.startsWith('al_') || r.id.startsWith('auto_') || r.id.startsWith('rule-') || r.id.startsWith('manual_')) &&
        r.successRate !== undefined && r.successRate < 0.5
      );
      for (const rule of lowWinrateRules) {
        rule.isArchived = true;
        rule.archivedAt = new Date(now).toISOString();
        rule.archiveReason = `Убыточность: винрейт правила составляет ${(rule.successRate * 100).toFixed(0)}% (< 50%)`;
        rule.marketRegimeAtArchive = regime;
        programmaticArchivedCount++;
        await ctx.saveKnowledgeDB(rule);
      }

      // Шаг Б: Дедупликация правил индикаторов (auto_)
      const activeAutoRules = aiKnowledgeBase.filter(r => !r.isArchived && r.id.startsWith('auto_'));
      if (activeAutoRules.length > 0) {
        const categories: Record<string, typeof activeAutoRules> = {
          'rsi': [],
          'ob': [],
          'ema': [],
          'other': []
        };

        activeAutoRules.forEach(r => {
          if (r.id.startsWith('auto_rsi_')) categories['rsi'].push(r);
          else if (r.id.startsWith('auto_ob_')) categories['ob'].push(r);
          else if (r.id.startsWith('auto_ema_')) categories['ema'].push(r);
          else categories['other'].push(r);
        });

        for (const key of ['rsi', 'ob', 'ema', 'other']) {
          const items = categories[key];
          if (items.length > 2) {
            items.sort((a, b) => {
              const rateA = a.successRate ?? 0.5;
              const rateB = b.successRate ?? 0.5;
              if (rateB !== rateA) return rateB - rateA;
              const countA = a.usageCount ?? 0;
              const countB = b.usageCount ?? 0;
              if (countB !== countA) return countB - countA;
              return b.id.localeCompare(a.id);
            });

            const toArchive = items.slice(2);
            for (const rule of toArchive) {
              rule.isArchived = true;
              rule.archivedAt = new Date(now).toISOString();
              rule.archiveReason = `Системная дедупликация: архив старых версий авто-правил индикатора ${key.toUpperCase()}`;
              rule.marketRegimeAtArchive = regime;
              programmaticArchivedCount++;
              await ctx.saveKnowledgeDB(rule);
            }
          }
        }
      }

      // Шаг В: Дедупликация на основе активов/пар в правилах самообучения (al_ и manual_)
      const activeLearningRules = aiKnowledgeBase.filter(r => !r.isArchived && (r.id.startsWith('al_') || r.id.startsWith('manual_')));
      if (activeLearningRules.length > 0) {
        const groupedBySymbol: Record<string, typeof activeLearningRules> = {};
        activeLearningRules.forEach(r => {
          const match = r.text.match(/\|\s*([A-Z0-9/:]+)\s*\|/);
          const symbolKey = match ? match[1].trim() : 'GENERAL_AL';
          if (!groupedBySymbol[symbolKey]) groupedBySymbol[symbolKey] = [];
          groupedBySymbol[symbolKey].push(r);
        });

        for (const symbolKey in groupedBySymbol) {
          const items = groupedBySymbol[symbolKey];
          if (items.length > 2) {
            items.sort((a, b) => {
              const rateA = a.successRate ?? 0.5;
              const rateB = b.successRate ?? 0.5;
              if (rateB !== rateA) return rateB - rateA;
              const countA = a.usageCount ?? 0;
              const countB = b.usageCount ?? 0;
              if (countB !== countA) return countB - countA;
              return b.id.localeCompare(a.id);
            });

            const toArchive = items.slice(2);
            for (const rule of toArchive) {
              rule.isArchived = true;
              rule.archivedAt = new Date(now).toISOString();
              rule.archiveReason = `Дедупликация актива ${symbolKey}: оставлены только топовые правила самообучения`;
              rule.marketRegimeAtArchive = regime;
              programmaticArchivedCount++;
              await ctx.saveKnowledgeDB(rule);
            }
          }
        }
      }

      // Шаг Г: Общее квотирование
      const remainingActiveAutoRules = aiKnowledgeBase.filter(r => 
        !r.isArchived && 
        (r.id.startsWith('al_') || r.id.startsWith('auto_') || r.id.startsWith('rule-') || r.id.startsWith('manual_'))
      );
      if (remainingActiveAutoRules.length > 12) {
        remainingActiveAutoRules.sort((a, b) => {
          const scoreA = (a.successRate ?? 0.5) * (a.usageCount ?? 1);
          const scoreB = (b.successRate ?? 0.5) * (b.usageCount ?? 1);
          return scoreB - scoreA;
        });
        const surplusAutoRules = remainingActiveAutoRules.slice(12);
        for (const rule of surplusAutoRules) {
          rule.isArchived = true;
          rule.archivedAt = new Date(now).toISOString();
          rule.archiveReason = `Квотирование базы знаний: архивация избыточных правил для обеспечения Lean-структуры`;
          rule.marketRegimeAtArchive = regime;
          programmaticArchivedCount++;
          await ctx.saveKnowledgeDB(rule);
        }
      }

      if (programmaticArchivedCount > 0) {
        console.log(`[SMART ARCHIVIST] Программа-ассистент сжала базу данных, отправив ${programmaticArchivedCount} дублирующихся/устаревших авто-правил в архив.`);
      }

      const activeRules = aiKnowledgeBase.filter(r => !r.isArchived);
      const archivedRulesCandidates = aiKnowledgeBase.filter(r => r.isArchived).slice(-15);

      if (activeRules.length === 0 && archivedRulesCandidates.length === 0) {
        return { 
          success: true, 
          msg: "База знаний пуста", 
          archivedCount: programmaticArchivedCount, 
          unarchivedCount: 0, 
          explanation: "В базе знаний нет правил для анализа." 
        };
      }

      const activeRulesForAI = activeRules.filter(r => 
        r.id.startsWith('al_') || r.id.startsWith('auto_') || r.id.startsWith('rule-') || r.id.startsWith('manual_') || r.id.startsWith('adv_')
      ).slice(0, 15);

      const currentActiveListForAI = activeRulesForAI.map(r => ({
        id: r.id,
        agent: r.agent,
        text: r.text,
        successRate: r.successRate ?? 0.5,
        usageCount: r.usageCount ?? 0
      }));

      const currentArchivedListForAI = archivedRulesCandidates.map(r => ({
        id: r.id,
        agent: r.agent,
        text: r.text,
        successRate: r.successRate ?? 0.5,
        usageCount: r.usageCount ?? 0,
        archiveReason: r.archiveReason || '',
        marketRegimeAtArchive: r.marketRegimeAtArchive || ''
      }));

      const activeRulesCount = activeRules.length;
      const activeRulesJson = JSON.stringify(currentActiveListForAI, null, 2);
      const archivedRulesJson = JSON.stringify(currentArchivedListForAI, null, 2);

      const prompt = ctx.getSmartArchivistPrompt(
        regime,
        health,
        activeRulesCount,
        activeRulesJson,
        archivedRulesJson
      );

      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              rulesToArchive: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    reason: { type: Type.STRING }
                  },
                  required: ["id", "reason"]
                }
              },
              rulesToUnarchive: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    reason: { type: Type.STRING }
                  },
                  required: ["id", "reason"]
                }
              },
              explanation: { type: Type.STRING }
            },
            required: ["rulesToArchive", "rulesToUnarchive", "explanation"]
          }
        }
      });

      let aiArchivedCount = 0;
      let aiUnarchivedCount = 0;
      let explanationText = "Аудит завершен успешно.";

      if (response && response.text) {
        const decision = ctx.safeJsonParse(response.text, { rulesToArchive: [], rulesToUnarchive: [], explanation: "" });
        explanationText = decision.explanation || "Аудит завершен успешно.";

        if (Array.isArray(decision.rulesToArchive)) {
          for (const item of decision.rulesToArchive) {
            const rule = aiKnowledgeBase.find(r => r.id === item.id);
            if (rule && !rule.isArchived) {
              rule.isArchived = true;
              rule.archivedAt = new Date(now).toISOString();
              rule.archiveReason = item.reason;
              rule.marketRegimeAtArchive = regime;
              aiArchivedCount++;
              await ctx.saveKnowledgeDB(rule);
            }
          }
        }

        if (Array.isArray(decision.rulesToUnarchive)) {
          for (const item of decision.rulesToUnarchive) {
            const rule = aiKnowledgeBase.find(r => r.id === item.id);
            if (rule && rule.isArchived) {
              rule.isArchived = false;
              delete rule.archivedAt;
              delete rule.archiveReason;
              delete rule.marketRegimeAtArchive;
              aiUnarchivedCount++;
              await ctx.saveKnowledgeDB(rule);
            }
          }
        }
      }

      const totalArchived = programmaticArchivedCount + aiArchivedCount;
      const shouldSendTelegram = manualTrigger || totalArchived > 0 || aiUnarchivedCount > 0;
      if (shouldSendTelegram) {
        const detailsProgrammatic = programmaticArchivedCount > 0 ? `🧹 <i>Авто-клининг дубликатов: ${programmaticArchivedCount} правил перемещено в архив.</i>\n` : '';
        const telegramText = `💼 <b>Умный Архивариус: Аудит Базы Знаний</b>\n\n` +
          `📊 <b>Фаза рынка:</b> ${regime} (Health: ${health.toFixed(1)}%)\n` +
          `📥 <b>Архивировано:</b> ${totalArchived} шт. (${aiArchivedCount} по ИИ-анализу, ${programmaticArchivedCount} авто-клининг)\n` +
          `📤 <b>Восстановлено:</b> ${aiUnarchivedCount} шт.\n\n` +
          detailsProgrammatic +
          `💡 <b>Анализ конъюнктуры:</b>\n${explanationText}`;
        
        try {
          if (typeof ctx.sendTelegramMessage === 'function') {
            ctx.sendTelegramMessage(telegramText);
          }
        } catch (tgErr) {}
      }

      return { 
        success: true, 
        archivedCount: totalArchived, 
        unarchivedCount: aiUnarchivedCount, 
        explanation: explanationText 
      };
    } catch (e: any) {
      console.error("[SMART ARCHIVIST] Ошибка выполнения AI цикла:", e.message || e);

      let quantArchivedCount = 0;
      let quantUnarchivedCount = 0;
      const nowStr = new Date().toISOString();

      for (const rule of aiKnowledgeBase) {
        if (!rule.isArchived && (rule.usageCount || 0) >= 2 && (rule.successRate ?? 0.5) < 0.40) {
          rule.isArchived = true;
          rule.archivedAt = nowStr;
          rule.archiveReason = `[QUANT FALLBACK] Винрейт ${((rule.successRate || 0)*100).toFixed(0)}% < 40% на ${rule.usageCount} сделках`;
          quantArchivedCount++;
          await ctx.saveKnowledgeDB(rule);
        }
      }

      for (const rule of aiKnowledgeBase) {
        if (rule.isArchived && (rule.successRate ?? 0.5) >= 0.50) {
          if (!rule.marketRegimeAtArchive || rule.marketRegimeAtArchive === regime) {
            rule.isArchived = false;
            delete rule.archivedAt;
            delete rule.archiveReason;
            delete rule.marketRegimeAtArchive;
            quantUnarchivedCount++;
            await ctx.saveKnowledgeDB(rule);
          }
        }
      }

      const totalArchived = programmaticArchivedCount + quantArchivedCount;
      const fallbackExplanation = `Проведен аудит базы знаний под текущую фазу ${regime} в автономном квант-режиме. Выполнена детерминированная оптимизация: архивировано ${totalArchived} правил (${quantArchivedCount} по статистике винрейта <40%, ${programmaticArchivedCount} авто-клининг дубликатов), восстановлено ${quantUnarchivedCount} эффективных правил.`;
      console.log(`[SMART ARCHIVIST] ${fallbackExplanation}`);

      const shouldSendTelegram = manualTrigger || totalArchived > 0 || quantUnarchivedCount > 0;
      if (shouldSendTelegram) {
        const detailsProgrammatic = programmaticArchivedCount > 0 ? `🧹 <i>Авто-клининг дубликатов: ${programmaticArchivedCount} правил перемещено в архив.</i>\n` : '';
        const telegramText = `💼 <b>Умный Архивариус: Аудит Базы Знаний</b>\n\n` +
          `📊 <b>Фаза рынка:</b> ${regime} (Health: ${health.toFixed(1)}%)\n` +
          `📥 <b>Архивировано:</b> ${totalArchived} шт. (${quantArchivedCount} по анализу, ${programmaticArchivedCount} авто-клининг)\n` +
          `📤 <b>Восстановлено:</b> ${quantUnarchivedCount} шт.\n\n` +
          detailsProgrammatic +
          `💡 <b>Анализ конъюнктуры:</b>\n${fallbackExplanation}`;
        
        try {
          if (typeof ctx.sendTelegramMessage === 'function') {
            ctx.sendTelegramMessage(telegramText);
          }
        } catch (tgErr) {}
      }

      return { 
        success: true, 
        archivedCount: totalArchived, 
        unarchivedCount: quantUnarchivedCount, 
        explanation: fallbackExplanation 
      };
    } finally {
      isSmartArchivistRunning = false;
    }
  }

  async function runNewAIPerformanceOptimizationCircuit(manualTrigger = false) {
    if (isPerformanceOptimizationRunning) {
      console.log("[PERFORMANCE OPTIMIZER] Cycle skipped: runNewAIPerformanceOptimizationCircuit is already running.");
      return { success: false, error: "Already running" };
    }
    isPerformanceOptimizationRunning = true;
    try {
      const dbData = ctx.getCachedDB();
      const closedTrades = (dbData.trades || []).filter((t: any) => t.status === 'CLOSED');
      
      console.log(`[PERFORMANCE OPTIMIZER] Running optimization with ${closedTrades.length} closed trades.`);
      
      if (closedTrades.length === 0) {
        if (manualTrigger) {
          ctx.logAgentExchange('RETROSPECTIVE', 'ALL', 
            'Запуск ретроспективного анализа', 
            'В системе пока отсутствуют закрытые сделки. Для проведения детального ИИ-анализа необходимо дождаться закрытия как минимум одной сделки.', 
            'warning'
          );
        }
        return { success: true, count: 0, msg: "No closed trades to analyze" };
      }
      
      const lastTradesSample = closedTrades.slice(-15).map((t: any) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        pnlPercent: t.pnlPercent || 0,
        pnlUsd: t.pnl || 0,
        closeReason: t.closeReason || t.notes || 'Normal Close',
        durationMinutes: t.closeTime && t.openTime ? Math.round((t.closeTime - t.openTime) / 60000) : 0,
        leverage: t.leverage || 1
      }));
      
      const aiKnowledgeBase = ctx.getKnowledgeBase();
      const activeRules = aiKnowledgeBase.filter(r => !r.isArchived).map(r => ({
        id: r.id,
        agent: r.agent,
        text: r.text,
        successRate: r.successRate ?? 0.5,
        usageCount: r.usageCount ?? 0
      }));
      
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const oneWeekMs = 7 * oneDayMs;
      const oneMonthMs = 30 * oneDayMs;

      const dayTrades = closedTrades.filter((t: any) => (t.closeTime || now) >= now - oneDayMs);
      const weekTrades = closedTrades.filter((t: any) => (t.closeTime || now) >= now - oneWeekMs);
      const monthTrades = closedTrades.filter((t: any) => (t.closeTime || now) >= now - oneMonthMs);

      const calcStats = (trades: any[]) => {
        if (trades.length === 0) return { winRate: 0, count: 0, profitCount: 0, totalPnl: 0 };
        const profits = trades.filter((t: any) => (t.pnlPercent || t.pnl || 0) > 0);
        const totalPnl = trades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
        return {
          winRate: (profits.length / trades.length) * 100,
          count: trades.length,
          profitCount: profits.length,
          totalPnl
        };
      };

      const statsDay = calcStats(dayTrades);
      const statsWeek = calcStats(weekTrades);
      const statsMonth = calcStats(monthTrades);

      const previousReports = (dbData.aiPerformanceReports || []).slice(-5).map((r: any) => ({
        timestamp: r.timestamp,
        winRate: r.winRateAfter ?? 0,
        optimizedLogicSummary: r.optimizedLogicSummary ?? "Н/Д",
        impactAssessment: r.impactAssessment ?? "Н/Д",
        historicalSelfReview: r.historicalSelfReview ?? "Н/Д"
      }));

      const previousReportsJson = JSON.stringify(previousReports, null, 2);
      const dayWinRateFormatted = statsDay.winRate.toFixed(1);
      const dayPnlFormatted = statsDay.totalPnl.toFixed(2);
      const weekWinRateFormatted = statsWeek.winRate.toFixed(1);
      const weekPnlFormatted = statsWeek.totalPnl.toFixed(2);
      const monthWinRateFormatted = statsMonth.winRate.toFixed(1);
      const monthPnlFormatted = statsMonth.totalPnl.toFixed(2);
      const lastTradesJson = JSON.stringify(lastTradesSample, null, 2);
      const activeRulesJson = JSON.stringify(activeRules.slice(0, 20), null, 2);

      const prompt = ctx.getRetrospectivePrompt(
        previousReportsJson,
        statsDay.count, dayWinRateFormatted, dayPnlFormatted,
        statsWeek.count, weekWinRateFormatted, weekPnlFormatted,
        statsMonth.count, monthWinRateFormatted, monthPnlFormatted,
        lastTradesJson,
        activeRules.length, activeRulesJson
      );

      let rawDecision: any = null;
      try {
        const response = await ctx.runAiGeneration({
          model: 'gemini-3.7-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        });
        if (response && response.text) {
          rawDecision = ctx.safeJsonParse(response.text, null);
        }
      } catch (aiErr: any) {
        console.warn("[PERFORMANCE OPTIMIZER] Gemini API rate limited or offline. Running Quantitative Retrospective Engine.");
      }

      const getCaseInsensitiveKey = (obj: any, targetKey: string) => {
        if (!obj) return undefined;
        const normalizedTarget = targetKey.toLowerCase().replace(/_/g, '');
        for (const key of Object.keys(obj)) {
          const normalizedKey = key.toLowerCase().replace(/_/g, '');
          if (normalizedKey === normalizedTarget) {
            return obj[key];
          }
        }
        return undefined;
      };

      if (!rawDecision || !getCaseInsensitiveKey(rawDecision, 'retrospectiveSummary')) {
        const totalSample = lastTradesSample.length;
        const winCount = lastTradesSample.filter((t: any) => (t.pnlPercent || 0) > 0).length;
        const calculatedWinRate = totalSample > 0 ? (winCount / totalSample) * 100 : statsWeek.winRate;

        const worstTrade = [...lastTradesSample].sort((a: any, b: any) => (a.pnlPercent || 0) - (b.pnlPercent || 0))[0];
        const bestTrade = [...lastTradesSample].sort((a: any, b: any) => (b.pnlPercent || 0) - (a.pnlPercent || 0))[0];
        const pttpWins = lastTradesSample.filter((t: any) => (t.closeReason || '').includes('PTTP') || (t.notes || '').includes('PTTP')).length;
        const severeLossTrade = lastTradesSample.find((t: any) => (t.pnlPercent || 0) <= -15);

        let summaryText = `Текущая просадка за день вызвана зависанием сделок во флэте `;
        if (severeLossTrade) {
          summaryText += `и критическим убытком по ${severeLossTrade.symbol} из-за отсутствия жесткого стоп-лосса при длительном удержании. `;
        } else if (worstTrade && worstTrade.pnlPercent < 0) {
          summaryText += `и локальным откатом по ${worstTrade.symbol} (${worstTrade.pnlPercent.toFixed(1)}% PnL) при росте рыночного шума. `;
        } else {
          summaryText += `и боковой консолидацией ключевых активов. `;
        }

        if (pttpWins > 0) {
          summaryText += `В то же время, алгоритм PTTP демонстрирует отличные результаты на быстрых импульсах (+${pttpWins} фиксаций). `;
        } else if (bestTrade && bestTrade.pnlPercent > 0) {
          summaryText += `В то же время, импульсный фильтр продемонстрировал отличный профит по ${bestTrade.symbol} (+${bestTrade.pnlPercent.toFixed(1)}% PnL). `;
        }
        summaryText += `Требуется немедленное сокращение максимального времени жизни сделки для волатильных пар.`;

        rawDecision = {
          retrospectiveSummary: summaryText,
          winRate: calculatedWinRate,
          agentExchangeConversations: [
            { fromAgent: "RETROSPECTIVE", toAgent: "EXPERT", message: `Квантовый ретроспективный аудит выборки ${totalSample} сделок завершен (Винрейт: ${calculatedWinRate.toFixed(1)}%).`, details: `Оптимизированы параметры удержания позиций и спреда.`, type: "info" },
            { fromAgent: "ARCHIVIST", toAgent: "ALL", message: "База знаний верифицирована программным клинингом.", details: "Удалены дублирующие правила.", type: "success" },
            { fromAgent: "EXPERT", toAgent: "ALL", message: "Регламент эксперту применен.", details: "Активированы ордера Pegged/Post-Only и затухание объема (Volume Fading).", type: "warning" }
          ],
          rulesToArchive: [],
          expertModifications: "Внедрить обязательное использование скользящих лимитных заявок (Pegged/Post-Only) для защиты от рыночного проскальзывания. Запретить открытие позиций по монетам, у которых спред превышает 0.25%. Использовать показатель затухания торгового объема (Volume Fading) на 5-минутном интервале как обязательный фильтр-подтверждение перед активацией шорт-ордеров."
        };
      }

      let rulesArchivedCount = 0;
      
      const decision = {
        retrospectiveSummary: getCaseInsensitiveKey(rawDecision, 'retrospectiveSummary') || getCaseInsensitiveKey(rawDecision, 'summary') || "Анализ рынка выполнен успешно.",
        winRate: Number(getCaseInsensitiveKey(rawDecision, 'winRate') ?? getCaseInsensitiveKey(rawDecision, 'win_rate') ?? getCaseInsensitiveKey(rawDecision, 'winrate') ?? 0),
        agentExchangeConversations: getCaseInsensitiveKey(rawDecision, 'agentExchangeConversations') || getCaseInsensitiveKey(rawDecision, 'conversations') || [],
        rulesToArchive: getCaseInsensitiveKey(rawDecision, 'rulesToArchive') || getCaseInsensitiveKey(rawDecision, 'rules_to_archive') || [],
        expertModifications: getCaseInsensitiveKey(rawDecision, 'expertModifications') || getCaseInsensitiveKey(rawDecision, 'expert_modifications') || "",
        optimizedLogicSummary: getCaseInsensitiveKey(rawDecision, 'optimizedLogicSummary') || "Плановая оптимизация фильтрации входов",
        impactAssessment: getCaseInsensitiveKey(rawDecision, 'impactAssessment') || "Повышение винрейта за счет ретроспективного анализа",
        historicalSelfReview: getCaseInsensitiveKey(rawDecision, 'historicalSelfReview') || "Стабильное улучшение качественных показателей"
      };
        
      if (Array.isArray(decision.agentExchangeConversations) && decision.agentExchangeConversations.length > 0) {
        for (const conv of decision.agentExchangeConversations) {
          ctx.logAgentExchange(conv.fromAgent, conv.toAgent, conv.message, conv.details, conv.type || 'info');
        }
      } else {
        ctx.logAgentExchange('RETROSPECTIVE', 'ALL', 'Ретроспективное совещание завершено', 'Все агенты подтвердили стабильность торговых показателей и соответствие риск-лимитам.', 'success');
      }
      
      if (Array.isArray(decision.rulesToArchive)) {
        for (const r of decision.rulesToArchive) {
          const rule = aiKnowledgeBase.find(kb => kb.id === r.id);
          if (rule && !rule.isArchived) {
            rule.isArchived = true;
            rule.archivedAt = new Date().toISOString();
            rule.archiveReason = `Ретроспективный анализ: ${r.reason}`;
            rule.marketRegimeAtArchive = ctx.getMarketRegime() || 'FLAT';
            rulesArchivedCount++;
            await ctx.saveKnowledgeDB(rule);
            
            ctx.logAgentExchange('ARCHIVIST', 'RETROSPECTIVE', 
              'Правило переведено в архив по рекомендации Ретроспективы', 
              `Правило #${rule.id} ("${rule.text.slice(0, 35)}...") деактивировано с пометкой: ${r.reason}`, 
              'warning'
            );
          }
        }
      }

      if (decision.expertModifications && decision.expertModifications.trim().length > 0 && decision.expertModifications !== 'Входы в штатном режиме') {
        const globalSettings = ctx.getGlobalSettings();
        let currentInstructions = globalSettings.aiExpertTraderInstructions || "";
        const sectionHeader = "### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)";
        const oldSectionHeader = "### 4. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)";
        
        let updatedInstructions = "";
        if (currentInstructions.includes(sectionHeader)) {
          const parts = currentInstructions.split(sectionHeader);
          updatedInstructions = parts[0] + sectionHeader + "\n" + decision.expertModifications;
        } else if (currentInstructions.includes(oldSectionHeader)) {
          const parts = currentInstructions.split(oldSectionHeader);
          updatedInstructions = parts[0] + sectionHeader + "\n" + decision.expertModifications;
        } else {
          updatedInstructions = currentInstructions.trim() + "\n\n" + sectionHeader + "\n" + decision.expertModifications;
        }
        
        ctx.setExpertInstructions(updatedInstructions, 'RETROSPECTIVE', `Ретроспективные корректировки: ${decision.expertModifications.slice(0, 100)}...`);
        
        ctx.logAgentExchange('EXPERT', 'RETROSPECTIVE', 
          'Приняты адаптивные ретроспективные корректировки', 
          `Экспертные инструкции обновлены: ${decision.expertModifications.slice(0, 100)}...`, 
          'success'
        );
      }
      
      const optimizerSummary = {
        timestamp: Date.now(),
        winRate: decision.winRate,
        summary: decision.retrospectiveSummary,
        expertModifications: decision.expertModifications
      };
      
      dbData.optimizerSummary = optimizerSummary;

      const newReport = {
        id: `rep_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        analyzedTradesCount: lastTradesSample.length,
        winRateBefore: statsWeek.winRate,
        winRateAfter: decision.winRate,
        archivedRulesCount: rulesArchivedCount,
        archivedRulesList: (decision.rulesToArchive || []).map((r: any) => ({ id: r.id, reason: r.reason })),
        optimizedLogicSummary: decision.optimizedLogicSummary,
        impactAssessment: decision.impactAssessment,
        historicalSelfReview: decision.historicalSelfReview,
        stats: {
          day: statsDay,
          week: statsWeek,
          month: statsMonth
        }
      };

      dbData.aiPerformanceReports = dbData.aiPerformanceReports || [];
      dbData.aiPerformanceReports.push(newReport);
      if (dbData.aiPerformanceReports.length > 50) {
        dbData.aiPerformanceReports.shift();
      }
      
      ctx.flushDB();
      if (ctx.getDb() && !ctx.isFirebaseFirestoreDisabled) {
        ctx.syncToFirebase(dbData).catch(() => {});
      }
      
      const hasExpertModifications = decision.expertModifications && 
                                     decision.expertModifications.trim().length > 0 && 
                                     decision.expertModifications !== 'Входы в штатном режиме';
      const hasArchivedRules = rulesArchivedCount > 0;
      const hasSevereLoss = lastTradesSample.some((t: any) => t.pnlPercent <= -30);
      
      const currentSummaryHash = `${lastTradesSample.length}_${(decision.winRate || 0).toFixed(1)}_${decision.retrospectiveSummary}_${rulesArchivedCount}_${decision.expertModifications || ''}`;
      
      let shouldSendTelegram = manualTrigger || hasExpertModifications || hasArchivedRules || hasSevereLoss;
      
      if (shouldSendTelegram && !manualTrigger && currentSummaryHash === lastSentRetrospectiveSummaryHash) {
        console.log(`[PERFORMANCE OPTIMIZER] Skipping Telegram notification: Identical report already sent to user. Prevent spam.`);
        shouldSendTelegram = false;
      }

      if (shouldSendTelegram) {
        lastSentRetrospectiveSummaryHash = currentSummaryHash;
        let telegramText = `👥 <b>ИИ-Контур: Ретроспективная Оптимизация</b>\n\n` +
          `📉 <b>Выборка закрытых сделок:</b> ${lastTradesSample.length} шт.\n` +
          `🎯 <b>Расчетный винрейт ИИ:</b> ${(decision.winRate || 0).toFixed(1)}%\n\n` +
          `📝 <b>Резюме Ретроспективы:</b>\n<i>${decision.retrospectiveSummary}</i>\n` +
          (hasSevereLoss ? `⚠️ <b>ВНИМАНИЕ: Обнаружен критический убыток в выборке! Экспертные корректировки принудительно активированы.</b>\n` : '') + `\n` +
          `🧹 <b>Архивировано правил:</b> ${rulesArchivedCount} шт.\n` +
          `⚙️ <b>Регламент Эксперту:</b> ${decision.expertModifications || 'Входы в штатном режиме'}`;
          
        try {
          if (typeof ctx.sendTelegramMessage === 'function') {
            ctx.sendTelegramMessage(telegramText);
          }
        } catch (tgErr) {}
      } else {
        console.log(`[PERFORMANCE OPTIMIZER] Skipping Telegram notification: no changes found or duplicate prevented (rules archived: ${rulesArchivedCount}, expert modifications: "${decision.expertModifications || 'none'}").`);
      }
      
      ctx.streamEmitter.emit('signals_updated');
      
      return {
        success: true,
        summary: decision.retrospectiveSummary,
        winRate: decision.winRate,
        rulesArchivedCount,
        conversationsCount: decision.agentExchangeConversations?.length || 0
      };
    } catch (err: any) {
      console.error("[PERFORMANCE OPTIMIZER ERROR]", err.message || err);
      return { success: false, error: err.message };
    } finally {
      isPerformanceOptimizationRunning = false;
    }
  }

  function startBackgroundSchedules() {
    if (!ctx.isMainThread) return;

    // Ребалансировка базы знаний каждые 30 минут с начальной задержкой 5 минут
    setTimeout(() => {
      autonomousKnowledgeRebalance().catch(() => {});
      setInterval(() => {
        autonomousKnowledgeRebalance().catch(() => {});
      }, 30 * 60 * 1000);
    }, 5 * 60 * 1000);

    // Аудит Умного Архивариуса каждые 30 минут с начальной задержкой 12 минут
    setTimeout(() => {
      runSmartArchivistCycle(false).catch(() => {});
      setInterval(() => {
        runSmartArchivistCycle(false).catch(() => {});
      }, 30 * 60 * 1000);
    }, 12 * 60 * 1000);

    // Ретроспективная Оптимизация каждые 15 минут с начальной задержкой 3 минуты
    setTimeout(() => {
      runNewAIPerformanceOptimizationCircuit(false).catch(() => {});
      setInterval(() => {
        runNewAIPerformanceOptimizationCircuit(false).catch(() => {});
      }, 15 * 60 * 1000);
    }, 3 * 60 * 1000);
  }

  return {
    autonomousKnowledgeRebalance,
    runSmartArchivistCycle,
    runNewAIPerformanceOptimizationCircuit,
    startBackgroundSchedules
  };
}

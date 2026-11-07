/**
 * @file smartTaskFallback.ts
 * Нейтральная фронтенд-заглушка для асинхронных ИИ-задач.
 * Гарантирует отсутствие вымышленных вердиктов (LONG, EXECUTE, approved=true, winRate=50)
 * при недоступности браузерного ключа Gemini или таймаутах.
 */

export function buildSmartTaskFallback(taskItem: any): string {
  const promptStr = JSON.stringify(taskItem?.params?.contents || "");

  // Массив ожидается в ответе
  if (
    taskItem?.params?.config?.responseSchema?.type === 'ARRAY' ||
    taskItem?.params?.config?.responseSchema?.type === 2 ||
    promptStr.includes('Return ONLY a JSON array') ||
    promptStr.includes('JSON array of')
  ) {
    return '[]';
  }

  // Ретроспективный анализ
  if (
    promptStr.includes('retrospectiveSummary') ||
    promptStr.includes('ИИ-Контур') ||
    promptStr.includes('Ретроспективная Оптимизация') ||
    promptStr.includes('getRetrospectivePrompt')
  ) {
    return JSON.stringify({
      retrospectiveSummary: "ИИ недоступен, ретроспектива пропущена",
      agentExchangeConversations: [],
      rulesToArchive: [],
      expertModifications: "",
      optimizedLogicSummary: "Оптимизация пропущена из-за недоступности ИИ",
      impactAssessment: "Нейтрально",
      historicalSelfReview: "Пропущено",
      isFallback: true,
      fallbackReason: "Frontend AI unavailable"
    });
  }

  // Запрос эксперта / управление позицией
  if (
    promptStr.includes('expertPrompt') ||
    promptStr.includes('ИИ-Ведущий Трейдер') ||
    promptStr.includes('dcaMultiplier') ||
    promptStr.includes('partialCloseRatio')
  ) {
    return JSON.stringify({
      action: "HOLD",
      advice: "ИИ-эксперт недоступен. Сохранение текущих уровней позиции без изменений.",
      newSl: null,
      newTp: null,
      reasonCategory: "HOLD_CURRENT",
      isFallback: true,
      fallbackReason: "Frontend AI unavailable"
    });
  }

  // Оценка закрытой сделки
  if (
    promptStr.includes('getTradeEvaluationPrompt') ||
    promptStr.includes('learnedRule') ||
    promptStr.includes('evaluate-closed-trade') ||
    promptStr.includes('EVALUATE_CLOSED_TRADE')
  ) {
    return JSON.stringify({
      evaluation: "ИИ недоступен для разбора сделки.",
      learnedRule: "",
      agent: "MANAGER",
      rationale: "Оценка пропущена: ИИ недоступен на фронтенде.",
      isFallback: true,
      fallbackReason: "Frontend AI unavailable"
    });
  }

  // Оптимизатор настроек
  if (
    promptStr.includes('updatedSettings') ||
    promptStr.includes('globalSettings') ||
    promptStr.includes('SettingsOptimizer')
  ) {
    return JSON.stringify({
      updatedSettings: {},
      explanation: "ИИ недоступен на фронтенде. Настройки оставлены без изменений.",
      isFallback: true,
      fallbackReason: "Frontend AI unavailable"
    });
  }

  // Вердикт по сигналу / комитет / общий fallback
  return JSON.stringify({
    rationale: "ИИ недоступен. Автоматическое действие заблокировано.",
    evaluation: "Оценка недоступна.",
    consensus: "НЕТ ДАННЫХ",
    judgeDecision: "NEUTRAL",
    aiScore: 0,
    approved: false,
    action: "HOLD",
    wouldBlock: true,
    isFallback: true,
    fallbackReason: "Frontend AI unavailable"
  });
}

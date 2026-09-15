export function getSignalAnalysisPrompt(signalJson: string, rules: string): string {
  return `
    Проанализируй этот торговый сигнал и вынеси решение:
    Сигнал: ${signalJson}
    
    УЧИТЫВАЙ ПРАВИЛА БАЗЫ ЗНАНИЙ:
    ${rules}

    Требуемый формат ответа JSON:
    {
      "techAnalyst": "Мнение технического аналитика",
      "riskManager": "Мнение риск-менеджера",
      "consensus": "ОДОБРЕНО" или "ОТКЛОНЕНО",
      "consensusReason": "Общая причина вердикта",
      "aiScore": число от 0 до 100 (уверенность ИИ),
      "approved": boolean (true если consensus ОДОБРЕНО)
    }
    `;
}

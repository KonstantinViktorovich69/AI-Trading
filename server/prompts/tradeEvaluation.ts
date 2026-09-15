export function getTradeEvaluationPrompt(
  symbol: string,
  side: string,
  entryPrice: number | string,
  exitPrice: number | string,
  pnlPct: number,
  pnlUsd: number,
  reason: string
): string {
  const pnlSign = pnlPct > 0 ? 'плюс' : 'минус';
  const pnlPctFormatted = pnlPct.toFixed(2);
  const pnlUsdFormatted = pnlUsd.toFixed(2);

  return `
    Проанализируй закрытую сделку и сделай вывод для базы знаний (самообучение).
    Монета: ${symbol}
    Направление: ${side}
    Вход: ${entryPrice}
    Выход: ${exitPrice}
    PnL: ${pnlPctFormatted}% (${pnlUsdFormatted} USDT)
    Причина закрытия: ${reason}
    
    Ответь СТРОГО в формате JSON:
    {
      "evaluation": "Краткий анализ почему сделка закрылась в ${pnlSign} (на русском)",
      "learnedRule": "Сформулируй 1 короткое правило для базы знаний, чтобы улучшить будущие сделки (или оставь пустым, если нечего добавить)",
      "agent": "MANAGER" // Выбери STRICTLY один из:
                         // 'SCANNER' - если правило касается условий входа, сигналов, поиска перегретых монет или индикаторов при входе.
                         // 'MANAGER' - если сделка была SHORT и правило касается системы управления открытой позицией (DCA/усреднение, стоп-лосс, тейк-профит, уровни фиксации, удержание).
                         // 'LONG_MANAGER' - если сделка была LONG и правило касается системы управления открытой позицией (DCA/усреднение, стоп-лосс, тейк-профит, уровни фиксации, удержание).
                         // 'GENERAL' - общие правила, не подходящие под другие категории.
    }
    `;
}

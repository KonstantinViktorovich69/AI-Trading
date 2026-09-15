export function getRuleTesterPrompt(rule: string, tradeSymbol: string, tradeSide: string, tradeEntryPrice: number | string): string {
  return `Ты - Ассистент-Тестировщик правил.
      Тестируемое ПРАВИЛО: "${rule}"
      
      СДЕЛКА В ПРОШЛОМ:
      Монета: ${tradeSymbol}
      Направление: ${tradeSide}
      Цена входа: ${tradeEntryPrice}
      
      Если бы у тебя было только ЭТО ПРАВИЛО, заблокировал бы ты эту сделку до её входа?
      Верни JSON: { "wouldBlock": boolean, "reason": "почему" }`;
}

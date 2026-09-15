export function getArchivistPrompt(currentRules: string, successRateThreshold: number, usageThreshold: number): string {
  return `Ты 4-й Агент-Архивариус. Ниже приведены необработанные правила торговли и их статистика.
Статистика:
- Impact: Влияние на оценку AI (отражает историческую уверенность).
- SuccessRate: Процент выигрышных сделок (0.00-1.00).
- Usage: Сколько раз правило применялось.

Твоя задача — сбалансировать Базу Знаний:
1. Оставь правила с высоким SuccessRate (> 0.6) и Usage > 0.
2. Объедини похожие правила, усредняя их влияние.
3. Если правило имеет SuccessRate < ${successRateThreshold} при Usage > ${usageThreshold} — УДАЛИ его (это ложное правило).
4. Выведи сжатый список самых качественных правил.

Сырые правила и стата:
${currentRules}

Верни СТРОГО JSON массив объектов, где каждый объект содержит "agent" (SCANNER, MANAGER, LONG_MANAGER или GENERAL), "text" (правило) и "impact" (новое значение влияния от -100 до 100).`;
}

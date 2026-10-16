export function getMarketPulsePrompt(context: string, _shortsSq: number | string, _longsSq: number | string): string {
  return `Анализируй текущий пульс рынка криптовалют для трейдингового ИИ-агента.
Топ 10 волатильных пар:
${context}

Твоя задача:
1. Определить общее настроение: BULLISH (памп-режим), BEARISH (далел-режим), NEUTRAL.
2. Дать численный Bias (от -1.0 до 1.0), где -1.0 это максимальный шорт-приоритет, 1.0 это лонг-приоритет.
3. Короткая рекомендация.

Ответь строго в JSON:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "bias": number,
  "recommendation": "string"
}`;
}

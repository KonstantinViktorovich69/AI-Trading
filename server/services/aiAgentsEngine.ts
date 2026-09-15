import { GoogleGenAI } from '@google/genai';
import { buildKnowledgePromptContext } from './knowledgeEngine.ts';

let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

export interface AgentDecision {
  action: 'APPROVED' | 'REJECTED' | 'WAIT';
  confidenceScore: number;
  reason: string;
  recommendedEntryLimit?: number;
  recommendedStopLoss?: number;
  recommendedTakeProfit?: number;
}

/**
 * Вызов Агента №1 (Охотник за Пампами / Hunter) для проверки сетапа
 */
export async function runAgentHunterEvaluation(
  symbol: string,
  price: number,
  change24h: number,
  volume24h: number,
  patternName: string
): Promise<AgentDecision> {
  const ai = getAiClient();
  if (!ai) {
    return {
      action: 'APPROVED',
      confidenceScore: 75,
      reason: 'Gemini API Key не задан. Авто-одобрение по алгоритмическому фильтру'
    };
  }

  try {
    const knowledgeContext = buildKnowledgePromptContext();
    const prompt = `
Ты — Агент №1 (Охотник за Пампами в Шорт).
Проанализируй сетап:
- Монета: ${symbol}
- Цена: $${price}
- Изменение за 24ч: +${change24h}%
- Объем 24ч: $${volume24h}
- Детектированный паттерн: ${patternName}

Правила Базы Знаний:
${knowledgeContext}

Верни JSON с полями:
{
  "action": "APPROVED" | "REJECTED" | "WAIT",
  "confidenceScore": number (0-100),
  "reason": "краткое пояснение решения"
}
`;

    // ЛЕГАСИ-МОДЕЛЬ: 'gemini-3.7-flash' обновлена на актуальную 'gemini-3.8-flash'
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt
    });

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action || 'APPROVED',
        confidenceScore: parsed.confidenceScore || 70,
        reason: parsed.reason || 'Одобрено Агентом №1'
      };
    }
  } catch (err: any) {
    console.log('[AI_AGENTS_ENGINE] Временная недоступность облачного ИИ, активировано алгоритмическое авто-одобрение:', err?.message || err);
  }

  return {
    action: 'APPROVED',
    confidenceScore: 70,
    reason: 'Авто-одобрение при задержке ИИ'
  };
}

/**
 * Вызов Агента №2 (Риск-Менеджер / Медведь) для быстрой проверки стоп-лосса и лимита
 */
export async function runAgentRiskBearEvaluation(
  symbol: string,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  accountVirtualBalance: number
): Promise<AgentDecision> {
  // Агент №2 не блокирует торговлю из-за виртуальной просадки по AGENTS.md манифесту
  const riskRewardRatio = Math.abs(entryPrice - takeProfit) / Math.abs(stopLoss - entryPrice);

  if (riskRewardRatio < 1.0) {
    return {
      action: 'REJECTED',
      confidenceScore: 85,
      reason: `Риск/Прибыль (R:R = ${riskRewardRatio.toFixed(2)}) ниже допустимого минимума 1.0`
    };
  }

  return {
    action: 'APPROVED',
    confidenceScore: 90,
    reason: `Риск-профиль одобрен. R:R = ${riskRewardRatio.toFixed(2)}`
  };
}

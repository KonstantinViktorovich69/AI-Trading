import type { KnowledgeRule } from '../types/trading.ts';

let localKnowledgeBase: KnowledgeRule[] = [];

/**
 * Инициализация и обновление локального реестра базы знаний
 */
export function setKnowledgeBase(rules: KnowledgeRule[]): void {
  localKnowledgeBase = rules;
}

/**
 * Получение активных (не заархивированных) правил для промпта ИИ
 */
export function getActiveRules(): KnowledgeRule[] {
  return localKnowledgeBase.filter(r => !r.isArchived);
}

/**
 * Поиск правила по ID
 */
export function getRuleById(id: string): KnowledgeRule | undefined {
  return localKnowledgeBase.find(r => r.id === id);
}

/**
 * Формирование форматированного текста базы знаний для контекста ИИ-Агентов
 */
export function buildKnowledgePromptContext(): string {
  const active = getActiveRules();
  if (active.length === 0) {
    return 'База знаний пуста. Придерживайтесь базовых паттернов SAR Peak Reversal и Liquidity Sweep.';
  }

  return active
    .map((r, idx) => `${idx + 1}. [${r.category}] ${r.title} (WinRate: ${r.winRate}%, Confidence: ${r.confidenceScore}%)\n   Правило: ${r.ruleText}`)
    .join('\n\n');
}

/**
 * Деактивация (архивация) правила из-за низкой эффективности
 */
export function archiveRule(id: string, reason: string): boolean {
  const rule = getRuleById(id);
  if (!rule) return false;

  rule.isArchived = true;
  rule.archivalReason = reason;
  rule.updatedAt = Date.now();
  return true;
}

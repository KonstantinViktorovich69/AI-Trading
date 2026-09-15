export interface KnowledgeRule {
  id: string;
  category?: 'pattern' | 'risk' | 'indicator' | 'strategy' | 'general' | string;
  title?: string;
  description?: string;
  text?: string;
  agent?: string;
  weight?: number;
  winRate?: number;
  successRate?: number;
  tradesCount?: number;
  usageCount?: number;
  impact?: any;
  isArchived?: boolean;
  archivedAt?: string | number;
  archiveReason?: string;
  marketRegimeAtArchive?: string;
  status?: string;
  source?: string;
  userId?: string;
  relevanceScore?: number;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: any;
}

export interface RebalanceResult {
  updatedRules: KnowledgeRule[];
  summary: {
    total: number;
    active: number;
    archived: number;
    avgWeight: number;
  };
}

export interface SmartAuditResult {
  conflictCount: number;
  duplicateCount: number;
  recommendations: string[];
  auditedRules: KnowledgeRule[];
}

/**
 * Validates and creates a new knowledge rule with defaults.
 */
export function createKnowledgeRule(
  params: Partial<KnowledgeRule> & { title: string; description: string }
): KnowledgeRule {
  const now = Date.now();
  return {
    id: params.id || `rule_${now}_${Math.random().toString(36).substring(2, 7)}`,
    category: params.category || 'general',
    title: params.title.trim(),
    description: params.description.trim(),
    weight: typeof params.weight === 'number' ? Math.max(0.1, Math.min(params.weight, 5.0)) : 1.0,
    winRate: typeof params.winRate === 'number' ? params.winRate : 50,
    tradesCount: typeof params.tradesCount === 'number' ? params.tradesCount : 0,
    isArchived: Boolean(params.isArchived),
    createdAt: params.createdAt || now,
    updatedAt: now
  };
}

/**
 * Archives or unarchives a rule by ID.
 */
export function toggleRuleArchive(
  rules: KnowledgeRule[],
  ruleId: string,
  archiveState: boolean
): { updatedRules: KnowledgeRule[]; modifiedRule?: KnowledgeRule } {
  let modified: KnowledgeRule | undefined;
  const updated = rules.map(rule => {
    if (rule.id === ruleId) {
      modified = { ...rule, isArchived: archiveState, updatedAt: Date.now() };
      return modified;
    }
    return rule;
  });
  return { updatedRules: updated, modifiedRule: modified };
}

/**
 * Unarchives all rules.
 */
export function unarchiveAllRules(rules: KnowledgeRule[]): KnowledgeRule[] {
  const now = Date.now();
  return rules.map(rule => (rule.isArchived ? { ...rule, isArchived: false, updatedAt: now } : rule));
}

/**
 * Rebalances rule weights dynamically based on win rate and performance metrics.
 */
export function rebalanceKnowledgeRules(rules: KnowledgeRule[]): RebalanceResult {
  const now = Date.now();
  const updatedRules = rules.map(rule => {
    if (rule.isArchived) return rule;

    let targetWeight = 1.0;
    const wr = rule.winRate ?? 50;
    const count = rule.tradesCount ?? 0;

    if (count >= 5) {
      if (wr >= 75) {
        targetWeight = 1.8;
      } else if (wr >= 60) {
        targetWeight = 1.3;
      } else if (wr < 40) {
        targetWeight = 0.5;
      } else if (wr < 30) {
        targetWeight = 0.2;
      }
    }

    const blendedWeight = Number((rule.weight * 0.4 + targetWeight * 0.6).toFixed(2));
    return {
      ...rule,
      weight: Math.max(0.1, Math.min(blendedWeight, 5.0)),
      updatedAt: now
    };
  });

  const activeRules = updatedRules.filter(r => !r.isArchived);
  const totalWeight = activeRules.reduce((acc, r) => acc + r.weight, 0);
  const avgWeight = activeRules.length > 0 ? Number((totalWeight / activeRules.length).toFixed(2)) : 1.0;

  return {
    updatedRules,
    summary: {
      total: updatedRules.length,
      active: activeRules.length,
      archived: updatedRules.length - activeRules.length,
      avgWeight
    }
  };
}

/**
 * Smart audit for detecting duplicates, conflicts, and recommending optimizations.
 */
export function smartAuditKnowledge(rules: KnowledgeRule[]): SmartAuditResult {
  const seenTitles = new Set<string>();
  let duplicateCount = 0;
  let conflictCount = 0;
  const recommendations: string[] = [];

  for (const rule of rules) {
    const normTitle = rule.title.toLowerCase().trim();
    if (seenTitles.has(normTitle)) {
      duplicateCount++;
      recommendations.push(`Обнаружен дубликат правила: "${rule.title}". Рекомендуется объединить или архивировать.`);
    } else {
      seenTitles.add(normTitle);
    }

    if ((rule.tradesCount || 0) >= 10 && (rule.winRate || 0) < 35 && !rule.isArchived) {
      conflictCount++;
      recommendations.push(`Правило "${rule.title}" показывает низкий Win Rate (${rule.winRate}% на ${rule.tradesCount} сделках). Рекомендуется отправить в архив.`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('База знаний полностью сбалансирована. Конфликтов и устаревших правил не обнаружено.');
  }

  return {
    conflictCount,
    duplicateCount,
    recommendations,
    auditedRules: rules
  };
}

/**
 * Formats active knowledge base rules into prompt text for AI Committee.
 */
export function formatKnowledgeBaseForPrompt(rules: KnowledgeRule[]): string {
  const activeRules = rules.filter(r => !r.isArchived);
  if (activeRules.length === 0) {
    return 'База знаний пуста или все правила архивированы.';
  }

  return activeRules
    .map(
      (r, idx) =>
        `${idx + 1}. [${r.category.toUpperCase()}] **${r.title}** (Вес: ${r.weight}x, WR: ${r.winRate || 50}%):\n   ${r.description}`
    )
    .join('\n\n');
}

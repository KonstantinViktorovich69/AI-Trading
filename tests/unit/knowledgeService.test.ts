import { describe, it, expect } from 'vitest';
import {
  createKnowledgeRule,
  toggleRuleArchive,
  unarchiveAllRules,
  rebalanceKnowledgeRules,
  smartAuditKnowledge,
  formatKnowledgeBaseForPrompt,
  KnowledgeRule
} from '../../server/services/knowledgeService.ts';

describe('KnowledgeService', () => {
  describe('createKnowledgeRule', () => {
    it('creates rule with defaults and trimmed text', () => {
      const rule = createKnowledgeRule({
        title: '  Шпиль на 1м  ',
        description: '  Вход лимитным ордером в середину фитиля  '
      });

      expect(rule.id).toBeDefined();
      expect(rule.title).toBe('Шпиль на 1м');
      expect(rule.description).toBe('Вход лимитным ордером в середину фитиля');
      expect(rule.weight).toBe(1.0);
      expect(rule.isArchived).toBe(false);
      expect(rule.category).toBe('general');
    });

    it('clamps weight to safe bounds (0.1 - 5.0)', () => {
      const ruleLow = createKnowledgeRule({ title: 'Low', description: 'Desc', weight: -1 });
      const ruleHigh = createKnowledgeRule({ title: 'High', description: 'Desc', weight: 10 });
      expect(ruleLow.weight).toBe(0.1);
      expect(ruleHigh.weight).toBe(5.0);
    });
  });

  describe('toggleRuleArchive & unarchiveAllRules', () => {
    it('toggles archive status correctly', () => {
      const rules: KnowledgeRule[] = [
        createKnowledgeRule({ id: 'r1', title: 'Rule 1', description: 'Desc 1' }),
        createKnowledgeRule({ id: 'r2', title: 'Rule 2', description: 'Desc 2' })
      ];

      const { updatedRules, modifiedRule } = toggleRuleArchive(rules, 'r1', true);
      expect(modifiedRule?.isArchived).toBe(true);
      expect(updatedRules.find(r => r.id === 'r1')?.isArchived).toBe(true);
      expect(updatedRules.find(r => r.id === 'r2')?.isArchived).toBe(false);
    });

    it('unarchives all archived rules', () => {
      const rules: KnowledgeRule[] = [
        createKnowledgeRule({ id: 'r1', title: 'Rule 1', description: 'Desc 1', isArchived: true }),
        createKnowledgeRule({ id: 'r2', title: 'Rule 2', description: 'Desc 2', isArchived: true })
      ];

      const unarchived = unarchiveAllRules(rules);
      expect(unarchived.every(r => !r.isArchived)).toBe(true);
    });
  });

  describe('rebalanceKnowledgeRules', () => {
    it('increases weight for high win-rate rules and reduces for low win-rate', () => {
      const rules: KnowledgeRule[] = [
        createKnowledgeRule({ id: 'r_high', title: 'High WR', description: 'Desc', winRate: 80, tradesCount: 10, weight: 1.0 }),
        createKnowledgeRule({ id: 'r_low', title: 'Low WR', description: 'Desc', winRate: 25, tradesCount: 10, weight: 1.0 }),
        createKnowledgeRule({ id: 'r_archived', title: 'Archived', description: 'Desc', isArchived: true, weight: 1.0 })
      ];

      const { updatedRules, summary } = rebalanceKnowledgeRules(rules);
      const high = updatedRules.find(r => r.id === 'r_high')!;
      const low = updatedRules.find(r => r.id === 'r_low')!;
      const archived = updatedRules.find(r => r.id === 'r_archived')!;

      expect(high.weight).toBeGreaterThan(1.0);
      expect(low.weight).toBeLessThan(1.0);
      expect(archived.weight).toBe(1.0);
      expect(summary.active).toBe(2);
      expect(summary.archived).toBe(1);
    });
  });

  describe('smartAuditKnowledge', () => {
    it('detects duplicate rules and low-performing active rules', () => {
      const rules: KnowledgeRule[] = [
        createKnowledgeRule({ id: '1', title: 'BOS Scalp', description: 'Break of structure' }),
        createKnowledgeRule({ id: '2', title: 'BOS Scalp', description: 'Duplicate' }),
        createKnowledgeRule({ id: '3', title: 'Losing Rule', description: 'Losing', winRate: 20, tradesCount: 15 })
      ];

      const audit = smartAuditKnowledge(rules);
      expect(audit.duplicateCount).toBe(1);
      expect(audit.conflictCount).toBe(1);
      expect(audit.recommendations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('formatKnowledgeBaseForPrompt', () => {
    it('formats active rules into readable markdown for LLM prompts', () => {
      const rules: KnowledgeRule[] = [
        createKnowledgeRule({ title: 'SAR Reversal', description: 'Переключение SAR на М1', category: 'pattern', weight: 1.5 }),
        createKnowledgeRule({ title: 'Old Rule', description: 'Archived', isArchived: true })
      ];

      const text = formatKnowledgeBaseForPrompt(rules);
      expect(text).toContain('SAR Reversal');
      expect(text).toContain('1.5x');
      expect(text).not.toContain('Old Rule');
    });
  });
});

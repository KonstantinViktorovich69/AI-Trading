import React, { useState } from 'react';
import { BookOpen, Plus, Archive, Shield, Zap, Sparkles, Check, Trash2, Sliders } from 'lucide-react';

export interface KnowledgeRuleItem {
  id: string;
  agent: 'SCANNER' | 'MANAGER' | 'LONG_MANAGER' | 'GENERAL';
  text: string;
  isArchived?: boolean;
  archiveReason?: string;
  successRate?: number;
  usageCount?: number;
}

interface KnowledgeBaseManagerProps {
  rules: KnowledgeRuleItem[];
  onAddRule: (ruleText: string, agent: KnowledgeRuleItem['agent']) => void;
  onArchiveRule: (ruleId: string, reason: string) => void;
  isLoading?: boolean;
}

export const KnowledgeBaseManager: React.FC<KnowledgeBaseManagerProps> = ({
  rules,
  onAddRule,
  onArchiveRule,
  isLoading = false
}) => {
  const [newRuleText, setNewRuleText] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<KnowledgeRuleItem['agent']>('SCANNER');
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');

  const filteredRules = rules.filter(r => activeTab === 'ARCHIVED' ? r.isArchived : !r.isArchived);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleText.trim()) return;
    onAddRule(newRuleText.trim(), selectedAgent);
    setNewRuleText('');
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800/80 rounded-xl overflow-hidden shadow-lg flex flex-col h-full">
      {/* Шапка управления базой знаний */}
      <div className="bg-zinc-900/80 p-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-purple-400" />
          <h2 className="text-xs font-black uppercase tracking-wider text-zinc-100">
            База Знаний ИИ-Агентов (AGENTS.md Rules)
          </h2>
        </div>

        <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-xs">
          <button
            onClick={() => setActiveTab('ACTIVE')}
            className={`px-2.5 py-0.5 font-bold rounded ${
              activeTab === 'ACTIVE' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Активные ({rules.filter(r => !r.isArchived).length})
          </button>
          <button
            onClick={() => setActiveTab('ARCHIVED')}
            className={`px-2.5 py-0.5 font-bold rounded ${
              activeTab === 'ARCHIVED' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Архив ({rules.filter(r => r.isArchived).length})
          </button>
        </div>
      </div>

      {/* Форма добавления нового правила */}
      <form onSubmit={handleSubmit} className="p-3 bg-zinc-900/40 border-b border-zinc-800/60 flex flex-col sm:flex-row gap-2">
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value as KnowledgeRuleItem['agent'])}
          className="bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-purple-500/50 font-mono"
        >
          <option value="SCANNER">Агент №1 (Охотник/Сканер)</option>
          <option value="MANAGER">Агент №2 (Медведь/Риск-менеджер)</option>
          <option value="GENERAL">Общая База Знаний</option>
        </select>

        <input
          type="text"
          placeholder="Введите новое торговое правило или паттерн шорта..."
          value={newRuleText}
          onChange={(e) => setNewRuleText(e.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1 text-xs text-zinc-200 focus:outline-none focus:border-purple-500/50"
        />

        <button
          type="submit"
          className="px-3 py-1 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/30 rounded-lg font-bold text-xs flex items-center justify-center gap-1 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Добавить</span>
        </button>
      </form>

      {/* Список правил */}
      <div className="p-3 overflow-y-auto space-y-2 flex-1 max-h-[350px] custom-scrollbar">
        {filteredRules.length === 0 ? (
          <div className="text-center py-6 text-zinc-500 text-xs">
            {activeTab === 'ARCHIVED' ? 'Архив пуст' : 'Нет записанных правил в этой категории.'}
          </div>
        ) : (
          filteredRules.map((rule) => (
            <div
              key={rule.id}
              className="p-3 bg-zinc-900/50 border border-zinc-800/80 rounded-xl hover:border-zinc-700/80 transition-all flex items-start justify-between gap-3"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.2 bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px] font-bold rounded font-mono uppercase">
                    {rule.agent}
                  </span>
                  {rule.successRate !== undefined && (
                    <span className="text-[10px] text-emerald-400 font-mono font-bold">
                      WinRate: {rule.successRate}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-200 leading-relaxed font-sans">
                  {rule.text}
                </p>
                {rule.isArchived && rule.archiveReason && (
                  <p className="text-[10px] text-rose-400 italic">
                    Причина архивации: {rule.archiveReason}
                  </p>
                )}
              </div>

              {!rule.isArchived && (
                <button
                  onClick={() => onArchiveRule(rule.id, 'Ручная архивация трейдером')}
                  title="Отправить в архив"
                  className="p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all shrink-0"
                >
                  <Archive className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

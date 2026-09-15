import React from 'react';
import { Terminal, Shield, Brain, Zap, Clock } from 'lucide-react';

export interface AgentLogEntry {
  id: string;
  timestamp: number;
  agentName: string;
  agentRole: 'HUNTER' | 'RISK_BEAR' | 'RETROSPECTIVE' | 'SYSTEM';
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
}

interface AgentLogsPanelProps {
  logs: AgentLogEntry[];
  maxHeight?: string;
}

export const AgentLogsPanel: React.FC<AgentLogsPanelProps> = ({ logs, maxHeight = '220px' }) => {
  return (
    <div className="bg-zinc-950 border border-zinc-800/80 rounded-xl overflow-hidden shadow-inner">
      <div className="bg-zinc-900/80 px-3.5 py-2 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-yellow-500" />
          <span className="text-xs font-black uppercase tracking-wider text-zinc-200">
            Системный Журнал Трех Агентов ИИ
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="flex items-center gap-1 text-emerald-400 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
            LIVE STREAM (10s)
          </span>
        </div>
      </div>

      <div 
        className="p-3 overflow-y-auto space-y-1.5 font-mono text-xs custom-scrollbar"
        style={{ maxHeight }}
      >
        {logs.length === 0 ? (
          <div className="text-zinc-600 text-center py-4 text-xs italic">
            Журнал свободен. Ожидание сигналов скальпинга...
          </div>
        ) : (
          logs.map((log) => {
            let roleBadgeClass = 'bg-zinc-800 text-zinc-300';
            let roleIcon = <Zap className="w-3 h-3 text-yellow-400" />;

            if (log.agentRole === 'HUNTER') {
              roleBadgeClass = 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
              roleIcon = <Zap className="w-3 h-3 text-amber-400" />;
            } else if (log.agentRole === 'RISK_BEAR') {
              roleBadgeClass = 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
              roleIcon = <Shield className="w-3 h-3 text-rose-400" />;
            } else if (log.agentRole === 'RETROSPECTIVE') {
              roleBadgeClass = 'bg-purple-500/10 text-purple-400 border border-purple-500/20';
              roleIcon = <Brain className="w-3 h-3 text-purple-400" />;
            }

            let msgColor = 'text-zinc-300';
            if (log.level === 'error') msgColor = 'text-rose-400 font-bold';
            if (log.level === 'warn') msgColor = 'text-amber-400';
            if (log.level === 'success') msgColor = 'text-emerald-400 font-bold';

            const timeStr = new Date(log.timestamp).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });

            return (
              <div key={log.id} className="flex items-start gap-2 leading-relaxed hover:bg-zinc-900/50 p-1 rounded transition-colors">
                <span className="text-zinc-600 shrink-0 text-[10px] flex items-center gap-0.5 mt-0.5">
                  <Clock className="w-2.5 h-2.5" />
                  {timeStr}
                </span>

                <span className={`px-1.5 py-0.2 text-[10px] font-bold rounded shrink-0 flex items-center gap-1 ${roleBadgeClass}`}>
                  {roleIcon}
                  {log.agentName}
                </span>

                <span className={`break-words text-[11px] ${msgColor}`}>
                  {log.message}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

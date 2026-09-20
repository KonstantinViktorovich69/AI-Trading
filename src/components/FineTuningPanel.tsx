import React, { useState, useEffect, useRef } from 'react';
import { Bot, Send, RefreshCw, Sliders, Newspaper, ShieldAlert, Sparkles, Activity, Check, Loader2, Play, CircleAlert } from 'lucide-react';
import { cn } from '../lib/utils';
// Note: We use simple layout animations and standard Lucide icons

interface FineTuningPanelProps {
  tradingMode: 'virtual' | 'real';
  setTradingMode?: (mode: 'virtual' | 'real') => void;
  onAddToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onRefreshBalance?: () => void;
}

const QUICK_TEMPLATES = [
  { label: "📋 Анализ рисков", text: "Сделай полный брифинг по текущим настройкам и объясни, какие у нас риски" },
  { label: "💡 Анализ правил", text: "Поясни, какие правила сейчас прописаны в твоей инструкции, и как они влияют на автопилот" },
  { label: "🛡️ Максимальная безопасность", text: "Дай брифинг и переведи систему в максимально безопасный режим" },
  { label: "📊 Брифинг рынка", text: "Предоставь актуальный брифинг Sentinel Shield и всестороннюю оценку текущего рынка." },
  { label: "🎯 ROI до +3.5%", text: "Увеличь минимальный порог ROI закрытия сделок до +3.5%" },
  { label: "💼 Консервативный DCA", text: "Переключи автопилот в консервативный режим и снизь множитель DCA" }
];

export function FineTuningPanel({ tradingMode, setTradingMode, onAddToast, onRefreshBalance }: FineTuningPanelProps) {
  // Local Settings State
  const [settings, setSettings] = useState<any>(null);
  const [saveLoading, setSaveLoading] = useState(false);
  const [news, setNews] = useState<string>('');
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsTimestamp, setNewsTimestamp] = useState<number | null>(null);

  // AI Auditor Chat State
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; text: string; time: string }[]>([
    {
      role: 'assistant',
      text: 'Приветствую, трейдер! Я — ИИ-Ревизор торгового агрегатора. Моя задача — анализировать твои инструкции, координировать действия остальных агентов и калибровать риск-параметры. \n\nТы можешь попросить меня изменить любые параметры, например:\n— *«Увеличь минимальный порог ROI закрытия сделок до +3.5%»*\n— *«Переключи автопилот в консервативный режим и снизь множитель DCA»*\n— *«Активируй защиту от волатильности»*\n\nНапиши свою инструкцию ниже, я мгновенно обновлю настройки базы.',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // History and Sanitization State
  const [history, setHistory] = useState<any[]>([]);
  const [instructionsSanitized, setInstructionsSanitized] = useState(false);
  const [sanitizeReason, setSanitizeReason] = useState('');

  // Fetch current settings on load
  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        if (data && data.success) {
          setSettings(data.data);
          if (data.instructionsSanitized) {
            setInstructionsSanitized(true);
            setSanitizeReason(data.sanitizeReason || '');
          } else {
            setInstructionsSanitized(false);
            setSanitizeReason('');
          }
        }
      }
    } catch (e) {
      console.error('Error fetching settings:', e);
    }
  };

  // Fetch History of instructions
  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/settings/instructions-history');
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        if (data && data.success) {
          setHistory(data.history || []);
        }
      }
    } catch (e) {
      console.error('Error fetching instructions history:', e);
    }
  };

  // Rollback instructions
  const handleRollback = async (id: string) => {
    try {
      const res = await fetch('/api/settings/instructions-rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        const text = await res.text();
        if (!text.trim()) {
          throw new Error('Пустой ответ сервера');
        }
        const data = JSON.parse(text);
        if (data.success) {
          onAddToast('Успешный откат инструкции ИИ!', 'success');
          setSettings(data.data);
          fetchHistory();
          if (data.instructionsSanitized) {
            setInstructionsSanitized(true);
            setSanitizeReason(data.sanitizeReason || '');
            onAddToast('Обнаружена попытка удаления базовых защитных правил! Восстановлен дефолтный шаблон с вашими правками.', 'error');
          } else {
            setInstructionsSanitized(false);
            setSanitizeReason('');
          }
        } else {
          onAddToast('Не удалось выполнить откат: ' + data.error, 'error');
        }
      }
    } catch (e: any) {
      onAddToast('Сбой подключения при откате: ' + e.message, 'error');
    }
  };

  // Fetch News from Sentinel Shield
  const fetchNews = async (force = false) => {
    setNewsLoading(true);
    try {
      const res = await fetch(`/api/market/news?refresh=${force}`);
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const text = await res.text();
          if (text.trim()) {
            const data = JSON.parse(text);
            if (data.success) {
              setNews(data.text);
              setNewsTimestamp(data.timestamp);
              if (force) {
                onAddToast('Бюллетень Sentinel Shield успешно обновлен!', 'success');
              }
            } else {
              onAddToast('Не удалось получить бюллетень: ' + (data.error || ''), 'error');
            }
          } else {
            onAddToast('Пустой ответ от службы новостей Sentinel', 'error');
          }
        } else {
          onAddToast('Неверный формат ответа службы новостей Sentinel', 'error');
        }
      }
    } catch (e: any) {
      onAddToast('Ошибка подключения к службе новостей Sentinel: ' + e.message, 'error');
    } finally {
      setNewsLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    fetchNews();
    fetchHistory();
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [chatMessages, chatLoading]);

  // Handle Manual Save
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaveLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const text = await res.text();
        if (!text.trim()) {
          throw new Error('Пустой ответ сервера');
        }
        const data = JSON.parse(text);
        if (data.success) {
          setSettings(data.data);
          onAddToast('Торговые параметры успешно сохранены на сервере!', 'success');
          if (data.instructionsSanitized) {
            setInstructionsSanitized(true);
            setSanitizeReason(data.sanitizeReason || '');
            onAddToast('Обнаружена попытка удаления базовых защитных правил! Восстановлен дефолтный шаблон с вашими правками.', 'error');
          } else {
            setInstructionsSanitized(false);
            setSanitizeReason('');
          }
          if (setTradingMode && settings.tradingMode !== tradingMode) {
            setTradingMode(settings.tradingMode);
            if (onRefreshBalance) onRefreshBalance();
          }
          fetchHistory();
        } else {
          onAddToast('Ошибка сохранения: ' + (data.error || 'неизвестно'), 'error');
        }
      }
    } catch (e: any) {
      onAddToast('Сбой сети при сохранении параметров: ' + e.message, 'error');
    } finally {
      setSaveLoading(false);
    }
  };

  // Core AI Auditor interaction logic
  const sendMessageToAuditor = async (textToSend: string) => {
    if (!textToSend.trim() || chatLoading) return;

    const userMsg = textToSend.trim();
    setChatMessages(prev => [...prev, {
      role: 'user',
      text: userMsg,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/settings/ai-auditor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg })
      });
      
      if (res.ok) {
        const text = await res.text();
        if (!text.trim()) {
          throw new Error('Пустой ответ сервера');
        }
        const data = JSON.parse(text);
        if (data.success) {
          setChatMessages(prev => [...prev, {
            role: 'assistant',
            text: data.explanation,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }]);
          setSettings(data.updatedSettings);
          onAddToast('Настройки адаптированы ИИ-Ревизором!', 'success');
          if (data.instructionsSanitized) {
            setInstructionsSanitized(true);
            setSanitizeReason(data.sanitizeReason || '');
            onAddToast('Обнаружена попытка удаления базовых защитных правил! Восстановлен дефолтный шаблон с вашими правками.', 'error');
          } else {
            setInstructionsSanitized(false);
            setSanitizeReason('');
          }
          if (setTradingMode && data.updatedSettings.tradingMode !== tradingMode) {
            setTradingMode(data.updatedSettings.tradingMode);
            if (onRefreshBalance) onRefreshBalance();
          }
          fetchHistory();
        } else {
          setChatMessages(prev => [...prev, {
            role: 'assistant',
            text: `Ошибка калибровки: ${data.error || 'Не удалось применить команду.'}`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }]);
        }
      } else {
        setChatMessages(prev => [...prev, {
          role: 'assistant',
          text: 'К сожалению, сервер сейчас перегружен. Попробуйте отправить команду повторно через несколько секунд.',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
      }
    } catch (e: any) {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        text: `Сеть недоступна: ${e.message}`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Handle Chat submit to AI Auditor
  const handleSendToAuditor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const inputMsg = chatInput;
    setChatInput('');
    await sendMessageToAuditor(inputMsg);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* HEADER HUD */}
      <div className="bg-gradient-to-r from-indigo-950/20 via-[#0a0a0c]/90 to-amber-950/20 border border-white/[0.04] rounded-2xl p-6 shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
            <h1 className="text-xl font-sans font-black tracking-tight text-white uppercase">ИИ-Ревизор & Настройки Трейдинга</h1>
          </div>
          <p className="text-xs text-zinc-400">Управляйте микронастройками шорт-скальпинга напрямую или поручите калибровку правил ИИ-Ревизору</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-zinc-550 uppercase tracking-widest bg-zinc-900 px-2.5 py-1 rounded-md border border-white/[0.03]">СТАТУС ИИ</span>
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-black text-emerald-400 font-mono tracking-widest uppercase animate-pulse">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span> АКТИВЕН & НА СВЯЗИ
          </span>
        </div>
      </div>

      {instructionsSanitized && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-5 flex items-start gap-3.5 animate-in slide-in-from-top duration-300">
          <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-xs font-black uppercase text-rose-400 tracking-wider mb-1">Критическое Предупреждение ИИ-Ревизора</h4>
            <p className="text-xs text-zinc-300 font-sans leading-relaxed">
              {sanitizeReason || "Обнаружена попытка удаления базовых защитных правил! Восстановлен дефолтный шаблон с вашими правками."}
            </p>
          </div>
          <button 
            type="button"
            onClick={() => setInstructionsSanitized(false)}
            className="text-[9px] font-mono text-zinc-400 hover:text-white bg-zinc-900 border border-white/[0.04] px-2.5 py-1.5 rounded-lg active:scale-95 transition"
          >
            Скрыть
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* LEFT COLUMN: NEWS + FINE-TUNING FORM (col-span-7) */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          
          {/* BULLET SENTINEL SHIELD NEWS */}
          <div className="bg-[#0b0b0e]/90 border border-white/[0.04] rounded-2xl p-5 shadow-lg flex flex-col min-h-[320px] relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-44 h-44 bg-indigo-500/[0.01] rounded-full blur-3xl pointer-events-none group-hover:bg-indigo-500/[0.02] transition-all"></div>
            
            <div className="flex justify-between items-center border-b border-white/[0.04] pb-4 mb-4">
              <div className="flex items-center gap-2">
                <Newspaper className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-black tracking-wider uppercase text-zinc-100">Бюллетень Sentinel Shield (Новости)</h3>
              </div>
              <div className="flex items-center gap-3">
                {newsTimestamp && (
                  <span className="text-[9px] font-mono text-zinc-500">
                    Обновлено: {new Date(newsTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
                <button
                  type="button"
                  disabled={newsLoading}
                  onClick={() => fetchNews(true)}
                  className="p-1.5 bg-zinc-900 border border-white/[0.06] rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition disabled:opacity-50"
                  title="Обновить сводку"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", newsLoading ? "animate-spin text-emerald-400" : "")} />
                </button>
              </div>
            </div>

            {newsLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 py-10">
                <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                <p className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest animate-pulse">Анализ Sentinel Shield и генерация новостей...</p>
              </div>
            ) : news ? (
              <div className="flex-1 overflow-y-auto max-h-[380px] pr-2 scrollbar-thin text-zinc-300 text-xs leading-relaxed space-y-4 font-sans select-text">
                <div className="markdown-body prose prose-invert prose-xs max-w-none">
                  {news.split('\n').map((line, idx) => {
                    if (line.startsWith('#')) {
                      const text = line.replace(/^[#\s]+/, '');
                      return <h4 key={idx} className="text-zinc-100 font-bold uppercase tracking-wide border-l-2 border-indigo-500 pl-2 mt-4 mb-2 text-xs">{text}</h4>;
                    }
                    if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
                      return <li key={idx} className="ml-4 list-disc text-zinc-300 my-1">{line.replace(/^[\s-*]+/, '')}</li>;
                    }
                    if (line.includes('**')) {
                      // Simple strong format replacement
                      const parts = line.split('**');
                      return (
                        <p key={idx} className="my-1.5 text-zinc-300">
                          {parts.map((p, i) => i % 2 === 1 ? <strong key={i} className="text-zinc-100 font-bold">{p}</strong> : p)}
                        </p>
                      );
                    }
                    return line.trim() ? <p key={idx} className="my-1 text-zinc-300">{line}</p> : <div key={idx} className="h-2"></div>;
                  })}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
                <CircleAlert className="w-6 h-6 text-zinc-650 mb-2" />
                <p className="text-xs text-zinc-500">Бюллетень временно недоступен. Нажмите кнопку обновления выше.</p>
              </div>
            )}
            
            <div className="mt-4 pt-3 border-t border-white/[0.03] text-[9px] font-mono text-zinc-550 flex items-center justify-between">
              <span>Сентимент-анализ обновляется в реальном времени.</span>
              <span className="text-emerald-400">РУССКАЯ ОЦЕНКА ВЛИЯНИЯ</span>
            </div>
          </div>

          {/* DYNAMIC SETTINGS CONSOLE */}
          <div className="bg-[#0b0b0e]/90 border border-white/[0.04] rounded-2xl p-5 shadow-lg flex flex-col relative overflow-hidden group">
            <div className="flex items-center gap-2 border-b border-white/[0.04] pb-4 mb-5">
              <Sliders className="w-4 h-4 text-indigo-400" />
              <h3 className="text-xs font-black tracking-wider uppercase text-zinc-100">Терминальная Калибровка Параметров</h3>
            </div>

            {settings ? (
              <form onSubmit={handleSaveSettings} className="space-y-5">
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Mode */}
                  <div>
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Режим работы терминала</label>
                    <select
                      value={settings.tradingMode || 'virtual'}
                      onChange={e => setSettings({ ...settings, tradingMode: e.target.value })}
                      className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-bold focus:outline-none focus:border-indigo-500/40"
                    >
                      <option value="virtual">TESTNET (Виртуальный симулятор)</option>
                      <option value="real">LIVE (Реальные фьючерсы)</option>
                    </select>
                  </div>

                  {/* Autopilot Aggressiveness */}
                  <div>
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Стиль автопилота</label>
                    <select
                      value={settings.autopilotAggressiveness || 'conservative'}
                      onChange={e => setSettings({ ...settings, autopilotAggressiveness: e.target.value })}
                      className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-bold focus:outline-none focus:border-indigo-500/40"
                    >
                      <option value="conservative">КОНСЕРВАТИВНЫЙ (Квалифицированный риск)</option>
                      <option value="moderate">УМЕРЕННЫЙ (Баланс шорт-сетки)</option>
                      <option value="aggressive">АГРЕССИВНЫЙ (Частый вход по SAR)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/[0.03] pt-4.5">
                  {/* DCA MULTIPLIER */}
                  <div>
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1 my-0.5">Множитель сеток DCA</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number"
                        step="0.1"
                        min="0.3"
                        max="3.0"
                        value={settings.dcaMultiplierFactor !== undefined ? settings.dcaMultiplierFactor : 1.0}
                        onChange={e => setSettings({ ...settings, dcaMultiplierFactor: Number(e.target.value) })}
                        className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-indigo-500/40"
                      />
                      <span className="text-[10px] font-mono text-zinc-500">x</span>
                    </div>
                  </div>

                  {/* AI MIN CONFIDENCE */}
                  <div>
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1 my-0.5">Мин. коэффициент ИИ</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.4"
                      max="0.95"
                      value={settings.aiMinConfidenceThreshold !== undefined ? settings.aiMinConfidenceThreshold : 0.75}
                      onChange={e => setSettings({ ...settings, aiMinConfidenceThreshold: Number(e.target.value) })}
                      className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-indigo-500/40"
                    />
                  </div>

                  {/* BTC SHOCK */}
                  <div>
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1 my-0.5">Порог шока BTC (%)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.5"
                      max="5.0"
                      value={settings.btcShockThreshold !== undefined ? settings.btcShockThreshold : 1.5}
                      onChange={e => setSettings({ ...settings, btcShockThreshold: Number(e.target.value) })}
                      className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-indigo-500/40"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-white/[0.03] pt-4.5">
                  {/* VOLATILITY BRAKE */}
                  <div className="bg-[#111113] p-3 rounded-xl border border-white/[0.04]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-zinc-200">ТОРМОЗ ВОЛАТИЛЬНОСТИ</span>
                      <input
                        type="checkbox"
                        checked={!!settings.isVolatilityBrakeEnabled}
                        onChange={e => setSettings({ ...settings, isVolatilityBrakeEnabled: e.target.checked })}
                        className="rounded bg-zinc-800 border-zinc-700 text-indigo-500 focus:ring-indigo-500 h-3.5 w-3.5"
                      />
                    </div>
                    <p className="text-[9px] text-zinc-500 leading-normal mb-2">Блокирует Short-сделки при экстремальной волатильности монеты за последний час.</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] text-zinc-500 uppercase">Предел 1ч (%):</span>
                      <input
                        type="number"
                        step="0.5"
                        value={settings.maxVolatilityLimit || 12.0}
                        onChange={e => setSettings({ ...settings, maxVolatilityLimit: Number(e.target.value) })}
                        disabled={!settings.isVolatilityBrakeEnabled}
                        className="w-20 bg-zinc-900 border border-white/[0.04] rounded-lg px-2 py-1 text-xs text-zinc-200 font-mono disabled:opacity-30"
                      />
                    </div>
                  </div>

                  {/* DRIFT SHIELD (FUNDING LIMIT) */}
                  <div className="bg-[#111113] p-3 rounded-xl border border-white/[0.04]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-zinc-200">ЛИМИТ DRIFT SHIELD</span>
                      <span className="text-[8px] bg-red-500/10 text-red-400 border border-red-500/20 px-1 rounded font-mono font-black">ФАНДИНГ</span>
                    </div>
                    <p className="text-[9px] text-zinc-500 leading-normal mb-2">Запрещает шорты по монетам с критически отрицательным фандингом (опасность сквиза).</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] text-zinc-500 uppercase">Limit (%):</span>
                      <input
                        type="number"
                        step="0.01"
                        max="0.0"
                        value={settings.fundingShieldLimit !== undefined ? settings.fundingShieldLimit : -0.15}
                        onChange={e => setSettings({ ...settings, fundingShieldLimit: Number(e.target.value) })}
                        className="w-24 bg-zinc-900 border border-white/[0.04] rounded-lg px-2 py-1 text-xs text-zinc-200 font-mono"
                      />
                    </div>
                  </div>

                  {/* OPTIMAL TRADE ENTRY (OTE) */}
                  <div className="bg-[#111113] p-3 rounded-xl border border-white/[0.04]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-zinc-200">OPTIMAL TRADE ENTRY (OTE)</span>
                      <input
                        type="checkbox"
                        checked={!!settings.isOteEntryEnabled}
                        onChange={e => setSettings({ ...settings, isOteEntryEnabled: e.target.checked })}
                        className="rounded bg-zinc-800 border-zinc-700 text-indigo-500 focus:ring-indigo-500 h-3.5 w-3.5"
                      />
                    </div>
                    <p className="text-[9px] text-zinc-500 leading-normal">Вместо немедленного входа по рынку выставляет лимитную заявку глубже в зоне отката (50–61.8% от импульса после снятия ликвидности) и ждёт исполнения до 3 минут. Если цена не вернётся в зону — сделка пропускается. Работает и на реальных, и на виртуальных сделках.</p>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={saveLoading}
                    className="px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider text-white bg-indigo-600 hover:bg-indigo-500 active:scale-95 transition-all shadow-lg flex items-center gap-2 disabled:opacity-50"
                  >
                    {saveLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Сохранить изменения
                  </button>
                </div>

              </form>
            ) : (
              <div className="py-8 text-center text-zinc-500 text-xs">Загрузка параметров терминала...</div>
            )}
          </div>

          {/* СКВОЗНОЕ ТЕСТИРОВАНИЕ СИСТЕМЫ И СИГНАЛОВ */}
          <div className="bg-[#0b0b0e]/90 border border-white/[0.04] rounded-2xl p-5 shadow-lg flex flex-col relative overflow-hidden group">
            <div className="flex items-center gap-2 border-b border-white/[0.04] pb-4 mb-4">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h3 className="text-xs font-black tracking-wider uppercase text-zinc-100">Сквозное Тестирование Сигналов</h3>
            </div>
            
            <p className="text-[10px] text-zinc-400 leading-relaxed mb-4">
              Поскольку реальные рынки Weex могут быть спокойными, используйте инжектор для вброса идеального торгового сетапа. Система перерассчитает индикаторы, сгенерирует сигнал и автоматически откроет виртуальную позицию.
            </p>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Тестовый актив</label>
                <select
                  id="test-symbol"
                  defaultValue="SOLUSDT"
                  className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-bold focus:outline-none focus:border-emerald-500/40"
                >
                  <option value="SOLUSDT">SOLUSDT</option>
                  <option value="BTCUSDT">BTCUSDT</option>
                  <option value="ETHUSDT">ETHUSDT</option>
                  <option value="XRPUSDT">XRPUSDT</option>
                </select>
              </div>

              <div>
                <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Направление</label>
                <select
                  id="test-direction"
                  defaultValue="SHORT"
                  className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-bold focus:outline-none focus:border-emerald-500/40"
                >
                  <option value="SHORT">SHORT (Памп-разворот)</option>
                  <option value="LONG">LONG (Пролив-отскок)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                id="test-btn-force"
                className="flex-1 px-4 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-wider text-white bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition-all shadow-lg flex items-center justify-center gap-1.5 cursor-pointer"
                onClick={async () => {
                  const sym = (document.getElementById('test-symbol') as HTMLSelectElement)?.value || 'SOLUSDT';
                  const dir = (document.getElementById('test-direction') as HTMLSelectElement)?.value || 'SHORT';
                  try {
                    const res = await fetch('/api/debug/inject-test-signal', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ symbol: sym, direction: dir, force: true })
                    });
                    const text = await res.text();
                    if (!text.trim()) {
                      throw new Error('Пустой ответ сервера');
                    }
                    const data = JSON.parse(text);
                    if (data.success) {
                      onAddToast(`Тестовый сигнал ${sym} (${dir}) успешно сгенерирован! Сделка открыта: ${data.autopilotTradeOpened ? 'Да' : 'Нет'}`, 'success');
                      if (onRefreshBalance) onRefreshBalance();
                    } else {
                      onAddToast(`Ошибка теста: ${data.error}`, 'error');
                    }
                  } catch (e: any) {
                    onAddToast(`Сбой подключения: ${e.message}`, 'error');
                  }
                }}
              >
                <Play className="w-3.5 h-3.5" />
                Вбросить Сигнал (Force Entry)
              </button>

              <button
                type="button"
                id="test-btn-scan"
                className="px-4 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-wider text-zinc-200 bg-zinc-800 hover:bg-zinc-700 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                onClick={async () => {
                  const sym = (document.getElementById('test-symbol') as HTMLSelectElement)?.value || 'SOLUSDT';
                  const dir = (document.getElementById('test-direction') as HTMLSelectElement)?.value || 'SHORT';
                  try {
                    const res = await fetch('/api/debug/inject-test-signal', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ symbol: sym, direction: dir, force: false })
                    });
                    const text = await res.text();
                    if (!text.trim()) {
                      throw new Error('Пустой ответ сервера');
                    }
                    const data = JSON.parse(text);
                    if (data.success) {
                      onAddToast(`Сигнал ${sym} передан сканеру. Прошел фильтры: ${data.signalGenerated ? 'Да' : 'Нет'}. Сделка: ${data.autopilotTradeOpened ? 'Да' : 'Нет'}`, 'info');
                      if (onRefreshBalance) onRefreshBalance();
                    } else {
                      onAddToast(`Ошибка сканирования: ${data.error}`, 'error');
                    }
                  } catch (e: any) {
                    onAddToast(`Сбой подключения: ${e.message}`, 'error');
                  }
                }}
              >
                <Activity className="w-3.5 h-3.5" />
                Тест Сканера (Чистый проход)
              </button>
            </div>
          </div>

          {/* ИСТОРИЯ ИЗМЕНЕНИЙ ИИ */}
          <div className="bg-[#0b0b0e]/90 border border-white/[0.04] rounded-2xl p-5 shadow-lg flex flex-col relative overflow-hidden group">
            <div className="flex items-center justify-between border-b border-white/[0.04] pb-4 mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-black tracking-wider uppercase text-zinc-100">История изменений инструкций ИИ</h3>
              </div>
              <button
                type="button"
                onClick={fetchHistory}
                className="p-1 px-2.5 bg-zinc-900 border border-white/[0.06] rounded-lg text-zinc-400 hover:text-white transition text-[9px] font-mono flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-2.5 h-2.5" />
                Обновить
              </button>
            </div>

            {history.length === 0 ? (
              <div className="py-6 text-center text-zinc-500 text-xs">История изменений пуста или еще не сформирована.</div>
            ) : (
              <div className="space-y-3 max-h-60 overflow-y-auto pr-1 scrollbar-thin">
                {history.slice().reverse().map((item: any) => (
                  <div key={item.id} className="p-3 rounded-xl bg-[#111113] border border-white/[0.03] flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          "text-[8px] px-1.5 py-0.5 rounded font-black font-mono tracking-wider uppercase",
                          item.author === 'USER' 
                            ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" 
                            : item.author === 'RETROSPECTIVE'
                              ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                              : "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                        )}>
                          {item.author}
                        </span>
                        <span className="text-[9px] font-mono text-zinc-500">
                          {new Date(item.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-[10px] text-zinc-300 font-sans truncate" title={item.reason}>
                        Причина: <span className="text-zinc-400 font-bold">{item.reason}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRollback(item.id)}
                      className="px-2.5 py-1.5 rounded-lg bg-indigo-600/10 hover:bg-indigo-600 hover:text-white text-indigo-400 border border-indigo-500/20 text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer"
                    >
                      Откатить
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN: INTERACTIVE AI REMISSOR CHAT (col-span-5) */}
        <div className="lg:col-span-5 bg-[#0a0a0c]/85 border border-white/[0.04] rounded-3xl p-5.5 shadow-xl flex flex-col justify-between max-h-[820px] relative overflow-hidden">
          
          <div>
            <div className="flex items-center justify-between border-b border-white/[0.04] pb-4 mb-4">
              <div className="flex items-center gap-22.5">
                <div className="flex items-center gap-2">
                  <div className="bg-indigo-500/10 p-1.5 rounded-xl border border-indigo-500/20">
                    <Bot className="w-4 h-4 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-xs font-black tracking-wider uppercase text-zinc-100 leading-tight">ИИ-Ревизор Трейдинга</h3>
                    <span className="text-[8px] font-mono text-zinc-550 uppercase tracking-widest block mt-[2px]">Синхронизация Агентов</span>
                  </div>
                </div>
              </div>
              <span className="text-[8px] bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded font-black font-mono">РЕАКТИВНЫЙ</span>
            </div>
            
            {/* CHAT MESSAGES LOG */}
            <div 
              ref={chatContainerRef}
              className="space-y-4 overflow-y-auto max-h-[580px] pr-2.5 scrollbar-thin flex flex-col py-2 select-text" 
              style={{ minHeight: '380px' }}
            >
              {chatMessages.map((msg, idx) => (
                <div 
                  key={idx} 
                  className={cn(
                    "max-w-[88%] rounded-2xl p-3.5 text-xs flex flex-col gap-1 shadow-sm",
                    msg.role === 'user' 
                      ? "bg-indigo-600 border border-indigo-500/30 text-white self-end rounded-tr-none" 
                      : "bg-zinc-900/60 border border-white/[0.03] text-zinc-150 self-start rounded-tl-none"
                  )}
                >
                  <p className="whitespace-pre-line leading-relaxed font-sans select-text">
                    {msg.text}
                  </p>
                  <span className={cn(
                    "text-[8px] font-mono select-none self-end mt-1",
                    msg.role === 'user' ? "text-indigo-200" : "text-zinc-500"
                  )}>
                    {msg.time}
                  </span>
                </div>
              ))}
              {chatLoading && (
                <div className="bg-zinc-900/60 border border-white/[0.03] text-zinc-150 self-start rounded-2xl rounded-tl-none p-3.5 max-w-[85%] flex items-center gap-2.5">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                  <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider animate-pulse">ИИ-Ревизор думает, перерассчитывает правила...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>

          {/* QUICK TEMPLATES */}
          <div className="border-t border-white/[0.04] pt-4 mt-2">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-2.5">Быстрые шаблоны запросов / директив (клик для отправки):</span>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto pr-1">
              {QUICK_TEMPLATES.map((t, idx) => (
                <button
                  key={idx}
                  type="button"
                  disabled={chatLoading}
                  onClick={() => {
                    sendMessageToAuditor(t.text);
                    onAddToast(`Отправлен шаблон: "${t.label}"`, 'info');
                  }}
                  className="bg-zinc-900 hover:bg-indigo-950/40 hover:text-indigo-400 border border-white/[0.04] hover:border-indigo-500/20 rounded-xl px-2.5 py-1.5 text-[10px] text-zinc-400 font-medium transition-all text-left whitespace-nowrap active:scale-95 disabled:opacity-50"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* INPUT FORM */}
          <form onSubmit={handleSendToAuditor} className="border-t border-white/[0.04] pt-4 mt-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                disabled={chatLoading}
                placeholder="Спроси меня или дай директиву боту..."
                className="flex-1 bg-[#111113] border border-white/[0.06] rounded-xl px-4 py-3 text-xs text-zinc-150 focus:outline-none focus:border-indigo-500/40 disabled:opacity-50 font-sans"
              />
              <button
                type="submit"
                disabled={chatLoading || !chatInput.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 active:scale-95 disabled:opacity-50 text-white p-3 rounded-xl transition-all shadow-lg flex items-center justify-center border border-indigo-500/20"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[8.5px] text-zinc-500 text-center mt-2.5">Директивы напрямую транслируют логику в ядро экспертного трейдинга.</p>
          </form>

        </div>

      </div>

    </div>
  );
}

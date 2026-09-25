/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { TradingTerminal } from './components/TradingTerminal';
import { FineTuningPanel } from './components/FineTuningPanel';
import { Settings, X, Send, BookOpen, GraduationCap, AlertTriangle, Activity, Bell, BellOff, Plus, Trash2, Key, Eye, EyeOff, ShieldAlert, Flame, Brain, Bot, BrainCircuit, TrendingDown, TrendingUp, Zap, Maximize2, Minimize2, ExternalLink, Sparkles, Sliders, Layers, Copy, Check, RotateCcw } from 'lucide-react';
import { cn } from './lib/utils';

interface TelegramBotConfig {
  id: string;
  name?: string;
  botToken: string;
  chatId: string;
  isEnabled: boolean;
  muteWatchdog?: boolean;
}

export interface MultiAccountItem {
  id: string;
  name: string;
  exchange: string;
  apiKey: string;
  apiSecret: string;
  password?: string;
  isEnabled: boolean;
  statusText?: string;
}

interface ExchangeConfig {
  exchange: string;
  apiKey: string;
  apiSecret: string;
  password?: string;
  isEnabled: boolean;
  multiAccounts?: MultiAccountItem[];
}

export default function App() {
  const [currentTab, setCurrentTab] = useState<'terminal'>('terminal');
  const [isStandaloneTerminal, setIsStandaloneTerminal] = useState(false);
  const [isStandaloneTrade, setIsStandaloneTrade] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isStandaloneTerm = window.location.search.includes('standalone=terminal');
      const isStandaloneTrd = window.location.search.includes('standalone=trade');
      if (isStandaloneTerm || isStandaloneTrd) {
        setIsStandaloneTerminal(true);
        if (isStandaloneTrd) {
          setIsStandaloneTrade(true);
        }
        setCurrentTab('terminal');
      }
    }
  }, []);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  const handleOpenNewWindow = async () => {
    try {
      const res = await fetch('/api/paper-trade');
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const text = await res.text();
        if (text.trim()) {
          const data = JSON.parse(text);
          const activeTrades = data.activeTrades || data.data || [];
          if (activeTrades.length > 0) {
            const first = activeTrades[0];
            const url = window.location.origin + `?standalone=trade&tradeId=${first.id}&symbol=${first.symbol}`;
            window.open(url, '_blank', 'width=1400,height=900,status=no,menubar=no,resizable=yes');
            return;
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
    const url = window.location.origin + '?standalone=terminal';
    window.open(url, '_blank', 'width=1400,height=900,status=no,menubar=no,resizable=yes');
  };

  const [isFaqOpen, setIsFaqOpen] = useState(false);
  const [telegramBots, setTelegramBots] = useState<TelegramBotConfig[]>([]);
  const [exchangeConfig, setExchangeConfig] = useState<ExchangeConfig>({
    exchange: 'weex',
    apiKey: '',
    apiSecret: '',
    isEnabled: false
  });
  const [showSecret, setShowSecret] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testStatus, setTestStatus] = useState('');
  const [exchangeTestStatus, setExchangeTestStatus] = useState('');
  const [btcShockThreshold, setBtcShockThreshold] = useState<number>(1.5);
  const [failedAutopilotSymbols, setFailedAutopilotSymbols] = useState<string[]>([]);
  const [autopilotAggressiveness, setAutopilotAggressiveness] = useState<'conservative' | 'moderate' | 'aggressive'>('conservative');
  const [isAiExpertTraderEnabled, setIsAiExpertTraderEnabled] = useState<boolean>(true);
  const [isAiPartialCloseRealEnabled, setIsAiPartialCloseRealEnabled] = useState<boolean>(true);
  const [aiExpertTraderInterval, setAiExpertTraderInterval] = useState<number>(120000);
  const [aiExpertTraderInstructions, setAiExpertTraderInstructions] = useState<string>('');
  const [aiMinConfidenceThreshold, setAiMinConfidenceThreshold] = useState<number>(0.75);
  const [isVolatilityBrakeEnabled, setIsVolatilityBrakeEnabled] = useState<boolean>(false);
  const [maxVolatilityLimit, setMaxVolatilityLimit] = useState<number>(12.0);
  const [fundingShieldLimit, setFundingShieldLimit] = useState<number>(-0.15);
  const [dcaMultiplierFactor, setDcaMultiplierFactor] = useState<number>(1.0);
  const [allowedTradingDirections, setAllowedTradingDirections] = useState<'SHORT_ONLY' | 'LONG_ONLY' | 'BOTH'>('BOTH');
  const [activeStrategy, setActiveStrategy] = useState<'SHORT_PUMP_FADE' | 'TREND_FOLLOWING' | 'RANGE_MEAN_REVERSION' | 'ADAPTIVE_DYNAMIC'>('SHORT_PUMP_FADE');
  const [isLiquiditySweepFilterEnabled, setIsLiquiditySweepFilterEnabled] = useState<boolean>(true);
  const [isEma200FilterEnabled, setIsEma200FilterEnabled] = useState<boolean>(true);
  const [isFvgAboveFilterEnabled, setIsFvgAboveFilterEnabled] = useState<boolean>(true);
  const [isFvgSupportBelowFilterEnabled, setIsFvgSupportBelowFilterEnabled] = useState<boolean>(true);
  const [isLateShortFilterEnabled, setIsLateShortFilterEnabled] = useState<boolean>(true);
  const [isSymmetricConfidenceFilterEnabled, setIsSymmetricConfidenceFilterEnabled] = useState<boolean>(false);
  const [isCommitteeConsensusCheckEnabled, setIsCommitteeConsensusCheckEnabled] = useState<boolean>(false);
  const [isOteEntryEnabled, setIsOteEntryEnabled] = useState<boolean>(false);
  const [liquiditySweepWickThreshold, setLiquiditySweepWickThreshold] = useState<number>(0.60);
  const [settingsSnapshot, setSettingsSnapshot] = useState<string | null>(null);
  const [modelWeights, setModelWeights] = useState<Record<string, number> | null>(null);
  const [settingsTab, setSettingsTab] = useState<'system' | 'ai_settings' | 'integrations'>('system');
  
  const [excludeBinanceCrossListed, setExcludeBinanceCrossListed] = useState<boolean>(false);
  const [maxSpotAllocationPct, setMaxSpotAllocationPct] = useState<number>(10);
  const [tradingMarketMode, setTradingMarketMode] = useState<'FUTURES' | 'SPOT' | 'HYBRID'>('HYBRID');
  const [virtualBalanceApp, setVirtualBalanceApp] = useState<number>(0);
  const [realBalanceApp, setRealBalanceApp] = useState<number | null>(null);
  const [tradingMode, setTradingMode] = useState<'virtual'|'real'>('virtual');
  const [isAutoPilotEnabled, setIsAutoPilotEnabled] = useState<boolean>(false); // FORCE FALSE BY DEFAULT FOR SAFETY

  const toggleAutopilot = () => {
    const newState = !isAutoPilotEnabled;
    setIsAutoPilotEnabled(newState);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('isAutoPilotEnabled', newState.toString());
    }
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAutopilotEnabled: newState })
    }).catch(err => console.error('Failed to update autopilot setting on server', err));
  };
  
  const fetchRealBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/exchange/balance');
      if (!res.ok) return;
      
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) return;

      const text = await res.text();
      if (!text || !text.trim()) return;
      const data = JSON.parse(text);
      if (data.success) setRealBalanceApp(data.balance);
    } catch(e) {}
  }, []);

  const filteredTelegramBots = useMemo(() => {
    return telegramBots.filter(b => b.isEnabled && b.botToken && b.chatId);
  }, [telegramBots]);

  useEffect(() => {
    fetchRealBalance();
    const interval = setInterval(fetchRealBalance, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, [exchangeConfig, tradingMode]);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('soundEnabled') !== 'false';
    }
    return true;
  });

  const toggleSound = () => {
    const newState = !soundEnabled;
    setSoundEnabled(newState);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('soundEnabled', newState.toString());
    }
    if (newState) {
      try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.05, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.3);
        }
      } catch (e) {
        console.error('Audio play failed', e);
      }
    }
  };

  const [toasts, setToasts] = useState<{id: number, msg: string, type: 'success' | 'error' | 'info'}[]>([]);
  const addToast = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (msg.includes("Failed to fetch")) return; // Suppress spamming network errors
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    let active = true;
    let retryDelay = 1000;
    const loadSettings = () => {
      fetch('/api/settings')
        .then(res => {
          if (res.ok && res.headers.get('content-type')?.includes('application/json')) return res.json();
          return { success: false };
        })
        .then(data => {
          if (!active) return;
          if (data.success && data.data) {
            setTelegramBots(data.data.telegramBots || []);
            if (data.data.exchangeApiConfig) {
              setExchangeConfig(data.data.exchangeApiConfig);
            }
            if (data.data.btcShockThreshold !== undefined) {
               setBtcShockThreshold(data.data.btcShockThreshold);
            }
            if (data.data.failedAutopilotSymbols !== undefined) {
               setFailedAutopilotSymbols(data.data.failedAutopilotSymbols || []);
            }
            if (data.data.autopilotAggressiveness !== undefined) {
               setAutopilotAggressiveness(data.data.autopilotAggressiveness || 'conservative');
            }
            if (data.data.isAiExpertTraderEnabled !== undefined) {
               setIsAiExpertTraderEnabled(data.data.isAiExpertTraderEnabled);
            }
            if (data.data.isAiPartialCloseRealEnabled !== undefined) {
               setIsAiPartialCloseRealEnabled(data.data.isAiPartialCloseRealEnabled);
            }
            if (data.data.aiExpertTraderInterval !== undefined) {
               setAiExpertTraderInterval(data.data.aiExpertTraderInterval);
            }
            if (data.data.aiExpertTraderInstructions !== undefined) {
               setAiExpertTraderInstructions(data.data.aiExpertTraderInstructions);
            }
            if (data.data.aiMinConfidenceThreshold !== undefined) {
               setAiMinConfidenceThreshold(data.data.aiMinConfidenceThreshold);
            }
            if (data.data.isVolatilityBrakeEnabled !== undefined) {
               setIsVolatilityBrakeEnabled(data.data.isVolatilityBrakeEnabled);
            }
            if (data.data.maxVolatilityLimit !== undefined) {
               setMaxVolatilityLimit(data.data.maxVolatilityLimit);
            }
            if (data.data.fundingShieldLimit !== undefined) {
               setFundingShieldLimit(data.data.fundingShieldLimit);
            }
            if (data.data.dcaMultiplierFactor !== undefined) {
               setDcaMultiplierFactor(data.data.dcaMultiplierFactor);
            }
            if (data.data.isOteEntryEnabled !== undefined) {
               setIsOteEntryEnabled(data.data.isOteEntryEnabled);
            }
            if (data.data.tradingMode !== undefined) {
               setTradingMode(data.data.tradingMode);
            }
            if (data.data.tradingMarketMode !== undefined) {
               setTradingMarketMode(data.data.tradingMarketMode);
               if (data.data.maxSpotAllocationPct !== undefined) setMaxSpotAllocationPct(data.data.maxSpotAllocationPct);
            }
            if (data.data.excludeBinanceCrossListed !== undefined) {
               setExcludeBinanceCrossListed(data.data.excludeBinanceCrossListed);
            }
            if (data.data.allowedTradingDirections !== undefined) {
               setAllowedTradingDirections(data.data.allowedTradingDirections);
            }
            if (data.data.activeStrategy !== undefined) {
               setActiveStrategy(data.data.activeStrategy);
            }
            if (data.data.isEma200FilterEnabled !== undefined) {
               setIsEma200FilterEnabled(data.data.isEma200FilterEnabled);
            }
            if (data.data.isFvgAboveFilterEnabled !== undefined) {
               setIsFvgAboveFilterEnabled(data.data.isFvgAboveFilterEnabled);
            }
            if (data.data.isFvgSupportBelowFilterEnabled !== undefined) {
               setIsFvgSupportBelowFilterEnabled(data.data.isFvgSupportBelowFilterEnabled);
            }
            if (data.data.isLiquiditySweepFilterEnabled !== undefined) {
               setIsLiquiditySweepFilterEnabled(data.data.isLiquiditySweepFilterEnabled);
            }
            if (data.data.isLateShortFilterEnabled !== undefined) {
               setIsLateShortFilterEnabled(data.data.isLateShortFilterEnabled);
            }
            if (data.data.isSymmetricConfidenceFilterEnabled !== undefined) {
               setIsSymmetricConfidenceFilterEnabled(data.data.isSymmetricConfidenceFilterEnabled);
            }
            if (data.data.isCommitteeConsensusCheckEnabled !== undefined) {
               setIsCommitteeConsensusCheckEnabled(data.data.isCommitteeConsensusCheckEnabled);
            }
            if (data.data.liquiditySweepWickThreshold !== undefined) {
               setLiquiditySweepWickThreshold(data.data.liquiditySweepWickThreshold);
            }
            if (data.data.modelWeights !== undefined) {
               setModelWeights(data.data.modelWeights);
            }
            if (data.data.isAutopilotEnabled !== undefined) {
               setIsAutoPilotEnabled(data.data.isAutopilotEnabled);
               if (typeof localStorage !== 'undefined') {
                 localStorage.setItem('isAutoPilotEnabled', data.data.isAutopilotEnabled.toString());
               }
            }
          } else {
            if (active && retryDelay < 16000) {
              setTimeout(() => { if (active) loadSettings(); }, retryDelay);
              retryDelay *= 2;
            }
          }
        })
        .catch(err => {
          console.warn('[SETTINGS FETCH] Failed to load, retrying in ' + retryDelay + 'ms...', err);
          if (active && retryDelay < 16000) {
            setTimeout(() => { if (active) loadSettings(); }, retryDelay);
            retryDelay *= 2;
          }
        });
    };
    loadSettings();
    return () => { active = false; };
  }, []);

  const handleRemoveFailedSymbol = async (sym: string) => {
    try {
      const res = await fetch('/api/settings/failed-symbols/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym })
      });
      const data = await res.json();
      if (data.success && data.data) {
        setFailedAutopilotSymbols(data.data.failedAutopilotSymbols || []);
        addToast(`Пара ${sym} разблокирована для автопилота`, 'success');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearFailedSymbols = async () => {
    try {
      const res = await fetch('/api/settings/failed-symbols/clear', {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success && data.data) {
        setFailedAutopilotSymbols([]);
        addToast('Черный список монет очищен', 'success');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const getSettingsSnapshotString = () => {
    return JSON.stringify({
      telegramBots,
      exchangeConfig,
      btcShockThreshold,
      autopilotAggressiveness,
      isAiExpertTraderEnabled,
      isAiPartialCloseRealEnabled,
      aiExpertTraderInterval,
      aiExpertTraderInstructions,
      aiMinConfidenceThreshold,
      isVolatilityBrakeEnabled,
      maxVolatilityLimit,
      fundingShieldLimit,
      dcaMultiplierFactor,
      isOteEntryEnabled,
      allowedTradingDirections,
      isEma200FilterEnabled,
      isFvgAboveFilterEnabled,
      isFvgSupportBelowFilterEnabled,
      isLiquiditySweepFilterEnabled,
      isLateShortFilterEnabled,
      isSymmetricConfidenceFilterEnabled,
      isCommitteeConsensusCheckEnabled,
      liquiditySweepWickThreshold
    });
  };

  useEffect(() => {
    if (isSettingsOpen) {
      setSettingsSnapshot(getSettingsSnapshotString());
    } else {
      setSettingsSnapshot(null);
    }
  }, [isSettingsOpen]);

  const saveSettings = async (overrideAgg?: 'conservative' | 'moderate' | 'aggressive') => {
    try {
      const isStringAgg = typeof overrideAgg === 'string' && ['conservative', 'moderate', 'aggressive'].includes(overrideAgg);
      const finalAgg = isStringAgg ? overrideAgg : autopilotAggressiveness;
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          telegramBots, 
          exchangeApiConfig: exchangeConfig, 
          btcShockThreshold,
          autopilotAggressiveness: finalAgg,
          isAiExpertTraderEnabled,
          isAiPartialCloseRealEnabled,
          aiExpertTraderInterval,
          aiExpertTraderInstructions,
          aiMinConfidenceThreshold,
          isVolatilityBrakeEnabled,
          maxVolatilityLimit,
          fundingShieldLimit,
          dcaMultiplierFactor,
          isOteEntryEnabled,
          allowedTradingDirections,
          isEma200FilterEnabled,
          isFvgAboveFilterEnabled,
          isFvgSupportBelowFilterEnabled,
          isLiquiditySweepFilterEnabled,
          liquiditySweepWickThreshold,
          isLateShortFilterEnabled,
          isSymmetricConfidenceFilterEnabled,
          isCommitteeConsensusCheckEnabled,
          tradingMarketMode,
          excludeBinanceCrossListed
        })
      });
      if (res.ok) {
        setTestStatus('Настройки сохранены!');
        setTimeout(() => setTestStatus(''), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const testConnection = async (botToken: string, chatId: string) => {
    setTestStatus('Тестирование...');
    try {
      const res = await fetch('/api/settings/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId })
      });
      const data = await res.json();
      if (data.success) {
        setTestStatus('✅ Успешно! Сообщение отправлено.');
      } else {
        setTestStatus('❌ Ошибка: ' + data.error);
      }
    } catch (e: any) {
      setTestStatus('❌ Ошибка: ' + e.message);
    }
  };

  const getChatId = async (id: string, botToken: string) => {
    if (!botToken) {
      setTestStatus('❌ Введите токен бота сначала');
      return;
    }
    setTestStatus('Ожидание подключения...');
    try {
      const res = await fetch('/api/telegram/get-chat-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken })
      });
      const data = await res.json();
      if (data.success) {
        updateBot(id, { chatId: data.chatId, name: data.name });
        setTestStatus(`✅ Chat ID получен (${data.name})`);
      } else {
        setTestStatus('❌ Ошибка: ' + data.error);
      }
    } catch (e: any) {
      setTestStatus('❌ Ошибка: ' + e.message);
    }
  };

  const testExchangeConnection = async () => {
    setExchangeTestStatus('Проверка подключения...');
    try {
      const res = await fetch('/api/settings/exchange/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exchangeConfig)
      });
      const data = await res.json();
      if (data.success) {
        setExchangeTestStatus('✅ Успешное подключение');
      } else {
        setExchangeTestStatus('❌ Ошибка: ' + data.error);
      }
    } catch (e: any) {
      setExchangeTestStatus('❌ Ошибка: ' + e.message);
    }
  };

  const addBot = () => {
    setTelegramBots([
      ...telegramBots, 
      { id: `bot-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`, name: `Бот ${telegramBots.length + 1}`, botToken: '', chatId: '', isEnabled: true }
    ]);
  };

  const updateBot = (id: string, updates: Partial<TelegramBotConfig>) => {
    setTelegramBots(bots => {
      const newBots = bots.map(b => b.id === id ? { ...b, ...updates } : b);
      // Auto-save when toggle is changed
      if (updates.isEnabled !== undefined || updates.muteWatchdog !== undefined) {
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telegramBots: newBots, exchangeApiConfig: exchangeConfig })
        });
      }
      return newBots;
    });
  };

  const toggleExchange = () => {
    const newConfig = { ...exchangeConfig, isEnabled: !exchangeConfig.isEnabled };
    setExchangeConfig(newConfig);
    // Auto-save toggle
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramBots, exchangeApiConfig: newConfig })
    });
  };

  const removeBot = (id: string) => {
    setTelegramBots(bots => bots.filter(b => b.id !== id));
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      {!isStandaloneTerminal && (
        <header className="border-b border-zinc-800 bg-zinc-900/50 p-4 flex flex-col md:flex-row gap-4 justify-between items-center z-50 relative">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-black text-yellow-500 tracking-tight">SpreadScanner</h1>
            <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">WEEX Quantitative Engine (SHORT & LONG)</span>
          </div>

          <div className="flex items-center gap-2">
            <button 
              onClick={toggleSound}
              className={`p-2 rounded-lg transition-colors ${soundEnabled ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
              title={soundEnabled ? "Звук включен" : "Звук выключен"}
            >
              {soundEnabled ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
            </button>
            <button 
              onClick={() => setIsFaqOpen(true)}
              className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-zinc-200 text-sm font-medium"
            >
              <BookOpen className="w-5 h-5" />
              <span className="hidden sm:inline">FAQ и Обучение</span>
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-zinc-200"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </header>
      )}
      <main className={cn(
        isStandaloneTerminal ? "p-0 h-screen w-full overflow-y-auto" : "p-4 relative min-h-[calc(100vh-80px)]"
      )}>
        <TradingTerminal 
          telegramBots={filteredTelegramBots} 
          addToast={addToast} 
          soundEnabled={soundEnabled} 
          onVirtualBalanceChange={setVirtualBalanceApp}
          tradingMode={tradingMode}
          setTradingMode={setTradingMode}
          realBalance={realBalanceApp}
          isAutoPilotEnabled={isAutoPilotEnabled}
          setIsAutoPilotEnabled={setIsAutoPilotEnabled}
          exchangeConfigEnabled={exchangeConfig.isEnabled}
          onRefreshRealBalance={fetchRealBalance}
          isStandaloneTrade={isStandaloneTrade}
          isStandaloneTerminal={isStandaloneTerminal}
          isAppFullscreen={isFullscreen}
          onToggleAppFullscreen={toggleFullscreen}
          onOpenSettings={(tab: 'system' | 'ai_settings' | 'integrations' = 'system') => {
            setSettingsTab(tab);
            setIsSettingsOpen(true);
          }}
        />
        
        {/* Global Toasts */}
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map(t => (
            <div key={t.id} className={`px-4 py-3 rounded-lg shadow-xl text-sm font-medium border animate-in slide-in-from-right-8 pointer-events-auto ${
              t.type === 'error' ? 'bg-red-950/90 border-red-900/50 text-red-200' :
              t.type === 'success' ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-200' :
              'bg-blue-950/90 border-blue-900/50 text-blue-200'
            }`}>
              {t.msg}
            </div>
          ))}
        </div>
      </main>

      {isFaqOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex justify-between items-center p-5 border-b border-zinc-800 bg-zinc-900/50">
              <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
                <GraduationCap className="w-6 h-6 text-yellow-500" />
                База знаний и Обучение
              </h2>
              <button onClick={() => setIsFaqOpen(false)} className="text-zinc-500 hover:text-zinc-300 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto space-y-8 custom-scrollbar">
              
              {/* Section 1 */}
              <div className="border border-zinc-800/80 rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800/80 flex items-center gap-3">
                  <GraduationCap className="w-5 h-5 text-indigo-400" />
                  <h3 className="text-lg font-bold text-zinc-200">Базовые принципы: Как устроена система?</h3>
                </div>
                <div className="p-5 bg-zinc-950/50 space-y-4 text-sm text-zinc-300">
                  <p>
                    <strong className="text-zinc-100">Двунаправленный квантовый скальпинг (SHORT & LONG)</strong> — это математически выверенная система поиска точек входа на фьючерсах и споте биржи WEEX. Сканер выявляет аномалии движения цены и открывает позиции как в ШОРТ (на истощении импульсов), так и в ЛОНГ (на реакциях от ключевых уровней).
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                    <div className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-lg">
                      <div className="text-indigo-400 font-bold mb-2">Этап 1: Детекция Импульса</div>
                      <p className="text-xs text-zinc-400">Сканер фиксирует аномальное движение цены (&gt;7% за 24ч или глубокий сброс) и всплеск объема выше нормы.</p>
                    </div>
                    <div className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-lg">
                      <div className="text-indigo-400 font-bold mb-2">Этап 2: Подтверждение ИИ</div>
                      <p className="text-xs text-zinc-400">Ансамбль ИИ проверяет переключение Parabolic SAR (1m/15m), снятие ликвидности (Sweep) и структуру BOS/ChoCh.</p>
                    </div>
                    <div className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-lg">
                      <div className="text-indigo-400 font-bold mb-2">Этап 3: Исполнение На WEEX</div>
                      <p className="text-xs text-zinc-400">Выставляется Sell/Buy Limit ордер у локального экстремума. Контроль рисков сопровождают сделку с динамическим TP/SL и DCA.</p>
                    </div>
                  </div>

                  <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex gap-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0" />
                    <p className="text-xs text-yellow-500/90">
                      <strong>Золотое правило:</strong> Вход осуществляется строго лимитными ордерами на откате после снятия ликвидности. Никогда не заходите маркет-ордерами в разгар вертикальной свечи.
                    </p>
                  </div>
                </div>
              </div>

              {/* Section 2 */}
              <div className="border border-zinc-800/80 rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800/80 flex items-center gap-3">
                  <BookOpen className="w-5 h-5 text-yellow-500" />
                  <h3 className="text-lg font-bold text-zinc-200">AI Трейдинг: Поиск уязвимостей и шорт-позиции</h3>
                </div>
                <div className="p-5 bg-zinc-950/50 space-y-6 text-sm text-zinc-300">
                  
                  <div className="space-y-3">
                    <p><strong className="text-yellow-500">Главная идея:</strong> Наш ИИ-агент непрерывно анализирует тысячи активов, выявляя те, из которых начинается массовый отток капитала. Цель — найти переоцененные монеты, готовые к стремительному падению.</p>
                    <p><strong className="text-zinc-100">Причины падения:</strong> Снижение цены обычно провоцируется новостным фоном, техническими факторами или нехваткой ликвидности. Крупный капитал избавляется от таких активов, что вызывает резкий дамп, на котором мы и зарабатываем.</p>
                    <p><strong className="text-zinc-100">Механика работы:</strong> При обнаружении паттерна бот выдает сигнал. Мы входим в позицию на понижение (шорт). Как только цена достигает целевого уровня, позиция закрывается с прибылью.</p>
                  </div>

                  <div className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-lg">
                    <h4 className="font-bold text-zinc-200 mb-2">Потенциал доходности (Пример расчета)</h4>
                    <ul className="list-disc pl-5 space-y-1 text-xs text-zinc-400">
                      <li>Старт: Депозит $200, Плечо: x5.</li>
                      <li>Первый вход: 5% от депозита = $10.</li>
                      <li>Усреднение 1 (лесенкой): +$10.</li>
                      <li>Усреднение 2: +$10.</li>
                      <li>Итого в сделке: $30.</li>
                    </ul>
                    <p className="text-xs text-emerald-400 mt-2 font-medium">
                      При движении цены на 3% в нашу сторону (с плечом 5x это 15% на позицию): $30 превращаются в $34.5. Чистая прибыль: +$4.5 с одной сделки.
                    </p>
                  </div>

                  <div className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-lg">
                    <h4 className="font-bold text-zinc-200 mb-3">Рекомендации по объему входа (Риск-менеджмент)</h4>
                    <div className="space-y-3">
                      <div>
                        <div className="text-indigo-400 font-medium text-xs">1. Капитал до $500</div>
                        <p className="text-xs text-zinc-400">Первый вход ~5%. При просадке на 5-10% усредняем позицию на 2-3%. <span className="text-red-400">Максимальная загрузка в одну сделку — до 15% от капитала!</span></p>
                      </div>
                      <div>
                        <div className="text-indigo-400 font-medium text-xs">2. Капитал $1,000 - $10,000</div>
                        <p className="text-xs text-zinc-400">Первый вход ~3%. При просадке на 5-10% усредняем на 1-2%. <span className="text-red-400">Максимальная загрузка — до 7%.</span></p>
                      </div>
                      <div>
                        <div className="text-indigo-400 font-medium text-xs">3. Капитал от $10,000</div>
                        <p className="text-xs text-zinc-400">Первый вход 1-2%. При просадке на 5-10% добавляем 1-2%. <span className="text-red-400">Максимальная загрузка — до 5%.</span></p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-bold text-zinc-200 mb-2">Правильное усреднение (Стратегия лесенки)</h4>
                    <p className="text-xs text-zinc-400 bg-zinc-900/30 p-3 rounded border border-zinc-800/50">
                      Например, вы вошли по $0.22 на 3% от депозита. Если цена пошла против вас на 5% (до $0.231), вы добавляете еще 3%. Ваша средняя цена становится $0.225. Не усредняйте позицию при микро-колебаниях (например, на $0.221 или $0.222).
                    </p>
                  </div>

                  <div className="bg-emerald-500/5 border border-emerald-500/20 p-4 rounded-lg">
                    <h4 className="font-bold text-emerald-400 mb-2">Разбор идеального шорт-сигнала</h4>
                    <div className="font-mono text-xs text-emerald-500/80 mb-3 bg-emerald-500/10 p-2 rounded">
                      Бот прислал сигнал! Монета: MUSDT. Аккуратно заходим лесенкой. Позиция: ШОРТ 🔻 Плечо: 4x. У меня цена входа: 2.6628 (2%). Лесенкой буду докупать (если цена пойдет вверх): 2.74 (2%). Тейк-профит: 2.625.
                    </div>
                    <p className="text-xs text-zinc-400">
                      В этом сценарии есть четкий алгоритм: безопасный начальный вход (2%), заранее спланированная точка добавления маржи (2.74) и понятная цель для фиксации прибыли (2.625). Плечо 4x обеспечивает консервативный уровень риска.
                    </p>
                  </div>

                  <div className="bg-red-500/5 border border-red-500/20 p-4 rounded-lg">
                    <h4 className="font-bold text-red-400 mb-3">4 главные ошибки начинающих</h4>
                    <ul className="space-y-2 text-xs text-zinc-300">
                      <li><strong className="text-red-400">1. Излишняя жадность:</strong> Ожидание "самого дна" вместо планомерной фиксации прибыли. Забирайте свое движение.</li>
                      <li><strong className="text-red-400">2. Вход "на всю котлету" (All-in):</strong> Одна ошибка может уничтожить весь депозит.</li>
                      <li><strong className="text-red-400">3. Усреднение в плюс:</strong> Добавление объема в сделку, которая уже идет в нужном направлении (ухудшает среднюю цену).</li>
                      <li><strong className="text-red-400">4. Отсутствие торговой системы:</strong> Торговля на эмоциях без четкого плана и дисциплины.</li>
                    </ul>
                  </div>

                </div>
              </div>

              {/* Section 3 */}
              <div className="border border-zinc-800/80 rounded-xl overflow-hidden">
                <div className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800/80 flex items-center gap-3">
                  <Activity className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-lg font-bold text-zinc-200">Продвинутый функционал и умные алгоритмы</h3>
                </div>
                <div className="p-5 bg-zinc-950/50 space-y-4 text-sm text-zinc-300">
                  <p>Система постоянно совершенствуется. Недавно внедрены новые профессиональные инструменты, помогающие вам торговать с меньшим риском и большей прибылью:</p>
                  <ul className="space-y-4">
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">1. Авто-безубыток и Трейлинг-стоп (Trailing Stop)</strong>
                      <span className="text-zinc-400">Как только сделка достигает <strong>+2% прибыли</strong>, ИИ-менеджер автоматически переводит стоп-лосс в "безубыток" (на цену входа). Если цена продолжает идти в вашу сторону и прибыль превышает <strong>+4%</strong>, включается трейлинг-стоп: стоп-лосс начинает автоматически "подтягиваться" за ценой на расстоянии 1.5% от максимальной зафиксированной плавающей прибыли. Это позволяет забирать максимум движения и не терять профит при резких разворотах.</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">2. Корреляция с BTC (Поводырь)</strong>
                      <span className="text-zinc-400">Весь крипторынок ходит за Биткоином. Теперь сканер автоматически проверяет тренд BTC перед выдачей сигнала на альткоин. Если ИИ видит сильный сигнал в шорт, но Биткоин в этот момент стремительно растет, сигнал будет помечен предупреждением <code>[⚠️ BTC растет]</code> (высокий риск).</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">3. Интеграция AI Committee (Консенсус 3 Агентов)</strong>
                      <span className="text-zinc-400">Вместо одного алгоритма, сделки теперь анализируются <strong>Комитетом ИИ</strong>. Перед входом в сделку актив оценивают: Теханалитик (ищет паттерны), Риск-менеджер (оценивает опасности) и Главный Судья (выносит консенсус). Это снижает количество ложных входов.</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">4. Настоящие индикаторы RSI, MACD и Bollinger Bands</strong>
                      <span className="text-zinc-400">Теперь сканер рассчитывает полноценные технические индикаторы по истории свечей: <strong>RSI</strong> (перегрев), <strong>MACD</strong> (направление тренда) и <strong>Bollinger Bands</strong> (выход цены за рамки нормальной волатильности). Мощнейшие сигналы `CRITICAL_SELL` теперь базируются на одновременном подтверждении от всех 3 индикаторов.</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">5. Динамическая лесенка по волатильности (ATR)</strong>
                      <span className="text-zinc-400">В автоматическом режиме шаг усреднения больше не является фиксированным. Система замеряет текущую волатильность монеты, и если актив "летает" на 10-20% (как альткоины малого объема), шаг лесенки автоматически расширяется, чтобы вас не выбило по стопам, имитируя логику индикатора ATR.</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">6. Защита от дневной просадки (Global Drawdown)</strong>
                      <span className="text-zinc-400">Встроена система защиты капитала "как в проп-трейдинге". Если общая просадка виртуального баланса за день превышает 15%, авто-торговля ставится на паузу, предотвращая слив депозита в неудачные рыночные фазы.</span>
                    </li>
                    <li className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50">
                      <strong className="text-yellow-500 block mb-1">7. Бэктестинг стратегии</strong>
                      <span className="text-zinc-400">Нажмите кнопку <strong>Бэктест</strong>, чтобы симулировать прогон текущих настроек по историческим данным и узнать их математическое ожидание, винрейт и PnL.</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* Section 4 */}
              <div className="border border-zinc-800/80 rounded-xl overflow-hidden mt-6">
                <div className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800/80 flex items-center gap-3">
                  <BookOpen className="w-5 h-5 text-blue-400" />
                  <h3 className="text-lg font-bold text-zinc-200">Словарь терминов</h3>
                </div>
                <div className="p-5 bg-zinc-950/50 space-y-4 text-sm text-zinc-300">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Шорт (Short)</strong> — позиция на понижение. Вы зарабатываете, когда актив падает в цене.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Лонг (Long)</strong> — позиция на повышение. Вы зарабатываете, когда актив растет.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Кредитное плечо (Leverage)</strong> — заемные средства биржи. Плечо 5x увеличивает прибыль (и убытки) в 5 раз.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Усреднение (DCA/Лесенка)</strong> — покупка дополнительного объема при просадке для улучшения цены входа.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Дамп (Dump)</strong> — резкое падение цены.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Памп (Pump)</strong> — резкий рост цены.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Take Profit / Stop Loss</strong> — ордера для автоматической фиксации прибыли или убытка.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Волатильность</strong> — изменчивость цены. Высокая волатильность = сильные скачки.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">RSI</strong> — Индекс относительной силы. Выше 70 = перекупленность, ниже 30 = перепроданность.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">MACD</strong> — Индикатор тренда. Пересечение линий говорит о его возможной смене.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Bollinger Bands</strong> — коридор цены. Выход цены за границу предвещает возврат в канал.
                    </div>
                    <div className="bg-zinc-900/30 p-3 rounded border border-zinc-800/40">
                      <strong className="text-zinc-100">Drawdown (Просадка)</strong> — просадка баланса от пика. Лимит -15% останавливает торги.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
          <div className={cn(
            "bg-zinc-900 border border-zinc-800 rounded-xl w-full max-h-[92vh] overflow-hidden flex flex-col transition-all duration-300",
            settingsTab === 'ai_settings' ? "max-w-6xl" : "max-w-2xl"
          )}>
            <div className="flex justify-between items-center p-4 border-b border-zinc-800">
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                <Settings className="w-5 h-5 text-zinc-400" />
                {settingsTab === 'system' ? 'Настройки Системы' : settingsTab === 'ai_settings' ? 'ИИ Настройки & Ревизор' : 'Интеграции'}
              </h2>
              <button 
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg hover:bg-zinc-800 transition-colors"
                title="Закрыть"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tab Selector Header */}
            <div className="flex border-b border-zinc-800 px-4 bg-zinc-950/40">
              <button
                type="button"
                onClick={() => setSettingsTab('system')}
                className={cn(
                  "px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all flex items-center gap-2",
                  settingsTab === 'system'
                    ? "border-blue-500 text-blue-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                )}
              >
                <Sliders className="w-3.5 h-3.5" />
                Настройки Системы
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('ai_settings')}
                className={cn(
                  "px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all flex items-center gap-2",
                  settingsTab === 'ai_settings'
                    ? "border-indigo-500 text-indigo-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                )}
              >
                <Bot className="w-3.5 h-3.5 text-indigo-400" />
                ИИ Настройки
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('integrations')}
                className={cn(
                  "px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all flex items-center gap-2",
                  settingsTab === 'integrations'
                    ? "border-blue-500 text-blue-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                )}
              >
                <Key className="w-3.5 h-3.5" />
                Интеграции
              </button>
            </div>
            
            <div className="p-4 overflow-y-auto custom-scrollbar flex-1 space-y-6">
              
              {/* AI Fine-Tuning Settings */}
              {settingsTab === 'ai_settings' && (
                <div className="w-full">
                  <FineTuningPanel 
                    tradingMode={tradingMode}
                    setTradingMode={setTradingMode}
                    onAddToast={(msg, type) => {
                      addToast(msg, type);
                    }}
                    onRefreshBalance={fetchRealBalance}
                  />
                </div>
              )}
              
              {/* Exchange API integration */}
              {settingsTab === 'integrations' && (
                <>
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-yellow-400" />
                    API Кошелька Биржи (Реальная Торговля)
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Включить</span>
                    <button 
                      onClick={toggleExchange}
                      className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", exchangeConfig.isEnabled ? "bg-emerald-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", exchangeConfig.isEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>
                </div>

                <div className={cn("space-y-3 transition-opacity", exchangeConfig.isEnabled ? "opacity-100" : "opacity-50 pointer-events-none")}>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Биржа (Исполнение API)</label>
                    <select 
                      value={exchangeConfig.exchange}
                      onChange={(e) => setExchangeConfig({ ...exchangeConfig, exchange: e.target.value })}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 text-sm focus:outline-none focus:border-yellow-500/50 font-medium"
                    >
                      <option value="weex">WEEX (Основная Торговая Биржа API)</option>
                    </select>
                    <p className="text-[10px] text-zinc-500 mt-1 leading-normal">
                      * Торговые ордера исполняются через WEEX API (Фьючерсы и Спот).
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">API Key</label>
                    <input 
                      type="text" 
                      value={exchangeConfig.apiKey}
                      onChange={(e) => setExchangeConfig({ ...exchangeConfig, apiKey: e.target.value })}
                      placeholder="Ваш API ключ"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 text-sm focus:outline-none focus:border-yellow-500/50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">API Secret</label>
                    <div className="relative">
                      <input 
                        type={showSecret ? "text" : "password"} 
                        value={exchangeConfig.apiSecret}
                        onChange={(e) => setExchangeConfig({ ...exchangeConfig, apiSecret: e.target.value })}
                        placeholder="Ваш секретный ключ"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 pr-10 text-zinc-200 text-sm focus:outline-none focus:border-yellow-500/50"
                      />
                      <button 
                        type="button"
                        onClick={() => setShowSecret(!showSecret)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                      >
                        {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  {['weex', 'okx', 'kucoin', 'bitget'].includes(exchangeConfig.exchange) && (
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Passphrase (Пароль API)</label>
                      <div className="relative">
                        <input 
                          type={showPassword ? "text" : "password"} 
                          value={exchangeConfig.password || ''}
                          onChange={(e) => setExchangeConfig({ ...exchangeConfig, password: e.target.value })}
                          placeholder="Пароль от API ключа (Passphrase)"
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 pr-10 text-zinc-200 text-sm focus:outline-none focus:border-yellow-500/50"
                        />
                        <button 
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  )}
                  
                  <div className="pt-2 flex flex-col md:flex-row gap-3">
                    <button 
                      onClick={testExchangeConnection}
                      disabled={!exchangeConfig.apiKey || !exchangeConfig.apiSecret}
                      className="px-4 py-2 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Проверить подключение
                    </button>
                    {exchangeTestStatus && (
                      <div className="text-xs flex items-center px-2">
                        <span className={exchangeTestStatus.includes('✅') ? "text-emerald-400" : "text-red-400"}>{exchangeTestStatus}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Multi-Account Trading Bridge (Sub-Accounts & Multi-Keys Copy-Trading) */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-emerald-400" />
                    Multi-Account Trading Bridge (Копи-трейдинг на доп. аккаунты)
                  </h3>
                  <button
                    onClick={() => {
                      const newAcc: MultiAccountItem = {
                        id: 'multi_' + Date.now(),
                        name: `Доп. Аккаунт ${((exchangeConfig.multiAccounts || []).length + 1)}`,
                        exchange: 'weex',
                        apiKey: '',
                        apiSecret: '',
                        password: '',
                        isEnabled: true
                      };
                      const updated = [...(exchangeConfig.multiAccounts || []), newAcc];
                      const newConf = { ...exchangeConfig, multiAccounts: updated };
                      setExchangeConfig(newConf);
                      fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ telegramBots, exchangeApiConfig: newConf })
                      });
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-medium transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Добавить аккаунт
                  </button>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Позволяет привязать несколько API-ключей биржи WEEX (суб-аккаунты WEEX). При открытии позиций или срабатывании усреднений сигналы ИИ-агента дублируются на все подключенные аккаунты параллельно.
                </p>

                {(!exchangeConfig.multiAccounts || exchangeConfig.multiAccounts.length === 0) ? (
                  <div className="text-center py-4 bg-zinc-900/30 rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-500">
                    Дополнительные аккаунты не привязаны. Торговля ведется только на основном API ключей выше.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {exchangeConfig.multiAccounts.map((acc, index) => (
                      <div key={acc.id} className="p-3 border border-zinc-800 rounded-lg bg-zinc-900/50 relative space-y-2">
                        <div className="flex justify-between items-center pr-8">
                          <input
                            type="text"
                            value={acc.name}
                            onChange={(e) => {
                              const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, name: e.target.value } : a);
                              setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                            }}
                            placeholder="Название аккаунта (например, WEEX Sub 1)"
                            className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 font-semibold focus:outline-none"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-zinc-400">Активен</span>
                            <button
                              onClick={() => {
                                const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, isEnabled: !a.isEnabled } : a);
                                const newConf = { ...exchangeConfig, multiAccounts: updated };
                                setExchangeConfig(newConf);
                                fetch('/api/settings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ telegramBots, exchangeApiConfig: newConf })
                                });
                              }}
                              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${acc.isEnabled ? "bg-emerald-500" : "bg-zinc-700"}`}
                            >
                              <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${acc.isEnabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
                            </button>
                            <button
                              onClick={() => {
                                const updated = (exchangeConfig.multiAccounts || []).filter(a => a.id !== acc.id);
                                const newConf = { ...exchangeConfig, multiAccounts: updated };
                                setExchangeConfig(newConf);
                                fetch('/api/settings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ telegramBots, exchangeApiConfig: newConf })
                                });
                              }}
                              className="text-zinc-500 hover:text-red-400 transition-colors p-1"
                              title="Удалить аккаунт"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <select
                            value={acc.exchange}
                            onChange={(e) => {
                              const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, exchange: e.target.value } : a);
                              setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                            }}
                            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none"
                          >
                            <option value="weex">WEEX</option>
                          </select>
                          <input
                            type="text"
                            value={acc.apiKey}
                            onChange={(e) => {
                              const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, apiKey: e.target.value } : a);
                              setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                            }}
                            placeholder="API Key"
                            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none"
                          />
                          <input
                            type="password"
                            value={acc.apiSecret}
                            onChange={(e) => {
                              const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, apiSecret: e.target.value } : a);
                              setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                            }}
                            placeholder="API Secret"
                            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none"
                          />
                        </div>

                        {['weex', 'okx', 'kucoin', 'bitget'].includes(acc.exchange) && (
                          <input
                            type="password"
                            value={acc.password || ''}
                            onChange={(e) => {
                              const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, password: e.target.value } : a);
                              setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                            }}
                            placeholder="Passphrase (пароль API)"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none"
                          />
                        )}

                        <div className="flex items-center justify-between pt-1">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const res = await fetch('/api/settings/exchange/test', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ exchange: acc.exchange, apiKey: acc.apiKey, apiSecret: acc.apiSecret, password: acc.password })
                                });
                                const data = await res.json();
                                const statusMsg = data.success ? '✅ Подключено успешно!' : `❌ Ошибка: ${data.error || 'Неверные ключи'}`;
                                const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, statusText: statusMsg } : a);
                                setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                              } catch (err: any) {
                                const updated = (exchangeConfig.multiAccounts || []).map(a => a.id === acc.id ? { ...a, statusText: '❌ Ошибка сети' } : a);
                                setExchangeConfig({ ...exchangeConfig, multiAccounts: updated });
                              }
                            }}
                            disabled={!acc.apiKey || !acc.apiSecret}
                            className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 rounded text-[11px] font-medium transition-colors"
                          >
                            Тест API ключей
                          </button>
                          {acc.statusText && (
                            <span className={`text-[11px] ${acc.statusText.includes('✅') ? 'text-emerald-400' : 'text-red-400'}`}>
                              {acc.statusText}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

              {settingsTab === 'system' && (
                <>
                  {/* Autopilot Aggressiveness Level */}
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                      <Flame className="w-4 h-4 text-orange-500 animate-pulse" />
                      Агрессивность Торгового Автопилота (Risk/Yield Level)
                    </h3>
                    <p className="text-xs text-zinc-400 mb-4 leading-relaxed font-sans">
                      Настройте компромисс между безопасностью депозита и объемами заработка.
                      Более агрессивный режим снижает входной порог ИИ-активности и увеличивает объем ордеров.
                    </p>
                    <div className="grid grid-cols-3 gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setAutopilotAggressiveness('conservative');
                          saveSettings('conservative');
                        }}
                        className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all ${
                          autopilotAggressiveness === 'conservative'
                            ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400 font-semibold shadow-emerald-950/50 shadow'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        <span className="text-lg">🛡️</span>
                        <span className="text-xs font-semibold mt-1">Консервативный</span>
                        <span className="text-[10px] text-zinc-500 mt-1">Макс. защита</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAutopilotAggressiveness('moderate');
                          saveSettings('moderate');
                        }}
                        className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all ${
                          autopilotAggressiveness === 'moderate'
                            ? 'bg-blue-500/10 border-blue-500 text-blue-400 font-semibold shadow-blue-950/50 shadow'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        <span className="text-lg">⚖️</span>
                        <span className="text-xs font-semibold mt-1">Умеренный</span>
                        <span className="text-[10px] text-zinc-500 mt-1">Баланс / Доход</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAutopilotAggressiveness('aggressive');
                          saveSettings('aggressive');
                        }}
                        className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all ${
                          autopilotAggressiveness === 'aggressive'
                            ? 'bg-orange-600/20 border-orange-500 text-orange-400 font-semibold shadow-orange-950/50 shadow'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        <span className="text-lg">🔥</span>
                        <span className="text-xs font-semibold mt-1">Агрессивный</span>
                        <span className="text-[10px] text-zinc-500 mt-1">Макс. прибыль</span>
                      </button>
                    </div>
                  </div>

                  {/* Market Modes & Binance Protection */}
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-4">
                    <div>
                      <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-1">
                        <Activity className="w-4 h-4 text-purple-400" />
                        Режим Рыночной Торговли (Market Modes)
                      </h3>
                      <p className="text-xs text-zinc-400 mb-3 leading-relaxed">
                        Выберите типы рынков для анализа и торговли. Спотовая стратегия использует алгоритмы накопления и откупа перепроданности, фьючерсная — скальпинг по и против тренда (Long и Short).
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setTradingMarketMode('FUTURES');
                            fetch('/api/settings', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ tradingMarketMode: 'FUTURES' })
                            });
                          }}
                          className={`p-2.5 rounded-lg border text-left text-xs font-semibold transition-all ${
                            tradingMarketMode === 'FUTURES'
                              ? 'bg-amber-500/15 border-amber-500 text-amber-400'
                              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                          }`}
                        >
                          <div className="font-bold flex items-center gap-1">⚡ Фьючерсы</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">Скальпинг (Long/Short)</div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setTradingMarketMode('SPOT');
                            fetch('/api/settings', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ tradingMarketMode: 'SPOT' })
                            });
                          }}
                          className={`p-2.5 rounded-lg border text-left text-xs font-semibold transition-all ${
                            tradingMarketMode === 'SPOT'
                              ? 'bg-purple-500/15 border-purple-500 text-purple-400'
                              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                          }`}
                        >
                          <div className="font-bold flex items-center gap-1">📈 Спот</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">Накопление / Dip</div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setTradingMarketMode('HYBRID');
                            fetch('/api/settings', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ tradingMarketMode: 'HYBRID' })
                            });
                          }}
                          className={`p-2.5 rounded-lg border text-left text-xs font-semibold transition-all ${
                            tradingMarketMode === 'HYBRID'
                              ? 'bg-blue-500/15 border-blue-500 text-blue-400'
                              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                          }`}
                        >
                          <div className="font-bold flex items-center gap-1">🔄 Совместная</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">Спот + Фьючерсы</div>
                        </button>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-zinc-900 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                          Исключать монеты Binance (Защита от Маркет-Мейкеров)
                        </div>
                        <div className="text-[11px] text-zinc-400 max-w-md mt-0.5">
                          Автоматически убирает из торговли токены, торгуемые на Binance, для защиты от манипуляций и спуфинга крупных игроков.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const val = !excludeBinanceCrossListed;
                          setExcludeBinanceCrossListed(val);
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ excludeBinanceCrossListed: val })
                          });
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          excludeBinanceCrossListed ? 'bg-amber-500' : 'bg-zinc-800'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            excludeBinanceCrossListed ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>

                    <div className="pt-3 border-t border-zinc-900 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5 text-purple-400" />
                          Макс. лимит на спотовую монету (% от USDT депозита)
                        </div>
                        <div className="text-[11px] text-zinc-400 max-w-md mt-0.5">
                          Ограничивает максимальный объем выделяемого депозита на 1 спотовую монету (рекомендуется 5-10%).
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={maxSpotAllocationPct}
                          onChange={(e) => {
                            const val = Math.max(1, Math.min(100, Number(e.target.value)));
                            setMaxSpotAllocationPct(val);
                            fetch('/api/settings', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ maxSpotAllocationPct: val })
                            });
                          }}
                          className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-center text-zinc-100 font-bold font-mono focus:outline-none focus:border-purple-500"
                        />
                        <span className="text-xs font-bold text-zinc-500">%</span>
                      </div>
                    </div>
                  </div>

                  {/* Active Trading Strategy */}
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                      <Zap className="w-4 h-4 text-amber-400" />
                      Активная торговая стратегия (Мульти-Стратегический Движок)
                    </h3>
                    <p className="text-xs text-zinc-400 mb-3 leading-relaxed">
                      Выбор профиля алгоритма торговли. Адаптирует генерацию сигналов, логику входа и параметры фильтрации риска под текущие рыночные условия.
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveStrategy('SHORT_PUMP_FADE');
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activeStrategy: 'SHORT_PUMP_FADE' })
                          });
                        }}
                        className={cn(
                          "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200 text-left flex flex-col gap-1",
                          activeStrategy === 'SHORT_PUMP_FADE'
                            ? "bg-red-500/10 border-red-500 text-red-400 font-bold"
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        )}
                      >
                        <span className="flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-red-400" /> Short Pump Fade</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Шорт пампа & скальпинг</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveStrategy('TREND_FOLLOWING');
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activeStrategy: 'TREND_FOLLOWING' })
                          });
                        }}
                        className={cn(
                          "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200 text-left flex flex-col gap-1",
                          activeStrategy === 'TREND_FOLLOWING'
                            ? "bg-emerald-500/10 border-emerald-500 text-emerald-400 font-bold"
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        )}
                      >
                        <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Trend Impulse</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Трендовый импульс</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveStrategy('RANGE_MEAN_REVERSION');
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activeStrategy: 'RANGE_MEAN_REVERSION' })
                          });
                        }}
                        className={cn(
                          "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200 text-left flex flex-col gap-1",
                          activeStrategy === 'RANGE_MEAN_REVERSION'
                            ? "bg-purple-500/10 border-purple-500 text-purple-400 font-bold"
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        )}
                      >
                        <span className="flex items-center gap-1.5"><Sliders className="w-3.5 h-3.5 text-purple-400" /> Range Reversion</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Флэтовый возврат</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveStrategy('ADAPTIVE_DYNAMIC');
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activeStrategy: 'ADAPTIVE_DYNAMIC' })
                          });
                        }}
                        className={cn(
                          "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200 text-left flex flex-col gap-1",
                          activeStrategy === 'ADAPTIVE_DYNAMIC'
                            ? "bg-amber-500/10 border-amber-500 text-amber-400 font-bold"
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        )}
                      >
                        <span className="flex items-center gap-1.5"><Bot className="w-3.5 h-3.5 text-amber-400" /> ИИ-Адаптив</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Авто-выбор Агента №4</span>
                      </button>
                    </div>
                  </div>

                  {/* Allowed Trading Directions */}
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  Разрешенные направления торговли
                </h3>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Определяет допустимые направления открываемых автопилотом (Autopilot) сделок и фильтрацию сигналов. Ручная торговля (Manual) всегда доступна во всех направлениях вне зависимости от выбранного режима.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAllowedTradingDirections('SHORT_ONLY');
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            allowedTradingDirections: 'SHORT_ONLY' 
                          })
                        });
                      }, 50);
                    }}
                    className={cn(
                      "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200",
                      allowedTradingDirections === 'SHORT_ONLY'
                        ? "bg-red-500/10 border-red-500 text-red-500 font-bold"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300"
                    )}
                  >
                    Только SHORT 🔴
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAllowedTradingDirections('LONG_ONLY');
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            allowedTradingDirections: 'LONG_ONLY' 
                          })
                        });
                      }, 50);
                    }}
                    className={cn(
                      "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200",
                      allowedTradingDirections === 'LONG_ONLY'
                        ? "bg-emerald-500/10 border-emerald-500 text-emerald-500 font-bold"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300"
                    )}
                  >
                    Только LONG 🟢
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAllowedTradingDirections('BOTH');
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            allowedTradingDirections: 'BOTH' 
                          })
                        });
                      }, 50);
                    }}
                    className={cn(
                      "px-3 py-2 text-xs font-semibold rounded-lg border transition-all duration-200",
                      allowedTradingDirections === 'BOTH'
                        ? "bg-blue-500/10 border-blue-500 text-blue-500 font-bold"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300"
                    )}
                  >
                    Все (SHORT & LONG) 🔄
                  </button>
                </div>
              </div>

              {/* Smart Money & Structural Filters */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-4">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-sky-400" />
                  Параметры Смарт-Мани и Рыночной Структуры (SMC Filters)
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                  Включите или отключите продвинутые фильтры рыночной структуры, объемов и умного капитала (Smart Money), используемые ИИ-агентами для одобрения сделок автопилота.
                </p>

                <div className="space-y-3 pt-2">
                  {/* EMA 200 */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Фильтр глобального тренда (EMA 200)</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Ограничивает шорты только под скользящей средней EMA 200 (ТФ 15m). Исключает сделки против сильного бычьего тренда.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isEma200FilterEnabled;
                        setIsEma200FilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled: next,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isEma200FilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isEma200FilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* Liquidity Sweep */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Фильтр снятия ликвидности (Liquidity Sweep)</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Вход осуществляется только после подтвержденного свипа (снятия ликвидности) за локальным максимумом на 15m у пиков.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isLiquiditySweepFilterEnabled;
                        setIsLiquiditySweepFilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled: next,
                              isLateShortFilterEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isLiquiditySweepFilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isLiquiditySweepFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* FVG Above */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Защита от Imbalance сопротивления сверху</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Игнорировать шорты, если прямо над ценой находится незаполненный FVG (Imbalance) или проблемная зона HTF, способная сквизануть позицию.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isFvgAboveFilterEnabled;
                        setIsFvgAboveFilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled: next,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isFvgAboveFilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isFvgAboveFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* FVG Support Below */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Защита от FVG поддержки снизу</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Запрещает шорты в сильный блок поддержки или неудовлетворенный FVG спроса старших таймфреймов прямо под текущей ценой.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isFvgSupportBelowFilterEnabled;
                        setIsFvgSupportBelowFilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled: next,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isFvgSupportBelowFilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isFvgSupportBelowFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* Late Short */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Блокировка поздних входов (Late Short Guard)</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Запрещает шорт, если цена уже ушла экстремально далеко вниз от локальной зоны хая, предотвращая вход в самом низу слива.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isLateShortFilterEnabled;
                        setIsLateShortFilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled: next,
                              isSymmetricConfidenceFilterEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isLateShortFilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isLateShortFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* Symmetric Confidence Filter */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Симметричный фильтр уверенности (Symmetric Confidence P)</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Применяет фильтр вероятности ИИ к LONG-сигналам так же, как и к SHORT-сигналам. При выключенном режиме фильтр применяется только к SELL.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isSymmetricConfidenceFilterEnabled;
                        setIsSymmetricConfidenceFilterEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled,
                              isSymmetricConfidenceFilterEnabled: next,
                              isCommitteeConsensusCheckEnabled
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isSymmetricConfidenceFilterEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isSymmetricConfidenceFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  {/* AI Committee Consensus Check */}
                  <div className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/60">
                    <div className="space-y-0.5 max-w-[80%]">
                      <span className="text-xs font-bold text-zinc-200 uppercase tracking-wide">Консенсус Комитета ИИ (Committee Consensus Check)</span>
                      <p className="text-[11px] text-zinc-400 leading-normal">
                        Блокирует реальные авто-входы, если вердикт Комитета ИИ равен REJECT или HOLD, даже если вероятность p находится выше минимального порога.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isCommitteeConsensusCheckEnabled;
                        setIsCommitteeConsensusCheckEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold,
                              isVolatilityBrakeEnabled,
                              maxVolatilityLimit,
                              fundingShieldLimit,
                              dcaMultiplierFactor,
                              allowedTradingDirections,
                              isEma200FilterEnabled,
                              isFvgAboveFilterEnabled,
                              isFvgSupportBelowFilterEnabled,
                              isLiquiditySweepFilterEnabled,
                              isLateShortFilterEnabled,
                              isSymmetricConfidenceFilterEnabled,
                              isCommitteeConsensusCheckEnabled: next
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isCommitteeConsensusCheckEnabled ? "bg-sky-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isCommitteeConsensusCheckEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Filter Sweep / Short Shadow Regulator */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-emerald-400" />
                    Фильтр Свипа / Короткой тени (Sweep & Wick Shadow Regulator)
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isLiquiditySweepFilterEnabled;
                      setIsLiquiditySweepFilterEnabled(next);
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            telegramBots, 
                            exchangeApiConfig: exchangeConfig, 
                            btcShockThreshold,
                            autopilotAggressiveness,
                            isAiExpertTraderEnabled,
                            isAiPartialCloseRealEnabled,
                            aiExpertTraderInterval,
                            aiExpertTraderInstructions,
                            aiMinConfidenceThreshold,
                            isVolatilityBrakeEnabled,
                            maxVolatilityLimit,
                            fundingShieldLimit,
                            dcaMultiplierFactor,
                            allowedTradingDirections,
                            isEma200FilterEnabled,
                            isFvgAboveFilterEnabled,
                            isFvgSupportBelowFilterEnabled,
                            isLiquiditySweepFilterEnabled: next,
                            liquiditySweepWickThreshold,
                            isLateShortFilterEnabled
                          })
                        });
                      }, 50);
                    }}
                    className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", isLiquiditySweepFilterEnabled ? "bg-emerald-500" : "bg-zinc-700")}
                  >
                    <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isLiquiditySweepFilterEnabled ? "translate-x-5" : "translate-x-1")} />
                  </button>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                  Регулирует минимально допустимую длину верхнего фитиля (тени) сигнальной свечи. Если подтвержденного снятия ликвидности (Liquidity Sweep) не обнаружено, а длина тени меньше заданного порога, вход в шорт блокируется как "короткая тень".
                </p>

                <div className={cn("space-y-2 pt-2 transition-opacity duration-200", isLiquiditySweepFilterEnabled ? "opacity-100" : "opacity-40 pointer-events-none")}>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <input 
                        type="range" 
                        min="0.10" 
                        max="0.90" 
                        step="0.05" 
                        value={liquiditySweepWickThreshold}
                        onChange={(e) => setLiquiditySweepWickThreshold(parseFloat(e.target.value))}
                        onMouseUp={() => saveSettings()}
                        onTouchEnd={() => saveSettings()}
                        className="w-full accent-emerald-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                        <span>10% (Макс. агрессивно)</span>
                        <span>60% (Стандарт ИИ)</span>
                        <span>90% (Макс. консервативно)</span>
                      </div>
                    </div>
                    <div className="bg-emerald-950/30 border border-emerald-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                      <span className="text-emerald-400 font-bold text-sm">{(liquiditySweepWickThreshold * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* BTC Silence Mode Volatility */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                  <Activity className="w-4 h-4 text-purple-400" />
                  Режим Тишины (Bitcoin Volatility Block)
                </h3>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Порог резкого импульса BTC (за 1 минуту в %), при достижении которого
                  блокируются новые автоматические сделки на 15 минут в целях безопасности.
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <input 
                      type="range" 
                      min="0.3" 
                      max="3.0" 
                      step="0.1" 
                      value={btcShockThreshold}
                      onChange={(e) => setBtcShockThreshold(parseFloat(e.target.value))}
                      className="w-full accent-purple-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>0.3% (Макс. защита)</span>
                      <span>1.5% (Рекомендуемо)</span>
                      <span>3.0% (Ослабленная фильтрация)</span>
                    </div>
                  </div>
                  <div className="bg-purple-950/30 border border-purple-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                    <span className="text-zinc-100 font-bold text-sm">{btcShockThreshold.toFixed(1)}%</span>
                  </div>
                </div>
              </div>

              {/* AI Minimum Confidence Threshold Settings */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                  <BrainCircuit className="w-4 h-4 text-indigo-400 animate-pulse" />
                  Порог уверенности ИИ для отображения сигналов
                </h3>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Позволяет уменьшить диапазон уверенности ИИ для фильтрации, чтобы увидеть больше сигналов. Все значения, фильтры и математический расчет остаются неизменными и соответствуют стандартным правилам.
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <input 
                      type="range" 
                      min="0.30" 
                      max="0.95" 
                      step="0.05" 
                      value={aiMinConfidenceThreshold}
                      onChange={(e) => setAiMinConfidenceThreshold(parseFloat(e.target.value))}
                      onMouseUp={() => saveSettings()}
                      onTouchEnd={() => saveSettings()}
                      className="w-full accent-indigo-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>30% (Показывать всё)</span>
                      <span>75% (Рекомендуемо)</span>
                      <span>95% (Максимальный фильтр)</span>
                    </div>
                  </div>
                  <div className="bg-indigo-950/30 border border-indigo-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                    <span className="text-zinc-100 font-bold text-sm">{(aiMinConfidenceThreshold * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>

              {/* Adaptive Volatility Brake */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    Адаптивный волатильный тормоз (Volatility Brake)
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isVolatilityBrakeEnabled;
                      setIsVolatilityBrakeEnabled(next);
                      // Save immediately
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            telegramBots, 
                            exchangeApiConfig: exchangeConfig, 
                            btcShockThreshold,
                            autopilotAggressiveness,
                            isAiExpertTraderEnabled,
                            aiExpertTraderInterval,
                            aiExpertTraderInstructions,
                            aiMinConfidenceThreshold,
                            isVolatilityBrakeEnabled: next,
                            maxVolatilityLimit,
                            fundingShieldLimit,
                            dcaMultiplierFactor
                          })
                        });
                      }, 50);
                    }}
                    className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", isVolatilityBrakeEnabled ? "bg-emerald-500" : "bg-zinc-700")}
                  >
                    <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isVolatilityBrakeEnabled ? "translate-x-5" : "translate-x-1")} />
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed font-sans">
                  Автоматически блокирует новые входы ИИ в перегретые монеты, чья 1-часовая волатильность превышает заданный лимит. Предохраняет систему от входа на хаотичных безоткатных движениях и пампах.
                </p>
                <div className={cn("transition-all duration-300", isVolatilityBrakeEnabled ? "opacity-100" : "opacity-40 pointer-events-none")}>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <input 
                        type="range" 
                        min="5.0" 
                        max="25.0" 
                        step="0.5" 
                        value={maxVolatilityLimit}
                        onChange={(e) => setMaxVolatilityLimit(parseFloat(e.target.value))}
                        onMouseUp={() => saveSettings()}
                        onTouchEnd={() => saveSettings()}
                        className="w-full accent-emerald-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                        <span>5.0% (Параноидальный тормоз)</span>
                        <span>12.0% (Рекомендуемо)</span>
                        <span>25.0% (Мягкий контроль)</span>
                      </div>
                    </div>
                    <div className="bg-emerald-950/30 border border-emerald-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                      <span className="text-zinc-100 font-bold text-sm">{maxVolatilityLimit.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Funding Shield Limit */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2 mb-2">
                  <TrendingDown className="w-4 h-4 text-amber-500" />
                  Уровень фильтрации фандинга (Funding Squeeze Limit)
                </h3>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed font-sans">
                  Ограничивает автоматическое открытие позиций SHORT при слишком высокой отрицательной плате за финансирование фандинга, минимизируя комиссии и шорт-сквиз риски на экстремальных лонгах.
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <input 
                      type="range" 
                      min="-0.50" 
                      max="0.00" 
                      step="0.01" 
                      value={fundingShieldLimit}
                      onChange={(e) => setFundingShieldLimit(parseFloat(e.target.value))}
                      onMouseUp={() => saveSettings()}
                      onTouchEnd={() => saveSettings()}
                      className="w-full accent-amber-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>-0.50% (Минимальный фильтр)</span>
                      <span>-0.15% (Рекомендуемо)</span>
                      <span>0.00% (Максимальный блок)</span>
                    </div>
                  </div>
                  <div className="bg-amber-950/30 border border-amber-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                    <span className="text-zinc-100 font-bold text-sm">{fundingShieldLimit.toFixed(2)}%</span>
                  </div>
                </div>
              </div>

              {/* DCA Multiplier Aggressiveness Guard */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-3 mb-2">
                  <Zap className="w-4 h-4 text-sky-400 animate-pulse" />
                  Мультипликатор объема сетки DCA (DCA Risk Scaling)
                </h3>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed font-sans">
                  Масштабирует размер каждого последующего шага сетки усреднений (DCA Grid). Снижение коэффициента уменьшает нагрузку на ваш свободный депозит во время движения рынка против нас.
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <input 
                      type="range" 
                      min="0.25" 
                      max="1.50" 
                      step="0.05" 
                      value={dcaMultiplierFactor}
                      onChange={(e) => setDcaMultiplierFactor(parseFloat(e.target.value))}
                      onMouseUp={() => saveSettings()}
                      onTouchEnd={() => saveSettings()}
                      className="w-full accent-sky-500 bg-zinc-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>0.25x (Макс. консервативно)</span>
                      <span>1.00x (Стандартный риск)</span>
                      <span>1.50x (Агрессивное мартини)</span>
                    </div>
                  </div>
                  <div className="bg-sky-950/30 border border-sky-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 min-w-[70px] justify-center">
                    <span className="text-zinc-100 font-bold text-sm">{dcaMultiplierFactor.toFixed(2)}x</span>
                  </div>
                </div>
              </div>



              {/* Optimal Trade Entry (OTE) */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-indigo-400" />
                    Optimal Trade Entry (OTE)
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isOteEntryEnabled;
                      setIsOteEntryEnabled(next);
                      setTimeout(() => {
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ 
                            isOteEntryEnabled: next
                          })
                        });
                      }, 50);
                    }}
                    className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer", isOteEntryEnabled ? "bg-indigo-500" : "bg-zinc-700")}
                  >
                    <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isOteEntryEnabled ? "translate-x-5" : "translate-x-1")} />
                  </button>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                  Вместо немедленного входа по рынку выставляет лимитную заявку глубже в зоне отката (50–61.8% от импульса после снятия ликвидности) и ждёт исполнения до 3 минут. Если цена не вернётся в зону — сделка пропускается. Работает и на реальных, и на виртуальных сделках.
                </p>
              </div>

              {/* ИИ-Ведущий Трейдер (AI Expert Co-Pilot) */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Brain className="w-4 h-4 text-emerald-400 animate-pulse" />
                    ИИ-Ведущий Трейдер (Lead Expert Trader Agent)
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Включить агента</span>
                    <button 
                      type="button"
                      onClick={() => {
                        const next = !isAiExpertTraderEnabled;
                        setIsAiExpertTraderEnabled(next);
                        // Save immediately via closure or trigger state
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled: next,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", isAiExpertTraderEnabled ? "bg-emerald-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isAiExpertTraderEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>
                </div>
                
                <p className="text-xs text-zinc-400 leading-relaxed">
                  ИИ-Ведущий Трейдер работает полностью автономно на сервере. Каждые несколько минут он 
                  анализирует моментум, структуру рынка (BOS/ChoCh), тени свечей и плотности стакана по каждой открытой сделке 
                  и динамически принимает профессиональные торговые решения (закрытие, частичный лок-ин прибыли с фиксацией 25-50-75% объема, упреждающее усреднение DCA, подтягивание Stop Loss).
                </p>

                <div className={cn("space-y-4 transition-all duration-300", isAiExpertTraderEnabled ? "opacity-100" : "opacity-40 pointer-events-none")}>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-1 flex justify-between">
                      <span>Интервал live-оценки сделок</span>
                      <span className="text-emerald-400 font-mono">каждые {aiExpertTraderInterval / 1000} сек.</span>
                    </label>
                    <select
                      value={aiExpertTraderInterval}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setAiExpertTraderInterval(val);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled,
                              aiExpertTraderInterval: val,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold
                            })
                          });
                        }, 50);
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/50"
                    >
                      <option value={30000}>30 секунд (Анализ микроструктур - повышенный расход токенов)</option>
                      <option value={60000}>60 секунд (Высокоактивный скальпинг)</option>
                      <option value={120000}>2 минуты (Оптимальный баланс)</option>
                      <option value={300000}>5 минут (Консервативный ко-пилот)</option>
                      <option value={600000}>10 минут (Старшие ТФ - Экономия API-вызовов)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between border-t border-b border-zinc-850 py-3 my-2">
                    <div className="space-y-0.5">
                      <span className="text-xs font-semibold text-zinc-300">Реальная фиксация фикс-TP по ИИ</span>
                      <p className="text-[10px] text-zinc-500 max-w-[280px]">
                        При включении ИИ фиксирует прибыль реальными ордерами частями. При выключении закрытия симулируются виртуально.
                      </p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => {
                        const next = !isAiPartialCloseRealEnabled;
                        setIsAiPartialCloseRealEnabled(next);
                        setTimeout(() => {
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                              telegramBots, 
                              exchangeApiConfig: exchangeConfig, 
                              btcShockThreshold,
                              autopilotAggressiveness,
                              isAiExpertTraderEnabled,
                              isAiPartialCloseRealEnabled: next,
                              aiExpertTraderInterval,
                              aiExpertTraderInstructions,
                              aiMinConfidenceThreshold
                            })
                          });
                        }, 50);
                      }}
                      className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", isAiPartialCloseRealEnabled ? "bg-emerald-500" : "bg-zinc-700")}
                    >
                      <span className={cn("inline-block h-3 w-3 transform rounded-full bg-white transition-transform", isAiPartialCloseRealEnabled ? "translate-x-5" : "translate-x-1")} />
                    </button>
                  </div>

                  <div className="pt-2 border-t border-zinc-800/80">
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                        <Brain className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Инструкции ИИ-Эксперта (System Prompt Mandate)</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (navigator.clipboard && aiExpertTraderInstructions) {
                              navigator.clipboard.writeText(aiExpertTraderInstructions);
                              const toast = document.createElement('div');
                              toast.innerText = 'Инструкции скопированы в буфер';
                              toast.className = 'fixed bottom-4 right-4 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg z-50 animate-fade-in';
                              document.body.appendChild(toast);
                              setTimeout(() => toast.remove(), 2500);
                            }
                          }}
                          className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded"
                          title="Скопировать текущие инструкции"
                        >
                          <Copy className="w-3 h-3 text-zinc-400" />
                          <span>Копировать</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/settings/default-instructions');
                              if (res.ok) {
                                const data = await res.json();
                                if (data?.instructions) {
                                  setAiExpertTraderInstructions(data.instructions);
                                  await fetch('/api/settings', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ 
                                      telegramBots, 
                                      exchangeApiConfig: exchangeConfig, 
                                      btcShockThreshold,
                                      autopilotAggressiveness,
                                      isAiExpertTraderEnabled,
                                      aiExpertTraderInterval,
                                      aiExpertTraderInstructions: data.instructions,
                                      aiMinConfidenceThreshold
                                    })
                                  });
                                  return;
                                }
                              }
                            } catch (e) {
                              console.error('Failed to fetch default instructions:', e);
                            }
                          }}
                          className="text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1 bg-emerald-950/40 border border-emerald-800/50 px-2 py-0.5 rounded"
                          title="Восстановить полный эталонный системный промт"
                        >
                          <RotateCcw className="w-3 h-3 text-emerald-400" />
                          <span>Сбросить на эталон</span>
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={aiExpertTraderInstructions}
                      onChange={(e) => setAiExpertTraderInstructions(e.target.value)}
                      onBlur={() => saveSettings()}
                      rows={9}
                      placeholder="Введите квантовые инструкции, паттерны входа и правила риск-менеджмента для ведущего ИИ-трейдера..."
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-zinc-300 text-xs focus:outline-none focus:border-emerald-500/50 resize-y font-mono leading-relaxed shadow-inner"
                    />
                    <div className="flex flex-wrap justify-between items-center mt-1.5 gap-2 text-[10px] text-zinc-500">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                          {aiExpertTraderInstructions?.length || 0} симв.
                        </span>
                        <span className="text-zinc-500">
                          Разделы: 1. Паттерны SHORT/LONG • 2. RM & DCA • 3. Сопровождение • 4. Confluence • 5. Ретроспектива
                        </span>
                      </div>
                      <span className="text-emerald-500/80 font-medium">Синхронизируется с сервером и Firebase</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Failed/Blacklisted Autopilot Symbols */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 animate-fade-in">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-red-400 animate-pulse" />
                    Блокировка пар автопилота (Черный список)
                  </h3>
                  {failedAutopilotSymbols.length > 0 && (
                    <button 
                      onClick={handleClearFailedSymbols}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors border border-red-500/10 px-2 py-0.5 rounded bg-red-950/20"
                    >
                      Очистить список
                    </button>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Сюда автоматически попадают монеты, по которым биржа вернула ошибку прав 
                  (например, нет прав торговли фьючерсной парой на WEEX). Торговля по ним 
                  блокируется во избежание спама логами.
                </p>

                {failedAutopilotSymbols.length === 0 ? (
                  <div className="text-center py-4 bg-zinc-900/35 rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-500">
                    Черный список автопилота пуст. Все поддерживаемые пары доступны для торгов.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto p-1 bg-zinc-900/10 rounded border border-zinc-850">
                    {failedAutopilotSymbols.map((sym) => (
                      <div 
                        key={sym} 
                        className="bg-red-950/25 border border-red-500/25 rounded-lg pl-3 pr-1 py-1 flex items-center gap-1.5 text-xs text-zinc-100 transition-all hover:border-red-500/40"
                      >
                        <span className="font-mono font-medium tracking-tight text-red-200">{sym}</span>
                        <button 
                          onClick={() => handleRemoveFailedSymbol(sym)}
                          className="text-zinc-500 hover:text-red-400 hover:bg-zinc-800/50 p-1 rounded transition-all"
                          title="Разблокировать пару"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </>
              )}

              {/* Telegram Bots */}
              {settingsTab === 'integrations' && (
                <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <Send className="w-4 h-4 text-blue-400" />
                    Telegram Боты для Уведомлений
                  </h3>
                  <button onClick={addBot} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                    <Plus className="w-3 h-3" /> Добавить бота
                  </button>
                </div>

                {telegramBots.length === 0 ? (
                  <div className="text-center py-6 text-zinc-500 text-sm">
                    Нет подключенных ботов.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {telegramBots.map((bot, index) => (
                      <div key={bot.id} className="p-3 border border-zinc-800 rounded-lg bg-zinc-900/50 relative">
                        <button 
                          onClick={() => removeBot(bot.id)}
                          className="absolute top-2 right-2 text-zinc-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <div className="grid grid-cols-1 gap-3 pr-8">
                          <div>
                            <input 
                              type="text" 
                              value={bot.name || ''}
                              onChange={(e) => updateBot(bot.id, { name: e.target.value })}
                              placeholder="Название (опционально)"
                              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                            />
                          </div>
                          <div>
                            <input 
                              type="text" 
                              value={bot.botToken}
                              onChange={(e) => updateBot(bot.id, { botToken: e.target.value })}
                              placeholder="Токен (BotFather: 12345:ABCde...)"
                              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                              <input 
                                type="text" 
                                value={bot.chatId}
                                onChange={(e) => updateBot(bot.id, { chatId: e.target.value })}
                                placeholder="Chat ID (напр. 12345678)"
                                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                              />
                              <button 
                                onClick={() => getChatId(bot.id, bot.botToken)}
                                disabled={!bot.botToken}
                                className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/30 disabled:opacity-50 text-xs font-medium rounded-lg whitespace-nowrap"
                                title="Автоматически определить Chat ID (напишите боту любое сообщение сначала)"
                              >
                                Узнать ID
                              </button>
                              <button 
                                onClick={() => testConnection(bot.botToken, bot.chatId)}
                                disabled={!bot.botToken || !bot.chatId}
                                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-xs font-medium rounded-lg"
                              >
                                Тест
                              </button>
                            </div>
                            <div className="text-[10px] text-zinc-500">
                              * Для авто-определения ID сперва отправьте боту любое сообщение в Telegram.
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-6 pt-2 border-t border-zinc-900">
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-zinc-400">Статус бота</span>
                              <button
                                onClick={() => updateBot(bot.id, { isEnabled: !bot.isEnabled })}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${bot.isEnabled ? "bg-blue-500" : "bg-zinc-700"}`}
                              >
                                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${bot.isEnabled ? "translate-x-5" : "translate-x-1"}`} />
                              </button>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-zinc-450 flex items-center gap-1">
                                {bot.muteWatchdog ? <BellOff className="w-3.5 h-3.5 text-zinc-500" /> : <Bell className="w-3.5 h-3.5 text-yellow-500" />}
                                Без шума Watchdog
                              </span>
                              <button
                                onClick={() => updateBot(bot.id, { muteWatchdog: !bot.muteWatchdog })}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${bot.muteWatchdog ? "bg-amber-600" : "bg-zinc-700"}`}
                              >
                                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${bot.muteWatchdog ? "translate-x-5" : "translate-x-1"}`} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}

              {testStatus && (
                <div className={`p-3 rounded-lg text-sm ${testStatus.includes('✅') || testStatus.includes('сохранены') ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : testStatus.includes('❌') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-zinc-800 text-zinc-300'}`}>
                  {testStatus}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-zinc-800 bg-zinc-900 flex justify-end">
              <button 
                onClick={async () => {
                  const hasChanges = settingsSnapshot !== null && getSettingsSnapshotString() !== settingsSnapshot;
                  if (hasChanges) {
                    await saveSettings();
                  }
                  setIsSettingsOpen(false);
                }}
                className={cn(
                  "px-6 py-2 text-sm font-medium rounded-lg transition-colors",
                  settingsSnapshot !== null && getSettingsSnapshotString() !== settingsSnapshot
                    ? "bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                    : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                )}
              >
                {settingsSnapshot !== null && getSettingsSnapshotString() !== settingsSnapshot
                  ? "Сохранить и закрыть"
                  : "Закрыть"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

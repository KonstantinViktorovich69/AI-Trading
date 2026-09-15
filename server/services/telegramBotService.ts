import ccxt from 'ccxt';
import { type TelegramStatsContext, compileTelegramStats as serviceCompileTelegramStats, getVirtualBalanceText as serviceGetVirtualBalanceText, toggleRealAutopilotText, pollTelegramUpdates as servicePollTelegramUpdates } from './telegramService.ts';

export interface TelegramBotServiceContext {
  getGlobalSettings: () => any;
  saveSettings: () => void;
  getVirtualTrades: () => any[];
  getVirtualBalance: () => number;
  getStartOfDayBalance: () => number;
  getAiKnowledgeBaseCount: () => number;
  getCcxtClient: (config: any) => any;
  fetchCachedRealBalance: (client: any, defaultType: string, force: boolean, context: string) => Promise<any>;
  WEEX_HEADERS?: Record<string, string>;
  isMainThread: boolean;
}

export function createTelegramBotService(ctx: TelegramBotServiceContext) {
  async function compileTelegramStats(): Promise<string> {
    let realBalanceUsdt: number | null = null;
    let realBalanceError: string | null = null;
    const globalSettings = ctx.getGlobalSettings();
    const config = globalSettings.exchangeApiConfig;

    if (config && config.isEnabled && config.apiKey) {
      try {
        const exClass = (ccxt as any)[config.exchange] as typeof ccxt.Exchange;
        if (exClass) {
          const client = ctx.getCcxtClient(config);
          if (client) {
            const defaultOptions = { defaultType: config.exchange === 'weex' ? 'swap' : 'future' };
            const balance = await ctx.fetchCachedRealBalance(client, defaultOptions.defaultType, false, 'fetchBalance for stats text').catch(() => null);
            if (balance && balance.USDT) {
              realBalanceUsdt = balance.USDT.total || balance.USDT.free || 0;
            } else {
              realBalanceError = 'Ошибка получения';
            }
          }
        }
      } catch (e: any) {
        realBalanceError = e?.message || String(e);
      }
    }

    return serviceCompileTelegramStats({
      virtualTrades: ctx.getVirtualTrades(),
      virtualBalance: ctx.getVirtualBalance(),
      startOfDayBalance: ctx.getStartOfDayBalance(),
      aiKnowledgeBaseCount: ctx.getAiKnowledgeBaseCount(),
      autopilotAggressiveness: globalSettings.autopilotAggressiveness,
      exchangeConfig: config,
      realBalanceUsdt,
      realBalanceError
    });
  }

  function getVirtualBalanceText(): string {
    return serviceGetVirtualBalanceText({
      virtualTrades: ctx.getVirtualTrades(),
      virtualBalance: ctx.getVirtualBalance(),
      startOfDayBalance: ctx.getStartOfDayBalance()
    });
  }

  async function getRealBalanceText(): Promise<string> {
    const globalSettings = ctx.getGlobalSettings();
    const config = globalSettings.exchangeApiConfig;
    if (!config || !config.apiKey) {
      return `❌ <b>РЕАЛЬНЫЙ БАЛАНС</b>\n\nAPI Ключи биржи не подключены в терминале. Перейдите во вкладку 'Настройки' на веб-панели и введите API ключи.`;
    }
    try {
      const exClass = (ccxt as any)[config.exchange] as typeof ccxt.Exchange;
      if (exClass) {
        const defaultOptions = { defaultType: config.exchange === 'weex' ? 'swap' : 'future' };
        const client = new exClass({
          apiKey: config.apiKey,
          secret: config.apiSecret,
          password: config.password,
          enableRateLimit: true,
          options: defaultOptions,
          headers: config.exchange === 'weex' ? ctx.WEEX_HEADERS : undefined
        });
        const balance = await client.fetchBalance({ type: defaultOptions.defaultType }).catch(() => null);
        if (balance && balance.USDT) {
          const total = balance.USDT.total !== undefined ? balance.USDT.total : 0;
          const free = balance.USDT.free !== undefined ? balance.USDT.free : 0;
          const used = total - free;
          return `🟢 <b>БАЛАНС НА РЕАЛЬНОЙ БИРЖЕ (${config.exchange.toUpperCase()})</b>\n\n` +
                 `• Всего: <b>${total.toFixed(2)} USDT</b>\n` +
                 `• Свободно: <code>${free.toFixed(2)} USDT</code>\n` +
                 `• Используется: <code>${used.toFixed(2)} USDT</code>\n\n` +
                 `<i>(Автопилот на бирже: <b>${config.isEnabled ? 'ВКЛЮЧЕН 🟢' : 'ВЫКЛЮЧЕН 🔴'}</b>)</i>`;
        } else {
          return `❌ <b>РЕАЛЬНЫЙ БАЛАНС</b>\n\nНе удалось получить баланс USDT. Проверьте правильность прав API ключа (требуется доступ к балансу / Futures Read).`;
        }
      }
      return `❌ <b>РЕАЛЬНЫЙ БАЛАНС</b>\n\nБиржа ${config.exchange} не поддерживается ccxt.`;
    } catch (e: any) {
      return `❌ <b>РЕАЛЬНЫЙ БАЛАНС</b>\n\nОшибка запроса к бирже:\n<code>${e?.message || e}</code>`;
    }
  }

  function toggleRealAutopilot(): string {
    const globalSettings = ctx.getGlobalSettings();
    return toggleRealAutopilotText(globalSettings.exchangeApiConfig, ctx.saveSettings);
  }

  async function pollTelegramUpdates() {
    const globalSettings = ctx.getGlobalSettings();
    return servicePollTelegramUpdates({
      getBots: () => globalSettings.telegramBots || [],
      getGlobalSettings: () => globalSettings,
      saveSettings: ctx.saveSettings,
      compileStats: compileTelegramStats,
      getVirtualBalance: getVirtualBalanceText,
      getRealBalance: getRealBalanceText,
      toggleAutopilot: toggleRealAutopilot
    });
  }

  function startPollingLoop(intervalMs: number = 5000): NodeJS.Timeout | null {
    if (!ctx.isMainThread) return null;
    return setInterval(pollTelegramUpdates, intervalMs);
  }

  return {
    compileTelegramStats,
    getVirtualBalanceText,
    getRealBalanceText,
    toggleRealAutopilot,
    pollTelegramUpdates,
    startPollingLoop
  };
}

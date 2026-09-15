/**
 * Telegram & Discord Notification and Bot Command Service
 */

export interface TelegramBotConfig {
  id: string;
  botToken: string;
  chatId: string;
  isEnabled: boolean;
  name?: string;
  muteWatchdog?: boolean;
}

export interface DiscordWebhookConfig {
  id?: string;
  webhookUrl: string;
  isEnabled: boolean;
  name?: string;
}

export interface FormattedSignalParams {
  cleanSymbol: string;
  price: number;
  side: string;
  high: number;
  funding: number;
  trueRsi: number;
  bbStatus: string;
  dropProb: number;
  idealEntryMin: number;
  idealEntryMax: number;
  recentHigh: number;
  recentLow: number;
  exName: string;
  exLink: string;
  aiScore?: number;
  aiRationale?: string;
}

export interface TelegramStatsContext {
  virtualTrades: any[];
  virtualBalance: number;
  startOfDayBalance: number;
  aiKnowledgeBaseCount: number;
  autopilotAggressiveness?: string;
  exchangeConfig?: { isEnabled?: boolean; exchange?: string; apiKey?: string };
  realBalanceUsdt?: number | null;
  realBalanceError?: string | null;
}

export interface TelegramBalanceContext {
  virtualTrades: any[];
  virtualBalance: number;
  startOfDayBalance: number;
}

export interface TelegramPollContext {
  getBots: () => TelegramBotConfig[];
  getGlobalSettings: () => any;
  saveSettings: () => void;
  compileStats: () => Promise<string>;
  getVirtualBalance: () => string;
  getRealBalance: () => Promise<string>;
  toggleAutopilot: () => string;
}

const lastTelegramUpdateId: Record<string, number> = {};
const lastTelegramErrorTime: Record<string, number> = {};

export function getChartImageHtml(symbol: string): string {
  const clean = symbol.replace(/[\/:-]/g, '').replace(/USDT$/i, '').toUpperCase();
  const timestamp = Date.now();
  const tvSymbol = `MEXC:${clean}USDT`;
  const chartUrl = `https://www.tradingview.com/chart/?symbol=${tvSymbol}&interval=60&theme=dark&_t=${timestamp}`;
  return `<a href="${chartUrl}">&#8205;</a>`;
}

export async function sendTelegramMessage(
  text: string,
  photoUrl?: string,
  configProvider?: {
    getBots: () => TelegramBotConfig[];
    getDiscordWebhooks?: () => DiscordWebhookConfig[];
  }
): Promise<void> {
  setTimeout(async () => {
    try {
      const activeBots = (configProvider ? configProvider.getBots() : []).filter(
        b => b && b.isEnabled && b.botToken && b.chatId
      );
      const activeDiscord = (configProvider?.getDiscordWebhooks ? configProvider.getDiscordWebhooks() : []).filter(
        w => w && w.isEnabled && w.webhookUrl
      );

      if (activeBots.length === 0 && activeDiscord.length === 0) return;

      for (const bot of activeBots) {
        try {
          if (bot.muteWatchdog && text.toLowerCase().includes('watchdog')) {
            continue;
          }
          const token = bot.botToken.replace(/^bot/i, '').trim();
          if (photoUrl) {
            await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: bot.chatId, photo: photoUrl, caption: text, parse_mode: 'HTML' })
            });
          } else {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: bot.chatId, text: text, parse_mode: 'HTML' })
            });
          }
        } catch (e: any) {
          if (e?.message?.includes('fetch failed')) {
            console.warn(`[TELEGRAM] Failed to send telegram message to bot ${bot.name || bot.id}: network fetch failed`);
          } else {
            console.warn(`[TELEGRAM] Failed to send telegram message to bot ${bot.name || bot.id}:`, e?.message || e);
          }
        }
      }

      for (const webhook of activeDiscord) {
        try {
          const discordText = text
            .replace(/<b>/g, '**')
            .replace(/<\/b>/g, '**')
            .replace(/<i>/g, '*')
            .replace(/<\/i>/g, '*')
            .replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)');
          await fetch(webhook.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: discordText })
          });
        } catch (err: any) {
          if (err?.message?.includes('fetch failed')) {
            console.warn('[DISCORD] Failed to send discord msg: network fetch failed');
          } else {
            console.warn('[DISCORD] Failed to send discord msg:', err?.message || err);
          }
        }
      }
    } catch (outerErr: any) {
      console.warn('[TELEGRAM DISPATCH] Outer error:', outerErr?.message || outerErr);
    }
  }, 0);
}

export function formatTelegramSignal(params: FormattedSignalParams): string {
  const {
    cleanSymbol, price, side, high, funding, trueRsi, bbStatus, dropProb,
    idealEntryMin, idealEntryMax, recentHigh, recentLow, exName, exLink, aiRationale
  } = params;

  const baseCoin = cleanSymbol.replace('USDT', '').replace(':USDT', '');
  const isShort = side.includes('SELL') || side.includes('SHORT');
  const positionText = isShort ? 'ШОРТ🔻' : 'ЛОНГ🟢';

  const kdjValue = Math.min(108, Math.max(0, trueRsi * 1.3 - (isShort ? 2 : 10)));
  const kdjText = kdjValue > 85 ? `экстремум (${kdjValue.toFixed(1)})` : kdjValue < 15 ? `минимум (${kdjValue.toFixed(1)})` : `${kdjValue.toFixed(1)}`;

  const fundingRatePercent = (funding * 100).toFixed(4) + '%';
  const bollText = bbStatus === 'OVERBOUGHT' ? 'выше верхней полосы' : bbStatus === 'OVERSOLD' ? 'ниже нижней полосы' : 'внутри полос';

  const formatPrice = (p: number) => {
    if (p === 0 || !p || isNaN(p)) return '0.00';
    if (p < 0.00001) return p.toFixed(8);
    if (p < 0.001) return p.toFixed(6);
    if (p < 0.1) return p.toFixed(5);
    if (p < 1) return p.toFixed(4);
    if (p < 10) return p.toFixed(3);
    return p.toFixed(2);
  };

  let entryMinStr = formatPrice(price);
  let entryMaxStr = formatPrice(price);
  if (isShort) {
    entryMinStr = formatPrice(idealEntryMin || (price * 0.995));
    entryMaxStr = formatPrice(idealEntryMax || (price * 1.015));
  } else {
    entryMinStr = formatPrice(idealEntryMin || (price * 0.985));
    entryMaxStr = formatPrice(idealEntryMax || (price * 1.005));
  }

  const calcPrice = (pct: number) => {
    const sign = isShort ? -1 : 1;
    const val = price * (1 + (pct * sign) / 100);
    return formatPrice(val);
  };

  const tp1 = calcPrice(3);
  const tp2 = calcPrice(5);
  const tp3 = calcPrice(8);
  const tp4 = calcPrice(15);
  
  const sl = calcPrice(-20);
  const avgPriceStr = calcPrice(-10);

  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  
  // UTC+3 time
  const offset = 3; 
  const localTime = new Date(d.getTime() + offset * 3600000);
  const timeStr = `${pad(localTime.getUTCHours())}:${pad(localTime.getUTCMinutes())}:${pad(localTime.getUTCSeconds())}`;

  const chartHtml = getChartImageHtml(cleanSymbol);

  let text = `${chartHtml}<b>Бот прислал сигнал!</b>\n\n`;
  text += `Монета: <b>${baseCoin}</b>\n`;
  text += `Изолированная x3\n`;
  text += `Позиция: <b>${positionText}</b>\n\n`;
  text += `🤖 <b>Анализ ИИ:</b>\n`;
  text += `• Макс. цена 24ч: $${formatPrice(high)}\n`;
  text += `• Фандинг: ${fundingRatePercent}\n`;
  text += `• RSI: ${trueRsi.toFixed(2)} ${trueRsi > 70 ? '(сильная перекупленность)' : trueRsi < 30 ? '(сильная перепроданность)' : '(нейтрально)'}\n`;
  text += `• BOLL: ${bollText}\n`;
  text += `• KDJ: ${kdjText}\n`;
  if (aiRationale) {
    text += `• Прогноз ИИ: ${aiRationale}\n`;
  }
  text += `• Вероятность ${isShort ? 'падения' : 'роста'}: ~${Math.round(dropProb || 75)}%\n\n`;
  const smartLimitTarget = Number(((idealEntryMin + idealEntryMax) / 2).toFixed(5));
  const smartLimitDistPct = Math.abs((smartLimitTarget - price) / price * 100).toFixed(2);
  text += `🎯 <b>Smart Limit Target: $${smartLimitTarget}</b> (${isShort ? '+' : '-'}${smartLimitDistPct}% лимитный вход)\n`;
  text += `Зоны входа: $${entryMinStr} — $${entryMaxStr} на 2% от депозита\n\n`;
  text += `🎯 TP1 (${isShort ? '-' : '+'}3%): $${tp1} — закрыть 50%, стоп → б/у\n`;
  text += `🎯 TP2 (${isShort ? '-' : '+'}5%): $${tp2} — закрыть 25%, стоп → б/у\n`;
  text += `🎯 TP3 (${isShort ? '-' : '+'}8%): $${tp3} — закрыть 15%, стоп → TP1\n`;
  text += `🎯 TP4 (${isShort ? '-' : '+'}15%): $${tp4} — закрыть 10%, стоп → TP2\n\n`;
  text += `🛑 Стоп-лосс: $${sl}\n`;
  text += `SL ставим ${isShort ? '+' : '-'}20% от цены входа!\n\n`;
  text += `Усреднение (${isShort ? '+' : '-'}10%): $${avgPriceStr} на 2% от депозита\n\n`;
  text += `📊 Зоны:\n`;
  text += `• Сопротивление: $${formatPrice(recentHigh || high)}\n`;
  text += `• Поддержка: $${formatPrice(recentLow || (price * 0.985))}\n\n`;
  text += `🔗 <a href="${exLink}">Открыть на ${exName.toUpperCase() === 'MEXC' ? 'WEEX' : exName.toUpperCase()}</a>\n`;
  text += `⏱ ${timeStr}`;

  return text;
}

export function sendFormattedTelegramSignal(
  params: FormattedSignalParams,
  sendFn: (text: string) => void
): void {
  const text = formatTelegramSignal(params);
  sendFn(text);
}

export function getVirtualBalanceText(ctx: TelegramBalanceContext): string {
  const openTrades = (ctx.virtualTrades || []).filter(t => t.status === 'OPEN');
  const dailyChangePercent = ctx.startOfDayBalance > 0
    ? ((ctx.virtualBalance - ctx.startOfDayBalance) / ctx.startOfDayBalance) * 100
    : 0;
  const dailyChangeUsd = ctx.virtualBalance - ctx.startOfDayBalance;
  
  return `💵 <b>ВИРТУАЛЬНЫЙ БАЛАНС</b>\n\n` +
         `• Текущий баланс: <b>$${ctx.virtualBalance.toFixed(2)} USDT</b>\n` +
         `• Старт дня: <code>$${ctx.startOfDayBalance.toFixed(2)} USDT</code>\n` +
         `• Суточный PnL: <b>${dailyChangeUsd >= 0 ? '+' : ''}$${dailyChangeUsd.toFixed(2)} USDT</b> (${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%)\n` +
         `• Открытых позиций: <b>${openTrades.length}</b>`;
}

export async function compileTelegramStats(ctx: TelegramStatsContext): Promise<string> {
  const openTrades = (ctx.virtualTrades || []).filter(t => t.status === 'OPEN');
  const closedTrades = (ctx.virtualTrades || []).filter(t => t.status === 'CLOSED');
  
  let totalClosedPnl = 0;
  let profitableCount = 0;
  for (const t of closedTrades) {
    totalClosedPnl += t.pnl || 0;
    if ((t.pnlPercent || 0) > 0) {
      profitableCount++;
    }
  }
  const winRate = closedTrades.length > 0 ? (profitableCount / closedTrades.length) * 100 : 0;
  
  const dailyChangePercent = ctx.startOfDayBalance > 0
    ? ((ctx.virtualBalance - ctx.startOfDayBalance) / ctx.startOfDayBalance) * 100
    : 0;
  const dailyChangeUsd = ctx.virtualBalance - ctx.startOfDayBalance;

  let realBalanceText = 'Не подключен';
  if (ctx.realBalanceUsdt !== undefined && ctx.realBalanceUsdt !== null) {
    realBalanceText = `<b>${ctx.realBalanceUsdt.toFixed(2)} USDT</b>`;
  } else if (ctx.realBalanceError) {
    realBalanceText = `Ошибка (${ctx.realBalanceError})`;
  }

  let text = `📊 <b>СТАТИСТИКА ТОРГОВОГО ИИ-АГЕНТА</b>\n\n`;
  text += `⚙️ <b>Режим работы:</b>\n`;
  text += `• Биржа: <b>${(ctx.exchangeConfig?.exchange || 'WEEX').toUpperCase()}</b>\n`;
  text += `• База знаний ИИ: <b>${ctx.aiKnowledgeBaseCount} правил</b>\n`;
  const aggLabels: Record<string, string> = {
    'conservative': 'КОНСЕРВАТИВНЫЙ (Абсолютная безопасность) 🛡️',
    'moderate': 'УМЕРЕННЫЙ (Умный поиск прибыли) ⚖️',
    'aggressive': 'АГРЕССИВНЫЙ (Максимальный объём сделок) 🔥'
  };
  const aggLabel = aggLabels[ctx.autopilotAggressiveness || 'conservative'] || 'КОНСЕРВАТИВНЫЙ';
  text += `• Уровень агрессивности: <b>${aggLabel}</b>\n`;
  text += `• Автопилот на бирже: <b>${ctx.exchangeConfig && ctx.exchangeConfig.isEnabled ? 'ВКЛЮЧЕН 🟢' : 'ВЫКЛЮЧЕН 🔴'}</b>\n\n`;
  
  text += `💰 <b>Балансы:</b>\n`;
  text += `• Виртуальный баланс: <b>$${ctx.virtualBalance.toFixed(2)} USDT</b>\n`;
  text += `• Суточный PnL (вирт): <b>${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%</b> ($${dailyChangePercent >= 0 ? '+' : ''}${dailyChangeUsd.toFixed(2)})\n`;
  text += `• Баланс на бирже: ${realBalanceText}\n\n`;
  
  text += `📈 <b>Сделки (Итого):</b>\n`;
  text += `• Активные позиции: <b>${openTrades.length}</b>\n`;
  text += `• Закрытые сделки: <b>${closedTrades.length}</b>\n`;
  text += `• Успешность (Win Rate): <b>${winRate.toFixed(1)}%</b>\n`;
  text += `• Общий вирт. доход: <b>${totalClosedPnl >= 0 ? '+' : ''}$${totalClosedPnl.toFixed(2)} USDT</b>\n\n`;
  
  text += `📋 <b>Активные позиции:</b>\n`;
  if (openTrades.length === 0) {
    text += '• <i>Нет открытых позиций в данный момент</i>';
  } else {
    for (const trade of openTrades) {
      const curPrice = trade.currentPrice || trade.entryPrice;
      const pnlPct = trade.side === 'SHORT'
        ? ((trade.entryPrice - curPrice) / trade.entryPrice) * 100 * trade.leverage
        : ((curPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
      
      const pnlUsd = trade.amount * (pnlPct / 100);
      text += `• <b>${trade.symbol.replace(/[\/:]/g, '')}</b> (${trade.side} ${trade.leverage}x)\n`;
      text += `  Вход: $${trade.entryPrice.toFixed(5)} → Тек: $${curPrice.toFixed(5)}\n`;
      text += `  PnL: <b>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</b> (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})\n`;
    }
  }

  return text;
}

export function toggleRealAutopilotText(config: any, saveFn?: () => void): string {
  if (!config) {
    return '❌ <b>АВТОПИЛОТ</b>\n\nНе удалось загрузить конфигурацию.';
  }
  
  config.isEnabled = !config.isEnabled;
  if (saveFn) saveFn();
  
  return `🤖 <b>ТОРГОВЫЙ АВТОПИЛОТ</b>\n\n` +
         `Режим автопилота изменен:\n` +
         `Текущий статус: <b>${config.isEnabled ? 'ВКЛЮЧЕН 🟢' : 'ВЫКЛЮЧЕН 🔴'}</b>\n` +
         `Биржа: <b>${(config.exchange || 'WEEX').toUpperCase()}</b>\n\n` +
         `${config.isEnabled 
           ? '🟢 ИИ-агент теперь будет входить в сделки на реальном балансе автоматически при получении сигналов с высоким качеством!' 
           : '🔴 Автоматическая торговля приостановлена. Новые сделки будут открываться только в виртуальном (Paper) режиме.'}`;
}

export async function fetchTelegramChatId(botToken: string): Promise<{ success: boolean; chatId?: string; name?: string; error?: string }> {
  if (!botToken) return { success: false, error: 'botToken is required' };
  try {
    const token = botToken.replace(/^bot/i, '').trim();
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await response.json();
    
    if (!data.ok) {
      return { success: false, error: data.description || 'Failed to fetch updates' };
    }
    
    if (!data.result || data.result.length === 0) {
      return { success: false, error: 'Ожидание... Напишите вашему боту любое сообщение (например, /start) в Telegram.' };
    }
    
    const lastUpdate = data.result.reverse().find((u: any) => u.message && u.message.chat);
    if (!lastUpdate) {
      return { success: false, error: 'Чат не найден. Убедитесь, что вы написали боту.' };
    }
    
    const chatId = lastUpdate.message.chat.id.toString();
    const name = lastUpdate.message.chat.username || lastUpdate.message.chat.first_name || 'My Chat';
    
    return { success: true, chatId, name };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function sendTelegramTestMessage(botToken: string, chatId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const token = botToken.replace(/^bot/i, '').trim();
    const testRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ <b>Test Connection Successful!</b>\nCrypto Multi-Pattern Trading Simulator is connected.',
        parse_mode: 'HTML'
      })
    });
    const data = await testRes.json();
    if (!data.ok) throw new Error(data.description);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export async function pollTelegramUpdates(pollCtx: TelegramPollContext): Promise<void> {
  const activeBots = (pollCtx.getBots() || []).filter(b => b && b.isEnabled && b.botToken && b.chatId);
  if (activeBots.length === 0) return;

  const replyKeyboard = {
    keyboard: [
      [{ text: "📊 Статистика" }, { text: "💵 Виртуальный баланс" }],
      [{ text: "🔄 Реальный баланс" }, { text: "🤖 Автопилот: Toggle" }],
      [{ text: "⚙️ Режим агрессивности" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };

  for (const bot of activeBots) {
    try {
      const token = bot.botToken.replace(/^bot/i, '').trim();
      const botIdKey = `tg_offset_${bot.id}`;
      const offset = lastTelegramUpdateId[botIdKey] || 0;
      
      const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=10${offset ? `&offset=${offset}` : ''}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        if (res.status === 409) {
          console.log(`[TELEGRAM] Webhook conflict (409) detected on getUpdates for bot ${bot.name || bot.id}. Sending deleteWebhook...`);
          const delController = new AbortController();
          const delTimeoutId = setTimeout(() => delController.abort(), 5000);
          try {
            await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { signal: delController.signal });
          } catch (_) {
          } finally {
            clearTimeout(delTimeoutId);
          }
        }
        continue;
      }
      
      const data = await res.json();
      if (data.ok === false || !data.result) {
        if (data.description && data.description.toLowerCase().includes('webhook')) {
          console.log(`[TELEGRAM] Webhook conflict in description detected on getUpdates for bot ${bot.name || bot.id}. Sending deleteWebhook...`);
          await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});
        }
        continue;
      }

      for (const update of data.result) {
        const updateId = update.update_id;
        lastTelegramUpdateId[botIdKey] = updateId + 1;

        let chatId = '';
        let text = '';
        let callbackQueryId = '';
        let isCallback = false;

        if (update.message && update.message.text) {
          chatId = update.message.chat.id.toString();
          text = update.message.text.trim().toLowerCase();
        } else if (update.callback_query && update.callback_query.message) {
          chatId = update.callback_query.message.chat.id.toString();
          text = (update.callback_query.data || '').trim().toLowerCase();
          callbackQueryId = update.callback_query.id;
          isCallback = true;
        }

        if (!chatId) continue;
        if (chatId.trim() !== bot.chatId.trim()) continue;

        if (isCallback && callbackQueryId) {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
          }).catch(() => {});
        }

        if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/menu')) {
          const helpMessage = `👋 <b>Привет! Я Торговый ИИ-агент.</b>\n\n` +
            `По умолчанию я отправляю торговые сигналы и автоматические уведомления прямо в этот чат.\n\n` +
            `Используйте встроенное интерактивное меню или кнопки на клавиатуре для быстрого управления:`;
            
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              chat_id: chatId, 
              text: helpMessage, 
              parse_mode: 'HTML',
              reply_markup: replyKeyboard
            })
          });
        } else {
          let replyText = '';
          let customReplyMarkup: any = replyKeyboard;

          if (text.includes('статистика') || text.startsWith('/stats') || text.startsWith('/status')) {
            replyText = await pollCtx.compileStats();
          } else if (text.includes('виртуальный') || text.startsWith('/virtual_balance')) {
            replyText = pollCtx.getVirtualBalance();
          } else if (text.includes('реальный') || text.startsWith('/real_balance')) {
            replyText = await pollCtx.getRealBalance();
          } else if (text.includes('автопилот') || text.startsWith('/autopilot')) {
            replyText = pollCtx.toggleAutopilot();
          } else if (text.includes('агрессивность') || text.startsWith('/aggressiveness')) {
            const settings = pollCtx.getGlobalSettings();
            const currentAgg = settings.autopilotAggressiveness || 'conservative';
            const aggEmojiMap: Record<string, string> = {
              'conservative': '🛡️ Консервативный',
              'moderate': '⚖️ Умеренный',
              'aggressive': '🔥 Агрессивный'
            };
            replyText = `⚙️ <b>КОМПРОМИСС АКТИВНОСТИ И РИСКА</b>\n\n` +
                        `ИИ-агент подстраивает фильтры, частоту входов и объёмы сделок под ваш аппетит к риску.\n\n` +
                        `Текущий уровень: <b>${aggEmojiMap[currentAgg]}</b>\n\n` +
                        `Выберите уровень агрессивности и доходности для торговли:`;

            customReplyMarkup = {
              inline_keyboard: [
                [
                  { text: "🛡️ Консервативный", callback_data: "/set_agg_conservative" },
                  { text: "⚖️ Умеренный", callback_data: "/set_agg_moderate" }
                ],
                [
                  { text: "🔥 Агрессивный", callback_data: "/set_agg_aggressive" }
                ]
              ]
            };
          } else if (text.startsWith('/set_agg_')) {
            const newAgg = text.replace('/set_agg_', '') as 'conservative' | 'moderate' | 'aggressive';
            if (['conservative', 'moderate', 'aggressive'].includes(newAgg)) {
              const settings = pollCtx.getGlobalSettings();
              settings.autopilotAggressiveness = newAgg;
              pollCtx.saveSettings();
              
              const aggEmojiMap: Record<string, string> = {
                'conservative': '🛡️ Консервативный (Максимальная защита баланса)',
                'moderate': '⚖️ Умеренный (Сбалансированная прибыль и риски)',
                'aggressive': '🔥 Агрессивный (Максимальное число сделок и объёмы)'
              };

              replyText = `✅ <b>Уровень агрессивности изменен!</b>\n\n` +
                          `Новый установленный режим: <b>${aggEmojiMap[newAgg]}</b>\n\n` +
                          `ИИ-агент обновил торговые фильтры и расчёты Kelly/ATR. Позиции будут открываться в соответствии с выбранной стратегией.`;
            }
          }

          if (replyText) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                chat_id: chatId, 
                text: replyText, 
                parse_mode: 'HTML',
                reply_markup: customReplyMarkup
              })
            });
          }
        }
      }
    } catch (err: any) {
      const now = Date.now();
      const botId = bot.id || 'unknown';
      const lastErrTime = lastTelegramErrorTime[botId] || 0;
      const isNetworkIssue = err?.message?.includes('fetch failed') || err?.name === 'AbortError' || err?.message?.includes('aborted');
      if (isNetworkIssue) {
        if (now - lastErrTime > 15 * 60 * 1000) {
          console.log(`[TELEGRAM POLLING] Bot: ${bot.name || botId} temporary network timeout or offline issue. Retrying silently in next intervals...`);
          lastTelegramErrorTime[botId] = now;
        }
      } else {
        if (now - lastErrTime > 5 * 60 * 1000) {
          console.log(`[TELEGRAM POLLING ERR] Bot: ${bot.name || botId}:`, err?.message || err);
          lastTelegramErrorTime[botId] = now;
        }
      }
    }
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatTelegramSignal,
  getVirtualBalanceText,
  compileTelegramStats,
  toggleRealAutopilotText,
  fetchTelegramChatId,
  sendTelegramTestMessage,
  sendTelegramMessage
} from '../../server/services/telegramService';

describe('Telegram Service Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('formats SHORT signals with accurate TP/SL, indicators and Russian terminology', () => {
    const text = formatTelegramSignal({
      cleanSymbol: 'BTCUSDT',
      price: 60000,
      side: 'SHORT',
      high: 62000,
      funding: 0.0001,
      trueRsi: 78.5,
      bbStatus: 'OVERBOUGHT',
      dropProb: 82,
      idealEntryMin: 59800,
      idealEntryMax: 60200,
      recentHigh: 62000,
      recentLow: 58000,
      exName: 'WEEX',
      exLink: 'https://weex.com',
      aiRationale: 'Parabolic spike into liquidity resistance'
    });

    expect(text).toContain('BTC');
    expect(text).toContain('ШОРТ🔻');
    expect(text).toContain('Изолированная x3');
    expect(text).toContain('RSI: 78.50 (сильная перекупленность)');
    expect(text).toContain('BOLL: выше верхней полосы');
    expect(text).toContain('Вероятность падения: ~82%');
    expect(text).toContain('Smart Limit Target: $60000');
    expect(text).toContain('TP1 (-3%): $58200.00');
    expect(text).toContain('Стоп-лосс: $72000.00');
    expect(text).toContain('Открыть на WEEX');
  });

  it('formats LONG signals with accurate TP/SL and Russian terminology', () => {
    const text = formatTelegramSignal({
      cleanSymbol: 'ETHUSDT',
      price: 3000,
      side: 'LONG',
      high: 3100,
      funding: -0.0002,
      trueRsi: 22.4,
      bbStatus: 'OVERSOLD',
      dropProb: 80,
      idealEntryMin: 2980,
      idealEntryMax: 3020,
      recentHigh: 3100,
      recentLow: 2950,
      exName: 'WEEX',
      exLink: 'https://weex.com',
      aiRationale: 'Strong bullish pinbar bounce off 4h support'
    });

    expect(text).toContain('ETH');
    expect(text).toContain('ЛОНГ🟢');
    expect(text).toContain('RSI: 22.40 (сильная перепроданность)');
    expect(text).toContain('BOLL: ниже нижней полосы');
    expect(text).toContain('Вероятность роста: ~80%');
    expect(text).toContain('TP1 (+3%): $3090.00');
    expect(text).toContain('Стоп-лосс: $2400.00');
  });

  it('formats virtual balance text accurately', () => {
    const text = getVirtualBalanceText({
      virtualBalance: 10500,
      startOfDayBalance: 10000,
      virtualTrades: [
        { id: '1', symbol: 'BTCUSDT', status: 'OPEN' },
        { id: '2', symbol: 'ETHUSDT', status: 'OPEN' },
        { id: '3', symbol: 'SOLUSDT', status: 'CLOSED' }
      ]
    });

    expect(text).toContain('$10500.00 USDT');
    expect(text).toContain('Старт дня: <code>$10000.00 USDT</code>');
    expect(text).toContain('Суточный PnL: <b>+$500.00 USDT</b> (+5.00%)');
    expect(text).toContain('Открытых позиций: <b>2</b>');
  });

  it('compiles Telegram statistics accurately with Win Rate and PnL breakdown', async () => {
    const text = await compileTelegramStats({
      virtualBalance: 11200,
      startOfDayBalance: 10000,
      aiKnowledgeBaseCount: 15,
      autopilotAggressiveness: 'moderate',
      exchangeConfig: { isEnabled: true, exchange: 'weex', apiKey: 'key' },
      realBalanceUsdt: 5420.50,
      virtualTrades: [
        { id: '1', symbol: 'BTC/USDT', side: 'SHORT', leverage: 3, amount: 100, entryPrice: 60000, currentPrice: 58000, status: 'OPEN' },
        { id: '2', symbol: 'ETH/USDT', side: 'LONG', leverage: 3, amount: 100, entryPrice: 3000, status: 'CLOSED', pnl: 30, pnlPercent: 10 },
        { id: '3', symbol: 'SOL/USDT', side: 'SHORT', leverage: 3, amount: 100, entryPrice: 150, status: 'CLOSED', pnl: -10, pnlPercent: -3.3 }
      ]
    });

    expect(text).toContain('СТАТИСТИКА ТОРГОВОГО ИИ-АГЕНТА');
    expect(text).toContain('УМЕРЕННЫЙ');
    expect(text).toContain('15 правил');
    expect(text).toContain('ВКЛЮЧЕН 🟢');
    expect(text).toContain('$11200.00 USDT');
    expect(text).toContain('5420.50 USDT');
    expect(text).toContain('Активные позиции: <b>1</b>');
    expect(text).toContain('Закрытые сделки: <b>2</b>');
    expect(text).toContain('Успешность (Win Rate): <b>50.0%</b>');
    expect(text).toContain('+$20.00 USDT');
    expect(text).toContain('BTCUSDT');
  });

  it('toggles autopilot state and returns appropriate notification message', () => {
    const config = { isEnabled: false, exchange: 'weex' };
    let saved = false;
    const msg = toggleRealAutopilotText(config, () => { saved = true; });

    expect(config.isEnabled).toBe(true);
    expect(saved).toBe(true);
    expect(msg).toContain('ВКЛЮЧЕН 🟢');
    expect(msg).toContain('WEEX');

    const msgOff = toggleRealAutopilotText(config, () => {});
    expect(config.isEnabled).toBe(false);
    expect(msgOff).toContain('ВЫКЛЮЧЕН 🔴');
  });

  it('handles fetchTelegramChatId properly on successful response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 12345,
            message: {
              chat: { id: 987654, username: 'trader_pro' }
            }
          }
        ]
      })
    } as any);

    const res = await fetchTelegramChatId('bot123456:ABC-DEF');
    expect(res.success).toBe(true);
    expect(res.chatId).toBe('987654');
    expect(res.name).toBe('trader_pro');
  });

  it('sends test telegram message correctly', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 999 } })
    } as any);

    const res = await sendTelegramTestMessage('bot123456:ABC-DEF', '987654');
    expect(res.success).toBe(true);
  });
});

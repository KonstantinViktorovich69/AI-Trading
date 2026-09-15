import { describe, it, expect, vi } from 'vitest';
import { createTelegramBotService } from './telegramBotService.ts';

describe('telegramBotService', () => {
  it('correctly generates virtual balance text', () => {
    const mockSettings = {
      telegramBots: [],
      exchangeApiConfig: { isEnabled: false }
    };
    const service = createTelegramBotService({
      getGlobalSettings: () => mockSettings,
      saveSettings: vi.fn(),
      getVirtualTrades: () => [
        { id: '1', status: 'OPEN', symbol: 'BTC/USDT', side: 'SHORT', entryPrice: 60000, currentPrice: 59000, leverage: 5, amount: 50 }
      ],
      getVirtualBalance: () => 1050,
      getStartOfDayBalance: () => 1000,
      getAiKnowledgeBaseCount: () => 12,
      getCcxtClient: vi.fn(),
      fetchCachedRealBalance: vi.fn().mockResolvedValue({ USDT: { total: 500, free: 450 } }),
      isMainThread: false
    });

    const text = service.getVirtualBalanceText();
    expect(text).toContain('ВИРТУАЛЬНЫЙ БАЛАНС');
    expect(text).toContain('$1050.00 USDT');
    expect(text).toContain('Открытых позиций: <b>1</b>');
  });

  it('correctly toggles autopilot in settings', () => {
    const mockSettings = {
      telegramBots: [],
      exchangeApiConfig: { isEnabled: false, exchange: 'weex' }
    };
    const saveFn = vi.fn();
    const service = createTelegramBotService({
      getGlobalSettings: () => mockSettings,
      saveSettings: saveFn,
      getVirtualTrades: () => [],
      getVirtualBalance: () => 1000,
      getStartOfDayBalance: () => 1000,
      getAiKnowledgeBaseCount: () => 10,
      getCcxtClient: vi.fn(),
      fetchCachedRealBalance: vi.fn(),
      isMainThread: false
    });

    const reply = service.toggleRealAutopilot();
    expect(mockSettings.exchangeApiConfig.isEnabled).toBe(true);
    expect(saveFn).toHaveBeenCalled();
    expect(reply).toContain('ВКЛЮЧЕН');
  });
});

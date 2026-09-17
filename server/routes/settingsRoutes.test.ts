import { describe, it, expect, vi } from 'vitest';
import { createSettingsRouter, type SettingsRouterContext } from './settingsRoutes.ts';
import { createSystemRouter, type SystemRouterContext } from './systemRoutes.ts';
import { CONFIGURED_SECRET_MASK } from '../utils/settingsSanitizer.ts';

describe('Settings Router Security Tests', () => {
  const createMockRes = () => {
    const res: any = {
      statusCode: 200,
      jsonData: null,
      headers: {},
      status: vi.fn().mockImplementation((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: vi.fn().mockImplementation((data: any) => {
        res.jsonData = data;
        return res;
      }),
      setHeader: vi.fn().mockImplementation((k: string, v: string) => {
        res.headers[k] = v;
        return res;
      })
    };
    return res;
  };

  const getHandler = (router: any, path: string, method: string) => {
    const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
    if (!layer) throw new Error(`Route ${method} ${path} not found`);
    return layer.route.stack[0].handle;
  };

  it('GET /settings masks exchange secrets and telegram credentials', async () => {
    const realSettings = {
      exchangeApiConfig: {
        exchange: 'weex',
        apiKey: 'super-secret-api-key',
        apiSecret: 'super-secret-secret',
        password: 'super-secret-passphrase',
        isEnabled: true
      },
      telegramBots: [
        { id: '1', name: 'Bot', botToken: '1234:TOKEN', chatId: '999999', isEnabled: true }
      ]
    };

    const mockCtx: Partial<SettingsRouterContext> = {
      getGlobalSettings: vi.fn().mockReturnValue(realSettings),
      getLastSanitizationStatus: vi.fn().mockReturnValue({ sanitized: false }),
      saveSettings: vi.fn()
    };

    const router = createSettingsRouter(mockCtx as SettingsRouterContext);
    const handler = getHandler(router, '/settings', 'get');
    const res = createMockRes();

    await handler({} as any, res);

    expect(res.jsonData.success).toBe(true);
    expect(res.jsonData.data.exchangeApiConfig.apiKey).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.data.exchangeApiConfig.apiSecret).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.data.exchangeApiConfig.password).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.data.telegramBots[0].botToken).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.data.telegramBots[0].chatId).toBe(CONFIGURED_SECRET_MASK);

    // In-memory settings must retain actual secret values
    expect(realSettings.exchangeApiConfig.apiKey).toBe('super-secret-api-key');
    expect(realSettings.exchangeApiConfig.apiSecret).toBe('super-secret-secret');
    expect(realSettings.telegramBots[0].botToken).toBe('1234:TOKEN');
  });

  it('POST /settings preserves existing secrets when ***configured*** is submitted', async () => {
    const realSettings = {
      exchangeApiConfig: {
        exchange: 'weex',
        apiKey: 'original-api-key',
        apiSecret: 'original-api-secret',
        password: 'original-password',
        isEnabled: true
      },
      telegramBots: [
        { id: '1', name: 'Bot 1', botToken: 'original-bot-token', chatId: 'original-chat-id', isEnabled: true }
      ]
    };

    const mockCtx: Partial<SettingsRouterContext> = {
      getGlobalSettings: vi.fn().mockReturnValue(realSettings),
      getAutopilotFailedSymbols: vi.fn().mockReturnValue(new Set()),
      getLastSanitizationStatus: vi.fn().mockReturnValue({ sanitized: false }),
      saveSettings: vi.fn()
    };

    const router = createSettingsRouter(mockCtx as SettingsRouterContext);
    const handler = getHandler(router, '/settings', 'post');
    const res = createMockRes();

    // Client posts back masked secrets along with an updated setting
    const req: any = {
      body: {
        exchangeApiConfig: {
          exchange: 'weex',
          apiKey: CONFIGURED_SECRET_MASK,
          apiSecret: CONFIGURED_SECRET_MASK,
          password: CONFIGURED_SECRET_MASK,
          isEnabled: false
        },
        telegramBots: [
          { id: '1', name: 'Bot 1 Updated', botToken: CONFIGURED_SECRET_MASK, chatId: CONFIGURED_SECRET_MASK, isEnabled: false }
        ]
      }
    };

    await handler(req, res);

    expect(mockCtx.saveSettings).toHaveBeenCalled();
    // Real secrets are preserved
    expect(realSettings.exchangeApiConfig.apiKey).toBe('original-api-key');
    expect(realSettings.exchangeApiConfig.apiSecret).toBe('original-api-secret');
    expect(realSettings.exchangeApiConfig.password).toBe('original-password');
    expect(realSettings.exchangeApiConfig.isEnabled).toBe(false);
    expect(realSettings.telegramBots[0].botToken).toBe('original-bot-token');
    expect(realSettings.telegramBots[0].chatId).toBe('original-chat-id');
    expect(realSettings.telegramBots[0].name).toBe('Bot 1 Updated');

    // And returned response is sanitized
    expect(res.jsonData.data.exchangeApiConfig.apiKey).toBe(CONFIGURED_SECRET_MASK);
  });

  it('POST /settings updates secrets when a new non-masked value is provided', async () => {
    const realSettings = {
      exchangeApiConfig: {
        exchange: 'mexc',
        apiKey: 'old-api-key',
        apiSecret: 'old-secret',
        password: 'old-password',
        isEnabled: false
      },
      telegramBots: []
    };

    const mockCtx: Partial<SettingsRouterContext> = {
      getGlobalSettings: vi.fn().mockReturnValue(realSettings),
      getAutopilotFailedSymbols: vi.fn().mockReturnValue(new Set()),
      getLastSanitizationStatus: vi.fn().mockReturnValue({ sanitized: false }),
      saveSettings: vi.fn()
    };

    const router = createSettingsRouter(mockCtx as SettingsRouterContext);
    const handler = getHandler(router, '/settings', 'post');
    const res = createMockRes();

    const req: any = {
      body: {
        exchangeApiConfig: {
          exchange: 'weex',
          apiKey: 'new-brand-key',
          apiSecret: 'new-brand-secret',
          password: 'new-brand-pass',
          isEnabled: true
        }
      }
    };

    await handler(req, res);

    expect(realSettings.exchangeApiConfig.apiKey).toBe('new-brand-key');
    expect(realSettings.exchangeApiConfig.apiSecret).toBe('new-brand-secret');
    expect(realSettings.exchangeApiConfig.password).toBe('new-brand-pass');
    expect(realSettings.exchangeApiConfig.exchange).toBe('weex');
  });

  it('GET /database/export masks globalSettings in backup export', async () => {
    const cachedDB = {
      virtualTrades: [{ id: 'trade-1', symbol: 'BTCUSDT' }],
      globalSettings: {
        exchangeApiConfig: {
          apiKey: 'secret-export-key',
          apiSecret: 'secret-export-secret',
          password: 'secret-export-password'
        },
        telegramBots: [{ botToken: 'secret-bot-token', chatId: '12345' }]
      }
    };

    const mockCtx: Partial<SystemRouterContext> = {
      getCachedDB: vi.fn().mockReturnValue(cachedDB)
    };

    const router = createSystemRouter(mockCtx as SystemRouterContext);
    const handler = getHandler(router, '/database/export', 'get');
    const res = createMockRes();

    await handler({} as any, res);

    expect(res.jsonData.virtualTrades).toEqual([{ id: 'trade-1', symbol: 'BTCUSDT' }]);
    expect(res.jsonData.globalSettings.exchangeApiConfig.apiKey).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.globalSettings.exchangeApiConfig.apiSecret).toBe(CONFIGURED_SECRET_MASK);
    expect(res.jsonData.globalSettings.telegramBots[0].botToken).toBe(CONFIGURED_SECRET_MASK);

    // In-memory cachedDB must NOT be modified
    expect(cachedDB.globalSettings.exchangeApiConfig.apiKey).toBe('secret-export-key');
  });
});

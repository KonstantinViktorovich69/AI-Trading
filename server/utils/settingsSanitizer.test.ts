import { describe, it, expect } from 'vitest';
import { sanitizeSettingsForClient, CONFIGURED_SECRET_MASK } from './settingsSanitizer.ts';

describe('sanitizeSettingsForClient', () => {
  it('masks exchangeApiConfig secrets when non-empty', () => {
    const rawSettings = {
      exchangeApiConfig: {
        exchange: 'weex',
        apiKey: 'real-key-12345',
        apiSecret: 'real-secret-67890',
        password: 'real-passphrase',
        isEnabled: true
      },
      virtualBalance: 5000
    };

    const sanitized = sanitizeSettingsForClient(rawSettings);

    expect(sanitized.exchangeApiConfig.apiKey).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.exchangeApiConfig.apiSecret).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.exchangeApiConfig.password).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.exchangeApiConfig.exchange).toBe('weex');
    expect(sanitized.exchangeApiConfig.isEnabled).toBe(true);
    expect(sanitized.virtualBalance).toBe(5000);

    // Verify deep copy: original is NOT modified
    expect(rawSettings.exchangeApiConfig.apiKey).toBe('real-key-12345');
    expect(rawSettings.exchangeApiConfig.apiSecret).toBe('real-secret-67890');
    expect(rawSettings.exchangeApiConfig.password).toBe('real-passphrase');
  });

  it('keeps empty exchange secrets as empty strings', () => {
    const rawSettings = {
      exchangeApiConfig: {
        exchange: 'mexc',
        apiKey: '',
        apiSecret: '   ',
        password: null,
        isEnabled: false
      }
    };

    const sanitized = sanitizeSettingsForClient(rawSettings);
    expect(sanitized.exchangeApiConfig.apiKey).toBe('');
    expect(sanitized.exchangeApiConfig.apiSecret).toBe('   ');
    expect(sanitized.exchangeApiConfig.password).toBeNull();
  });

  it('masks telegramBots tokens and chat IDs when non-empty', () => {
    const rawSettings = {
      telegramBots: [
        { id: '1', name: 'Alerts', botToken: '123456:ABC-DEF', chatId: '987654321', isEnabled: true },
        { id: '2', name: 'Empty', botToken: '', chatId: '', isEnabled: false }
      ]
    };

    const sanitized = sanitizeSettingsForClient(rawSettings);
    expect(sanitized.telegramBots[0].botToken).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.telegramBots[0].chatId).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.telegramBots[0].name).toBe('Alerts');

    expect(sanitized.telegramBots[1].botToken).toBe('');
    expect(sanitized.telegramBots[1].chatId).toBe('');
    expect(sanitized.telegramBots[1].name).toBe('Empty');

    // Original must remain untouched
    expect(rawSettings.telegramBots[0].botToken).toBe('123456:ABC-DEF');
  });

  it('masks legacy telegram fields if present and non-empty', () => {
    const rawSettings = {
      telegramBotToken: 'token123',
      telegramChatId: 'chat456'
    };

    const sanitized = sanitizeSettingsForClient(rawSettings);
    expect(sanitized.telegramBotToken).toBe(CONFIGURED_SECRET_MASK);
    expect(sanitized.telegramChatId).toBe(CONFIGURED_SECRET_MASK);
    expect(rawSettings.telegramBotToken).toBe('token123');
  });

  it('handles null, undefined, or non-object gracefully', () => {
    expect(sanitizeSettingsForClient(null)).toBeNull();
    expect(sanitizeSettingsForClient(undefined)).toBeUndefined();
    expect(sanitizeSettingsForClient('string')).toBe('string');
  });
});

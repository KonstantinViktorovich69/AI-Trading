export const CONFIGURED_SECRET_MASK = '***configured***';

function isNonEmptySecret(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * Creates a deep copy of global settings and replaces sensitive secrets
 * (exchange API keys/secrets/passwords, Telegram bot tokens and chat IDs)
 * with "***configured***" if non-empty, preserving empty/unset values.
 */
export function sanitizeSettingsForClient<T = any>(settings: T): T {
  if (!settings || typeof settings !== 'object') {
    return settings;
  }

  // Deep clone so in-memory settings are never mutated
  const copy: any = JSON.parse(JSON.stringify(settings));

  // 1. exchangeApiConfig: apiKey, apiSecret, password
  if (copy.exchangeApiConfig && typeof copy.exchangeApiConfig === 'object') {
    if (isNonEmptySecret(copy.exchangeApiConfig.apiKey)) {
      copy.exchangeApiConfig.apiKey = CONFIGURED_SECRET_MASK;
    }
    if (isNonEmptySecret(copy.exchangeApiConfig.apiSecret)) {
      copy.exchangeApiConfig.apiSecret = CONFIGURED_SECRET_MASK;
    }
    if (isNonEmptySecret(copy.exchangeApiConfig.password)) {
      copy.exchangeApiConfig.password = CONFIGURED_SECRET_MASK;
    }
  }

  // 2. telegramBots: botToken, chatId
  if (Array.isArray(copy.telegramBots)) {
    copy.telegramBots = copy.telegramBots.map((bot: any) => {
      if (!bot || typeof bot !== 'object') return bot;
      const sanitizedBot = { ...bot };
      if (isNonEmptySecret(sanitizedBot.botToken)) {
        sanitizedBot.botToken = CONFIGURED_SECRET_MASK;
      }
      if (isNonEmptySecret(sanitizedBot.chatId)) {
        sanitizedBot.chatId = CONFIGURED_SECRET_MASK;
      }
      return sanitizedBot;
    });
  }

  // 3. Top-level or legacy telegram bot fields
  if (isNonEmptySecret(copy.telegramBotToken)) {
    copy.telegramBotToken = CONFIGURED_SECRET_MASK;
  }
  if (isNonEmptySecret(copy.telegramChatId)) {
    copy.telegramChatId = CONFIGURED_SECRET_MASK;
  }
  if (isNonEmptySecret(copy.botToken)) {
    copy.botToken = CONFIGURED_SECRET_MASK;
  }
  if (isNonEmptySecret(copy.chatId)) {
    copy.chatId = CONFIGURED_SECRET_MASK;
  }

  return copy;
}

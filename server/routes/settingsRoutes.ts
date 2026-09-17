import express from 'express';
import type { Request, Response, Router } from 'express';
import ccxt from 'ccxt';
import { sanitizeSettingsForClient, CONFIGURED_SECRET_MASK } from '../utils/settingsSanitizer.ts';

export interface SettingsRouterContext {
  getGlobalSettings: () => any;
  saveSettings: () => void;
  getLastSanitizationStatus: () => { sanitized: boolean; reason?: string };
  getCachedDB: () => any;
  setExpertInstructions: (instructions: string, source: string, reason?: string) => void;
  getAutopilotFailedSymbols: () => Set<string>;
  fetchTelegramChatId: (botToken: string) => Promise<{ success: boolean; chatId?: string; name?: string; error?: string }>;
  sendTelegramTestMessage: (botToken: string, chatId: string) => Promise<{ success: boolean; error?: string }>;
  enrichExchangeError: (error: any) => string;
  WEEX_HEADERS?: Record<string, string>;
  getSettingsOptimizerPrompt: (currentSettings: string, message: string) => string;
  runAiGeneration: (params: any) => Promise<any>;
}

const FORBIDDEN_AI_SETTINGS_KEYS = ['exchangeApiConfig', 'telegramBots', 'tradingMode'];

export function sanitizeAiSettingsUpdate(updates: any, sourceLabel: string): any {
  if (!updates || typeof updates !== 'object') return updates;
  for (const key of FORBIDDEN_AI_SETTINGS_KEYS) {
    if (key in updates) {
      console.warn(`[AI-SETTINGS GUARD] ИИ (${sourceLabel}) попытался изменить запрещённое поле "${key}" — заблокировано, поле удалено из обновления.`);
      delete updates[key];
    }
  }
  return updates;
}

export function createSettingsRouter(ctx: SettingsRouterContext): Router {
  const router = express.Router();

  // GET /api/settings
  router.get('/settings', (req: Request, res: Response) => {
    const status = ctx.getLastSanitizationStatus();
    res.json({
      success: true,
      data: sanitizeSettingsForClient(ctx.getGlobalSettings()),
      instructionsSanitized: status.sanitized,
      sanitizeReason: status.reason
    });
  });

  // GET /api/ai-chat-settings
  router.get('/ai-chat-settings', (req: Request, res: Response) => {
    const status = ctx.getLastSanitizationStatus();
    res.json({
      success: true,
      data: sanitizeSettingsForClient(ctx.getGlobalSettings()),
      instructionsSanitized: status.sanitized,
      sanitizeReason: status.reason
    });
  });

  // GET /api/settings/instructions-history
  router.get('/settings/instructions-history', (req: Request, res: Response) => {
    const dbData = ctx.getCachedDB();
    res.json({
      success: true,
      history: dbData.aiExpertTraderInstructionsHistory || []
    });
  });

  // POST /api/settings/instructions-rollback
  router.post('/settings/instructions-rollback', (req: Request, res: Response) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });
    const dbData = ctx.getCachedDB();
    const history = dbData.aiExpertTraderInstructionsHistory || [];
    const found = history.find((item: any) => item.id === id);
    if (!found) return res.status(404).json({ success: false, error: 'Версия не найдена в истории' });
    ctx.setExpertInstructions(found.instructions, 'USER', `Откат к версии от ${new Date(found.timestamp).toLocaleString()}`);
    const status = ctx.getLastSanitizationStatus();
    res.json({
      success: true,
      message: 'Успешный откат инструкции!',
      data: sanitizeSettingsForClient(ctx.getGlobalSettings()),
      instructionsSanitized: status.sanitized,
      sanitizeReason: status.reason
    });
  });

  // POST /api/telegram/get-chat-id
  router.post('/telegram/get-chat-id', async (req: Request, res: Response) => {
    const { botToken } = req.body;
    if (!botToken) return res.status(400).json({ success: false, error: 'botToken is required' });
    const result = await ctx.fetchTelegramChatId(botToken);
    if (!result.success) {
      return res.json({ success: false, error: result.error });
    }
    res.json({ success: true, chatId: result.chatId, name: result.name });
  });

  // POST /api/settings
  router.post('/settings', (req: Request, res: Response) => {
    const globalSettings = ctx.getGlobalSettings();
    const autopilotFailedSymbols = ctx.getAutopilotFailedSymbols();
    const {
      telegramBots, discordWebhooks, exchangeApiConfig, btcShockThreshold,
      autopilotAggressiveness, isAiExpertTraderEnabled, aiExpertTraderInterval,
      aiExpertTraderInstructions, tradingMode, aiMinConfidenceThreshold,
      isVolatilityBrakeEnabled, maxVolatilityLimit, fundingShieldLimit,
      dcaMultiplierFactor, isEma200FilterEnabled, isFvgAboveFilterEnabled,
      isFvgSupportBelowFilterEnabled, isLiquiditySweepFilterEnabled,
      isLateShortFilterEnabled, allowedTradingDirections, isAutopilotEnabled,
      isSymmetricConfidenceFilterEnabled, isCommitteeConsensusCheckEnabled
    } = req.body;

    if (isAutopilotEnabled !== undefined) {
      globalSettings.isAutopilotEnabled = !!isAutopilotEnabled;
    }
    if (telegramBots) {
      if (Array.isArray(telegramBots)) {
        const existingBots = globalSettings.telegramBots || [];
        globalSettings.telegramBots = telegramBots.map((b: any, idx: number) => {
          if (!b || typeof b !== 'object') return b;
          const existingBot = existingBots.find((eb: any) => eb && eb.id === b.id) || existingBots[idx];
          return {
            ...b,
            botToken: b.botToken === CONFIGURED_SECRET_MASK ? (existingBot?.botToken ?? '') : b.botToken,
            chatId: b.chatId === CONFIGURED_SECRET_MASK ? (existingBot?.chatId ?? '') : b.chatId
          };
        });
      } else {
        globalSettings.telegramBots = telegramBots;
      }
    }
    if (discordWebhooks) globalSettings.discordWebhooks = discordWebhooks;
    if (exchangeApiConfig) {
      const existingConfig = globalSettings.exchangeApiConfig || {
        exchange: 'mexc',
        apiKey: '',
        apiSecret: '',
        password: '',
        isEnabled: false
      };
      const rawApiKey = exchangeApiConfig.apiKey !== undefined ? exchangeApiConfig.apiKey?.trim() : undefined;
      const rawApiSecret = exchangeApiConfig.apiSecret !== undefined ? exchangeApiConfig.apiSecret?.trim() : undefined;
      const rawPassword = exchangeApiConfig.password !== undefined ? exchangeApiConfig.password?.trim() : undefined;

      const finalApiKey = rawApiKey === CONFIGURED_SECRET_MASK ? existingConfig.apiKey : (rawApiKey ?? existingConfig.apiKey);
      const finalApiSecret = rawApiSecret === CONFIGURED_SECRET_MASK ? existingConfig.apiSecret : (rawApiSecret ?? existingConfig.apiSecret);
      const finalPassword = rawPassword === CONFIGURED_SECRET_MASK ? existingConfig.password : (rawPassword ?? existingConfig.password);

      globalSettings.exchangeApiConfig = {
        ...existingConfig,
        ...exchangeApiConfig,
        apiKey: finalApiKey,
        apiSecret: finalApiSecret,
        password: finalPassword
      };
      autopilotFailedSymbols.clear();
    }
    if (btcShockThreshold !== undefined) {
      globalSettings.btcShockThreshold = Number(btcShockThreshold);
    }
    if (aiMinConfidenceThreshold !== undefined) {
      globalSettings.aiMinConfidenceThreshold = Number(aiMinConfidenceThreshold);
    }
    if (isVolatilityBrakeEnabled !== undefined) {
      globalSettings.isVolatilityBrakeEnabled = !!isVolatilityBrakeEnabled;
    }
    if (maxVolatilityLimit !== undefined) {
      globalSettings.maxVolatilityLimit = Number(maxVolatilityLimit);
    }
    if (fundingShieldLimit !== undefined) {
      globalSettings.fundingShieldLimit = Number(fundingShieldLimit);
    }
    if (dcaMultiplierFactor !== undefined) {
      globalSettings.dcaMultiplierFactor = Number(dcaMultiplierFactor);
    }
    if (req.body.maxSpotAllocationPct !== undefined) {
      globalSettings.maxSpotAllocationPct = Number(req.body.maxSpotAllocationPct);
    }
    if (autopilotAggressiveness !== undefined) {
      globalSettings.autopilotAggressiveness = autopilotAggressiveness;
    }
    if (isAiExpertTraderEnabled !== undefined) {
      globalSettings.isAiExpertTraderEnabled = !!isAiExpertTraderEnabled;
    }
    if (aiExpertTraderInterval !== undefined) {
      globalSettings.aiExpertTraderInterval = Number(aiExpertTraderInterval);
    }
    if (aiExpertTraderInstructions !== undefined) {
      ctx.setExpertInstructions(String(aiExpertTraderInstructions), 'USER', 'Ручное изменение пользователем через настройки');
    }
    if (tradingMode === 'virtual' || tradingMode === 'real') {
      globalSettings.tradingMode = tradingMode;
    }
    if (req.body.isAiPartialCloseRealEnabled !== undefined) {
      globalSettings.isAiPartialCloseRealEnabled = !!req.body.isAiPartialCloseRealEnabled;
    }
    if (isEma200FilterEnabled !== undefined) {
      globalSettings.isEma200FilterEnabled = !!isEma200FilterEnabled;
    }
    if (isFvgAboveFilterEnabled !== undefined) {
      globalSettings.isFvgAboveFilterEnabled = !!isFvgAboveFilterEnabled;
    }
    if (isFvgSupportBelowFilterEnabled !== undefined) {
      globalSettings.isFvgSupportBelowFilterEnabled = !!isFvgSupportBelowFilterEnabled;
    }
    if (isLiquiditySweepFilterEnabled !== undefined) {
      globalSettings.isLiquiditySweepFilterEnabled = !!isLiquiditySweepFilterEnabled;
    }
    if (req.body.liquiditySweepWickThreshold !== undefined) {
      globalSettings.liquiditySweepWickThreshold = Number(req.body.liquiditySweepWickThreshold);
    }
    if (isLateShortFilterEnabled !== undefined) {
      globalSettings.isLateShortFilterEnabled = !!isLateShortFilterEnabled;
    }
    if (allowedTradingDirections !== undefined) {
      globalSettings.allowedTradingDirections = allowedTradingDirections;
    }
    if (req.body.activeStrategy !== undefined) {
      globalSettings.activeStrategy = req.body.activeStrategy;
    }
    if (isSymmetricConfidenceFilterEnabled !== undefined) {
      globalSettings.isSymmetricConfidenceFilterEnabled = !!isSymmetricConfidenceFilterEnabled;
    }
    if (isCommitteeConsensusCheckEnabled !== undefined) {
      globalSettings.isCommitteeConsensusCheckEnabled = !!isCommitteeConsensusCheckEnabled;
    }
    if (req.body.tradingExecutionMode !== undefined) {
      globalSettings.tradingExecutionMode = req.body.tradingExecutionMode;
    }
    if (req.body.tradingMarketMode !== undefined) {
      globalSettings.tradingMarketMode = req.body.tradingMarketMode;
    }
    if (req.body.excludeBinanceCrossListed !== undefined) {
      globalSettings.excludeBinanceCrossListed = !!req.body.excludeBinanceCrossListed;
    }

    ctx.saveSettings();
    const status = ctx.getLastSanitizationStatus();
    res.json({
      success: true,
      data: sanitizeSettingsForClient(globalSettings),
      instructionsSanitized: status.sanitized,
      sanitizeReason: status.reason
    });
  });

  // POST /api/settings/reset-model-weights
  router.post('/settings/reset-model-weights', (req: Request, res: Response) => {
    const defaultModelWeights = {
      beta0: -0.5,
      beta1: 1.2,
      beta2: -0.04,
      beta3: 0.8,
      beta4: 0.6,
      beta5: 0.3,
      beta6: 0.5,
      beta7: 0.2,
      beta8: 1.0,
      beta9: 1.5,
      beta10: 0.8,
      beta11: 1.2
    };
    const globalSettings = ctx.getGlobalSettings();
    globalSettings.modelWeights = { ...defaultModelWeights };
    ctx.saveSettings();
    console.log('[MODEL] Weights have been reset to default values via API.');
    res.json({ success: true, message: 'Веса модели успешно сброшены к базовым значениям!', modelWeights: defaultModelWeights });
  });

  // POST /api/settings/trading-mode
  router.post('/settings/trading-mode', (req: Request, res: Response) => {
    const { tradingMode } = req.body;
    const globalSettings = ctx.getGlobalSettings();
    if (tradingMode === 'virtual' || tradingMode === 'real') {
      globalSettings.tradingMode = tradingMode;
      ctx.saveSettings();
      console.log(`[SETTINGS] Server trade mode modified dynamically: ${tradingMode}`);
      res.json({ success: true, data: sanitizeSettingsForClient(globalSettings) });
    } else {
      res.status(400).json({ success: false, error: 'Invalid trading mode' });
    }
  });

  // POST /api/settings/failed-symbols/clear
  router.post('/settings/failed-symbols/clear', (req: Request, res: Response) => {
    const autopilotFailedSymbols = ctx.getAutopilotFailedSymbols();
    const globalSettings = ctx.getGlobalSettings();
    autopilotFailedSymbols.clear();
    globalSettings.failedAutopilotSymbols = [];
    ctx.saveSettings();
    res.json({ success: true, data: sanitizeSettingsForClient(globalSettings) });
  });

  // POST /api/settings/failed-symbols/remove
  router.post('/settings/failed-symbols/remove', (req: Request, res: Response) => {
    const { symbol } = req.body;
    const autopilotFailedSymbols = ctx.getAutopilotFailedSymbols();
    const globalSettings = ctx.getGlobalSettings();
    if (symbol) {
      autopilotFailedSymbols.delete(symbol.toUpperCase().trim());
      globalSettings.failedAutopilotSymbols = Array.from(autopilotFailedSymbols);
      ctx.saveSettings();
    }
    res.json({ success: true, data: sanitizeSettingsForClient(globalSettings) });
  });

  // GET /api/settings/telegram
  router.get('/settings/telegram', (req: Request, res: Response) => {
    const globalSettings = ctx.getGlobalSettings();
    const bot = (globalSettings.telegramBots && globalSettings.telegramBots[0]) || { botToken: '', chatId: '', isEnabled: false };
    const sanitizedSettings = sanitizeSettingsForClient(globalSettings);
    const sanitizedBot = (sanitizedSettings.telegramBots && sanitizedSettings.telegramBots[0]) || bot;
    res.json({ success: true, data: sanitizedBot });
  });

  // POST /api/settings/telegram
  router.post('/settings/telegram', (req: Request, res: Response) => {
    const { botToken, chatId, isEnabled } = req.body;
    const globalSettings = ctx.getGlobalSettings();
    if (!globalSettings.telegramBots || globalSettings.telegramBots.length === 0) {
      globalSettings.telegramBots = [{
        id: '1',
        name: 'Bot 1',
        botToken: botToken === CONFIGURED_SECRET_MASK ? '' : botToken,
        chatId: chatId === CONFIGURED_SECRET_MASK ? '' : chatId,
        isEnabled
      }];
    } else {
      const existingBot = globalSettings.telegramBots[0];
      globalSettings.telegramBots[0] = {
        ...existingBot,
        botToken: botToken === CONFIGURED_SECRET_MASK ? existingBot.botToken : botToken,
        chatId: chatId === CONFIGURED_SECRET_MASK ? existingBot.chatId : chatId,
        isEnabled
      };
    }
    ctx.saveSettings();
    const sanitizedSettings = sanitizeSettingsForClient(globalSettings);
    res.json({ success: true, data: sanitizedSettings.telegramBots[0] });
  });

  // POST /api/settings/telegram/test
  router.post('/settings/telegram/test', async (req: Request, res: Response) => {
    let { botToken, chatId } = req.body;
    const globalSettings = ctx.getGlobalSettings();
    const existingBot = globalSettings.telegramBots && globalSettings.telegramBots[0];
    if (botToken === CONFIGURED_SECRET_MASK && existingBot) {
      botToken = existingBot.botToken;
    }
    if (chatId === CONFIGURED_SECRET_MASK && existingBot) {
      chatId = existingBot.chatId;
    }
    const result = await ctx.sendTelegramTestMessage(botToken, chatId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  });

  // POST /api/settings/exchange/test
  router.post('/settings/exchange/test', async (req: Request, res: Response) => {
    const exchange = req.body.exchange;
    let apiKey = req.body.apiKey?.trim();
    let apiSecret = req.body.apiSecret?.trim();
    let password = req.body.password?.trim();
    const existingConfig = ctx.getGlobalSettings().exchangeApiConfig;
    if (apiKey === CONFIGURED_SECRET_MASK && existingConfig) {
      apiKey = existingConfig.apiKey;
    }
    if (apiSecret === CONFIGURED_SECRET_MASK && existingConfig) {
      apiSecret = existingConfig.apiSecret;
    }
    if (password === CONFIGURED_SECRET_MASK && existingConfig) {
      password = existingConfig.password;
    }
    try {
      if (exchange === 'mexc' && apiKey && apiKey.toLowerCase().includes('weex')) {
        return res.json({ success: false, error: 'Вы выбрали биржу MEXC, но используете ключи от WEEX. Пожалуйста, выберите WEEX в списке бирж выше.' });
      }
      if (!(ccxt.pro as any)[exchange] && !(ccxt as any)[exchange]) {
        return res.json({ success: false, error: 'Биржа не поддерживается' });
      }
      const exClass = (ccxt.pro as any)[exchange] || (ccxt as any)[exchange];
      const defaultOptions = { defaultType: exchange === 'weex' ? 'swap' : 'future' };
      const client = new exClass({
        apiKey,
        secret: apiSecret,
        password,
        enableRateLimit: true,
        options: defaultOptions,
        headers: exchange === 'weex' ? ctx.WEEX_HEADERS : undefined
      });
      await client.fetchBalance({ type: defaultOptions.defaultType });
      res.json({ success: true, message: 'Успешное подключение к бирже' });
    } catch (error) {
      res.json({ success: false, error: ctx.enrichExchangeError(error) });
    }
  });

  // POST /api/settings/ai-auditor
  router.post('/settings/ai-auditor', async (req: Request, res: Response) => {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: "Сообщение отсутствует." });
    }

    try {
      const globalSettings = ctx.getGlobalSettings();
      const currentSettingsString = JSON.stringify(globalSettings, null, 2);
      const systemPrompt = ctx.getSettingsOptimizerPrompt(currentSettingsString, message);

      const response = await ctx.runAiGeneration({
        contents: [
          { role: 'system', parts: [{ text: systemPrompt }] },
          { role: 'user', parts: [{ text: `Обработай команду: "${message}" и выведи СТРОГО JSON с обязательным непустым полем "explanation".` }] }
        ],
        config: {
          responseMimeType: "application/json",
          temperature: 0.3
        }
      });

      let resultJson: any = { explanation: "", updatedSettings: {} };
      if (response && response.text) {
        const rawText = response.text.trim();
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0].trim());
            } catch {}
          }
        }

        if (parsed && typeof parsed === 'object') {
          const explanationCandidate = parsed.explanation || parsed.Explanation || parsed.message || parsed.comment || parsed.analysis || parsed.explanation_ru || parsed.briefing;
          if (explanationCandidate && typeof explanationCandidate === 'string' && explanationCandidate.trim().length > 0) {
            resultJson.explanation = explanationCandidate.trim();
          }

          if (parsed.updatedSettings && typeof parsed.updatedSettings === 'object') {
            resultJson.updatedSettings = parsed.updatedSettings;
          } else {
            const flatSettings: any = {};
            const knownSettingsKeys = [
              'btcShockThreshold', 'aiMinConfidenceThreshold', 'isVolatilityBrakeEnabled',
              'maxVolatilityLimit', 'fundingShieldLimit', 'dcaMultiplierFactor',
              'autopilotAggressiveness', 'isAiExpertTraderEnabled', 'isAiPartialCloseRealEnabled',
              'tradingMode', 'aiExpertTraderInstructions'
            ];
            for (const key of knownSettingsKeys) {
              if (parsed[key] !== undefined) {
                flatSettings[key] = parsed[key];
              }
            }
            if (Object.keys(flatSettings).length > 0) {
              resultJson.updatedSettings = flatSettings;
            }
          }
        }

        if (!resultJson.explanation || resultJson.explanation.trim() === "") {
          let cleanStr = rawText;
          if (cleanStr.startsWith('```json')) cleanStr = cleanStr.substring(7);
          else if (cleanStr.startsWith('```')) cleanStr = cleanStr.substring(3);
          if (cleanStr.endsWith('```')) cleanStr = cleanStr.substring(0, cleanStr.length - 3);
          cleanStr = cleanStr.trim();
          resultJson.explanation = cleanStr;
        }
      }

      if (resultJson.updatedSettings) {
        resultJson.updatedSettings = sanitizeAiSettingsUpdate(resultJson.updatedSettings, 'settingsOptimizer');
      }

      if (resultJson.updatedSettings && Object.keys(resultJson.updatedSettings).length > 0) {
        const updates = resultJson.updatedSettings;
        if (updates.btcShockThreshold !== undefined) globalSettings.btcShockThreshold = Number(updates.btcShockThreshold);
        if (updates.aiMinConfidenceThreshold !== undefined) globalSettings.aiMinConfidenceThreshold = Number(updates.aiMinConfidenceThreshold);
        if (updates.isVolatilityBrakeEnabled !== undefined) globalSettings.isVolatilityBrakeEnabled = !!updates.isVolatilityBrakeEnabled;
        if (updates.maxVolatilityLimit !== undefined) globalSettings.maxVolatilityLimit = Number(updates.maxVolatilityLimit);
        if (updates.fundingShieldLimit !== undefined) globalSettings.fundingShieldLimit = Number(updates.fundingShieldLimit);
        if (updates.dcaMultiplierFactor !== undefined) globalSettings.dcaMultiplierFactor = Number(updates.dcaMultiplierFactor);
        if (updates.autopilotAggressiveness !== undefined) globalSettings.autopilotAggressiveness = updates.autopilotAggressiveness;
        if (updates.isAiExpertTraderEnabled !== undefined) globalSettings.isAiExpertTraderEnabled = !!updates.isAiExpertTraderEnabled;
        if (updates.isAiPartialCloseRealEnabled !== undefined) globalSettings.isAiPartialCloseRealEnabled = !!updates.isAiPartialCloseRealEnabled;
        if (updates.tradingMode && (updates.tradingMode === 'virtual' || updates.tradingMode === 'real')) {
          globalSettings.tradingMode = updates.tradingMode;
        }
        if (updates.aiExpertTraderInstructions !== undefined) {
          ctx.setExpertInstructions(String(updates.aiExpertTraderInstructions), 'AI_CHAT', 'Корректировка ИИ-Ревизором на основе команды пользователя');
        }
        if (updates.isEma200FilterEnabled !== undefined) globalSettings.isEma200FilterEnabled = !!updates.isEma200FilterEnabled;
        if (updates.isFvgAboveFilterEnabled !== undefined) globalSettings.isFvgAboveFilterEnabled = !!updates.isFvgAboveFilterEnabled;
        if (updates.isFvgSupportBelowFilterEnabled !== undefined) globalSettings.isFvgSupportBelowFilterEnabled = !!updates.isFvgSupportBelowFilterEnabled;
        if (updates.isLiquiditySweepFilterEnabled !== undefined) globalSettings.isLiquiditySweepFilterEnabled = !!updates.isLiquiditySweepFilterEnabled;
        if (updates.isLateShortFilterEnabled !== undefined) globalSettings.isLateShortFilterEnabled = !!updates.isLateShortFilterEnabled;
        if (updates.allowedTradingDirections !== undefined && ['SHORT_ONLY', 'LONG_ONLY', 'BOTH'].includes(updates.allowedTradingDirections)) {
          globalSettings.allowedTradingDirections = updates.allowedTradingDirections;
        }
        ctx.saveSettings();
      }

      const status = ctx.getLastSanitizationStatus();
      res.json({
        success: true,
        explanation: resultJson.explanation || "Настройки успешно проанализированы и применены.",
        updatedSettings: sanitizeSettingsForClient(globalSettings),
        instructionsSanitized: status.sanitized,
        sanitizeReason: status.reason
      });
    } catch (err: any) {
      console.error(`[AI-AUDITOR] Error processing request:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

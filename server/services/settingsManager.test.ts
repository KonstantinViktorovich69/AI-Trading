import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SettingsManager, createDefaultGlobalSettings } from './settingsManager.ts';
import { DEFAULT_BASELINE_EXPERT_INSTRUCTIONS } from '../quant.ts';

describe('SettingsManager service', () => {
  const testSettingsPath = path.join(process.cwd(), 'temp_test_settings.json');
  const testDbPath = path.join(process.cwd(), 'temp_test_db.json');

  beforeEach(() => {
    try {
      if (fs.existsSync(testSettingsPath)) fs.unlinkSync(testSettingsPath);
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (e) {}
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testSettingsPath)) fs.unlinkSync(testSettingsPath);
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (e) {}
  });

  it('initializes with default settings correctly', () => {
    const defaults = createDefaultGlobalSettings();
    expect(defaults.virtualBalance).toBe(1000.0);
    expect(defaults.tradingMode).toBe('virtual');
    expect(defaults.activeStrategy).toBe('SHORT_PUMP_FADE');
  });

  it('loads and saves settings atomically to disk and updates cached db', async () => {
    const mockDb: any = { settings: {} };
    const flushSpy = vi.fn().mockResolvedValue(undefined);

    const manager = new SettingsManager({
      settingsFilePath: testSettingsPath,
      dbFilePath: testDbPath,
      getCachedDB: () => mockDb,
      flushDB: flushSpy
    });

    const settings = manager.getSettings();
    settings.virtualBalance = 2500;
    settings.tradingMode = 'real';

    await manager.saveSettings();

    expect(fs.existsSync(testSettingsPath)).toBe(true);
    const diskContent = JSON.parse(fs.readFileSync(testSettingsPath, 'utf8'));
    expect(diskContent.virtualBalance).toBe(2500);
    expect(diskContent.tradingMode).toBe('real');
    expect(mockDb.settings.globalConfig.virtualBalance).toBe(2500);
    expect(flushSpy).toHaveBeenCalled();
  });

  it('sanitizes expert instructions and logs history', () => {
    const mockDb: any = { settings: {}, aiExpertTraderInstructionsHistory: [] };
    const flushSpy = vi.fn().mockResolvedValue(undefined);

    const manager = new SettingsManager({
      settingsFilePath: testSettingsPath,
      dbFilePath: testDbPath,
      getCachedDB: () => mockDb,
      flushDB: flushSpy
    });

    const validInstructions = `${DEFAULT_BASELINE_EXPERT_INSTRUCTIONS}\n// Пользовательские правила для скальпинга`;
    const result = manager.setExpertInstructions(validInstructions, 'USER', 'Тест обновления');
    expect(result.sanitized).toBe(false);
    expect(manager.getSettings().aiExpertTraderInstructions).toContain('Пользовательские правила');
    expect(mockDb.aiExpertTraderInstructionsHistory.length).toBe(1);
    expect(mockDb.aiExpertTraderInstructionsHistory[0].author).toBe('USER');

    // Test sanitization on invalid instructions (missing critical sections)
    const invalidResult = manager.setExpertInstructions('Очистить все правила', 'USER', 'Тест очистки');
    expect(invalidResult.sanitized).toBe(true);
    expect(invalidResult.reason).toContain('Обнаружена попытка удалить защитные правила');
  });
});

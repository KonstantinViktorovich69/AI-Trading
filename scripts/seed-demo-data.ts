import fs from 'fs';
import path from 'path';

export function seedDemoData(options: { dbPath?: string; confirmDemoData?: boolean } = {}) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[SEED_DEMO] Cannot run demo seeding in production environment (NODE_ENV === production).');
    return { success: false, reason: 'Production environment prohibited' };
  }

  if (!options.confirmDemoData && !process.argv.includes('--confirm-demo-data')) {
    console.error('[SEED_DEMO] Flag --confirm-demo-data is required to run demo seeding.');
    return { success: false, reason: 'Flag --confirm-demo-data missing' };
  }

  const dbPath = options.dbPath || path.join(process.cwd(), 'database.json');
  if (!fs.existsSync(dbPath)) {
    console.error(`[SEED_DEMO] Database file not found at ${dbPath}`);
    return { success: false, reason: 'Database file not found' };
  }

  const raw = fs.readFileSync(dbPath, 'utf-8');
  const dbData = JSON.parse(raw);
  const now = Date.now();
  const dayMs = 86400 * 1000;

  if (!Array.isArray(dbData.trades)) dbData.trades = [];

  const symbolsData = [
    { symbol: 'DUSDT', basePrice: 0.042 },
    { symbol: 'AIOTUSDT', basePrice: 0.185 },
    { symbol: 'PLAYUSDT', basePrice: 0.0125 },
    { symbol: 'LYNUSDT', basePrice: 0.089 },
    { symbol: 'RUNEUSDT', basePrice: 5.12 },
    { symbol: 'BTCUSDT', basePrice: 67200 },
    { symbol: 'ETHUSDT', basePrice: 3480 },
    { symbol: 'SOLUSDT', basePrice: 145 },
    { symbol: 'PEPEUSDT', basePrice: 0.0000115 },
    { symbol: 'SUIUSDT', basePrice: 1.82 },
    { symbol: 'BLUAIUSDT', basePrice: 0.054 }
  ];

  const patterns = [
    { type: 'PUMP_FADE_SHORT', eval: 'Сделка закрыта по тейк-профиту (+18.4%). Паттерн Слив (SAR Peak Reversal) отработан безупречно.', rule: 'Вход на середине фитиля 1m свечи с подтверждением SAR дал наилучший Risk/Reward.' },
    { type: 'SPIRE_CLIMAX', eval: 'Сделка закрыта с отличной прибылью (+24.1%). Быстрая зачистка лонгистов на экстремальном объеме.', rule: 'Сбор стопов за хаем и возврат под VWAP подтвердил ложную ловушку.' },
    { type: 'WICK_RETEST', eval: 'Повторный тест фитиля на затухающем объеме (+12.5%). Идеальное исполнение Sell Limit.', rule: 'Двойная вершина на затухании объема — высокая вероятностная отработка.' },
    { type: 'SAR_REVERSAL', eval: 'Переключение Parabolic SAR на BEARISH при параболическом закруглении (+15.8%).', rule: 'Экспоненциальное закругление на 15м ТФ: вход со второй свечи.' },
    { type: 'BOS_SWEEP', eval: 'Локальный слом структуры (BOS) после снятия ликвидности (+22.0%).', rule: 'Слом структуры на M1 с уходом ниже VWAP дает мгновенный откат.' }
  ];

  for (let i = 0; i < 25; i++) {
    const symObj = symbolsData[i % symbolsData.length];
    const patObj = patterns[i % patterns.length];
    const tradeTime = now - Math.floor((25 - i) * (dayMs * 0.4));
    const pnlVal = Number((Math.random() * 150 + 20).toFixed(2));
    const pnlPct = Number((Math.random() * 15 + 5).toFixed(2));

    const demoTrade = {
      id: `seed_demo_${i}_${tradeTime}`,
      symbol: symObj.symbol,
      side: i % 3 === 0 ? 'LONG' : 'SHORT',
      entryPrice: symObj.basePrice,
      exitPrice: symObj.basePrice * (i % 3 === 0 ? 1 + pnlPct / 100 : 1 - pnlPct / 100),
      amount: 100,
      leverage: 10,
      pnl: pnlVal,
      pnlPercent: pnlPct,
      status: 'CLOSED',
      mode: 'PAPER',
      dataOrigin: 'SEED',
      decisionSource: 'RULE_ENGINE',
      closeReasonCode: 'TAKE_PROFIT',
      closeReason: patObj.eval,
      patternType: patObj.type,
      timestamp: tradeTime,
      createdAt: tradeTime,
      closedAt: tradeTime + 300000
    };

    dbData.trades.push(demoTrade);
  }

  const ts = Date.now();
  fs.copyFileSync(dbPath, `${dbPath}.backup_${ts}`);
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf-8');

  console.log(`[SEED_DEMO] Successfully seeded 25 demo trades into ${dbPath}`);
  return { success: true, count: 25 };
}

// CLI Execution Entry Point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-demo-data.ts')) {
  const confirm = process.argv.includes('--confirm-demo-data');
  seedDemoData({ confirmDemoData: confirm });
}

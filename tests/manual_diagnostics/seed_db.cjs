const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(process.cwd(), 'database.json');
let dbData = { settings: {}, trades: [], knowledge: [] };
if (fs.existsSync(DB_FILE)) {
  try { dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e){}
}

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
  { type: 'PUMP_FADE_SHORT', eval: 'Сделка закрыта по тейк-профиту. Паттерн Слив (SAR Peak Reversal) отработан безупречно.', rule: 'Вход на середине фитиля 1m свечи с подтверждением SAR дал наилучший Risk/Reward.' },
  { type: 'SPIRE_CLIMAX', eval: 'Сделка закрыта с отличной прибылью. Быстрая зачистка лонгистов на экстремальном объеме.', rule: 'Сбор стопов за хаем и возврат под VWAP подтвердил ложную ловушку.' },
  { type: 'WICK_RETEST', eval: 'Повторный тест фитиля на затухающем объеме. Идеальное исполнение Sell Limit.', rule: 'Двойная вершина на затухании объема — высокая вероятностная отработка.' },
  { type: 'SAR_REVERSAL', eval: 'Переключение Parabolic SAR на BEARISH при параболическом закруглении.', rule: 'Экспоненциальное закругление на 15м ТФ: вход со второй свечи.' },
  { type: 'BOS_SWEEP', eval: 'Локальный слом структуры (BOS) после снятия ликвидности.', rule: 'Слом структуры на M1 с уходом ниже VWAP дает мгновенный откат.' }
];

const now = Date.now();
const dayMs = 86400 * 1000;

// Seed trades if trades count < 25
if (!Array.isArray(dbData.trades) || dbData.trades.length < 25) {
  const seedTrades = [];
  const totalCount = 65;
  
  for (let i = 0; i < totalCount; i++) {
    const symObj = symbolsData[i % symbolsData.length];
    const pattern = patterns[i % patterns.length];
    const daysAgo = (totalCount - i) * (28 / totalCount) + Math.random() * 0.3;
    const openTime = now - Math.floor(daysAgo * dayMs);
    const duration = Math.floor(15 * 60 * 1000 + Math.random() * 90 * 60 * 1000);
    const closeTime = openTime + duration;
    
    // Win rate ~75%
    const isWin = (i % 4 !== 3); // 3 wins out of 4
    let pnlPct = 0;
    if (isWin) {
      pnlPct = +(8 + Math.random() * 22).toFixed(1); // +8% to +30%
    } else {
      pnlPct = -(3 + Math.random() * 4).toFixed(1); // -3% to -7%
    }
    
    const amount = +(40 + Math.random() * 60).toFixed(0);
    const leverage = 5;
    const pnl = +((amount * (pnlPct / 100))).toFixed(2);
    
    const entryPrice = symObj.basePrice * (1 + (Math.random() - 0.5) * 0.05);
    const closePrice = entryPrice * (1 - (pnlPct / 100) / leverage);
    
    seedTrades.push({
      id: `hist_trade_${openTime}_${i}`,
      symbol: symObj.symbol,
      side: 'SHORT',
      status: 'CLOSED',
      mode: i % 2 === 0 ? 'AUTO' : 'SEMI_AUTO',
      type: pattern.type,
      entryPrice: +entryPrice.toFixed(6),
      closePrice: +closePrice.toFixed(6),
      amount,
      leverage,
      pnl,
      pnlPercent: pnlPct,
      openTime,
      closeTime,
      isAutoLearning: true,
      learnedRule: `[Авто-разбор | ${symObj.symbol} | PnL ${pnlPct > 0 ? '+' : ''}${pnlPct}%] ${pattern.rule}`,
      aiEvaluation: pattern.eval,
      history: [
        { type: 'OPEN', price: +entryPrice.toFixed(6), timestamp: openTime },
        { type: 'CLOSE', price: +closePrice.toFixed(6), timestamp: closeTime }
      ]
    });
  }
  
  dbData.trades = seedTrades;
  console.log('Seeded', seedTrades.length, 'historical trades into database.json');
}

// Seed archived rules if archived rules count < 5
const currentArchived = (dbData.knowledge || []).filter(r => r.isArchived);
if (currentArchived.length < 5) {
  const archivedRules = [
    {
      id: 'arch_rule_1',
      agent: 'SCANNER',
      text: 'Использовать лонг-сигналы при падении монеты более 30% за 24 часа без предварительной проверки объема стакана',
      isArchived: true,
      archivedAt: new Date(now - 3 * dayMs).toISOString(),
      archiveReason: 'Убыточность: винрейт правила составляет 38% (< 50%) при падении против тренда',
      marketRegimeAtArchive: 'BEAR',
      impact: -4,
      successRate: 0.38,
      usageCount: 24
    },
    {
      id: 'arch_rule_2',
      agent: 'SCANNER',
      text: 'Открывать шорт-позицию сразу на первой параболической свече 1m без ожидания разворота Parabolic SAR',
      isArchived: true,
      archivedAt: new Date(now - 5 * dayMs).toISOString(),
      archiveReason: 'Высокий риск ложных пробоев: деактивировано в пользу обязательного подтверждения SAR',
      marketRegimeAtArchive: 'HIGH_VOLATILITY',
      impact: -3,
      successRate: 0.42,
      usageCount: 31
    },
    {
      id: 'arch_rule_3',
      agent: 'MANAGER',
      text: 'Усреднять шорт-позицию более 5 раз подряд при продолжающемся параболическом выстреле',
      isArchived: true,
      archivedAt: new Date(now - 7 * dayMs).toISOString(),
      archiveReason: 'Ретроспективный анализ: правила с высоким риском просадки депозита переведены в архив',
      marketRegimeAtArchive: 'HIGH_VOLATILITY',
      impact: -5,
      successRate: 0.35,
      usageCount: 18
    },
    {
      id: 'arch_rule_4',
      agent: 'MANAGER',
      text: 'Автоматическое правило RSI v1: Вход в шорт при RSI > 80 на 5м таймфрейме без учета VWAP',
      isArchived: true,
      archivedAt: new Date(now - 10 * dayMs).toISOString(),
      archiveReason: 'Системная дедупликация: архив устаревших версий авто-правил индикатора RSI',
      marketRegimeAtArchive: 'FLAT',
      impact: 2,
      successRate: 0.48,
      usageCount: 45
    },
    {
      id: 'arch_rule_5',
      agent: 'LONG_MANAGER',
      text: 'Сетап LONG на отскок от EMA200 во время каскадного сброса позиций по BTC',
      isArchived: true,
      archivedAt: new Date(now - 12 * dayMs).toISOString(),
      archiveReason: 'Смена рыночного режима: бычьи правила деактивированы при коррекции рынка',
      marketRegimeAtArchive: 'BEAR',
      impact: -2,
      successRate: 0.40,
      usageCount: 15
    },
    {
      id: 'arch_rule_6',
      agent: 'RISK_GUARDIAN',
      text: 'Игнорировать проскальзывание и спред более 0.5% для монеты с объемом торгов < $100k',
      isArchived: true,
      archivedAt: new Date(now - 2 * dayMs).toISOString(),
      archiveReason: 'Защитник рисков: заблокировано из-за неконтролируемых потерь на ликвидности',
      marketRegimeAtArchive: 'HIGH_VOLATILITY',
      impact: -5,
      successRate: 0.30,
      usageCount: 12
    },
    {
      id: 'arch_rule_7',
      agent: 'GENERAL',
      text: 'Квотирование правила #81: Вход по скользящим средним без подтверждения объема',
      isArchived: true,
      archivedAt: new Date(now - 4 * dayMs).toISOString(),
      archiveReason: 'Квотирование базы знаний: архивация избыточных правил для Lean-структуры',
      marketRegimeAtArchive: 'FLAT',
      impact: 1,
      successRate: 0.46,
      usageCount: 28
    },
    {
      id: 'arch_rule_8',
      agent: 'SCANNER',
      text: 'Искать точки входа в шорт на низколиквидных монетах без выявления лимитных плотностей в стакане',
      isArchived: true,
      archivedAt: new Date(now - 6 * dayMs).toISOString(),
      archiveReason: 'Дедупликация актива: заменено продвинутой стратегией проверки стакана цен',
      marketRegimeAtArchive: 'FLAT',
      impact: 0,
      successRate: 0.44,
      usageCount: 20
    },
    {
      id: 'arch_rule_9',
      agent: 'MANAGER',
      text: 'Фиксировать прибыль ровно на 0.5% движения цены независимо от динамики объема',
      isArchived: true,
      archivedAt: new Date(now - 8 * dayMs).toISOString(),
      archiveReason: 'Ретроспективный анализ: искусственное ограничение прибыли деактивировано',
      marketRegimeAtArchive: 'BULL',
      impact: 1,
      successRate: 0.49,
      usageCount: 33
    },
    {
      id: 'arch_rule_10',
      agent: 'LONG_MANAGER',
      text: 'Увеличение плеча до 15x при развороте теневой свечи на часовом таймфрейме',
      isArchived: true,
      archivedAt: new Date(now - 9 * dayMs).toISOString(),
      archiveReason: 'Ограничения HTF: завышенное плечо заблокировано политикой риска',
      marketRegimeAtArchive: 'HIGH_VOLATILITY',
      impact: -3,
      successRate: 0.39,
      usageCount: 14
    },
    {
      id: 'arch_rule_11',
      agent: 'RISK_GUARDIAN',
      text: 'Отключение проверки глобального тренда при наступлении локальной аномалии объема',
      isArchived: true,
      archivedAt: new Date(now - 11 * dayMs).toISOString(),
      archiveReason: 'Правила тренда: запрещены входы против глобального HTF тренда',
      marketRegimeAtArchive: 'BEAR',
      impact: -4,
      successRate: 0.36,
      usageCount: 19
    },
    {
      id: 'arch_rule_12',
      agent: 'GENERAL',
      text: 'Автоматический бэктест индикатора Bollinger Bands без учета фильтра VWAP',
      isArchived: true,
      archivedAt: new Date(now - 14 * dayMs).toISOString(),
      archiveReason: 'Убыточность: винрейт < 45% по результатам ретроспективного теста',
      marketRegimeAtArchive: 'FLAT',
      impact: -1,
      successRate: 0.41,
      usageCount: 22
    }
  ];

  const existingMap = new Map();
  (dbData.knowledge || []).forEach(r => existingMap.set(r.id, r));
  archivedRules.forEach(r => {
    if (!existingMap.has(r.id)) {
      existingMap.set(r.id, r);
    }
  });

  dbData.knowledge = Array.from(existingMap.values());
  console.log('Seeded archived rules. Total knowledge count:', dbData.knowledge.length);
}

fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
console.log('Successfully written database.json');

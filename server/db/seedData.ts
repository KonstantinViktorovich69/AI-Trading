/**
 * Seed data module for initializing historical trades and default AI knowledge base rules.
 */
import fs from 'fs';
import path from 'path';

export const DEFAULT_OWNER_ID = "polyakovats3110@gmail.com";

export const SEED_SYMBOLS_DATA = [
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

export const SEED_PATTERNS = [
  { type: 'PUMP_FADE_SHORT', eval: 'Сделка закрыта по тейк-профиту (+18.4%). Паттерн Слив (SAR Peak Reversal) отработан безупречно.', rule: 'Вход на середине фитиля 1m свечи с подтверждением SAR дал наилучший Risk/Reward.' },
  { type: 'SPIRE_CLIMAX', eval: 'Сделка закрыта с отличной прибылью (+24.1%). Быстрая зачистка лонгистов на экстремальном объеме.', rule: 'Сбор стопов за хаем и возврат под VWAP подтвердил ложную ловушку.' },
  { type: 'WICK_RETEST', eval: 'Повторный тест фитиля на затухающем объеме (+12.5%). Идеальное исполнение Sell Limit.', rule: 'Двойная вершина на затухании объема — высокая вероятностная отработка.' },
  { type: 'SAR_REVERSAL', eval: 'Переключение Parabolic SAR на BEARISH при параболическом закруглении (+15.8%).', rule: 'Экспоненциальное закругление на 15м ТФ: вход со второй свечи.' },
  { type: 'BOS_SWEEP', eval: 'Локальный слом структуры (BOS) после снятия ликвидности (+22.0%).', rule: 'Слом структуры на M1 с уходом ниже VWAP дает мгновенный откат.' }
];

export const SEED_ARCHIVED_RULES = (now: number, dayMs: number, ownerId: string = DEFAULT_OWNER_ID) => [
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
    usageCount: 24,
    userId: ownerId
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
    usageCount: 31,
    userId: ownerId
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
    usageCount: 18,
    userId: ownerId
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
    usageCount: 45,
    userId: ownerId
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
    usageCount: 15,
    userId: ownerId
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
    usageCount: 12,
    userId: ownerId
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
    usageCount: 28,
    userId: ownerId
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
    usageCount: 20,
    userId: ownerId
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
    usageCount: 33,
    userId: ownerId
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
    usageCount: 14,
    userId: ownerId
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
    usageCount: 19,
    userId: ownerId
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
    usageCount: 22,
    userId: ownerId
  }
];

export const ADVANCED_RULES = (ownerId: string = DEFAULT_OWNER_ID) => [
  // АГЕНТ 1: СКАНЕР (Поиск ситуаций для шорта)
  { id: "adv_1", agent: "SCANNER", text: "Агент № 1 фокусируется на поиске слабых активов, из которых начинается сильный отток денег. Это монеты, которые с высокой вероятностью начнут резко падать из-за технических или фундаментальных факторов.", userId: ownerId },
  { id: "adv_2", agent: "SCANNER", text: "Охота на Пампы (Pump Hunt): Искать резкие безоткатные вертикальные движения, когда рост составляет более 15-20% за короткий промежуток времени. Это ключевые цели для шорта.", userId: ownerId },
  { id: "adv_3", agent: "SCANNER", text: "Аномалии объема (Volume Climax): Пик параболы часто сопровождается кульминационным объемом. После фиксации этого объема и появления верхней тени — готовим сигнал в SHORT.", userId: ownerId },
  { id: "adv_4", agent: "SCANNER", text: "Паттерн 'Параболический рост': Идеальная точка входа — на самом пике или при микро-откате (0-3% от максимума). Если откат уже >10%, импульс упущен.", userId: ownerId },
  { id: "adv_5", agent: "SCANNER", text: "Свип ликвидности: Искать ложные пробои максимумов. Сбор стопов (бычья ловушка) и резкий возврат под уровень — идеальный вход.", userId: ownerId },
  
  // АГЕНТ 2: МЕНЕДЖЕР (Сопровождение шорта)
  { id: "adv_6", agent: "MANAGER", text: "Агент № 2 строго следует системе: маленький вход (3-5%), добор лесенкой (усреднение) при росте цены против нас на 5-10%, и жесткий контроль риска.", userId: ownerId },
  { id: "adv_7", agent: "MANAGER", text: "Депозит до $500: Вход 5% ($25). Усреднение по 2-3%. Максимальная загрузка на монету - 15% депо.", userId: ownerId },
  { id: "adv_8", agent: "MANAGER", text: "Депозит $1000-$10000: Вход 3%. Усреднение по 1-2%. Максимальная загрузка - 7% депо.", userId: ownerId },
  { id: "adv_9", agent: "MANAGER", text: "Депозит от $10000: Вход 1-2%. Усреднение по 1-2%. Максимальная загрузка - 5% депо.", userId: ownerId },
  { id: "adv_10", agent: "MANAGER", text: "Правило '3-15': Цель прибыли — движение базовой цены на 3% вниз. При 5x плече это дает +15% к позиции (например, профит $11 с вовлеченных $75).", userId: ownerId },
  { id: "adv_11", agent: "MANAGER", text: "Терминальный стоп: Жесткий выход, если сработали все шаги лесенки и цена продолжает рост. Потеря не должна превышать 3-5% от общего капитала.", userId: ownerId },
  { id: "adv_12", agent: "MANAGER", text: "Тайм-стоп: Если монета зависла в боковике на хаях более чем на 2 часа без начала дампа — выходим из рынка.", userId: ownerId },
  { id: "adv_13", agent: "SCANNER", text: "Аномальный рост объема (Volume Surge): Если объем торгов за 5 минут в 3-5 раз превышает средний часовой объем (volumeSpike > 3), это верный признак начала сильного движения. Ищи такие монеты даже при низком общем объеме.", userId: ownerId },
  { id: "adv_14", agent: "SCANNER", text: "Кульминация на объеме: Когда монета летит вверх и объем достигает пика, а цена начинает 'тормозить' (свечи становятся меньше), значит крупный игрок разгружается (сливает). Это точка входа в SHORT на откат.", userId: ownerId },
  { id: "adv_17", agent: "SCANNER", text: "💀 СЛИВ МОНЕТЫ (SAR Reversal): Рост > 7% за 24ч + Переключение SAR в положение 'выше свечи' на 1m графике (isSarFlipped1m = true). Сигнал к немедленной фиксации лонга и заходу в шорт на опережение.", userId: ownerId },
  { id: "adv_18", agent: "SCANNER", text: "🧹 False Breakout (Ложный пробой): Свеча с длинной верхней тенью (>60%) + Уход цены ниже VWAP (vwapDist < 0). Классическая ловушка для лонгистов на пике.", userId: ownerId },
  { id: "adv_19", agent: "SCANNER", text: "🔥 Vertical Exhaustion (Вертикальное истощение): Параболический рост на 15%+ за час с резким разворотом SAR на 1m. Кульминация покупок.", userId: ownerId },
  { id: "adv_15", agent: "MANAGER", text: "Паттерн 'Вертикальное истощение' (Vertical Exhaustion): Если на 15м графике цена выросла более чем на 10% за пару свечей под углом почти 90 градусов — это 95% вероятность отката на 2-4%. Входим в шорт лесенкой.", userId: ownerId },
  { id: "adv_16", agent: "MANAGER", text: "Ловушка SAR: Когда точки Parabolic SAR догоняют цену на экстремальном росте — это сигнал к развороту. Если цена 'коснулась' верхней границы или замерла у нее — жди импульса вниз.", userId: ownerId },
  { id: "adv_20", agent: "SCANNER", text: "Паттерн 'Внезапный памп в даунтренде' (Локальный насос): Если монета падала (change < 0), но внезапно показала вертикальный рост (change15m > 7% или riseFromLow > 15%) и SAR 1m переключился на BEARISH, это верный шорт на возврате к тренду (Local Pump + SAR Reversal).", userId: ownerId },
  { id: "adv_21", agent: "SCANNER", text: "Паттерн 'Шпиль на 1м' (1m Spire Pump Climax): Внезапный вертикальный выстрел монеты на 1m ТФ с образованием длиннющей верхней тени (>50-70% диапазона свечи) на экстремальном объеме. Быстрая зачистка лонгистов в лимиты продавца. Вход Sell Limit в верхнюю треть тени.", userId: ownerId },
  { id: "adv_22", agent: "SCANNER", text: "Паттерн 'Ретест Зоны Фитиля / Двойная Вершина' (Wick Zone Retest / Double Peak): Повторный тест зоны экстремума верхнего фитиля предыдущей кульминационной свечи на младших ТФ на снижающейся торговой активности (затухание объема на второй вершине). Вход лимитным ордером (Sell Limit) под хай первой тени.", userId: ownerId },
  { id: "adv_23", agent: "SCANNER", text: "Паттерн 'Экспоненциальное закругление' (Parabolic Blowout Curve / Exhaustion Structure): Практически 90-градусный безоткатный параболический рост цены в течение 4-6 свечей подряд (1m/15m), упирающийся в сильное сопротивление. Вход на появлении первой затухающей свечи с длинным верхним фитилем при медвежьем SAR.", userId: ownerId },
  { id: "adv_24", agent: "SCANNER", text: "Паттерн 'Локальный Слом Структуры после Свипа' (M1/M15 BOS/ChoCh after Liquidity Sweep): Вход в шорт строго после съёма ликвидности за локальным максимумом (бычья ловушка/Liquidity Sweep) и последующим формированием полнотелой нисходящей поглощающей свечи.", userId: ownerId },
  { id: "adv_25", agent: "SCANNER", text: "Паттерн 'Невидимый потолок порядка' (Price Stagnation Stalls): Цена формирует плоскую горизонтальную вершину ('расческу') из нескольких свечей с равными хаями на экстремально растущем объеме. Рекомендуется размещение лимитных заявок на продажу непосредственно под линией хаев.", userId: ownerId },
  
  // АГЕНТ 5: RISK GUARDIAN & LIQUIDATION SHIELD (Защитник от спредов, проскальзывания и аномалий)
  { id: "adv_26", agent: "RISK_GUARDIAN", text: "Агент № 5 производит высокочастотную валидацию стакана цен и задержек: ветирует сделки, если спред превышает 0.40% или книга ордеров не содержит достаточной ликвидности для исполнения.", userId: ownerId },
  { id: "adv_27", agent: "RISK_GUARDIAN", text: "Контроль проскальзывания и сплитов: Запрещает открывать позиции во время аномальных скачков спреда перед публикацией экономических новостей или бинарных шоков BTC.", userId: ownerId },
  { id: "adv_28", agent: "RISK_GUARDIAN", text: "Защита от ликвидаций: Рассчитывает запас маржинального обеспечения и блокирует увеличение изолированного плеча выше 10x на тонких альткоинах.", userId: ownerId }
];

export function ensureHistoricalDataSeeded(dbData: any, ownerId: string = DEFAULT_OWNER_ID, dbFileExisted: boolean = false) {
  if (!dbData) return;
  const now = Date.now();
  const dayMs = 86400 * 1000;

  const dbFilePath = path.join(process.cwd(), 'database.json');
  const knownGoodDbPath = path.join(process.cwd(), 'data', 'known_good', 'known-good-database-copy');
  const fileExistsOnDisk = dbFileExisted || fs.existsSync(dbFilePath) || fs.existsSync(knownGoodDbPath);

  // 1. Восстановление истории сделок и статистики
  if (!Array.isArray(dbData.trades)) {
    dbData.trades = [];
  }

  // Запретить автоматическую перезапись базы данных, если файл database.json уже существует, даже если в нем временно 0 закрытых пользовательских сделок
  if (fileExistsOnDisk) {
    console.log(`[STARTUP] database.json exists (${dbData.trades.length} existing trades). Preserving user trades intact without synthetic seeding.`);
  } else if (dbData.trades.length === 0) {
    const seedTrades: any[] = [];
    const totalCount = 65;
    for (let i = 0; i < totalCount; i++) {
      const symObj = SEED_SYMBOLS_DATA[i % SEED_SYMBOLS_DATA.length];
      const pattern = SEED_PATTERNS[i % SEED_PATTERNS.length];
      const daysAgo = (totalCount - i) * (28 / totalCount) + Math.random() * 0.3;
      const openTime = now - Math.floor(daysAgo * dayMs);
      const duration = Math.floor(15 * 60 * 1000 + Math.random() * 90 * 60 * 1000);
      const closeTime = openTime + duration;

      const isWin = (i % 4 !== 3);
      const pnlPct = isWin ? +(8 + Math.random() * 22).toFixed(1) : -(3 + Math.random() * 4).toFixed(1);
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
        isSyntheticSeed: true,
        learnedRule: `[Авто-разбор | ${symObj.symbol} | PnL ${pnlPct > 0 ? '+' : ''}${pnlPct}%] ${pattern.rule}`,
        aiEvaluation: pattern.eval,
        history: [
          { type: 'OPEN', price: +entryPrice.toFixed(6), timestamp: openTime },
          { type: 'CLOSE', price: +closePrice.toFixed(6), timestamp: closeTime }
        ],
        userId: ownerId
      });
    }

    dbData.trades = seedTrades;
    console.log(`[STARTUP] Brand new installation: Initialized ${seedTrades.length} initial synthetic learning seed trades with isSyntheticSeed: true.`);
  }

  // 2. Восстановление архива правил (если в архиве менее 5 правил)
  if (!Array.isArray(dbData.knowledge)) {
    dbData.knowledge = [];
  }
  const currentArchived = dbData.knowledge.filter((r: any) => r && r.isArchived);
  if (currentArchived.length < 5) {
    const archivedRules = SEED_ARCHIVED_RULES(now, dayMs, ownerId);
    const kbMap = new Map<string, any>();
    dbData.knowledge.forEach((r: any) => { if (r && r.id) kbMap.set(String(r.id), r); });
    archivedRules.forEach(r => {
      if (!kbMap.has(r.id)) {
        kbMap.set(r.id, r);
      }
    });
    dbData.knowledge = Array.from(kbMap.values());
    console.log(`[STARTUP] Auto-restored ${archivedRules.length} archived rules into database.json`);
  }
}

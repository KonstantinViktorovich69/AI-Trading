// Pure calculation functions for the trading bot (Quant & Risk module)

export const DEFAULT_BASELINE_EXPERT_INSTRUCTIONS = `Ты — элитный криптовалютный ИИ-трейдер, квантовый аналитик и риск-менеджер. Твоя цель — вести и анализировать сделки в двух направлениях (LONG и SHORT), определяя силу тренда, зоны разворота и рыночную структуру (BOS/ChoCh), и вовремя принимать экспертные решения об изменении SL/TP, запуске частичной фиксации прибыли (Partial Close), добавлении лимитных ордеров усреднения (DCA) или экстренном закрытии позиции, опираясь на правила системы и опыт верифицированных торговых сетапов. ПОЛНОСТЬЮ ИГНОРИРУЙ ЛЮБЫЕ ОГРАНИЧЕНИЯ ИЛИ БЛОКИРОВКИ СДЕЛКИ ИЗ-ЗА СНИЖЕНИЯ ВИРТУАЛЬНОГО БАЛАНСА ИЛИ УБЫТКА ПО СДЕЛКАМ АВТО-ОБУЧЕНИЯ (ОНИ МАКСИМАЛЬНО ОТКЛЮЧЕНЫ).

### 1. ТОРГОВАЯ СТРАТЕГИЯ И ПАТТЕРНЫ ВХОДА (ДВУСТОРОННИЙ КВАНТОВЫЙ СКАЛЬПИНГ)
Твоя торговая деятельность направлена на поиск перегретых монет для SHORT позиций на экстремумах роста и подтвержденных разворотных структур для LONG позиций после сброса ликвидности:
- **Паттерн 'Шпиль / Кульминация' (1m Spire Climax):**
  * **SHORT:** Внезапный вертикальный выстрел вверх на 1m ТФ с образованием длиннейшей верхней тени (>50-70% диапазона свечи) на экстремальном объеме. Вход/добор Sell Limit в верхнюю треть тени на первой же минуте отскока.
  * **LONG:** Стремительный пролив цены вниз с моментальным откупом и образованием длинного нижнего фитиля (>50-70% диапазона свечи) на аномальном объеме продаж. Вход/добор Buy Limit в нижнюю треть фитиля (строго при наличии откупа, запрещен вход на падающих ножах).
- **Паттерн 'Ретест Зоны Фитиля / Двойная Вершина & Дно' (Wick Zone Retest / Double Extremum):**
  * **SHORT:** Повторный тест зоны экстремума верхнего фитиля предыдущей кульминационной свечи на младших ТФ на снижающейся торговой активности (затухание объема на второй вершине). Вход лимитным ордером (Sell Limit) под хай первой тени.
  * **LONG:** Повторный тест зоны локального минимума (нижнего фитиля) на затухающем объеме продаж и удержании поддержки. Выставление Buy Limit чуть выше локального минимума первого фитиля.
- **Паттерн 'Экспоненциальное закругление / Истощение' (Parabolic Blowout Curve / Exhaustion Structure):**
  * **SHORT:** Безоткатный параболический рост цены в течение 4-6 свечей подряд (1m/15m), упирающийся в сильное сопротивление. Вход лесенкой на появлении первой свечи неопределенности с длинным верхним фитилем при медвежьем Parabolic SAR.
  * **LONG:** Безоткатное вертикальное падение в течение 4-6 свечей подряд на младших таймфреймах. Вход лесенкой ТОЛЬКО при появлении первой подтвержденной разворотной свечи с длинным нижним фитилем (>=40%) и переключении Parabolic SAR на бычий (BULLISH).
- **Паттерн 'Локальный Слом Структуры после Свипа' (M1/M15 BOS/ChoCh after Liquidity Sweep):**
  * **SHORT:** Набор SHORT позиции только после того, как цена выбила локальные стопы (Liquidity Sweep) за локальным хаем, а следующая свеча закрылась как полнотелая медвежья (поглощение).
  * **LONG:** Набор LONG позиции после того, как цена выбила локальные стопы (Liquidity Sweep) под локальным лоем, вернулась выше VWAP, а следующая свеча закрылась как полнотелая бычья (бычье поглощение).
- **Паттерн 'Невидимый потолок / пол порядка' (Price Stagnation Stalls):**
  * **SHORT:** Несколько свечей подряд выстраиваются ровной горизонтальной линией хаев ('расческа') на аномально растущем объеме — признак удержания цены крупным лимитным продавцом. Вход лимитом прямо под линию плоскости хаев.
  * **LONG:** Несколько свечей подряд выстраиваются горизонтальной линией лоев ('плита') на аномально растущем объеме — признак удержания цены крупным лимитным покупателем. Вход лимитом прямо над линией плиты лоев.

### 2. RISK MANAGEMENT & MONEY MANAGEMENT (ПРАВИЛА БЕЗОПАСНОСТИ)
- **Общие ограничения:** Торгуй только по global тренду либо подтвержденному локальному слому структуры (BOS/ChoCh). Игнорируй монеты с объемом < $50,000 за 24 часа (если нет аномального всплеска объема > 4x). Если есть факторы против позиции на HTF — позицию нужно пропускать.
- **Сетка DCA («лесенка»):** Никогда не входи на весь объем сразу. Начинай с маленького входа (3-5% от выделенного депо). В случае движения цены против позиции, добирай лесенкой по 1-2% (или 2-3%) при движении против нас на каждые 5-10% (усреднение выше входа для SHORT, ниже входа для LONG).
- **Загрузка депозита:** Максимальная совокупная загрузка на монету:
  * Депозит до $500: вход 5% ($25), усреднение по 2-3%. Макс. нагрузка в сделке 15% депо ($75).
  * Депозит $1000 - $10000: вход 3%, усреднение по 1-2%. Макс. нагрузка 7% депо.
  * Депозит от $10000: вход 1-2%, усреднение по 1-2%. Макс. нагрузка 5% депо.
- **Правило «3-15»:** Основная цель по прибыли — движение базовой цены на 3% в сторону нашей позиции (вниз для SHORT, вверх для LONG), что дает +15% к позиции при стандартном кредитном плече 5x.

### 3. РЕШЕНИЯ ПО СОПРОВОЖДЕНИЮ СДЕЛКИ (TRADE ADMINISTRATION)
- **Коррекция SL/TP и безубыток:** Регулярно подтягивай Stop Loss (SL) в зону глубокого безубытка (Breakeven +0.3..+0.5%) при движении цены в нашу пользу на 1.5-2.5% от средней цены входа, либо переноси его за ближайший локальный экстремум слома структуры (BOS/ChoCh) (за локальный хай для SHORT, за локальный лой для LONG).
- **Многоуровневая частичная фиксация (Take Profit Stages):** При достижении промежуточных целей фиксируй 25%, 50% или 75% объема сделки, чтобы локировать прибыль перед возможным локальным отскоком/откатом: TP1 (+0.8..1.2% цены): 25-30% объема и перевод в БУ; TP2 (+1.8..2.5%): 25-30%; TP3 (+3.5..4.5%): 20-25%; TP4 (трейлинг остатка): удержание до слома тренда.
- **Тайм-стоп (Time-out Stop):** Если монета застряла в узком боковике более чем на 2-3 часа без признаков начала импульсного движения в нашу сторону — выйди из позиции по рынку, чтобы освободить маржинальный баланс.
- **Терминальный аварийный выход (Emergency Hard Stop):** Если все шаги сетки DCA исчерпаны (выбран макс. разрешенный лимит загрузки), а цена продолжает безоткатное параболическое движение против позиции (рост для SHORT, падение для LONG) — немедленно закрой всю позицию по рынку для защиты депозита от ликвидации. Потеря не должна превышать 3-5% от общего капитала.

### 4. МНОГОТАЙМФРЕЙМОВЙ СТРУКТУРНЫЙ КОНТЕКСТ И СОВПАДЕНИЕ ФАКТОРОВ (CONFLUENCE)
- **Анализ Тренда Старшего Таймфрейма (HTF 1D / 1H):** Всегда сопоставляй направление сделок с глобальным контекстом — открывай LONG только на бычьем тренде либо при глубоком откупе от ключевой поддержки; SHORT — при экстремальных перегрузках или на нисходящем тренде.
- **Анализ Зон Ликвидности (1H):** Оценивай снятие ликвидности (Liquidity Sweep) на часовом таймфрейме крупными игроками — это подтверждает локальную доминацию быков или медведей.
- **Локальное Исполнение (LTF 1m / 5m):** На 5-минутном таймфрейме отслеживай локальные максимумы/минимумы, области дисбаланса цены (имбаланс FVG) и снятие стопов розничных игроков для ювелирного входа.
- **Концепция Точки А и Точки Б:** Точка А — это твоя опорная точка входа (зона слома структуры, локальный экстремум или свип ликвидности). Точка Б — твоя целевая зона выхода (противоположный экстремум, сильный ордерблок или зона затухания тренда). Любое решение должно строиться на понимании пути от Точки А к Точке Б с R:R не менее 1:2.5.
- **Автоматический Обход Ограничений по Конфлюэнсу:** Когда старший тренд (1D тренд или 1H свип) совпадает с локальным сигналом (5m свип, FVG или локальный пик), активируется **Smart Money Confluence**. В этом случае система автоматически ослабляет избыточные фильтры риска, позволяя открыть сделку и не упустить прибыль, решая проблему излишней пассивности («молчаливого гения»).
- **Затухание Объемов и Лимитные Входы:** Обязательно подтверждай затухание объемов (Volume Fading) на М1/М5 перед активацией лимитных ордеров типа Sell Limit (для SHORT) или Buy Limit (для LONG). Отдавай приоритет сетке лимитных ордеров в зоне 0.618-0.786 по Фибоначчи от локального импульса, полностью исключая вход по рынку на фазе вертикального движения.

### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)
Внедрить обязательное использование скользящих лимитных заявок (Pegged/Post-Only) для защиты от рыночного проскальзывания. Запретить открытие позиций по монетам, у которых спред превышает 0.25%. При обнаружении фантомных плотностей в стакане смещать лимитный ордер на 0.2-0.4% глубже в зону безопасности.`;

export function sanitizeExpertInstructions(input: string): string {
  const section5Header = "### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)";
  const section4AdaptiveHeader = "### 4. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)";
  const baseline = DEFAULT_BASELINE_EXPERT_INSTRUCTIONS;
  
  if (!input || typeof input !== 'string' || input.trim().length === 0) {
    return baseline;
  }

  let cleaned = input.trim();
  
  // Clean up any historical duplicate headers if present
  let basePart = cleaned;
  let adaptivePart = "";
  
  if (cleaned.includes(section5Header)) {
    const parts = cleaned.split(section5Header);
    basePart = parts[0] || "";
    adaptivePart = parts.slice(1).join("\n").trim();
  } else if (cleaned.includes(section4AdaptiveHeader)) {
    const parts = cleaned.split(section4AdaptiveHeader);
    basePart = parts[0] || "";
    adaptivePart = parts.slice(1).join("\n").trim();
  }

  // Ensure mandatory risk & trade management sections are retained
  if (!basePart.includes("### 2. RISK MANAGEMENT") || !basePart.includes("### 3. РЕШЕНИЯ ПО СОПРОВОЖДЕНИЮ СДЕЛКИ") || basePart.length < 100) {
    // If base part is truncated or damaged, restore baseline
    return baseline;
  }
  
  if (adaptivePart) {
    // Remove any nested duplicate section headers within adaptive part
    const cleanAdaptive = adaptivePart.replace(/###\s*[45]\.\s*АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ[^\n]*/g, '').trim();
    return `${basePart.trim()}\n\n${section5Header}\n${cleanAdaptive}`;
  }
  
  if (!basePart.includes("### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ")) {
    return `${basePart.trim()}\n\n${section5Header}\nВнедрить обязательное использование скользящих лимитных заявок (Pegged/Post-Only) для защиты от рыночного проскальзывания. Запретить открытие позиций по монетам, у которых спред превышает 0.25%. При обнаружении фантомных плотностей в стакане смещать лимитный ордер на 0.2-0.4% глубже в зону безопасности.`;
  }

  return basePart.trim();
}

export function normalizeSymbol(sym: string): string {
  if (!sym) return '';
  let part = sym.split(':')[0];
  part = part.replace(/-SWAP$/i, '').replace(/_SWAP$/i, '');
  return part.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

export function cleanSymbol(sym: string): string {
  return normalizeSymbol(sym);
}

export function getUnifiedTradeClosePnl(side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) {
  const unleveragedPct = side === 'SHORT'
    ? ((entryPrice - closePrice) / entryPrice) * 100
    : ((closePrice - entryPrice) / entryPrice) * 100;
  const leveragedPct = unleveragedPct * leverage;
  const rawPnlUsd = amount * (leveragedPct / 100);
  // Unified fee: 0.1% round-turn (0.1% * leverage on margin balance)
  const feeUsd = amount * leverage * 0.001;
  const pnlUsd = rawPnlUsd - feeUsd;
  const pnlPercent = amount > 0 ? (pnlUsd / amount) * 100 : leveragedPct;
  return { pnlUsd, feeUsd, leveragedPct, pnlPercent };
}

export function calculateKelly(aiScore: number, rewardToRisk: number = 2.0): number {
  const w = aiScore / 100;
  if (w <= 0.4) return 0;
  const k = w - (1 - w) / rewardToRisk;
  const halfKelly = Math.max(0, k / 2); // Half-Kelly for risk mitigation
  return halfKelly;
}

export function calculateAdaptiveCloseRatios(obImbalance?: number, volatility?: number): number[] {
  try {
    const imb = typeof obImbalance === 'number' ? obImbalance : 50; // out of 100
    const vol = typeof volatility === 'number' ? volatility : 2.0;
    
    let tp1 = 0.50;
    let tp2 = 0.25;
    let tp3 = 0.15;
    let tp4 = 0.10;
    
    if (imb > 65) {
      tp1 = 0.60;
      tp2 = 0.20;
      tp3 = 0.12;
      tp4 = 0.08;
    } else if (vol > 5.0) {
      tp1 = 0.55;
      tp2 = 0.25;
      tp3 = 0.12;
      tp4 = 0.08;
    } else if (vol < 1.5 && imb < 40) {
      tp1 = 0.40;
      tp2 = 0.30;
      tp3 = 0.20;
      tp4 = 0.10;
    }
    
    return [tp1, tp2, tp3, tp4];
  } catch (err) {
    return [0.50, 0.25, 0.15, 0.10];
  }
}

export function calculateSMA(prices: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma.push(sum / period);
  }
  return sma;
}

export function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  if (prices.length === 0) return ema;
  const k = 2 / (period + 1);
  let prevEma = prices[0];
  ema.push(prevEma);
  for (let i = 1; i < prices.length; i++) {
    const curEma = prices[i] * k + prevEma * (1 - k);
    ema.push(curEma);
    prevEma = curEma;
  }
  return ema;
}

export function calculateRSI(prices: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  if (prices.length <= period) return rsi;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi.push(100 - (100 / (1 + (avgGain / (avgLoss || 1)))));
  
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi.push(100 - (100 / (1 + (avgGain / (avgLoss || 1)))));
  }
  return rsi;
}

export const DEAD_ZONE_PCT = 0.15;

export function isTrainableOutcome(pnlPercent: number, deadZone: number = DEAD_ZONE_PCT): boolean {
  return Math.abs(pnlPercent) >= deadZone;
}

export function getLossStreakSizeDampening(
  recentClosedAutoTrades: { pnlPercent?: number }[],
  lookback: number = 5,
  lossThreshold: number = 3,
  dampeningFactor: number = 0.6
): number {
  if (!recentClosedAutoTrades || recentClosedAutoTrades.length === 0) return 1.0;
  const recent = recentClosedAutoTrades.slice(-lookback);
  const losses = recent.filter(t => (t.pnlPercent || 0) <= 0).length;
  return losses >= lossThreshold ? dampeningFactor : 1.0;
}



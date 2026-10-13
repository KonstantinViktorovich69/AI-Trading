/**
 * Shared Session Trading Definitions and Calculation Utilities
 * Safe for both Client (Vite React) and Server (Node.js/Express)
 */

export type TradingSessionId = 'ASIAN' | 'LONDON' | 'OVERLAP_LONDON_NY' | 'NEW_YORK' | 'PACIFIC_OFF_HOURS';

export interface TradingSessionMeta {
  id: TradingSessionId;
  name: string;
  nameRu: string;
  startHourUtc: number;
  endHourUtc: number; // exclusive
  description: string;
  liquidityRating: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedBias: 'FAVORABLE' | 'NEUTRAL' | 'HIGH_RISK';
}

export const TRADING_SESSIONS: Record<TradingSessionId, TradingSessionMeta> = {
  ASIAN: {
    id: 'ASIAN',
    name: 'Asian Session (Tokyo / HK / SG)',
    nameRu: 'Азиатская сессия (Токио / Гонконг)',
    startHourUtc: 0,
    endHourUtc: 8,
    description: 'Низкая/средняя ликвидность на альтах, повышенный риск ложных пробоев и сбора стопов.',
    liquidityRating: 'MEDIUM',
    recommendedBias: 'HIGH_RISK'
  },
  LONDON: {
    id: 'LONDON',
    name: 'London / European Morning',
    nameRu: 'Лондонская сессия (Европа)',
    startHourUtc: 8,
    endHourUtc: 13,
    description: 'Приток институциональных объемов, формирование локальных внутридневных трендов.',
    liquidityRating: 'HIGH',
    recommendedBias: 'NEUTRAL'
  },
  OVERLAP_LONDON_NY: {
    id: 'OVERLAP_LONDON_NY',
    name: 'London + New York Overlap',
    nameRu: 'Перекрытие Лондон + Нью-Йорк',
    startHourUtc: 13,
    endHourUtc: 17,
    description: 'Пиковая мировая ликвидность. Исторически наивысший винрейт и чистая отработка паттернов.',
    liquidityRating: 'HIGH',
    recommendedBias: 'FAVORABLE'
  },
  NEW_YORK: {
    id: 'NEW_YORK',
    name: 'New York Afternoon',
    nameRu: 'Американская сессия (Нью-Йорк)',
    startHourUtc: 17,
    endHourUtc: 22,
    description: 'Высокая волатильность, направленные импульсы (историческое преимущество Лонг-позиций).',
    liquidityRating: 'HIGH',
    recommendedBias: 'NEUTRAL'
  },
  PACIFIC_OFF_HOURS: {
    id: 'PACIFIC_OFF_HOURS',
    name: 'Pacific / Late Off-Hours',
    nameRu: 'Тихоокеанская / Ночная пауза',
    startHourUtc: 22,
    endHourUtc: 24,
    description: 'Тонкий стакан, переходный период закрытия рынков США. Сниженная активность.',
    liquidityRating: 'LOW',
    recommendedBias: 'HIGH_RISK'
  }
};

export function getTradingSessionForHour(hourUtc: number): TradingSessionId {
  const h = ((hourUtc % 24) + 24) % 24;
  if (h >= 0 && h < 8) return 'ASIAN';
  if (h >= 8 && h < 13) return 'LONDON';
  if (h >= 13 && h < 17) return 'OVERLAP_LONDON_NY';
  if (h >= 17 && h < 22) return 'NEW_YORK';
  return 'PACIFIC_OFF_HOURS';
}

export function getTradingSession(time: number | Date = Date.now()): TradingSessionId {
  const d = typeof time === 'number' ? new Date(time) : time;
  return getTradingSessionForHour(d.getUTCHours());
}

export interface CurrentSessionInfo {
  session: TradingSessionMeta;
  utcHour: number;
  utcTimeFormatted: string;
  localTimeFormatted: string;
  isPeakLiquidity: boolean;
  recommendation: string;
}

export function getCurrentSessionInfo(time: number | Date = Date.now()): CurrentSessionInfo {
  const d = typeof time === 'number' ? new Date(time) : time;
  const utcHour = d.getUTCHours();
  const sessionId = getTradingSessionForHour(utcHour);
  const session = TRADING_SESSIONS[sessionId];
  
  const pad = (n: number) => String(n).padStart(2, '0');
  const utcTimeFormatted = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const localTimeFormatted = `${pad(d.getHours())}:${pad(d.getMinutes())} Local`;

  let recommendation = session.description;
  if (sessionId === 'OVERLAP_LONDON_NY') {
    recommendation = 'Оптимальное окно для входов: максимальная ликвидность, высокая статистическая отработка.';
  } else if (sessionId === 'ASIAN' && (utcHour >= 4 && utcHour <= 7)) {
    recommendation = 'Период утреннего азиатского сброса / сбора стопов: повышенная осторожность для новых входов.';
  }

  return {
    session,
    utcHour,
    utcTimeFormatted,
    localTimeFormatted,
    isPeakLiquidity: session.liquidityRating === 'HIGH',
    recommendation
  };
}

export interface SessionMetrics {
  sessionId: TradingSessionId;
  name: string;
  nameRu: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  profitFactor: number;
  shortCount: number;
  shortWins: number;
  shortWinRate: number;
  longCount: number;
  longWins: number;
  longWinRate: number;
}

export interface HourlyMetrics {
  hourUtc: number;
  sessionId: TradingSessionId;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
}

const getTradeTimestamp = (t: any): number => {
  const raw = t.openTime || t.entryTime || t.createdAt || t.timestamp || 0;
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return num;
  const parsed = new Date(raw).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

const getTradePnl = (t: any): number => {
  if (t.pnl !== undefined && t.pnl !== null) return Number(t.pnl);
  if (t.realizedPnl !== undefined && t.realizedPnl !== null) return Number(t.realizedPnl);
  if (t.pnlPercent !== undefined && t.pnlPercent !== null) {
    const amt = Number(t.amount || t.initialAmount || 10);
    return amt * (Number(t.pnlPercent) / 100);
  }
  return 0;
};

export function calculateSessionStats(trades: any[]): Record<TradingSessionId, SessionMetrics> {
  const sessions: Record<TradingSessionId, SessionMetrics> = {
    ASIAN: createEmptySessionMetrics('ASIAN'),
    LONDON: createEmptySessionMetrics('LONDON'),
    OVERLAP_LONDON_NY: createEmptySessionMetrics('OVERLAP_LONDON_NY'),
    NEW_YORK: createEmptySessionMetrics('NEW_YORK'),
    PACIFIC_OFF_HOURS: createEmptySessionMetrics('PACIFIC_OFF_HOURS')
  };

  const closedTrades = (trades || []).filter(t => t && t.status === 'CLOSED');

  for (const t of closedTrades) {
    const ts = getTradeTimestamp(t);
    if (!ts) continue;
    const h = new Date(ts).getUTCHours();
    const sessionId = getTradingSessionForHour(h);
    const sm = sessions[sessionId];

    const pnl = getTradePnl(t);
    const isWin = pnl > 0;
    const isShort = t.side === 'SHORT';

    sm.totalTrades++;
    sm.totalPnl += pnl;
    if (isWin) {
      sm.winningTrades++;
    } else if (pnl < 0) {
      sm.losingTrades++;
    }

    if (isShort) {
      sm.shortCount++;
      if (isWin) sm.shortWins++;
    } else {
      sm.longCount++;
      if (isWin) sm.longWins++;
    }
  }

  for (const key of Object.keys(sessions) as TradingSessionId[]) {
    const s = sessions[key];
    s.winRate = s.totalTrades > 0 ? Number(((s.winningTrades / s.totalTrades) * 100).toFixed(1)) : 0;
    s.avgPnl = s.totalTrades > 0 ? Number((s.totalPnl / s.totalTrades).toFixed(2)) : 0;
    s.totalPnl = Number(s.totalPnl.toFixed(2));
    s.shortWinRate = s.shortCount > 0 ? Number(((s.shortWins / s.shortCount) * 100).toFixed(1)) : 0;
    s.longWinRate = s.longCount > 0 ? Number(((s.longWins / s.longCount) * 100).toFixed(1)) : 0;
  }

  return sessions;
}

function createEmptySessionMetrics(sessionId: TradingSessionId): SessionMetrics {
  const meta = TRADING_SESSIONS[sessionId];
  return {
    sessionId,
    name: meta.name,
    nameRu: meta.nameRu,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalPnl: 0,
    avgPnl: 0,
    profitFactor: 0,
    shortCount: 0,
    shortWins: 0,
    shortWinRate: 0,
    longCount: 0,
    longWins: 0,
    longWinRate: 0
  };
}

export function calculateHourlyStats(trades: any[]): HourlyMetrics[] {
  const hours: HourlyMetrics[] = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      hourUtc: h,
      sessionId: getTradingSessionForHour(h),
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0
    });
  }

  const closedTrades = (trades || []).filter(t => t && t.status === 'CLOSED');
  for (const t of closedTrades) {
    const ts = getTradeTimestamp(t);
    if (!ts) continue;
    const h = new Date(ts).getUTCHours();
    const hm = hours[h];
    const pnl = getTradePnl(t);

    hm.totalTrades++;
    hm.totalPnl += pnl;
    if (pnl > 0) hm.winningTrades++;
    else if (pnl < 0) hm.losingTrades++;
  }

  for (const hm of hours) {
    hm.winRate = hm.totalTrades > 0 ? Number(((hm.winningTrades / hm.totalTrades) * 100).toFixed(1)) : 0;
    hm.totalPnl = Number(hm.totalPnl.toFixed(2));
  }

  return hours;
}

export interface SessionFilterVerdict {
  allowed: boolean;
  reason?: string;
  session: TradingSessionId;
  hourUtc: number;
  scoreAdjustment?: number;
}

export function evaluateSessionFilter(
  timestamp: number | Date = Date.now(),
  settings?: any,
  side?: 'LONG' | 'SHORT'
): SessionFilterVerdict {
  const d = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const hourUtc = d.getUTCHours();
  const session = getTradingSessionForHour(hourUtc);

  if (!settings?.isSessionFilterEnabled) {
    return {
      allowed: true,
      session,
      hourUtc,
      scoreAdjustment: 0
    };
  }

  if (Array.isArray(settings.blockedHoursUtc) && settings.blockedHoursUtc.includes(hourUtc)) {
    return {
      allowed: false,
      reason: `Blocked by UTC hour filter (${hourUtc}:00 UTC)`,
      session,
      hourUtc
    };
  }

  if (Array.isArray(settings.allowedSessions) && settings.allowedSessions.length > 0) {
    if (!settings.allowedSessions.includes(session)) {
      return {
        allowed: false,
        reason: `Session "${TRADING_SESSIONS[session]?.nameRu || session}" is not in allowed sessions list`,
        session,
        hourUtc
      };
    }
  }

  let scoreAdjustment = 0;
  if (settings.sessionAdaptiveScoreBoost) {
    if (session === 'OVERLAP_LONDON_NY') {
      scoreAdjustment = 3;
    } else if (session === 'ASIAN') {
      scoreAdjustment = -4;
    } else if (session === 'NEW_YORK' && side === 'SHORT') {
      scoreAdjustment = -3;
    }
  }

  return {
    allowed: true,
    session,
    hourUtc,
    scoreAdjustment
  };
}

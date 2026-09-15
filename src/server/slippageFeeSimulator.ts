/**
 * Модуль симуляции комиссий биржи и динамического проскальзывания (Slippage & Exchange Fee Model).
 * Позволяет Paper Trading эмулировать реалистичные условия выполнения Taker ордеров на фьючерсах.
 */

export interface FeeSlippageConfig {
  takerFeeRate: number; // Стандартная комиссия тейкера (0.0004 = 0.04% или 0.0005 = 0.05%)
  makerFeeRate: number; // Стандартная комиссия мейкера (0.0002 = 0.02%)
  defaultSlippagePct: number; // Базовое проскальзывание в процентах (0.03 = 0.03%)
  volatilitySlippageMultiplier: number; // Коэффициент увеличения проскальзывания при высоком PnL/импульсе
}

export const DEFAULT_FEE_CONFIG: FeeSlippageConfig = {
  takerFeeRate: 0.0005, // 0.05% Taker fee (Binance/Bybit Futures standard)
  makerFeeRate: 0.0002, // 0.02% Maker fee
  defaultSlippagePct: 0.03, // 0.03% базовое проскальзывание
  volatilitySlippageMultiplier: 1.2
};

/**
 * Расчет чистой цены исполнения с учетом проскальзывания для SHORT позиции.
 * При входе в SHORT (продажа): проскальзывание снижает цену входа (получаем чуть худшую цену продажи).
 * При выходе из SHORT (покупка): проскальзывание увеличивает цену покупки (покупаем чуть дороже).
 */
export function calculateExecutionPriceWithSlippage(
  nominalPrice: number,
  side: 'SHORT' | 'LONG',
  isEntry: boolean,
  isMarketOrder: boolean = true,
  volatilityFactor: number = 1.0,
  config: FeeSlippageConfig = DEFAULT_FEE_CONFIG
): { executedPrice: number; slippagePct: number } {
  if (!isMarketOrder || nominalPrice <= 0) {
    return { executedPrice: nominalPrice, slippagePct: 0 };
  }

  // Расчет динамического проскальзывания в зависимости от волатильности монеты
  const baseSlippage = config.defaultSlippagePct * Math.min(3.0, Math.max(0.5, volatilityFactor));
  const randomFactor = 0.8 + Math.random() * 0.4; // Небольшой рандом 80%-120% от базового
  const finalSlippagePct = +(baseSlippage * randomFactor).toFixed(4);
  const slippageMultiplier = finalSlippagePct / 100;

  let executedPrice = nominalPrice;

  if (side === 'SHORT') {
    if (isEntry) {
      // Продажа: проскальзывание ведет к продаже ниже рыночной
      executedPrice = nominalPrice * (1 - slippageMultiplier);
    } else {
      // Покупка для закрытия шорта: проскальзывание ведет к покупке выше рыночной
      executedPrice = nominalPrice * (1 + slippageMultiplier);
    }
  } else {
    // LONG
    if (isEntry) {
      executedPrice = nominalPrice * (1 + slippageMultiplier);
    } else {
      executedPrice = nominalPrice * (1 - slippageMultiplier);
    }
  }

  return {
    executedPrice: +executedPrice.toFixed(8),
    slippagePct: finalSlippagePct
  };
}

/**
 * Расчет биржевой комиссии в USDT для ордера
 */
export function calculateTradingFee(
  notionalValueUsdt: number,
  isTaker: boolean = true,
  config: FeeSlippageConfig = DEFAULT_FEE_CONFIG
): number {
  const feeRate = isTaker ? config.takerFeeRate : config.makerFeeRate;
  return +(notionalValueUsdt * feeRate).toFixed(4);
}

/**
 * Расчет чистого PnL позиции с вычетом комиссий открытия и закрытия
 */
export function calculateNetPnl(
  notionalEntryUsdt: number,
  notionalExitUsdt: number,
  grossPnlUsdt: number,
  config: FeeSlippageConfig = DEFAULT_FEE_CONFIG
): { netPnlUsdt: number; entryFeeUsdt: number; exitFeeUsdt: number; totalFeeUsdt: number } {
  const entryFeeUsdt = calculateTradingFee(notionalEntryUsdt, true, config);
  const exitFeeUsdt = calculateTradingFee(notionalExitUsdt, true, config);
  const totalFeeUsdt = +(entryFeeUsdt + exitFeeUsdt).toFixed(4);
  const netPnlUsdt = +(grossPnlUsdt - totalFeeUsdt).toFixed(2);

  return {
    netPnlUsdt,
    entryFeeUsdt,
    exitFeeUsdt,
    totalFeeUsdt
  };
}

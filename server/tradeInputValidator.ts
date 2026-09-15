export interface TradeInput {
  entryPrice?: any;
  amount?: any;
  leverage?: any;
  side?: any;
  takeProfit?: any;
  stopLoss?: any;
}

export interface ValidatedTradeValues {
  entryPrice: number;
  amount: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  takeProfit?: number;
  stopLoss?: number;
}

export type ValidationResult =
  | { valid: true; value: ValidatedTradeValues; error?: undefined }
  | { valid: false; error: string; value?: undefined };

function parsePositiveFiniteNumber(val: any): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  const num = Number(val);
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

export function validatePaperTradeInput(input: TradeInput): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Отсутствуют параметры сделки' };
  }

  const { entryPrice, amount, leverage, side, takeProfit, stopLoss } = input;

  const parsedEntry = parsePositiveFiniteNumber(entryPrice);
  if (parsedEntry === null) {
    return { valid: false, error: 'Некорректная или отсутствующая цена входа (entryPrice)' };
  }

  const parsedAmount = parsePositiveFiniteNumber(amount);
  if (parsedAmount === null) {
    return { valid: false, error: 'Некорректная или отсутствующая сумма сделки (amount)' };
  }

  const parsedLeverage = parsePositiveFiniteNumber(leverage);
  if (parsedLeverage === null) {
    return { valid: false, error: 'Некорректное или отсутствующее кредитное плечо (leverage)' };
  }

  let parsedSide: 'LONG' | 'SHORT' = 'SHORT';
  if (side !== undefined && side !== null) {
    const uppercaseSide = String(side).toUpperCase();
    if (uppercaseSide === 'LONG' || uppercaseSide === 'SHORT') {
      parsedSide = uppercaseSide as 'LONG' | 'SHORT';
    } else {
      return { valid: false, error: 'Недопустимое направление сделки (side). Допустимы только LONG или SHORT' };
    }
  }

  let parsedTp: number | undefined = undefined;
  if (takeProfit !== undefined && takeProfit !== null && String(takeProfit).trim() !== '') {
    const tp = parsePositiveFiniteNumber(takeProfit);
    if (tp === null) {
      return { valid: false, error: 'Некорректный Тейк-Профит (takeProfit)' };
    }
    parsedTp = tp;
  }

  let parsedSl: number | undefined = undefined;
  if (stopLoss !== undefined && stopLoss !== null && String(stopLoss).trim() !== '') {
    const sl = parsePositiveFiniteNumber(stopLoss);
    if (sl === null) {
      return { valid: false, error: 'Некорректный Стоп-Лосс (stopLoss)' };
    }
    parsedSl = sl;
  }

  return {
    valid: true,
    value: {
      entryPrice: parsedEntry,
      amount: parsedAmount,
      leverage: parsedLeverage,
      side: parsedSide,
      ...(parsedTp !== undefined ? { takeProfit: parsedTp } : {}),
      ...(parsedSl !== undefined ? { stopLoss: parsedSl } : {})
    }
  };
}

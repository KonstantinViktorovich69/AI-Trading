/**
 * Structural Exit Levels Calculator
 *
 * Вычисление структурного Stop-Loss (привязанного к локальным экстремумам 5m + буфер ATR)
 * и структурной лестницы Take-Profit TP1-TP4 (привязанной к swing-уровням 1h с волатильностным полом и потолком).
 *
 * Единый источник истины для Virtual и Real режимов автопилота.
 */

/**
 * Доля ATR, используемая в качестве защитного буфера за пределами локального экстремума 5m
 */
export const STRUCTURAL_SL_ATR_BUFFER_RATIO = 0.15;

/**
 * Запасной нейтральный процент Stop-Loss (1.5%), если структурный уровень оказался на неверной стороне от цены
 */
export const DEFAULT_FALLBACK_SL_RATIO = 0.015;

/**
 * Минимальная нижняя граница для R:R Guard по отношению к TP1 (1.2%)
 */
export const MIN_RR_GUARD_TP1_BOUND = 0.012;

/**
 * Множитель R:R Guard: Stop-Loss ограничен максимум 1.8x от дистанции первого TP
 */
export const RR_GUARD_TP1_MULTIPLIER = 1.8;

/**
 * Минимально допустимый процент движения цены для Stop-Loss (0.8%)
 */
export const MIN_SL_PCT = 0.008;

/**
 * Максимально допустимый процент движения цены для Stop-Loss (2.2%)
 */
export const MAX_SL_PCT = 0.022;

/**
 * Множитель потолка для структурного TP4 относительно волатильностного пола (максимум в 3 раза дальше пола)
 */
export const TP_CAP_MULTIPLIER = 3.0;

/**
 * Доли дистанции TP4 для лестницы фиксации прибыли TP1-TP4
 */
export const TP_STAGE1_RATIO = 0.15;
export const TP_STAGE2_RATIO = 0.30;
export const TP_STAGE3_RATIO = 0.55;
export const TP_STAGE4_RATIO = 1.00;

export interface StructuralStopLossParams {
  isSellSignal: boolean;
  referencePrice: number;
  localLow5m: number;
  localHigh5m: number;
  atr: number;
  dAutoTp1OrDRealTp1: number;
}

export interface StructuralStopLossResult {
  stopLoss: number;
  slPct: number;
}

/**
 * Вычисляет структурный Stop-Loss с привязкой к 5m экстремумам и защитой R:R Guard
 */
export function calculateStructuralStopLoss(params: {
  isSellSignal: boolean;
  referencePrice: number;
  localLow5m: number;
  localHigh5m: number;
  atr: number;
  dAutoTp1OrDRealTp1: number;
}): { stopLoss: number; slPct: number } {
  const { isSellSignal, referencePrice, localLow5m, localHigh5m, atr, dAutoTp1OrDRealTp1 } = params;

  if (!referencePrice || referencePrice <= 0) {
    return { stopLoss: 0, slPct: DEFAULT_FALLBACK_SL_RATIO };
  }

  const safeAtr = (atr && !isNaN(atr) && atr > 0) ? atr : referencePrice * DEFAULT_FALLBACK_SL_RATIO;
  const buffer = safeAtr * STRUCTURAL_SL_ATR_BUFFER_RATIO;

  let structuralDistance: number;
  if (isSellSignal) {
    // SHORT: стоп за локальный хай + буфер
    structuralDistance = (localHigh5m + buffer) - referencePrice;
  } else {
    // LONG: стоп за локальный лой - буфер
    structuralDistance = referencePrice - (localLow5m - buffer);
  }

  // Если уровень на неверной стороне (устаревшие/недостаточные данные) — запасной дефолт 1.5%
  if (structuralDistance <= 0 || isNaN(structuralDistance)) {
    structuralDistance = referencePrice * DEFAULT_FALLBACK_SL_RATIO;
  }

  const structuralSlPct = structuralDistance / referencePrice;
  const maxSlBoundByTp1 = Math.max(MIN_RR_GUARD_TP1_BOUND, (dAutoTp1OrDRealTp1 / 100) * RR_GUARD_TP1_MULTIPLIER);
  const finalSlPct = Math.min(MAX_SL_PCT, Math.max(MIN_SL_PCT, Math.min(structuralSlPct, maxSlBoundByTp1)));

  const rawStopLoss = isSellSignal
    ? referencePrice * (1 + finalSlPct)
    : referencePrice * (1 - finalSlPct);

  return {
    stopLoss: Number(rawStopLoss.toFixed(5)),
    slPct: finalSlPct
  };
}

export interface StructuralTpLadderParams {
  isSellSignal: boolean;
  referencePrice: number;
  swingHigh1h: number;
  swingLow1h: number;
  dAutoTp4OrDRealTp4Floor: number;
}

export interface StructuralTpLadderResult {
  stage1: number;
  stage2: number;
  stage3: number;
  stage4: number;
  tp4DistancePct: number;
}

/**
 * Вычисляет структурную лестницу TP1-TP4 с привязкой к 1h swing-уровням
 */
export function calculateStructuralTpLadder(params: {
  isSellSignal: boolean;
  referencePrice: number;
  swingHigh1h: number;
  swingLow1h: number;
  dAutoTp4OrDRealTp4Floor: number;
}): { stage1: number; stage2: number; stage3: number; stage4: number; tp4DistancePct: number } {
  const { isSellSignal, referencePrice, swingHigh1h, swingLow1h, dAutoTp4OrDRealTp4Floor } = params;

  if (!referencePrice || referencePrice <= 0) {
    return { stage1: 0, stage2: 0, stage3: 0, stage4: 0, tp4DistancePct: 0 };
  }

  // 1. Структурная дистанция до ключевого 1h swing-уровня
  let structuralDistance: number;
  if (isSellSignal) {
    structuralDistance = referencePrice - swingLow1h;
  } else {
    structuralDistance = swingHigh1h - referencePrice;
  }

  // 2. Волатильностный пол (абсолютная дистанция)
  const safeFloorPct = (dAutoTp4OrDRealTp4Floor && !isNaN(dAutoTp4OrDRealTp4Floor) && dAutoTp4OrDRealTp4Floor > 0)
    ? dAutoTp4OrDRealTp4Floor
    : 4.50;
  const floorDistance = referencePrice * (safeFloorPct / 100);

  // 3. Потолок: не более чем в 3 раза дальше волатильностного пола
  const capDistance = floorDistance * TP_CAP_MULTIPLIER;

  // 4. Клампинг и обработка неверной стороны
  let finalTp4Distance: number;
  if (structuralDistance <= 0 || isNaN(structuralDistance)) {
    finalTp4Distance = floorDistance;
  } else {
    finalTp4Distance = Math.min(capDistance, Math.max(floorDistance, structuralDistance));
  }

  // 5. Дистанция TP4 в процентах
  const tp4DistancePct = (finalTp4Distance / referencePrice) * 100;

  // 6. 4 стадии лестницы фиксации прибыли (0.15, 0.30, 0.55, 1.00)
  const directionSign = isSellSignal ? -1 : 1;
  const stage1 = referencePrice + directionSign * TP_STAGE1_RATIO * finalTp4Distance;
  const stage2 = referencePrice + directionSign * TP_STAGE2_RATIO * finalTp4Distance;
  const stage3 = referencePrice + directionSign * TP_STAGE3_RATIO * finalTp4Distance;
  const stage4 = referencePrice + directionSign * TP_STAGE4_RATIO * finalTp4Distance;

  // 7. Округление до 5 знаков после запятой
  return {
    stage1: Number(stage1.toFixed(5)),
    stage2: Number(stage2.toFixed(5)),
    stage3: Number(stage3.toFixed(5)),
    stage4: Number(stage4.toFixed(5)),
    tp4DistancePct: Number(tp4DistancePct.toFixed(5))
  };
}

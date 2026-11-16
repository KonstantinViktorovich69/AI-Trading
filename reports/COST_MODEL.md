# Cost Model Specification & WEEX Fee Audit (`AI-Trading`)

## 1. Основная расчётная модель (`costModelVersion = 2`, активна, не изменена)

Единый источник истины: `server/services/costModel.ts` и `server/quant.ts:getUnifiedTradeClosePnl`.

- **Комиссия (`feeRatePerSide`)**: `0.0006` (`0.06%` на сторону, `0.12%` round-trip по номиналу).
- **Проскальзывание (`slippageRoundTrip`)**: `0.0004` (`0.04%` round-trip по номиналу; при `slippageTierModelEnabled=true` масштабируется `1.5x` при объёме `< $200k` и `2.5x` при `< $50k`).
- **Совокупные издержки v2 (`roundTripCostPct`)**: `0.0006 * 2 + 0.0004 = 0.0016` (`0.16%` от номинала `amount * leverage`).
- **Формула итогового PnL**:
  - `notional = amount * leverage` (`amount` — маржа позиции в USDT)
  - `grossPnlUsd = amount * unleveragedMovePct * leverage / 100`
  - `feeUsd = notional * (feeRatePerSide * 2)`
  - `slippageUsd = notional * slippageRoundTrip`
  - `pnl = grossPnlUsd - feeUsd - slippageUsd`
  - `pnlPercent = (pnl / amount) * 100` (ROE % на маржу, с плечом).

## 2. Сверка с реальным API биржи WEEX (`exchangeInfo`)

Прямой запрос `GET https://api-contract.weex.com/capi/v3/market/exchangeInfo` (выполнен `2026-11-14`, 1026 фьючерсных контрактов):

| Параметр | Значение на WEEX | Доля контрактов |
|---|---|---|
| `takerFeeRate` | `0.0008` (`0.08%` на сторону) | `1025 / 1026` (и `1 / 1026` с `0.0016`) |
| `makerFeeRate` | `0.0002` (`0.02%` на сторону) | `901 / 1026` (остальные: `70` по `0.0003`, `36` по `0.0005`, `18` по `0.0008`, `1` по `0.0004`) |

Сравнение с текущей моделью:
- **Если ордер исполняется по маркету (Taker/Taker)**: комиссия WEEX составляет `0.08% * 2 = 0.16%` по номиналу, плюс проскальзывание `0.04%` = **`0.20%` round-trip** (`+0.04%` к номиналу сверх v2, или **`+0.20` п.п. ROE** при плече `5x`).
- **Если вход лимитным ордером (Maker), выход по TP лимитным (Maker)**: `0.02% * 2 = 0.04%` без проскальзывания.
- **Комбинированный Maker вход + Taker SL**: `0.02% + 0.08% + ~0.02% = 0.12%` (ниже текущих `0.16%`).

> Примечание: в `server/quant.ts:140` без передачи `costModel` legacy-ветка использует `0.001` (`0.10%`, 0 slippage).

## 3. Теневое поле `netPnlTakerFee` (внедрено аддитивно в G5)

Чтобы не ломать текущую логику баланса, порогов и `costModel v2`, но честно видеть худший Taker-сценарий (market entry + market SL/close):

- На всех новых закрытых сделках во всех путях закрытия (`virtualTradeEngine.ts`, `tradeManagerService.ts`, `paperTradeRoutes.ts`, `realTradeRoutes.ts`) дополнительно вычисляются и сохраняются поля:
  - `netPnlTakerFee` — теневой Net PnL в ROE % (в тех же единицах, что `pnlPercent`) при `feeRatePerSide = 0.0008` (`0.08% * 2 = 0.16%`) + `slippageRoundTrip` (по умолчанию `0.04%`, итого `0.20%` по номиналу).
  - `netPnlTakerFeeUsd` — аналогичный теневой Net PnL в USDT (при тех же `feeRatePerSide = 0.0008` и `slippageRoundTrip`).
- Хелпер: `getShadowTakerCostModel(costModel)` в `server/services/costModel.ts`.
- На баланс, статистику и существующий `pnl`/`pnlPercent` (`costModel v2`) теневое поле не влияет.

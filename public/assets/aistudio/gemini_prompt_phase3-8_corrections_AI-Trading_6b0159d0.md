# Промт для Gemini: исправления по итогам проверки Фаз 3–8 (AI-Trading)

Контекст: проверен коммит `44b8005` (origin/main). tsc чистый, vitest зелёный, но найдены дефекты, которые тесты не ловят. Правила прежние: «НЕ НАВРЕДИ», точечные изменения, один коммит на задачу, отвечай по-русски, ничего не изображай сделанным.

## D0. Сначала: влей готовые исправления (они уже проверены)

Файл `ai-trading_main-corrections.patch` (6 коммитов поверх `44b8005`, применяется чисто через `git am`) содержит:
- C1–C5 из `gemini_prompt_phase0-2_corrections_AI-Trading.md` (в main они НЕ попали);
- D1 (ниже) вместе с регрессионным тестом.

Если патч приложить нельзя, сделай C1–C5 по тому промту и D1 вручную. Не «переписывай по-своему»: поведение и тесты должны совпасть.

После применения: `npx tsc --noEmit` = 0 ошибок, `npx vitest run` = все зелёные (ожидается 93 файла / 586 тестов).

## D1. Критичный баг в `server/services/quantModelTrainer.ts` (регрессия Фазы 3)

В блоке сравнения потерь пропало `} else {`. Сейчас `setModelWeights()` вызывается только когда новая валидационная потеря ХУЖЕ текущей. Должно быть наоборот:

```ts
if (bestValLoss > currentValLoss && isFinite(currentValLoss)) {
  console.warn(`[MODEL] Retraining skipped: ...`);
} else {
  const updatedWeights = { beta0: clipModelWeight(bestWeights[0], 'beta0'), ... };
  context.setModelWeights(updatedWeights);
  console.log(`[MODEL] Retraining complete. ...`);
}
```

Тест: `server/services/quantModelTrainerUpdatesWeights.test.ts` (уже в патче). Без исправления он падает с «setModelWeights вызван 0 раз».

Почему важно: пока баг жив, модель не обучается вообще, а лог пишет «Advanced retraining complete», то есть выглядит рабочей.

## D2. Единая модель издержек на ВСЕХ путях закрытия

`getUnifiedTradeClosePnl` без `costModel` считает старые 0.10% нотионала, остальные пути уже 0.16%. Два места остались на старой модели:
- `server/routes/realTradeRoutes.ts:549`
- `server/routes/paperTradeRoutes.ts:216`

Что сделать: передать `getCostModel(globalSettings)` как последний аргумент, записывать `costModelVersion`, `grossPnlUsd`, `feeUsd`, `slippageUsd` в сделку, как это сделано в `virtualTradeEngine.ts` и в `paperTradeRoutes.ts:742`. Добавь тест: две сделки с одинаковыми входом и выходом, закрытые через разные пути, дают одинаковый `pnlUsd`.

Историю не пересчитывать.

## D3. Фаза 8 не выполнена: нет файлов результата

В коммите нет ни одного файла в `reports/`, хотя T8.2 и T8.3 требуют артефактов.

1. **T8.2.** Запусти ту же методику, что в `reports/baseline_20261107.txt`, и положи результат в `reports/after_phase8_<дата>.txt`. Рядом выведи таблицу «до/после» по закрытым сделкам и явно напиши: история не изменилась (число и суммарный PnL старых сделок совпадают). Если они не совпали, объясни почему (ретеншн переносит сделки старше 30 дней в `data/trades-archive.jsonl`, учитывай архив).
2. **T8.3.** `reports/FLAGS.md`: таблица всех флагов (имя, дефолт, класс I/B, что меняет, где читается, как включить). Данные брать из `settingsManager.ts`, не из памяти. Обязательные строки: `modelSideAwareFeatures`, `requireModelMaturity`, `strictLiquidityGate`, `useMeasuredVolumeSpike`, `slippageTierModelEnabled`, `realTradingEvidenceGateEnabled`, `evidenceGateOverride`, `allowBrowserAiPoller`, `staleDataPauseSec`, `AUTH_REQUIRED`/`AUTH_MODE`/`API_KEY`/`OWNER_ID`/`HOST`.
3. **T8.4.** Выполни grep по заглушкам (`Pegged`, `Post-Only`, `Volume Fading`, «спред превышает 0.25%») и приложи вывод. Остатки есть в `server/quant.ts` (строки ~44–47, ~87), `server/data/defaultStrategyKnowledge.ts` (~111–114) и в живом `settings.json`. Их не удаляй и не переписывай: это решение владельца. Просто перечисли в отчёте как «остаётся, ждёт решения».

## D4. Гигиена коммитов

Коммит `44b8005` назван «reset database and update configuration», но:
- `settings.json` НЕ сброшен (баланс 85.44);
- `known-good-settings-copy` содержит дефолты тестов (баланс 2500, `modelWeights: null`), то есть это побочный эффект запуска тестов, а не сброс;
- `database.json` и `known-good-database-copy` перезаписаны живым состоянием (~29 тыс. строк в каждом).

Правила на будущее:
- не добавляй в коммит `database.json`, `settings.json`, `data/known_good/*`, `data/trades-archive.jsonl`: это рантайм-состояние;
- перед `git add` смотри `git status`, после запуска тестов делай `git checkout -- data/known_good`;
- сообщение коммита описывает то, что реально изменено;
- один коммит на задачу (T3.1, T3.2, ...), а не один на шесть фаз.

## D5. Тесты, которые проверяют ветвление, а не наличие вызова

Баг D1 прошёл через 562 зелёных теста, потому что ни один тест не проверял, что веса действительно записываются. Для каждой защитной ветки Фаз 3–7 должен быть тест на оба исхода:
- трейнер: «улучшение => запись» (есть в патче) и «ухудшение => веса не тронуты»;
- `requireModelMaturity`: зрелая и незрелая модель;
- `evidenceGate`: прошёл и не прошёл (по каждому из четырёх условий отдельно);
- `selfLearningGuard`: принят и отклонён (длина, маркер, кулдаун).

Если такой тест уже есть, укажи файл и имя теста; если нет, добавь.

## Чего НЕ делать

- Не включай флаги класса B.
- Не меняй паттерны, геометрию выходов, пороги.
- Не трогай `database.json` / `settings.json` руками.
- Не пересчитывай историю сделок.

## Отчёт в конце

По каждому пункту D0–D5: что сделано, hash коммита, результат `tsc` и `vitest` (числа), что не удалось. Без пересказа процесса.

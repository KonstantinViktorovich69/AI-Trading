const http = require('http');
const fs = require('fs');
const path = require('path');

function fetchURL(pathStr) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${pathStr}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error on ${pathStr}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('=== ЗАПУСК КОМПЛЕКСНОГО ДИАГНОСТИЧЕСКОГО ТЕСТА СИСТЕМЫ СИГНАЛОВ И АВТОПИЛОТА ===');
  try {
    // 1. Загрузка настроек бота
    const settingsPath = path.join(process.cwd(), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    console.log('\n[1] Текущие настройки системы (settings.json):');
    console.log(`- Режим торговли (tradingMode): ${settings.tradingMode}`);
    console.log(`- Агрессивность автопилота (autopilotAggressiveness): ${settings.autopilotAggressiveness}`);
    console.log(`- Разрешенные направления (allowedTradingDirections): ${settings.allowedTradingDirections}`);
    console.log(`- Фильтр EMA-200 (isEma200FilterEnabled): ${settings.isEma200FilterEnabled}`);
    console.log(`- Фильтр FVG Сверху (isFvgAboveFilterEnabled): ${settings.isFvgAboveFilterEnabled}`);
    console.log(`- Фильтр FVG Поддержка Снизу (isFvgSupportBelowFilterEnabled): ${settings.isFvgSupportBelowFilterEnabled}`);
    console.log(`- Фильтр Liquidity Sweep (isLiquiditySweepFilterEnabled): ${settings.isLiquiditySweepFilterEnabled}`);
    console.log(`- Фильтр Запоздалых Входов (isLateShortFilterEnabled): ${settings.isLateShortFilterEnabled}`);

    // 2. Получение диагностических данных о сигналах
    console.log('\n[2] Запрос сигналов и индикаторов с запущенного сервера...');
    const diagRes = await fetchURL('/api/debug/diagnose-signals');
    const paperTradeRes = await fetchURL('/api/paper-trade');
    const activeSignalsRes = await fetchURL('/api/signals');

    console.log(`- Всего монет в обработке: ${diagRes.totalCoinsCalculated}`);
    console.log(`- Активных сигналов в кэше: ${activeSignalsRes.data ? activeSignalsRes.data.length : 0}`);
    
    if (activeSignalsRes.data && activeSignalsRes.data.length > 0) {
      console.log('--- Список активных сигналов в кэше:');
      activeSignalsRes.data.forEach((s, i) => {
        console.log(`  ${i+1}. ${s.symbol} | Сигнал: ${s.signal} | Паттерн: ${s.type} | AI Score: ${s.aiScore}`);
      });
    } else {
      console.log('--- Активных сигналов в кэше нет.');
    }

    // 3. Анализ причин блокировок шортов
    console.log('\n[3] Статистика блокировок SHORT-сигналов по фильтрам:');
    let totalBlockedShorts = 0;
    const blockReasons = {
      ema200AboveIsLock: 0,
      fvgAboveIsLock: 0,
      fvgSupportBelowIsLock: 0,
      missingSweepOrTopWickIsLock: 0,
      lateShortIsLock: 0,
      volatilityBrakeIsLock: 0
    };

    const potentialShorts = [];

    if (diagRes.diagnostics && diagRes.diagnostics.length > 0) {
      diagRes.diagnostics.forEach(coin => {
        // Проверяем, подходит ли монета под шорт-паттерн или заблокирована
        const hasLock = Object.values(coin.filters).some(v => v === true);
        const hasMatchedPattern = coin.matchedPattern && coin.matchedPattern !== 'None' && coin.matchedPattern.includes('Short') || coin.matchedPattern.includes('Peak') || coin.matchedPattern.includes('пробой') || coin.matchedPattern.includes('Разворот') || coin.matchedPattern.includes('ШОРТ') || coin.matchedPattern.includes('Dump');
        
        if (hasMatchedPattern || hasLock) {
          totalBlockedShorts++;
          Object.keys(coin.filters).forEach(key => {
            if (coin.filters[key] === true) {
              blockReasons[key] = (blockReasons[key] || 0) + 1;
            }
          });
          if (hasMatchedPattern) {
            potentialShorts.push({
              symbol: coin.symbol,
              pattern: coin.matchedPattern,
              locks: Object.keys(coin.filters).filter(k => coin.filters[k] === true)
            });
          }
        }
      });

      console.log(`- Общее количество заблокированных потенциальных SHORT сетапов: ${totalBlockedShorts}`);
      console.log(`- Блокировки по 1h EMA-200 (цена выше скользящей): ${blockReasons.ema200AboveIsLock}`);
      console.log(`- Блокировки по 4h FVG Сверху (магнитная зона роста): ${blockReasons.fvgAboveIsLock}`);
      console.log(`- Блокировки по 4h FVG Поддержка Снизу (сильная зона поддержки): ${blockReasons.fvgSupportBelowIsLock}`);
      console.log(`- Блокировки по Свипу ликвидности / Короткой тени (<60%): ${blockReasons.missingSweepOrTopWickIsLock}`);
      console.log(`- Блокировки по Запоздалому шорту (цена уже упала от пика): ${blockReasons.lateShortIsLock}`);
      console.log(`- Блокировки по Ограничению волатильности (volatility brake): ${blockReasons.volatilityBrakeIsLock}`);

      if (potentialShorts.length > 0) {
        console.log('\n--- Детализация потенциальных SHORT-сигналов, которые были отфильтрованы:');
        potentialShorts.forEach(ps => {
          console.log(`  * ${ps.symbol} -> Паттерн: "${ps.pattern}" | Причины блокировки: ${ps.locks.join(', ')}`);
        });
      } else {
        console.log('\n--- Нет ни одного паттерна SHORT на рынке сейчас из-за доминирующего нисходящего тренда (монеты уже упали, а шорт ищется на росте/пампе).');
      }
    }

    // 4. Анализ состояния открытых сделок и баланса автопилота
    console.log('\n[4] Анализ состояния автопилота и сделок самообучения:');
    if (paperTradeRes && paperTradeRes.success) {
      const openTrades = paperTradeRes.data ? paperTradeRes.data.filter(t => t.status === 'OPEN') : [];
      const autoOpenTrades = openTrades.filter(t => t.isAutoLearning === true);
      console.log(`- Баланс обучения (virtualBalance): $${paperTradeRes.balance}`);
      console.log(`- Всего открытых виртуальных сделок: ${openTrades.length}`);
      console.log(`- Из них сделок самообучения (isAutoLearning): ${autoOpenTrades.length}`);
      if (autoOpenTrades.length > 0) {
        console.log('--- Открытые в данный момент сделки самообучения:');
        autoOpenTrades.forEach((t, i) => {
          console.log(`  ${i+1}. Symbol: ${t.symbol} | Направление: ${t.side} | Цена входа: ${t.entryPrice} | Размер: ${t.amount} | ID: ${t.id}`);
        });
      }
      
      const maxVirtual = settings.maxActivePositionsVirtual || 10;
      console.log(`- Лимит позиций самообучения: ${autoOpenTrades.length} / ${maxVirtual}`);
      if (autoOpenTrades.length >= maxVirtual) {
        console.log('  ⚠️ ВНИМАНИЕ: Достигнут лимит открытых позиций! Новые сделки самообучения запускаться не будут, пока не закроются текущие!');
      } else {
        console.log('  ✅ Свободные слоты для сделок есть.');
      }
    } else {
      console.log('⚠️ Ошибка получения данных paper-trade.');
    }

  } catch (err) {
    console.error('Ошибка выполнения теста:', err.message);
  }
}

run();

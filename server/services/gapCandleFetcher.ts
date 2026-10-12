import { ensureExchangeMarket } from './marketDataHubService.ts';

export interface GapCandleResult {
  ok: boolean;
  reason?: string;
  candles?: any[][];
  timeframe?: string;
  complete?: boolean;
  error?: string;
}

/**
 * Resolves symbol for WEEX / CCXT exchange, matching the logic in updateTrueOHLCV:
 * nativeId, unified `${base}/USDT:USDT`, ensureExchangeMarket.
 */
export function resolveFetchSymbol(exchange: any, rawSymbol: string): string {
  if (!exchange) return rawSymbol;
  try {
    ensureExchangeMarket(exchange, rawSymbol);
    const nativeId = rawSymbol.split(':')[0].replace(/[\/_]/g, '');
    const unified = rawSymbol.includes(':') ? rawSymbol : `${rawSymbol.split(':')[0]}:USDT`;
    const market = (Object.values(exchange.markets || {}) as any[]).find(
      (m: any) =>
        (m.id === nativeId || m.symbol === unified || m.symbol === rawSymbol) &&
        (m.swap || m.future || m.linear || m.contract)
    );
    if (market) {
      return market.symbol;
    }
    ensureExchangeMarket(exchange, unified);
    return unified;
  } catch {
    return rawSymbol;
  }
}

/**
 * Fetches candles covering a downtime gap from `fromTs` to `toTs`.
 * Timeframe:
 *   - n = ceil(gapMs / tfMs) + 3
 *   - '1m' if n <= 1000 (~16 hours)
 *   - '5m' if n <= 1000 (~83 hours)
 *   - gap > 48 hours -> { ok: false, reason: 'GAP_TOO_LONG' }
 *
 * Pagination & Coarser TF Fallback:
 *   - limit 1000, max 4 requests per timeframe
 *   - 350ms delay between requests, 2 retries on error
 *   - total timeout 25 seconds
 *   - if complete=false, attempts coarser timeframe ('1m' -> '5m' -> '15m')
 */
export async function fetchGapCandles(
  exchange: any,
  symbol: string,
  fromTs: number,
  toTs: number
): Promise<GapCandleResult> {
  if (!exchange || !symbol || !fromTs || !toTs) {
    return { ok: false, reason: 'INVALID_ARGS' };
  }

  const gapMs = Math.max(0, toTs - fromTs);
  const fortyEightHoursMs = 48 * 60 * 60 * 1000;

  if (gapMs > fortyEightHoursMs) {
    return { ok: false, reason: 'GAP_TOO_LONG' };
  }

  // 1.2: Select timeframe by candle count: n = ceil(gapMs / tfMs) + 3
  const n1m = Math.ceil(gapMs / (60 * 1000)) + 3;
  const n5m = Math.ceil(gapMs / (5 * 60 * 1000)) + 3;

  let initialTf = '1m';
  if (n1m <= 1000) {
    initialTf = '1m';
  } else if (n5m <= 1000) {
    initialTf = '5m';
  } else {
    return { ok: false, reason: 'GAP_TOO_LONG' };
  }

  // 1.4: Progression '1m' -> '5m' -> '15m'
  const candidateTfs: string[] = initialTf === '1m' ? ['1m', '5m', '15m'] : ['5m', '15m'];

  // If instance needs loadMarkets, invoke it in try/catch
  if (exchange && typeof exchange.loadMarkets === 'function' && (!exchange.markets || Object.keys(exchange.markets).length === 0)) {
    try {
      await exchange.loadMarkets();
    } catch (loadErr) {
      // non-blocking fallback
    }
  }

  const realSymbol = resolveFetchSymbol(exchange, symbol);

  const overallTimeoutMs = 25000;
  const startTime = Date.now();

  let hadSuccessfulRequest = false;
  let lastErrorText: string | undefined = undefined;
  let lastResult: { candles: any[][]; timeframe: string; complete: boolean } | null = null;

  for (let tfIdx = 0; tfIdx < candidateTfs.length; tfIdx++) {
    const timeframe = candidateTfs[tfIdx];
    const tfMs = timeframe === '1m' ? 60 * 1000 : timeframe === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;

    const allCandles: any[][] = [];
    const seenTimestamps = new Set<number>();
    let currentSince = Math.max(0, fromTs - tfMs); // include preceding/first candle
    const maxRequests = 4;
    let requestCount = 0;

    while (requestCount < maxRequests && currentSince < toTs) {
      if (Date.now() - startTime >= overallTimeoutMs) {
        break;
      }

      if (requestCount > 0) {
        await new Promise((res) => setTimeout(res, 350));
      }

      let fetchedChunk: any[][] | null = null;
      let retries = 2;

      while (retries >= 0) {
        const remainingTime = Math.max(1000, overallTimeoutMs - (Date.now() - startTime));
        if (remainingTime <= 1000 && Date.now() - startTime >= overallTimeoutMs) {
          break;
        }
        try {
          // 1.1: Request limit = 1000
          const fetchPromise = exchange.fetchOHLCV(realSymbol, timeframe, currentSince, 1000);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), Math.min(10000, remainingTime))
          );
          fetchedChunk = await Promise.race([fetchPromise, timeoutPromise]);
          hadSuccessfulRequest = true;
          break;
        } catch (err: any) {
          lastErrorText = err?.message || String(err) || 'Fetch error';
          retries--;
          if (retries < 0) {
            break;
          }
          await new Promise((res) => setTimeout(res, 350));
        }
      }

      requestCount++;

      if (!Array.isArray(fetchedChunk) || fetchedChunk.length === 0) {
        break;
      }

      for (const c of fetchedChunk) {
        const ts = c[0];
        if (typeof ts === 'number' && !seenTimestamps.has(ts)) {
          seenTimestamps.add(ts);
          allCandles.push(c);
        }
      }

      const lastTs = fetchedChunk[fetchedChunk.length - 1][0];
      if (typeof lastTs !== 'number' || lastTs <= currentSince) {
        break;
      }

      if (lastTs >= toTs) {
        break;
      }

      currentSince = lastTs + tfMs;
    }

    allCandles.sort((a, b) => a[0] - b[0]);

    if (allCandles.length > 0) {
      // 1.3: complete = (время первой свечи <= fromTs)
      const complete = allCandles[0][0] <= fromTs;
      lastResult = { candles: allCandles, timeframe, complete };

      if (complete) {
        return {
          ok: true,
          candles: allCandles,
          timeframe,
          complete: true
        };
      }

      // 1.4: If complete=false and coarser timeframe exists, retry within deadline.
      // If no coarser timeframe left or deadline exceeded:
      const hasCoarser = tfIdx < candidateTfs.length - 1;
      const timeLeft = overallTimeoutMs - (Date.now() - startTime);
      if (!hasCoarser || timeLeft <= 1000) {
        return {
          ok: true,
          candles: allCandles,
          timeframe,
          complete: false
        };
      }
    }
  }

  // If any candidate timeframe returned candles, return it (incomplete)
  if (lastResult && lastResult.candles.length > 0) {
    return {
      ok: true,
      candles: lastResult.candles,
      timeframe: lastResult.timeframe,
      complete: lastResult.complete
    };
  }

  // 1.5: If all attempts failed with error and 0 successful issuances:
  if (!hadSuccessfulRequest) {
    return {
      ok: false,
      reason: 'FETCH_ERROR',
      error: lastErrorText || 'FETCH_ERROR'
    };
  }

  // Request succeeded, but no candles returned:
  return {
    ok: false,
    reason: 'NO_CANDLES_FETCHED'
  };
}

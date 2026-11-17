import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExchangeWsManager } from './exchangeWsManager.ts';

/**
 * WEEX V3 Public WebSocket Reference Documentation:
 * - Futures WebSocket Intro (endpoints & ping/pong):
 *   https://www.weex.com/api-doc/products/futures/streams/websocket-intro
 * - Tickers Channel payload specification:
 *   https://www.weex.com/api-doc/spot/Websocket/public/Tickers-Channel
 *   https://www.weex.com/legacy-docs/contract/Websocket/public/Tickers-Channel
 *
 * Captured live frame from wss://ws-contract.weex.com/v3/ws/public (stream BTCUSDT@ticker):
 * {"e":"ticker","E":1794698319724,"s":"BTCUSDT","d":[{"p":"-4303.3","P":"-0.063311","w":"65628.37089187","c":"63667.1","o":"67970.4","h":"68419.0","l":"63273.5","v":"118292.9898","q":"7763376208.50278","O":1794611700000,"C":1794698100000,"n":513857,"m":"63660.9","i":"63691.535277778"}]}
 */

function createHarness() {
  const wsTickers: any = { Kraken: {}, Kucoin: {}, Bitget: {}, Gateio: {}, OKX: {}, HTX: {}, WEEX: {}, Weex: {} };
  const globalCcxtTickers: any = { weex: { 'BTC/USDT': { symbol: 'BTC/USDT', last: 63680.0, percentage: -6.31 } } };
  const candleCalls: any[] = [];
  let emitCalls = 0;

  const manager = new ExchangeWsManager({
    getPairs: () => ['BTC/USDT', 'ETH/USDT'],
    getExchangeSymbols: () => ({}),
    getWsTickers: () => wsTickers,
    getGlobalCcxtTickers: () => globalCcxtTickers,
    getGlobalLiquidations: () => ({}),
    getGlobalWhales: () => ({}),
    getGlobalPumps: () => new Set(),
    getGlobalCvd: () => ({}),
    getCacheSignals: () => ({}),
    getVirtualTrades: () => [],
    throttlePriceEmit: () => { emitCalls++; },
    getExchangeLink: (_ex, pair) => `https://www.weex.com/trade/${pair.replace('/', '_')}`,
    updateLocalCandlesForSymbol: (cleanSym, finalPrice, volumeDelta) => {
      candleCalls.push({ cleanSym, finalPrice, volumeDelta });
    },
    updateSignalsCache: () => {}
  });

  return { manager, wsTickers, globalCcxtTickers, candleCalls, getEmitCalls: () => emitCalls };
}

describe('ExchangeWsManager WEEX V3 payload & observeOnly mode (G2)', () => {
  const createdManagers: ExchangeWsManager[] = [];

  afterEach(() => {
    while (createdManagers.length > 0) {
      createdManagers.pop()?.stopAll();
    }
  });

  it('parses real captured WEEX V3 @ticker array frame (msg.d + msg.s) from wss://ws-contract.weex.com/v3/ws/public', () => {
    const { manager, wsTickers, globalCcxtTickers, candleCalls, getEmitCalls } = createHarness();
    createdManagers.push(manager);

    const realWeexV3Frame = {
      e: 'ticker',
      E: 1794698319724,
      s: 'BTCUSDT',
      d: [
        {
          p: '-4303.3',
          P: '-0.063311',
          w: '65628.37089187',
          c: '63667.1',
          o: '67970.4',
          h: '68419.0',
          l: '63273.5',
          v: '118292.9898',
          q: '7763376208.50278',
          O: 1794611700000,
          C: 1794698100000,
          n: 513857,
          m: '63660.9',
          i: '63691.535277778'
        }
      ]
    };

    manager.handleIncomingMessage(JSON.stringify(realWeexV3Frame));

    expect(wsTickers.WEEX.BTCUSDT.last).toBe(63667.1);
    expect(wsTickers.WEEX['BTC/USDT'].last).toBe(63667.1);
    expect(globalCcxtTickers.weex['BTC/USDT'].last).toBe(63667.1);
    expect(globalCcxtTickers.weex['BTC/USDT'].quoteVolume).toBe(7763376208.50278);
    expect(globalCcxtTickers.weex['BTC/USDT'].percentage).toBeCloseTo(-6.3311, 4);
    expect(candleCalls).toEqual([{ cleanSym: 'BTCUSDT', finalPrice: 63667.1, volumeDelta: 0 }]);
    expect(getEmitCalls()).toBe(1);
  });

  it('preserves backward compatibility with legacy stream/data flat frames and ping/connected messages', () => {
    const { manager, wsTickers, globalCcxtTickers } = createHarness();
    createdManagers.push(manager);

    manager.handleIncomingMessage(JSON.stringify({ event: 'connected' }));
    manager.handleIncomingMessage(JSON.stringify({ event: 'ping' }));

    manager.handleIncomingMessage(JSON.stringify({
      stream: 'ETHUSDT@ticker',
      data: { s: 'ETHUSDT', c: '3420.5', b: '3420.0', a: '3421.0', P: '2.15', q: '45000000' }
    }));

    expect(wsTickers.WEEX.ETHUSDT.last).toBe(3420.5);
    expect(globalCcxtTickers.weex['ETH/USDT'].last).toBe(3420.5);
    expect(globalCcxtTickers.weex['ETH/USDT'].percentage).toBe(2.15);
  });

  it('runs in observeOnly mode without mutating currentPrice, wsTickers, ccxtTickers, or candles, and logs minute diff stats', () => {
    const { manager, wsTickers, globalCcxtTickers, candleCalls, getEmitCalls } = createHarness();
    createdManagers.push(manager);

    manager.startAll({ observeOnly: true });
    expect(manager.isObserveOnly()).toBe(true);
    expect(manager.getWatchdogStatus().weex.observeOnly).toBe(true);

    // Seed REST BTC price at 63680.0; feed WS tick at 63667.1
    manager.handleIncomingMessage(JSON.stringify({
      e: 'ticker',
      E: 1794698319724,
      s: 'BTCUSDT',
      d: [{ c: '63667.1', P: '-0.063311', o: '67970.4', q: '7763376208.5' }]
    }));

    // Must NOT modify wsTickers, REST ccxtTickers, local candles, or emit events
    expect(wsTickers.WEEX.BTCUSDT).toBeUndefined();
    expect(globalCcxtTickers.weex['BTC/USDT'].last).toBe(63680.0);
    expect(candleCalls.length).toBe(0);
    expect(getEmitCalls()).toBe(0);

    const summary = manager.flushObserveSummaryLog();
    expect(summary.ticksInWindow).toBe(1);
    expect(summary.totalTicks).toBe(1);
    expect(summary.trackedSymbolsCount).toBe(1);
    expect(summary.symbols[0].symbol).toBe('BTCUSDT');
    expect(summary.symbols[0].wsPrice).toBe(63667.1);
    expect(summary.symbols[0].restPrice).toBe(63680.0);
    expect(summary.symbols[0].diffPct).toBeCloseTo(((63667.1 - 63680.0) / 63680.0) * 100, 3);
    expect(summary.logLine).toContain('[WS OBSERVE]');
    expect(summary.logLine).toContain('ticks=1');

    // Window counter resets after flush while totalTicks keeps counting
    const summaryAfter = manager.getObserveSnapshot();
    expect(summaryAfter.ticksInWindow).toBe(0);
    expect(summaryAfter.totalTicks).toBe(1);
  });

  it('documents J6.2 small-percentage scaling bug where P="0.01" (+0.01% vs open) satisfies |empiricalRatio - pct| < 0.02 and is scaled x100 to 1', () => {
    const { manager, globalCcxtTickers } = createHarness();
    createdManagers.push(manager);

    // Simulate a V3 array tick with o="100", c="100.01" (empiricalRatio = 0.0001 = +0.01%)
    // Even if P is literally 0.01 (0.01%), Math.abs(0.0001 - 0.01) = 0.0099 < 0.02,
    // causing current logic to multiply by 100 -> 1.
    manager.handleIncomingMessage(JSON.stringify({
      e: 'ticker',
      E: 1794698319725,
      s: 'BTCUSDT',
      d: [{ c: '100.01', o: '100', P: '0.01', q: '1000000' }]
    }));

    expect(globalCcxtTickers.weex['BTC/USDT'].percentage).toBe(1);
  });
});

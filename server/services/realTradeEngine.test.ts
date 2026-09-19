import { describe, it, expect, vi, beforeEach } from 'vitest';
import ccxt from 'ccxt';
import {
  executeLimitOrderWithTimeout,
  LimitOrderWithTimeoutParams,
  executeSingleAccountOpen,
  executeRealOpenOnExchange,
  resetCcxtClientPool
} from './realTradeEngine.ts';

describe('executeLimitOrderWithTimeout', () => {
  const createMockDeps = () => ({
    isRealTradingAllowed: () => true,
    getGlobalSettings: () => ({}),
    formatFuturesSymbol: (s: string) => s,
    enrichExchangeError: (err: any) => err?.message || String(err)
  });

  it('handles immediate fill directly upon order creation', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-immediate',
        status: 'closed',
        average: 105.5,
        price: 105.5
      }),
      fetchOrder: vi.fn(),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'BTC/USDT:USDT',
      orderSide: 'buy',
      contracts: 0.5,
      targetPrice: 105.5,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(mockClient.createOrder).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      'limit',
      'buy',
      0.5,
      105.5,
      {}
    );
    expect(mockClient.fetchOrder).not.toHaveBeenCalled();
    expect(mockClient.cancelOrder).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'filled',
      order: expect.objectContaining({ id: 'ord-immediate', status: 'closed' }),
      entryPrice: 105.5
    });
  });

  it('handles fill on the first polling check', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-first-poll',
        status: 'open'
      }),
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-first-poll',
        status: 'closed',
        average: 105.4
      }),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'ETH/USDT:USDT',
      orderSide: 'sell',
      contracts: 2.0,
      targetPrice: 105.4,
      pollIntervalMs: 5,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(mockClient.fetchOrder).toHaveBeenCalledWith('ord-first-poll', 'ETH/USDT:USDT');
    expect(outcome).toEqual({
      status: 'filled',
      order: expect.objectContaining({ id: 'ord-first-poll', status: 'closed' }),
      entryPrice: 105.4
    });
  });

  it('handles fill after multiple status polling attempts', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-multi-poll',
        status: 'open'
      }),
      fetchOrder: vi
        .fn()
        .mockResolvedValueOnce({ id: 'ord-multi-poll', status: 'open' })
        .mockResolvedValueOnce({ id: 'ord-multi-poll', status: 'open' })
        .mockResolvedValueOnce({ id: 'ord-multi-poll', status: 'closed', price: 105.62 }),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'SOL/USDT:USDT',
      orderSide: 'buy',
      contracts: 10,
      targetPrice: 105.6,
      pollIntervalMs: 5,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(mockClient.fetchOrder).toHaveBeenCalledTimes(3);
    expect(mockClient.cancelOrder).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'filled',
      order: expect.objectContaining({ id: 'ord-multi-poll', status: 'closed' }),
      entryPrice: 105.62
    });
  });

  it('times out when order remains open and cancels order on exchange', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-timeout',
        status: 'open'
      }),
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-timeout',
        status: 'open'
      }),
      cancelOrder: vi.fn().mockResolvedValue({ success: true })
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'BTC/USDT:USDT',
      orderSide: 'buy',
      contracts: 1,
      targetPrice: 100,
      timeoutMs: 25,
      pollIntervalMs: 10,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(outcome).toEqual({ status: 'timed_out' });
    expect(mockClient.cancelOrder).toHaveBeenCalledWith('ord-timeout', 'BTC/USDT:USDT');
  });

  it('returns timed_out gracefully even if cancelOrder fails', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-cancel-fail',
        status: 'open'
      }),
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-cancel-fail',
        status: 'open'
      }),
      cancelOrder: vi.fn().mockRejectedValue(new Error('Order already filled or not found'))
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'BTC/USDT:USDT',
      orderSide: 'sell',
      contracts: 1,
      targetPrice: 100,
      timeoutMs: 25,
      pollIntervalMs: 10,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(outcome).toEqual({ status: 'timed_out' });
    expect(mockClient.cancelOrder).toHaveBeenCalledWith('ord-cancel-fail', 'BTC/USDT:USDT');
  });

  it('returns error when order creation fails', async () => {
    const mockClient = {
      createOrder: vi.fn().mockRejectedValue(new Error('Stop retrying because account has insufficient funds -1054')),
      fetchOrder: vi.fn(),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'ETH/USDT:USDT',
      orderSide: 'buy',
      contracts: 5,
      targetPrice: 2500,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toContain('insufficient funds');
    }
    expect(mockClient.fetchOrder).not.toHaveBeenCalled();
    expect(mockClient.cancelOrder).not.toHaveBeenCalled();
  });

  it('returns error when order is externally canceled or rejected', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-rejected',
        status: 'open'
      }),
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-rejected',
        status: 'rejected'
      }),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'SOL/USDT:USDT',
      orderSide: 'buy',
      contracts: 1,
      targetPrice: 150,
      pollIntervalMs: 5,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(outcome).toEqual({
      status: 'error',
      error: 'Order ord-rejected was rejected externally'
    });
  });

  it('returns error if order has no order id from exchange', async () => {
    const mockClient = {
      createOrder: vi.fn().mockResolvedValue({ status: 'open' }),
      fetchOrder: vi.fn(),
      cancelOrder: vi.fn()
    };

    const params: LimitOrderWithTimeoutParams = {
      client: mockClient,
      formattedSymbol: 'BTC/USDT:USDT',
      orderSide: 'buy',
      contracts: 1,
      targetPrice: 100,
      deps: createMockDeps()
    };

    const outcome = await executeLimitOrderWithTimeout(params);

    expect(outcome).toEqual({
      status: 'error',
      error: 'Order was created but no order id returned by exchange'
    });
  });
});

describe('executeSingleAccountOpen and executeRealOpenOnExchange with OTE', () => {
  const createMockDeps = () => ({
    isRealTradingAllowed: () => true,
    getGlobalSettings: () => ({
      exchangeApiConfig: {
        name: 'PrimaryAcc',
        exchange: 'mockex',
        apiKey: 'key123',
        apiSecret: 'sec123',
        isEnabled: true
      }
    }),
    formatFuturesSymbol: (s: string) => s,
    enrichExchangeError: (err: any) => err?.message || String(err)
  });

  const mockClientInstance: any = {
    markets: {
      'BTC/USDT': { contractSize: 1, limits: { amount: { min: 0.001 } } },
      'BTC/USDT:USDT': { contractSize: 1, limits: { amount: { min: 0.001 } } }
    },
    market: vi.fn((s: string) => mockClientInstance.markets[s] || { contractSize: 1, limits: { amount: { min: 0.001 } } }),
    has: { setMarginMode: false, setLeverage: false },
    loadMarkets: vi.fn().mockResolvedValue({}),
    setMarginMode: vi.fn().mockResolvedValue({}),
    setLeverage: vi.fn().mockResolvedValue({}),
    fetchTicker: vi.fn().mockResolvedValue({ last: 100 }),
    amountToPrecision: vi.fn((_sym: string, amt: number) => String(amt)),
    createOrder: vi.fn(),
    fetchOrder: vi.fn(),
    cancelOrder: vi.fn()
  };

  beforeEach(() => {
    resetCcxtClientPool();
    vi.clearAllMocks();
    delete process.env.OFFLINE_MODE;
    delete process.env.TEST_MODE;

    (ccxt as any)['mockex'] = class {
      constructor() {
        return mockClientInstance;
      }
    };
  });

  const accountConfig = {
    name: 'PrimaryAcc',
    exchange: 'mockex',
    apiKey: 'key123',
    apiSecret: 'sec123',
    isEnabled: true
  };

  it('executes limit order when oteOptions is provided and succeeds on fill', async () => {
    mockClientInstance.createOrder.mockResolvedValue({
      id: 'ord-ote-fill',
      status: 'closed',
      average: 98.2,
      price: 98.2
    });

    const res = await executeSingleAccountOpen(
      accountConfig,
      'BTC/USDT',
      'LONG',
      100,
      10,
      undefined,
      undefined,
      createMockDeps(),
      { targetPrice: 98.2, timeoutMs: 1000 }
    );

    expect(mockClientInstance.createOrder).toHaveBeenCalledWith(
      'BTC/USDT',
      'limit',
      'buy',
      expect.any(Number),
      98.2,
      expect.any(Object)
    );
    expect(res.success).toBe(true);
    expect(res.entryPrice).toBe(98.2);
    expect(res.data.id).toBe('ord-ote-fill');
  });

  it('returns OTE_TIMEOUT error when limit order times out', async () => {
    mockClientInstance.createOrder.mockResolvedValue({
      id: 'ord-ote-timeout',
      status: 'open'
    });
    mockClientInstance.fetchOrder.mockResolvedValue({
      id: 'ord-ote-timeout',
      status: 'open'
    });
    mockClientInstance.cancelOrder.mockResolvedValue({});

    const res = await executeSingleAccountOpen(
      accountConfig,
      'BTC/USDT',
      'LONG',
      100,
      10,
      undefined,
      undefined,
      createMockDeps(),
      { targetPrice: 98.2, timeoutMs: 20, pollIntervalMs: 5 }
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe('OTE_TIMEOUT: price did not retrace into target zone within timeout window');
  });

  it('returns error when limit order creation fails', async () => {
    mockClientInstance.createOrder.mockRejectedValue(new Error('Insufficient margin for order'));

    const res = await executeSingleAccountOpen(
      accountConfig,
      'BTC/USDT',
      'LONG',
      100,
      10,
      undefined,
      undefined,
      createMockDeps(),
      { targetPrice: 98.2 }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('Insufficient margin');
  });

  it('falls back to existing market order path when oteOptions is not provided', async () => {
    mockClientInstance.createOrder.mockResolvedValue({
      id: 'ord-market-normal',
      status: 'closed',
      average: 100,
      price: 100
    });

    const res = await executeSingleAccountOpen(
      accountConfig,
      'BTC/USDT',
      'LONG',
      100,
      10,
      undefined,
      undefined,
      createMockDeps()
    );

    expect(mockClientInstance.createOrder).toHaveBeenCalledWith(
      'BTC/USDT',
      'market',
      'buy',
      expect.any(Number),
      undefined,
      expect.any(Object)
    );
    expect(res.success).toBe(true);
    expect(res.entryPrice).toBe(100);
  });

  it('executeRealOpenOnExchange forwards oteOptions to executeSingleAccountOpen', async () => {
    mockClientInstance.createOrder.mockResolvedValue({
      id: 'ord-real-open-ote',
      status: 'closed',
      average: 99.0,
      price: 99.0
    });

    const res = await executeRealOpenOnExchange(
      'BTC/USDT',
      'LONG',
      100,
      10,
      undefined,
      undefined,
      createMockDeps(),
      { targetPrice: 99.0, timeoutMs: 500 }
    );

    expect(mockClientInstance.createOrder).toHaveBeenCalledWith(
      'BTC/USDT',
      'limit',
      'buy',
      expect.any(Number),
      99.0,
      expect.any(Object)
    );
    expect(res.success).toBe(true);
    expect(res.entryPrice).toBe(99.0);
  });

  it('executeRealOpenOnExchange accepts oteOptions as 5th argument when SL/TP omitted', async () => {
    mockClientInstance.createOrder.mockResolvedValue({
      id: 'ord-real-open-ote-5th',
      status: 'closed',
      average: 97.5,
      price: 97.5
    });

    const res = await executeRealOpenOnExchange(
      'BTC/USDT',
      'LONG',
      100,
      10,
      { targetPrice: 97.5, timeoutMs: 500 },
      undefined,
      createMockDeps()
    );

    expect(mockClientInstance.createOrder).toHaveBeenCalledWith(
      'BTC/USDT',
      'limit',
      'buy',
      expect.any(Number),
      97.5,
      expect.any(Object)
    );
    expect(res.success).toBe(true);
    expect(res.entryPrice).toBe(97.5);
  });
});


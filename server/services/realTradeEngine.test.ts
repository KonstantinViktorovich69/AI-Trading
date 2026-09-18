import { describe, it, expect, vi } from 'vitest';
import {
  executeLimitOrderWithTimeout,
  LimitOrderWithTimeoutParams
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

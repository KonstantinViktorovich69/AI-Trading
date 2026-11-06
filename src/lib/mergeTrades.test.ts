import { describe, it, expect } from 'vitest';
import { mergeTradesById } from './mergeTrades.ts';

describe('mergeTradesById', () => {
  it('(а) сделка из кеша, которой нет на сервере, удаляется', () => {
    const cachedTrades = [
      { id: 'ghost-1', symbol: 'BTC/USDT', status: 'CLOSED', pnl: 10, closeTime: 1000 },
      { id: 'valid-1', symbol: 'ETH/USDT', status: 'CLOSED', pnl: 20, closeTime: 2000 }
    ];
    const serverTrades = [
      { id: 'valid-1', symbol: 'ETH/USDT', status: 'CLOSED', pnl: 25, closeTime: 2000 }
    ];

    const result = mergeTradesById(cachedTrades, serverTrades);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('valid-1');
    expect(result.find(t => t.id === 'ghost-1')).toBeUndefined();
  });

  it('(б) пустой incoming возвращает existing без изменений', () => {
    const cachedTrades = [
      { id: 'trade-1', symbol: 'BTC/USDT', status: 'OPEN', openTime: 1000 }
    ];

    const resultEmptyArray = mergeTradesById(cachedTrades, []);
    expect(resultEmptyArray).toEqual(cachedTrades);

    const resultNull = mergeTradesById(cachedTrades, null as any);
    expect(resultNull).toEqual(cachedTrades);
  });

  it('(в) сделка есть на сервере: поля обновляются, порядок «OPEN сверху, затем по времени убывания»', () => {
    const cachedTrades = [
      { id: 'trade-1', symbol: 'BTC/USDT', status: 'CLOSED', pnl: 10, closeTime: 1000 }
    ];
    const serverTrades = [
      { id: 'trade-1', symbol: 'BTC/USDT', status: 'CLOSED', pnl: 50, closeTime: 1000 },
      { id: 'trade-2', symbol: 'SOL/USDT', status: 'CLOSED', pnl: 30, closeTime: 3000 },
      { id: 'trade-3', symbol: 'ETH/USDT', status: 'OPEN', openTime: 2000 }
    ];

    const result = mergeTradesById(cachedTrades, serverTrades);
    expect(result.length).toBe(3);
    // trade-1 обновлен полем pnl: 50
    expect(result.find(t => t.id === 'trade-1')?.pnl).toBe(50);
    // OPEN сделка должна быть первой
    expect(result[0].id).toBe('trade-3');
    expect(result[0].status).toBe('OPEN');
    // Затем CLOSED по времени убывания: trade-2 (3000) перед trade-1 (1000)
    expect(result[1].id).toBe('trade-2');
    expect(result[2].id).toBe('trade-1');
  });

  it('(г) OPEN в кеше, на сервере CLOSED: итоговый статус CLOSED', () => {
    const cachedTrades = [
      { id: 'trade-1', symbol: 'BTC/USDT', status: 'OPEN', openTime: 1000 }
    ];
    const serverTrades = [
      { id: 'trade-1', symbol: 'BTC/USDT', status: 'CLOSED', pnl: -5, openTime: 1000, closeTime: 2000 }
    ];

    const result = mergeTradesById(cachedTrades, serverTrades);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('trade-1');
    expect(result[0].status).toBe('CLOSED');
    expect(result[0].pnl).toBe(-5);
  });
});

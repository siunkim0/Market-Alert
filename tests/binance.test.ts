import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { BinanceFuturesImporter, SOURCE, sign, toTvSymbol } from '../src/journal/importers/binanceFutures.js';
import { Journal } from '../src/journal/journal.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');

describe('Binance 서명', () => {
  it('공식 문서 예제와 같은 HMAC-SHA256', () => {
    const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    expect(sign(q, secret)).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
    expect(toTvSymbol('BTCUSDC')).toBe('BINANCE:BTCUSDC.P');
  });
});

describe('Binance 동기화 (mock fetch)', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  function fakeFetch(calls: { method: string; path: string; params: URLSearchParams; key: string | null }[]) {
    const now = Date.now();
    const trades = [
      { id: 1, symbol: 'BTCUSDC', side: 'BUY', positionSide: 'BOTH', price: '90000', qty: '0.02', commission: '0.72', commissionAsset: 'USDC', realizedPnl: '0', time: now - 3 * 86_400_000 },
      { id: 2, symbol: 'BTCUSDC', side: 'SELL', positionSide: 'BOTH', price: '91000', qty: '0.01', commission: '0.36', commissionAsset: 'USDC', realizedPnl: '10', time: now - 2 * 86_400_000 },
    ];
    return (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? 'GET', path: u.pathname, params: u.searchParams, key: headers.get('X-MBX-APIKEY') });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      switch (u.pathname) {
        case '/fapi/v1/time':
          return json({ serverTime: now });
        case '/fapi/v1/income':
          return json([{ symbol: 'BTCUSDC', incomeType: 'COMMISSION', income: '-0.72', asset: 'USDC', time: now - 3 * 86_400_000 }]);
        case '/fapi/v2/positionRisk':
          return json([
            { symbol: 'BTCUSDC', positionAmt: '0.01', entryPrice: '90000', unRealizedProfit: '5', leverage: '5', positionSide: 'BOTH' },
            { symbol: 'ETHUSDC', positionAmt: '0', entryPrice: '0', unRealizedProfit: '0', leverage: '10', positionSide: 'BOTH' },
          ]);
        case '/fapi/v1/userTrades': {
          const start = Number(u.searchParams.get('startTime'));
          const end = Number(u.searchParams.get('endTime'));
          return json(trades.filter((t) => t.symbol === u.searchParams.get('symbol') && t.time >= start && t.time <= end));
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  it('체결이 중복 없이 들어오고 포지션이 거래소와 일치, GET만 호출', async () => {
    repo = new Repo(':memory:');
    const journal = new Journal(repo, logger);
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const imp = new BinanceFuturesImporter({ apiKey: 'k', apiSecret: 's', fetchImpl: fakeFetch(calls) }, repo, journal, logger);

    const r1 = await imp.sync();
    expect(r1.inserted).toBe(2);
    const r2 = await imp.sync(); // 같은 체결 → 중복 없음
    expect(r2.inserted).toBe(0);
    expect(repo.listTrades()).toHaveLength(2);

    const p = journal.position('BINANCE:BTCUSDC.P')!;
    expect(p.qty).toBeCloseTo(0.01, 12);
    expect(p.avgPrice).toBe(90000);
    const snap = repo.listPositionSnapshot(SOURCE);
    expect(snap).toEqual([expect.objectContaining({ symbol: 'BINANCE:BTCUSDC.P', qty: 0.01, avg_price: 90000 })]);
    // 거래소 제공 실현손익 10 - 수수료 0.36
    expect(journal.tradeRealized(2)).toBeCloseTo(9.64, 10);
    expect(repo.listTrades()[0]).toMatchObject({ source: SOURCE, external_id: '1', fee_currency: 'USDC', leverage: 5 });

    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(new Set(calls.map((c) => c.path))).toEqual(new Set(['/fapi/v1/time', '/fapi/v1/income', '/fapi/v2/positionRisk', '/fapi/v1/userTrades']));
    const signed = calls.filter((c) => c.path !== '/fapi/v1/time');
    expect(signed.every((c) => c.params.has('signature') && c.key === 'k')).toBe(true);
    // userTrades 구간은 7일 이하
    for (const c of calls.filter((c) => c.path === '/fapi/v1/userTrades')) {
      expect(Number(c.params.get('endTime')) - Number(c.params.get('startTime'))).toBeLessThan(7 * 86_400_000);
    }
  });
});

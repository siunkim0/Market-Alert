import { afterEach, describe, expect, it } from 'vitest';
import { parseTradeArgs } from '../src/bot/commands.js';
import { positionMismatches, tradesCsv } from '../src/bot/journalFormat.js';
import { Repo } from '../src/db/repo.js';
import { Journal } from '../src/journal/journal.js';
import { periodStart, periodStats } from '../src/journal/pnl.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');

describe('Journal', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  it('/sl로 손절가를 옮겨도 R은 최초 손절가 기준, trade_group 컬럼 기록', () => {
    repo = new Repo(':memory:');
    const j = new Journal(repo, logger);
    const sym = 'KRX:000660';
    const t0 = new Date('2026-11-10T01:00:00Z');
    j.record({ source: 'manual', symbol: sym, side: 'buy', qty: 10, price: 200000, executedAt: t0 });
    // 손절가 없이 진입 → /sl 190000 (최초) → /sl 205000 (이동)
    expect(j.setStop(sym, 'sl', 190000)?.group.initialStop).toBe(190000);
    const p = j.setStop(sym, 'sl', 205000)!;
    expect(p.group.currentStop).toBe(205000);
    expect(p.group.initialStop).toBe(190000);
    j.setStop(sym, 'tp', 230000);
    expect(j.position(sym)!.group.currentTarget).toBe(230000);

    const res = j.record({ source: 'manual', symbol: sym, side: 'sell', qty: 10, price: 220000, executedAt: new Date('2026-11-10T02:00:00Z') })!;
    expect(res.position).toBeUndefined();
    // R = 200000 / (|200000-190000| × 10) = 2
    expect(res.group).toMatchObject({ id: 'G1', pnl: 200000, r: 2 });
    expect(repo.listTrades().map((t) => t.trade_group)).toEqual(['G1', 'G1']);
    expect(j.setStop(sym, 'sl', 1)).toBeUndefined(); // 포지션 없음
  });

  it('기간 손익: KST 기준, 통화별', () => {
    repo = new Repo(':memory:');
    const j = new Journal(repo, logger);
    const rec = (symbol: string, side: 'buy' | 'sell', qty: number, price: number, at: string, sl?: number) =>
      j.record({ source: 'manual', symbol, side, qty, price, executedAt: new Date(at), stopLoss: sl });
    rec('KRX:005930', 'buy', 10, 100, '2026-11-09T01:00:00Z', 90);
    rec('KRX:005930', 'sell', 10, 110, '2026-11-09T02:00:00Z'); // 11/9 +100, R 1
    rec('KRX:005930', 'buy', 10, 100, '2026-11-10T01:00:00Z', 95);
    rec('KRX:005930', 'sell', 10, 95, '2026-11-10T02:00:00Z'); // 11/10 -50, R -1
    rec('BINANCE:BTCUSDT', 'buy', 1, 100, '2026-11-10T03:00:00Z');
    rec('BINANCE:BTCUSDT', 'sell', 1, 130, '2026-11-10T04:00:00Z'); // +30
    const currency = (s: string) => (s.startsWith('KRX') ? 'KRW' : 'USDT');
    const now = new Date('2026-11-10T06:00:00Z');
    const today = periodStats(j.groups(), 'today', currency, now);
    expect(today.find((s) => s.currency === 'KRW')).toMatchObject({ pnl: -50, count: 1, wins: 0, losses: 1, avgR: -1 });
    expect(today.find((s) => s.currency === 'USDT')).toMatchObject({ pnl: 30, avgR: null });
    const week = periodStats(j.groups(), 'week', currency, now);
    expect(week.find((s) => s.currency === 'KRW')).toMatchObject({ pnl: 50, count: 2, winRate: 0.5, avgR: 0 });
    expect(periodStart('week', now)).toBe('2026-11-09'); // 11/10(화) → 월요일
    expect(periodStart('month', now)).toBe('2026-11-01');
    // 11/9 23:30 KST 청산은 KST 기준 11/9
    expect(periodStart('today', new Date('2026-11-09T14:30:00Z'))).toBe('2026-11-09');
  });

  it('거래소 잔고 불일치, CSV', () => {
    repo = new Repo(':memory:');
    const j = new Journal(repo, logger);
    j.record({ source: 'binance_futures', externalId: '1', symbol: 'BINANCE:BTCUSDC.P', side: 'buy', qty: 0.02, price: 90000, note: '메모, "따옴표"' });
    const isEx = (s: string) => s.endsWith('.P');
    expect(positionMismatches(j.openPositions(), [{ source: 'x', symbol: 'BINANCE:BTCUSDC.P', qty: 0.02, avg_price: 90000, unrealized_pnl: 0, fetched_at: '' }], isEx)).toEqual([]);
    expect(positionMismatches(j.openPositions(), [], isEx)).toHaveLength(1);
    const csv = tradesCsv(repo.listTrades());
    expect(csv.startsWith('﻿id,source')).toBe(true);
    expect(csv).toContain('"메모, ""따옴표"""');
  });
});

describe('/buy 인자', () => {
  it('파싱', () => {
    expect(parseTradeArgs('SK 하이닉스 10 210,000 sl=190000 tp=250,000 눌림 매수')).toEqual({
      query: 'SK 하이닉스', qty: 10, price: 210000, stopLoss: 190000, takeProfit: 250000, fee: undefined, note: '눌림 매수',
    });
    expect(parseTradeArgs('BTC 0.01 @ 91000 fee=0.36')).toMatchObject({ query: 'BTC', qty: 0.01, price: 91000, fee: 0.36 });
    expect(parseTradeArgs('삼성전자 10')).toHaveProperty('error');
    expect(parseTradeArgs('005930 10 200000')).toMatchObject({ query: '005930', qty: 10 });
  });
});

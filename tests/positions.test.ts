import { describe, expect, it } from 'vitest';
import { feeInQuote, replay, unrealizedPnl, type TradeInput } from '../src/journal/positions.js';

let id = 0;
const t = (side: 'buy' | 'sell', qty: number, price: number, extra: Partial<TradeInput> = {}): TradeInput => {
  id++;
  return {
    id, symbol: 'KRX:000660', side, qty, price, fee: null, fee_currency: null,
    executed_at: `2026-11-${String(10 + Math.floor(id / 10)).padStart(2, '0')}T00:${String(id % 60).padStart(2, '0')}:00.000Z`,
    stop_loss: null, take_profit: null, realized_pnl: null, ...extra,
  };
};

describe('포지션 계산 (손계산 대조)', () => {
  it('매수 2회 → 일부 매도 → 전량 매도: 평균단가·실현손익·R', () => {
    id = 0;
    const trades = [
      t('buy', 10, 100, { fee: 1, stop_loss: 95 }),
      t('buy', 10, 110, { fee: 1 }),
      t('sell', 5, 120, { fee: 1 }),
      t('sell', 15, 90, { fee: 1 }),
    ];
    // 2회 매수 후: 평균 (10×100 + 10×110)/20 = 105
    const mid = replay(trades.slice(0, 2));
    expect(mid.positions.get('KRX:000660')).toMatchObject({ qty: 20, avgPrice: 105 });
    // 일부 매도: (120-105)×5 = 75, 수수료 1 → 74. 평균단가는 105 유지
    const part = replay(trades.slice(0, 3));
    expect(part.positions.get('KRX:000660')).toMatchObject({ qty: 15, avgPrice: 105 });
    expect(part.tradeRealized.get(3)).toBe(74);

    const r = replay(trades);
    expect(r.positions.size).toBe(0);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    // 전량 매도: (90-105)×15 = -225 - 1 = -226. 그룹 합: 진입 수수료 -2 + 74 - 226 = -154
    expect(r.tradeRealized.get(4)).toBe(-226);
    expect(g.pnl).toBe(-154);
    expect(g.fees).toBe(4);
    expect(g).toMatchObject({ id: 'G1', direction: 'long', entryAvg: 105, entryQty: 20, exitQty: 20, initialStop: 95 });
    // 청산 평균: (5×120 + 15×90)/20 = 97.5
    expect(g.exitAvg).toBe(97.5);
    // R = -154 / (|105-95| × 20) = -0.77
    expect(g.r).toBeCloseTo(-0.77, 10);
    expect(g.closedAt).toBe(trades[3]!.executed_at);
  });

  it('선물 숏 + 거래소 제공 실현손익 우선 + 수수료 통화', () => {
    id = 0;
    const trades = [
      t('sell', 2, 100, { symbol: 'BINANCE:BTCUSDC.P', fee: 0.1, fee_currency: 'USDC', realized_pnl: 0 }),
      t('sell', 2, 110, { symbol: 'BINANCE:BTCUSDC.P', fee: 0.1, fee_currency: 'USDC', realized_pnl: 0 }),
    ];
    const open = replay(trades);
    expect(open.positions.get('BINANCE:BTCUSDC.P')).toMatchObject({ qty: -4, avgPrice: 105 });
    expect(unrealizedPnl(open.positions.get('BINANCE:BTCUSDC.P')!, 100)).toBe(20); // 숏: (100-105)×-4

    trades.push(t('buy', 4, 95, { symbol: 'BINANCE:BTCUSDC.P', fee: 0.001, fee_currency: 'BNB', realized_pnl: 39.5 }));
    const r = replay(trades);
    const g = r.groups[0]!;
    expect(g.direction).toBe('short');
    // 계산값은 (95-105)×4×(-1) = 40이지만 거래소 값 39.5 우선. BNB 수수료는 차감하지 않음
    expect(r.tradeRealized.get(3)).toBe(39.5);
    expect(g.pnl).toBeCloseTo(39.5 - 0.2, 10);
    expect(feeInQuote({ fee: 0.001, fee_currency: 'BNB' })).toBe(0);
  });

  it('0을 지나 반대 포지션: 그룹이 나뉜다', () => {
    id = 0;
    const r = replay([t('buy', 10, 100), t('sell', 15, 110), t('buy', 5, 105)]);
    expect(r.groups.map((g) => [g.id, g.direction, g.pnl])).toEqual([
      ['G1', 'long', 100], // (110-100)×10
      ['G2', 'short', 25], // (105-110)×5×(-1)
    ]);
    expect(r.positions.size).toBe(0);
    expect(r.groups[1]!.entryAvg).toBe(110);
  });

  it('손절가 이동: R은 최초 손절가, 현재 손절가는 마지막 값', () => {
    id = 0;
    const r = replay([t('buy', 10, 100, { stop_loss: 90 }), t('buy', 0.0, 0), t('buy', 10, 100, { stop_loss: 98 })]);
    const p = r.positions.get('KRX:000660')!;
    expect(p.group.initialStop).toBe(90);
    expect(p.group.currentStop).toBe(98);
    expect(p.group.r).toBeNull(); // 열린 포지션은 R 없음
  });

  it('손절가가 없으면 R은 null, 입력 순서와 무관', () => {
    id = 0;
    const a = t('buy', 1, 100);
    const b = t('sell', 1, 120);
    const r = replay([b, a]);
    expect(r.groups[0]!.pnl).toBe(20);
    expect(r.groups[0]!.r).toBeNull();
  });
});

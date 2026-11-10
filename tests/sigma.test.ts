import { describe, expect, it } from 'vitest';
import { computeReturn, computeSigma, computeZ, dailyReturns, sampleStd } from '../src/market/history.js';

describe('σ 계산', () => {
  it('일간 수익률과 표본 표준편차를 손계산과 비교', () => {
    const closes = [100, 102, 99, 101];
    const rets = dailyReturns(closes);
    expect(rets[0]).toBeCloseTo(0.02, 12);
    expect(rets[1]).toBeCloseTo(99 / 102 - 1, 12);
    expect(rets[2]).toBeCloseTo(101 / 99 - 1, 12);
    // 손계산: 평균 m, 분산 = Σ(x-m)²/(n-1)
    const m = (rets[0]! + rets[1]! + rets[2]!) / 3;
    const v = ((rets[0]! - m) ** 2 + (rets[1]! - m) ** 2 + (rets[2]! - m) ** 2) / 2;
    expect(sampleStd(rets)).toBeCloseTo(Math.sqrt(v), 12);
  });

  it('최근 window개 수익률만 쓴다', () => {
    // +1%, -1% 교대 21개 봉 → 20개 수익률. 앞에 큰 이상치를 붙여도 window 밖이면 무시
    const closes = [1, 1000];
    let c = 100;
    for (let i = 0; i < 21; i++) {
      closes.push(c);
      c = i % 2 === 0 ? c * 1.01 : c * 0.99;
    }
    const bars = closes.map((close) => ({ close }));
    const s = computeSigma(bars, 20)!;
    const expected = sampleStd(dailyReturns(closes.slice(-21)))!;
    expect(s).toBeCloseTo(expected, 12);
    expect(s).toBeGreaterThan(0.009);
    expect(s).toBeLessThan(0.011);
  });

  it('봉이 부족하면 null', () => {
    expect(computeSigma([{ close: 1 }, { close: 2 }], 20)).toBeNull();
  });

  it('r과 z', () => {
    const r = computeReturn(106.1, 100);
    expect(r).toBeCloseTo(0.061, 12);
    expect(computeZ(r, 0.018)).toBeCloseTo(0.061 / 0.018, 12);
    expect(computeReturn(100, undefined)).toBeNull();
    expect(computeZ(0.01, null)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { DelayTracker, parseUpdateMode } from '../src/market/delay.js';

const cfg = { lagThresholdSec: 60, lagPersistMin: 5 };
const MIN = 60_000;

describe('지연 판정', () => {
  it('update_mode를 우선 사용', () => {
    expect(parseUpdateMode('delayed_streaming_1200')).toEqual({ delayed: true, delaySec: 1200 });
    expect(parseUpdateMode('streaming')).toEqual({ delayed: false, delaySec: null });
    expect(parseUpdateMode('weird')).toBeUndefined();

    const t = new DelayTracker(cfg);
    const r = t.observe('KRX:005930', { lagSec: 1201, updateMode: 'delayed_streaming_1200', nowMs: 0, marketOpen: true });
    expect(r.changed).toBe(true);
    expect(r.state).toMatchObject({ delayed: true, delaySec: 1200, source: 'update_mode', lastLagSec: 1201 });
  });

  it('측정: lag > 60s가 5분 지속되어야 delayed, 60s 이하가 5분 지속되어야 해제', () => {
    const t = new DelayTracker(cfg);
    const s = 'X:Y';
    const obs = (min: number, lag: number, open = true) =>
      t.observe(s, { lagSec: lag, updateMode: undefined, nowMs: min * MIN, marketOpen: open });

    expect(obs(0, 1200).state.delayed).toBe(false);
    expect(obs(4, 1201).state.delayed).toBe(false);
    const on = obs(5, 1202);
    expect(on.changed).toBe(true);
    expect(on.state).toMatchObject({ delayed: true, delaySec: 1200, source: 'measured' });
    expect(obs(6, 1199).changed).toBe(false); // 같은 분 단위 → 변화 없음

    // 일시적으로 lag가 줄었다가 다시 늘면 해제되지 않는다
    expect(obs(7, 2).state.delayed).toBe(true);
    expect(obs(9, 1200).state.delayed).toBe(true);
    expect(obs(10, 2).state.delayed).toBe(true);
    const off = obs(15, 1);
    expect(off.changed).toBe(true);
    expect(off.state.delayed).toBe(false);
  });

  it('장 마감 중에는 측정하지 않는다', () => {
    const t = new DelayTracker(cfg);
    for (let m = 0; m <= 30; m++) t.observe('A:B', { lagSec: 50_000, updateMode: undefined, nowMs: m * MIN, marketOpen: false });
    expect(t.get('A:B').delayed).toBe(false);
  });

  it('DB 상태 복원', () => {
    const t = new DelayTracker(cfg);
    t.seed('KRX:005930', true, 1200);
    expect(t.get('KRX:005930')).toMatchObject({ delayed: true, delaySec: 1200 });
  });
});

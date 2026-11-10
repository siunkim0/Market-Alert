import { describe, expect, it } from 'vitest';
import { Cooldown, cooldownKey, ladderStep, reachedLevel, type EscalationConfig } from '../src/triggers/cooldown.js';

const esc: EscalationConfig = { sigmaSteps: [3, 4, 5, 6], pctStep: 2.5, pctBase: 5 };

describe('단계 (ladder)', () => {
  it('sigma 기본: 3 → 4 → 5 → 6 → 7', () => {
    expect([0, 1, 2, 3, 4].map((k) => ladderStep('sigma', 3, k, esc))).toEqual([3, 4, 5, 6, 7]);
  });
  it('sigma 다른 기준값: +1σ씩', () => {
    expect([0, 1, 2].map((k) => ladderStep('sigma', 0.5, k, esc))).toEqual([0.5, 1.5, 2.5]);
  });
  it('pct: 5 → 7.5 → 10, 0.3 → 0.45 → 0.6', () => {
    expect([0, 1, 2].map((k) => ladderStep('pct', 5, k, esc))).toEqual([5, 7.5, 10]);
    expect([0, 1, 2].map((k) => ladderStep("pct", 0.3, k, esc))).toEqual([0.3, 0.45, 0.6]);
  });
  it('도달 단계', () => {
    expect(reachedLevel('sigma', 3, 2.99, esc)).toBeUndefined();
    expect(reachedLevel('sigma', 3, 3.5, esc)).toMatchObject({ level: 3, next: 4 });
    expect(reachedLevel('sigma', 3, 5.2, esc)).toMatchObject({ level: 5, next: 6 });
    expect(reachedLevel('pct', 5, 8, esc)).toMatchObject({ level: 7.5, next: 10 });
  });
});

describe('cooldown 시퀀스 (3.1σ → 3.5σ → 4.2σ → -3.2σ → 다음 거래일)', () => {
  it('알림 횟수와 단계', () => {
    const cd = new Cooldown();
    const sent: string[] = [];
    const feed = (z: number, sd: string) => {
      const lv = reachedLevel('sigma', 3, Math.abs(z), esc);
      if (!lv) return;
      const dir = z > 0 ? 'up' : 'down';
      if (cd.tryFire(cooldownKey('KRX:000660', 'sigma', dir, sd), lv.level)) sent.push(`${sd} ${dir} ${lv.level}`);
    };
    feed(3.1, 'd1'); // 첫 알림 3σ
    feed(3.5, 'd1'); // 같은 단계 → 없음
    feed(4.2, 'd1'); // 4σ
    feed(3.9, 'd1'); // 내려와도 없음
    feed(-3.2, 'd1'); // 반대 방향은 처음부터 3σ
    feed(3.1, 'd2'); // 다음 거래일 리셋 → 3σ
    expect(sent).toEqual(['d1 up 3', 'd1 up 4', 'd1 down 3', 'd2 up 3']);
  });

  it('alert_log에서 오늘 단계 복원', () => {
    const cd = new Cooldown();
    cd.restore([
      { symbol: 'A:B', trigger_type: 'sigma', direction: 'up', level_reached: 3, session_date: 'd1' },
      { symbol: 'A:B', trigger_type: 'sigma', direction: 'up', level_reached: 4, session_date: 'd1' },
      { symbol: 'A:B', trigger_type: 'level', direction: 'near', level_reached: 100, session_date: 'd1' },
    ]);
    const key = cooldownKey('A:B', 'sigma', 'up', 'd1');
    expect(cd.get(key)).toBe(4);
    expect(cd.tryFire(key, 4)).toBe(false);
    expect(cd.tryFire(key, 5)).toBe(true);
  });

  it('지난 거래일 정리', () => {
    const cd = new Cooldown();
    cd.tryFire(cooldownKey('A:B', 'sigma', 'up', '2026-11-01'), 3);
    cd.tryFire(cooldownKey('A:B', 'sigma', 'up', '2026-11-10'), 3);
    cd.prune('2026-11-07');
    expect(cd.get(cooldownKey('A:B', 'sigma', 'up', '2026-11-01'))).toBeUndefined();
    expect(cd.get(cooldownKey('A:B', 'sigma', 'up', '2026-11-10'))).toBe(3);
  });
});

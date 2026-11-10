import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { Journal } from '../src/journal/journal.js';
import { RulesChecker, type RuleWarning } from '../src/journal/rulesCheck.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');
const RULES = { max_trades_per_day: 2, max_loss_R: 1, require_stop_loss: true };

function setup() {
  const repo = new Repo(':memory:');
  const journal = new Journal(repo, logger);
  const checker = new RulesChecker(repo, journal, RULES, logger);
  const warnings: RuleWarning[] = [];
  journal.onRecorded((t) => warnings.push(...checker.check(t)));
  let min = 0;
  const rec = (symbol: string, side: 'buy' | 'sell', qty: number, price: number, sl?: number) =>
    journal.record({ source: 'manual', symbol, side, qty, price, stopLoss: sl, executedAt: new Date(Date.UTC(2026, 10, 10, 1, min++)) });
  return { repo, journal, checker, warnings, rec };
}

describe('매매 규칙 체크', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  it('하루 3번째 진입 → 경고 (한도 2)', () => {
    const s = setup();
    repo = s.repo;
    s.rec('KRX:005930', 'buy', 1, 100, 95);
    s.rec('KRX:005930', 'sell', 1, 101);
    s.rec('KRX:000660', 'buy', 1, 100, 95);
    s.rec('KRX:000660', 'buy', 1, 100); // 같은 거래에 추가 → 진입 아님
    expect(s.warnings.filter((w) => w.rule === 'max_trades_per_day')).toHaveLength(0);
    s.rec('KRX:035420', 'buy', 1, 100, 95);
    const w = s.warnings.filter((x) => x.rule === 'max_trades_per_day');
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toContain('3번째');
    expect(repo.violationsSince('2000-01-01').map((v) => v.rule)).toEqual(['max_trades_per_day']);
  });

  it('-1.5R 청산 → 경고', () => {
    const s = setup();
    repo = s.repo;
    s.rec('KRX:005930', 'buy', 10, 100, 90); // 위험 = 10 × 10 = 100
    s.rec('KRX:005930', 'sell', 10, 85); // -150 → -1.5R
    const w = s.warnings.filter((x) => x.rule === 'max_loss_R');
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toContain('-1.50R');
  });

  it('-0.5R 청산은 경고 없음', () => {
    const s = setup();
    repo = s.repo;
    s.rec('KRX:005930', 'buy', 10, 100, 90);
    s.rec('KRX:005930', 'sell', 10, 95);
    expect(s.warnings).toHaveLength(0);
  });

  it('손절가 없는 진입 → 입력 버튼 경고, 그대로 청산하면 위반 기록. 바로 입력하면 위반 아님', () => {
    const s = setup();
    repo = s.repo;
    s.rec('KRX:005930', 'buy', 10, 100);
    expect(s.warnings).toEqual([expect.objectContaining({ rule: 'require_stop_loss', askStop: true })]);
    expect(repo.violationsSince('2000-01-01')).toHaveLength(0); // 진입 시점에는 기록하지 않음
    s.rec('KRX:005930', 'sell', 10, 101);
    expect(repo.violationsSince('2000-01-01').map((v) => v.rule)).toEqual(['require_stop_loss']);

    // 진입 후 바로 손절가를 넣으면 청산 때 위반이 아니다
    s.rec('KRX:000660', 'buy', 10, 100);
    s.journal.setStop('KRX:000660', 'sl', 95);
    s.rec('KRX:000660', 'sell', 10, 101);
    expect(repo.violationsSince('2000-01-01')).toHaveLength(1);
  });

  it('/rules 요약: 이번 주·이번 달', () => {
    const s = setup();
    repo = s.repo;
    s.rec('KRX:005930', 'buy', 10, 100, 90);
    s.rec('KRX:005930', 'sell', 10, 80);
    const sum = s.checker.summary('2026-11-08T15:00:00.000Z', '2026-10-31T15:00:00.000Z');
    expect(sum.week.get('max_loss_R')).toBe(1);
    expect(sum.month.get('max_loss_R')).toBe(1);
    expect(sum.recent).toHaveLength(1);
  });
});

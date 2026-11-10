/**
 * 내 매매 규칙 위반 체크 (config.yaml trading_rules).
 * - max_trades_per_day: 새 진입(거래 그룹 시작)이 오늘(KST) 한도를 넘으면 즉시 경고·기록
 * - max_loss_R: 청산된 거래의 R이 -max_loss_R보다 나쁘면 경고·기록
 * - require_stop_loss: 손절가 없는 진입에 "손절가 입력" 버튼 경고 (기록은 손절가 없이 청산됐을 때)
 */
import type { Repo, TradeRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import { KST, localDate } from '../time.js';
import type { Journal } from './journal.js';
import type { TradeGroup } from './positions.js';

export interface TradingRules {
  max_trades_per_day: number;
  max_loss_R: number;
  require_stop_loss: boolean;
}

export type RuleName = 'max_trades_per_day' | 'max_loss_R' | 'require_stop_loss';

export const RULE_LABEL: Record<RuleName, string> = {
  max_trades_per_day: '하루 거래 횟수 초과',
  max_loss_R: '최대 손실 R 초과',
  require_stop_loss: '손절가 없이 거래',
};

export interface RuleWarning {
  rule: RuleName;
  symbol: string;
  groupId: string;
  text: string;
  /** 손절가 입력 버튼을 붙일지 */
  askStop: boolean;
}

export class RulesChecker {
  private readonly log: Logger;

  constructor(
    private readonly repo: Repo,
    private readonly journal: Journal,
    private readonly rules: TradingRules,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'rules' });
  }

  /** 새로 기록된 체결들을 검사해 경고 목록을 돌려준다 (위반은 DB에 기록) */
  check(trades: TradeRow[]): RuleWarning[] {
    const out: RuleWarning[] = [];
    const groups = this.journal.groups();
    for (const t of trades) {
      // 0을 지나는 체결은 두 그룹에 속할 수 있다
      for (const g of groups.filter((x) => x.tradeIds.includes(t.id))) {
        if (g.tradeIds[0] === t.id) out.push(...this.onEntry(t, g, groups));
        if (g.closedAt && g.tradeIds.at(-1) === t.id) out.push(...this.onClose(g));
      }
    }
    for (const w of out) this.log.info({ rule: w.rule, symbol: w.symbol, group: w.groupId }, '매매 규칙 경고');
    return out;
  }

  private onEntry(t: TradeRow, g: TradeGroup, all: TradeGroup[]): RuleWarning[] {
    const out: RuleWarning[] = [];
    const day = localDate(new Date(g.openedAt), KST);
    const count = all.filter((x) => localDate(new Date(x.openedAt), KST) === day).length;
    if (count > this.rules.max_trades_per_day) {
      const detail = `오늘 ${count}번째 진입 (한도 ${this.rules.max_trades_per_day})`;
      this.repo.addViolation({ rule: 'max_trades_per_day', symbol: t.symbol, tradeGroup: g.id, detail, at: new Date(g.openedAt) });
      out.push({ rule: 'max_trades_per_day', symbol: t.symbol, groupId: g.id, text: `⚠️ ${RULE_LABEL.max_trades_per_day}: ${detail}`, askStop: false });
    }
    if (this.rules.require_stop_loss && g.initialStop === null) {
      out.push({ rule: 'require_stop_loss', symbol: t.symbol, groupId: g.id, text: '⚠️ 손절가 없이 진입했습니다. 손절가를 입력할까요?', askStop: true });
    }
    return out;
  }

  private onClose(g: TradeGroup): RuleWarning[] {
    const out: RuleWarning[] = [];
    if (g.r !== null && g.r < -this.rules.max_loss_R) {
      const detail = `${g.r.toFixed(2)}R (한도 -${this.rules.max_loss_R}R)`;
      if (this.repo.addViolation({ rule: 'max_loss_R', symbol: g.symbol, tradeGroup: g.id, detail, at: new Date(g.closedAt!) })) {
        out.push({ rule: 'max_loss_R', symbol: g.symbol, groupId: g.id, text: `⚠️ ${RULE_LABEL.max_loss_R}: ${g.id} ${detail}`, askStop: false });
      }
    }
    if (this.rules.require_stop_loss && g.initialStop === null) {
      const detail = '손절가 없이 진입·청산';
      if (this.repo.addViolation({ rule: 'require_stop_loss', symbol: g.symbol, tradeGroup: g.id, detail, at: new Date(g.closedAt!) })) {
        out.push({ rule: 'require_stop_loss', symbol: g.symbol, groupId: g.id, text: `⚠️ ${RULE_LABEL.require_stop_loss}: ${g.id} (R 계산 불가)`, askStop: false });
      }
    }
    return out;
  }

  /** /rules: 이번 주·이번 달 위반 */
  summary(weekStartIso: string, monthStartIso: string): { week: Map<RuleName, number>; month: Map<RuleName, number>; recent: ReturnType<Repo['violationsSince']> } {
    const all = this.repo.violationsSince(weekStartIso < monthStartIso ? weekStartIso : monthStartIso);
    const month = all.filter((r) => r.occurred_at >= monthStartIso);
    const count = (rows: typeof month) => {
      const m = new Map<RuleName, number>();
      for (const r of rows) m.set(r.rule as RuleName, (m.get(r.rule as RuleName) ?? 0) + 1);
      return m;
    };
    return { week: count(all.filter((r) => r.occurred_at >= weekStartIso)), month: count(month), recent: all.slice(-5).reverse() };
  }
}

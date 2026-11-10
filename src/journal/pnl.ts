/** 기간별 실현손익·승률·평균 R (청산된 거래 그룹 기준, 통화별) */
import { KST, localDate } from '../time.js';
import type { TradeGroup } from './positions.js';

export type Period = 'today' | 'week' | 'month' | 'all';

export interface PeriodStats {
  currency: string;
  pnl: number;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  rCount: number;
  best: TradeGroup | undefined;
  worst: TradeGroup | undefined;
}

/** KST 기준 기간 시작 날짜 (YYYY-MM-DD, 포함) */
export function periodStart(period: Period, now = new Date()): string {
  if (period === 'all') return '0000-00-00';
  const today = localDate(now, KST);
  if (period === 'today') return today;
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  // week: 월요일 시작
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // 월=0
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

export function periodStats(groups: TradeGroup[], period: Period, currencyOf: (symbol: string) => string, now = new Date()): PeriodStats[] {
  const start = periodStart(period, now);
  const by = new Map<string, TradeGroup[]>();
  for (const g of groups) {
    if (!g.closedAt) continue;
    if (localDate(new Date(g.closedAt), KST) < start) continue;
    const c = currencyOf(g.symbol);
    by.set(c, [...(by.get(c) ?? []), g]);
  }
  return [...by.entries()].map(([currency, gs]) => {
    const wins = gs.filter((g) => g.pnl > 0).length;
    const losses = gs.filter((g) => g.pnl < 0).length;
    const rs = gs.map((g) => g.r).filter((r): r is number => r !== null);
    const sorted = [...gs].sort((a, b) => b.pnl - a.pnl);
    return {
      currency,
      pnl: gs.reduce((a, g) => a + g.pnl, 0),
      count: gs.length,
      wins,
      losses,
      winRate: gs.length ? wins / gs.length : null,
      avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      rCount: rs.length,
      best: sorted[0],
      worst: sorted.at(-1),
    };
  });
}

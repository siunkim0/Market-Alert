/** 규칙 평가 (순수 함수). 통과한 후보(RuleHit)를 돌려주고, cooldown 판단은 engine이 한다. */
import type { LevelRow, WatchRow } from '../db/repo.js';
import type { Snapshot } from '../market/monitor.js';
import { reachedLevel, type EscalationConfig } from './cooldown.js';

export type Direction = 'up' | 'down';

export type RuleHit =
  | { type: 'sigma' | 'pct'; direction: Direction; level: number; next: number; value: number }
  | { type: 'volume'; direction: 'up'; level: number; value: number }
  | { type: 'level'; phase: 'near' | 'reach'; level: LevelRow; distancePct: number };

export interface RuleConfig {
  esc: EscalationConfig;
  volumeRatio: number;
  /** 장 시작 후 이 시간(분) 동안은 거래량 규칙을 끈다 */
  volumeWarmupMin: number;
  levelDefaultProximityPct: number;
}

/** watchlist 규칙: sigma | pct | volume */
export function evaluateWatch(w: WatchRow, s: Snapshot, cfg: RuleConfig): RuleHit[] {
  const hits: RuleHit[] = [];
  if (!s.quote) return hits;

  const value = w.mode === 'sigma' ? s.z : s.r === null ? null : s.r * 100;
  if (value !== null && value !== 0) {
    const lv = reachedLevel(w.mode, w.threshold, Math.abs(value), cfg.esc);
    if (lv) hits.push({ type: w.mode, direction: value > 0 ? 'up' : 'down', level: lv.level, next: lv.next, value });
  }

  if (
    w.volume_enabled === 1 &&
    s.volumeRatio !== null &&
    s.sessionElapsedMin !== null &&
    s.sessionElapsedMin >= cfg.volumeWarmupMin &&
    s.volumeRatio >= cfg.volumeRatio
  ) {
    hits.push({ type: 'volume', direction: 'up', level: cfg.volumeRatio, value: s.volumeRatio });
  }
  return hits;
}

/** 레벨 규칙. above: 가격 ≥ 레벨이면 도달, below: 가격 ≤ 레벨이면 도달. 그 전 proximity% 이내면 근접. */
export function evaluateLevel(l: LevelRow, price: number, defaultProximityPct: number): RuleHit | undefined {
  if (l.direction === 'cross') return undefined; // 첫 quote에서 방향을 정한 뒤 평가
  const distancePct = ((l.price - price) / l.price) * 100; // +면 레벨이 위에 있음
  const reached = l.direction === 'above' ? price >= l.price : price <= l.price;
  if (reached) return { type: 'level', phase: 'reach', level: l, distancePct };
  const prox = l.proximity_pct ?? defaultProximityPct;
  if (prox > 0 && Math.abs(distancePct) <= prox) return { type: 'level', phase: 'near', level: l, distancePct };
  return undefined;
}

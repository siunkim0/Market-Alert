/** 규칙 평가 (순수 함수). 통과한 후보(RuleHit)를 돌려주고, cooldown 판단은 engine이 한다. */
import type { LevelRow, WatchRow } from '../db/repo.js';
import type { Snapshot } from '../market/monitor.js';
import { reachedLevel, type EscalationConfig } from './cooldown.js';

export type Direction = 'up' | 'down';

export type RuleHit =
  | { type: 'sigma' | 'pct'; direction: Direction; level: number; next: number; value: number }
  | { type: 'volume'; direction: 'up'; level: number; value: number }
  | { type: 'level'; phase: 'near' | 'reach'; level: LevelRow; distancePct: number }
  | { type: 'position'; kind: 'sl' | 'tp'; phase: 'near' | 'reach'; target: number; distancePct: number; groupId: string };

export interface PositionLike {
  qty: number;
  group: { id: string; currentStop: number | null; currentTarget: number | null };
}

/**
 * 보유 포지션 손절·익절 근접/도달. 롱: 손절은 아래, 익절은 위. 숏은 반대.
 * distancePct: 현재가 기준 목표가까지 남은 거리(%, 항상 양수, 도달 시 0 이하)
 */
export function evaluatePosition(p: PositionLike, price: number, proximityPct: number): RuleHit[] {
  const hits: RuleHit[] = [];
  const long = p.qty > 0;
  const check = (kind: 'sl' | 'tp', target: number | null) => {
    if (target === null || !(target > 0)) return;
    // 목표가가 현재가의 '아래'에 있어야 하는 경우: 롱 손절, 숏 익절
    const below = (kind === 'sl') === long;
    const dist = below ? ((price - target) / price) * 100 : ((target - price) / price) * 100;
    if (dist <= 0) hits.push({ type: 'position', kind, phase: 'reach', target, distancePct: dist, groupId: p.group.id });
    else if (dist <= proximityPct) hits.push({ type: 'position', kind, phase: 'near', target, distancePct: dist, groupId: p.group.id });
  };
  check('sl', p.group.currentStop);
  check('tp', p.group.currentTarget);
  return hits;
}

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

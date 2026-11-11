/**
 * 단계 상향과 cooldown.
 * 키: (symbol, trigger_type, direction, session_date). 같은 키에서는 더 높은 단계를 넘을 때만 다시 알린다.
 * session_date가 바뀌면 키가 달라지므로 자동 리셋. 재시작 시 alert_log에서 복원한다.
 */
import type { AlertLogRow, WatchMode } from '../db/repo.js';

export interface EscalationConfig {
  sigmaSteps: number[]; // [3, 4, 5, 6]
  pctStep: number; // 2.5
  pctBase: number; // 기본 pct_threshold (5) — pct 단계 비율 기준
}

const EPS = 1e-9;

/**
 * k번째 단계 값.
 * - sigma: 기준값이 sigma_steps[0]과 같으면 sigma_steps(3→4→5→6) 후 마지막 간격으로 계속,
 *          아니면 기준값 + k × (sigma_steps 간격, 기본 1).
 * - pct: 기준값 × (1 + k × pct_step / pct_threshold 기본값). 기본(5%)이면 5 → 7.5 → 10.
 */
export function ladderStep(mode: WatchMode, base: number, k: number, esc: EscalationConfig): number {
  return round6(rawStep(mode, base, k, esc));
}

/** 부동소수 오차(0.44999…) 제거 */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function rawStep(mode: WatchMode, base: number, k: number, esc: EscalationConfig): number {
  if (mode === 'pct') return base * (1 + (k * esc.pctStep) / esc.pctBase);
  const steps = esc.sigmaSteps;
  const unit = steps.length >= 2 ? steps[steps.length - 1]! - steps[steps.length - 2]! : 1;
  if (steps.length > 0 && Math.abs(steps[0]! - base) < EPS) {
    if (k < steps.length) return steps[k]!;
    return steps[steps.length - 1]! + (k - steps.length + 1) * unit;
  }
  return base + k * (unit > 0 ? unit : 1);
}

/** |value|가 넘은 가장 높은 단계 (못 넘었으면 undefined) */
export function reachedLevel(mode: WatchMode, base: number, absValue: number, esc: EscalationConfig): { k: number; level: number; next: number } | undefined {
  if (!(absValue + EPS >= base)) return undefined;
  let k = 0;
  while (k < 1000 && ladderStep(mode, base, k + 1, esc) <= absValue + EPS) k++;
  return { k, level: ladderStep(mode, base, k, esc), next: ladderStep(mode, base, k + 1, esc) };
}

export function cooldownKey(symbol: string, type: string, direction: string, sessionDate: string): string {
  return `${symbol}|${type}|${direction}|${sessionDate}`;
}

export class Cooldown {
  /** key → 오늘 이미 알린 최고 단계 값 */
  private readonly last = new Map<string, number>();

  /** level이 지난번보다 높으면 기록하고 true */
  tryFire(key: string, level: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && level <= prev + EPS) return false;
    this.last.set(key, level);
    return true;
  }

  get(key: string): number | undefined {
    return this.last.get(key);
  }

  /** alert_log 복원 (sigma/pct/volume만. level은 별도) */
  restore(rows: Pick<AlertLogRow, 'symbol' | 'trigger_type' | 'direction' | 'level_reached' | 'session_date'>[]): number {
    let n = 0;
    for (const r of rows) {
      if (r.trigger_type === 'level' || r.trigger_type === 'position' || r.trigger_type === 'ivol' || r.level_reached === null || !r.direction) continue;
      const key = cooldownKey(r.symbol, r.trigger_type, r.direction, r.session_date);
      const prev = this.last.get(key);
      if (prev === undefined || r.level_reached > prev) {
        this.last.set(key, r.level_reached);
        n++;
      }
    }
    return n;
  }

  /** minDate(YYYY-MM-DD)보다 이전 거래일 키 정리 */
  prune(minDate: string): void {
    for (const k of this.last.keys()) {
      const sd = k.slice(k.lastIndexOf('|') + 1);
      if (sd < minDate) this.last.delete(k);
    }
  }
}

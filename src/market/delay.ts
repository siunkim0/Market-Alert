/**
 * 종목별 지연 판정.
 * 1) quote의 update_mode가 'delayed_streaming_<초>'이면 그대로 쓴다 (TradingView가 알려 줌).
 *    'streaming'이면 실시간.
 * 2) update_mode가 없거나 모르는 값이면 측정: 장중 lag(now - lp_time)가 threshold를 넘는 상태가
 *    persist 동안 지속되면 delayed, threshold 이하가 persist 동안 지속되면 해제.
 */

export interface DelayConfig {
  lagThresholdSec: number;
  lagPersistMin: number;
}

export interface DelayState {
  delayed: boolean;
  /** 지연(초). update_mode 값 또는 측정값 */
  delaySec: number | null;
  source: 'update_mode' | 'measured' | null;
  /** 마지막 quote 수신 시 측정한 lag(초) */
  lastLagSec: number | null;
}

export interface DelayObservation {
  lagSec: number;
  updateMode: string | undefined;
  nowMs: number;
  marketOpen: boolean;
}

interface Internal extends DelayState {
  overSince: number | null;
  underSince: number | null;
}

export function parseUpdateMode(mode: string | undefined): { delayed: boolean; delaySec: number | null } | undefined {
  if (!mode) return undefined;
  const m = /^delayed_streaming_(\d+)$/.exec(mode);
  if (m) return { delayed: true, delaySec: Number(m[1]) };
  if (mode === 'streaming') return { delayed: false, delaySec: null };
  return undefined;
}

export class DelayTracker {
  private readonly states = new Map<string, Internal>();

  constructor(private readonly cfg: DelayConfig) {}

  /** 초기 상태 복원 (DB symbol_meta) */
  seed(symbol: string, delayed: boolean, delaySec: number | null): void {
    this.states.set(symbol, {
      delayed, delaySec, source: delayed ? 'measured' : null, lastLagSec: null, overSince: null, underSince: null,
    });
  }

  get(symbol: string): DelayState {
    const s = this.states.get(symbol);
    return s
      ? { delayed: s.delayed, delaySec: s.delaySec, source: s.source, lastLagSec: s.lastLagSec }
      : { delayed: false, delaySec: null, source: null, lastLagSec: null };
  }

  /** quote 하나를 반영한다. delayed 또는 delaySec가 바뀌면 changed=true. */
  observe(symbol: string, o: DelayObservation): { changed: boolean; state: DelayState } {
    const s: Internal = this.states.get(symbol) ?? {
      delayed: false, delaySec: null, source: null, lastLagSec: null, overSince: null, underSince: null,
    };
    this.states.set(symbol, s);
    const before = `${s.delayed}|${s.delaySec}`;
    s.lastLagSec = Math.max(0, Math.round(o.lagSec));

    const declared = parseUpdateMode(o.updateMode);
    if (declared) {
      s.delayed = declared.delayed;
      s.delaySec = declared.delaySec;
      s.source = 'update_mode';
      s.overSince = s.underSince = null;
    } else if (o.marketOpen) {
      const persistMs = this.cfg.lagPersistMin * 60_000;
      if (o.lagSec > this.cfg.lagThresholdSec) {
        s.underSince = null;
        s.overSince ??= o.nowMs;
        if (o.nowMs - s.overSince >= persistMs) {
          s.delayed = true;
          s.source = 'measured';
          // 분 단위로 반올림해 저장값이 매 quote마다 흔들리지 않게 한다.
          s.delaySec = Math.round(o.lagSec / 60) * 60;
        }
      } else {
        s.overSince = null;
        s.underSince ??= o.nowMs;
        if (s.delayed && o.nowMs - s.underSince >= persistMs) {
          s.delayed = false;
          s.delaySec = null;
          s.source = 'measured';
        }
      }
    }
    return { changed: before !== `${s.delayed}|${s.delaySec}`, state: this.get(symbol) };
  }
}

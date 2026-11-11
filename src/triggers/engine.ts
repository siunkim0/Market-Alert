/**
 * quote 업데이트 → 규칙 평가 → cooldown → AlertEvent.
 * alert_log 기록은 여기서 하고(재시작 복원용), 전송은 AlertSink(notifier)가 한다.
 */
import type { Repo, LevelRow, NewAlertLog, WatchRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { MarketMonitor, Snapshot } from '../market/monitor.js';
import { Cooldown, cooldownKey, type EscalationConfig } from './cooldown.js';
import {
  evaluateIntradayVolume, evaluateLevel, evaluatePosition, evaluateWatch,
  type IntradayVolumeConfig, type RuleConfig, type RuleHit,
} from './rules.js';
import { barPosition, type SessionSpec } from '../market/sessions.js';
import { criteriaOf, type WatchMode } from '../db/repo.js';

export interface HeldPosition {
  qty: number;
  avgPrice: number;
  group: { id: string; currentStop: number | null; currentTarget: number | null };
}

export interface PositionInfo {
  qty: number;
  avgPrice: number;
  unrealized: number;
  unrealizedPct: number;
  /** 손절가까지 남은 거리(%) */
  stopDistancePct: number | null;
}

export interface BenchmarkInfo {
  symbol: string;
  name: string;
  r: number | null;
  delayed: boolean;
}

export interface AlertEvent {
  alertId: number;
  symbol: string;
  displayName: string;
  hit: RuleHit;
  snapshot: Snapshot;
  /** 프로세스가 이 거래일 첫 quote를 받았을 때 이미 넘은 상태였음 (재시작·장 시작 직후) */
  startup: boolean;
  benchmark: BenchmarkInfo | undefined;
  position: PositionInfo | undefined;
}

export interface AlertSink {
  deliver(symbol: string, events: AlertEvent[]): Promise<void>;
}

export interface EngineDeps {
  repo: Repo;
  monitor: MarketMonitor;
  sink: AlertSink;
  logger: Logger;
  rules: RuleConfig;
  /** market → benchmark symbol */
  benchmarks: Record<string, string>;
  nameOf: (symbol: string) => string;
  /** 보유 포지션 (journal). 보유 종목은 watchlist에 없어도 기본 기준으로 감시한다 */
  positionOf?: (symbol: string) => HeldPosition | undefined;
  defaultWatch?: { mode: WatchMode; threshold: number };
  /** 분봉 거래량 알림 (없으면 끔) */
  intradayVolume?: IntradayVolumeConfig & { defaultRatio: number };
  /** 종목 세션 (분봉 위치 판단용) */
  sessionOf?: (symbol: string) => SessionSpec | undefined;
  now?: () => Date;
}

function ivolKey(symbol: string, barTime: number): string {
  return cooldownKey(symbol, 'ivol', 'up', `bar:${barTime}`);
}

function positionKey(symbol: string, kind: string, phase: string, groupId: string, target: number): string {
  return cooldownKey(symbol, 'position', `${kind}_${phase}`, `${groupId}:${target}`);
}

const RESTORE_DAYS = 4;

export class TriggerEngine {
  private readonly log: Logger;
  readonly cooldown = new Cooldown();
  private levels = new Map<string, LevelRow[]>();
  private readonly nearSent = new Set<number>();
  private readonly seen = new Set<string>();
  private pruneTimer: NodeJS.Timeout | undefined;

  constructor(private readonly d: EngineDeps) {
    this.log = d.logger.child({ mod: 'engine' });
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** 재시작 시 오늘 단계 복원 + 레벨 로드 + monitor 구독 */
  start(): void {
    const since = new Date(this.now().getTime() - RESTORE_DAYS * 86_400_000).toISOString();
    const rows = this.d.repo.alertsSince(since);
    let n = this.cooldown.restore(rows);
    for (const r of rows) {
      if (r.trigger_type !== 'position' || !r.direction || r.level_reached === null || r.level_id === null) continue;
      const [kind, phase] = r.direction.split('_');
      if (this.cooldown.tryFire(positionKey(r.symbol, kind!, phase!, `G${r.level_id}`, r.level_reached), 1)) n++;
    }
    for (const r of rows) {
      if (r.trigger_type === 'ivol' && r.level_id !== null && this.cooldown.tryFire(ivolKey(r.symbol, r.level_id), 1)) n++;
    }
    this.log.info({ restored: n }, 'cooldown 단계 복원');
    this.reloadLevels();
    this.d.monitor.addListener((s) => this.onSnapshot(s));
    this.pruneTimer = setInterval(() => {
      const min = new Date(this.now().getTime() - RESTORE_DAYS * 86_400_000).toISOString().slice(0, 10);
      this.cooldown.prune(min);
      for (const k of this.seen) if (k.slice(k.lastIndexOf('|') + 1) < min) this.seen.delete(k);
    }, 3_600_000);
    this.pruneTimer.unref();
  }

  stop(): void {
    clearInterval(this.pruneTimer);
  }

  reloadLevels(): void {
    const m = new Map<string, LevelRow[]>();
    for (const l of this.d.repo.listLevels(true)) {
      const arr = m.get(l.symbol) ?? [];
      arr.push(l);
      m.set(l.symbol, arr);
      if (this.d.repo.levelNearSent(l.id)) this.nearSent.add(l.id);
    }
    this.levels = m;
  }

  levelSymbols(): string[] {
    return [...this.levels.keys()];
  }

  /** /list용: 오늘 이미 알린 단계 (예: '▲4σ ▼3σ') */
  todaySteps(w: WatchRow, sessionDate: string | undefined): string | undefined {
    if (!sessionDate) return undefined;
    const parts: string[] = [];
    for (const c of criteriaOf(w)) {
      const unit = c.mode === 'sigma' ? 'σ' : '%';
      for (const [dir, arrow] of [['up', '▲'], ['down', '▼']] as const) {
        const v = this.cooldown.get(cooldownKey(w.symbol, c.mode, dir, sessionDate));
        if (v !== undefined) parts.push(`${arrow}${fmtLevel(v)}${unit}`);
      }
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  onSnapshot(s: Snapshot): void {
    const q = s.quote;
    if (!q || !s.sessionDate) return;
    const pos = this.d.positionOf?.(s.symbol);
    const w =
      this.d.repo.getWatch(s.symbol) ??
      (pos && this.d.defaultWatch
        ? {
            id: -1, symbol: s.symbol, display_name: null, mode: this.d.defaultWatch.mode,
            threshold: this.d.defaultWatch.threshold,
            sigma_threshold: this.d.defaultWatch.mode === 'sigma' ? this.d.defaultWatch.threshold : null,
            pct_threshold: this.d.defaultWatch.mode === 'pct' ? this.d.defaultWatch.threshold : null,
            volume_enabled: 0, ivol_ratio: 0, muted_until: null, created_at: '',
          }
        : undefined);
    const levels = this.levels.get(s.symbol) ?? [];
    if (!w && levels.length === 0 && !pos) return;
    if (!s.marketOpen) return;

    const now = this.now();
    if (w?.muted_until && new Date(w.muted_until) > now) return;

    const seenKey = `${s.symbol}|${s.sessionDate}`;
    const startup = !this.seen.has(seenKey);
    this.seen.add(seenKey);

    const fired: RuleHit[] = [];

    if (w) {
      for (const hit of evaluateWatch(w, s, this.d.rules)) {
        if (hit.type === 'level' || hit.type === 'position' || hit.type === 'ivol') continue;
        const key = cooldownKey(s.symbol, hit.type, hit.direction, s.sessionDate);
        if (this.cooldown.tryFire(key, hit.level)) fired.push(hit);
      }
    }

    for (const l of levels) {
      if (l.direction === 'cross') {
        // 방향 미정 레벨: 첫 가격 기준으로 정한다
        l.direction = q.price < l.price ? 'above' : 'below';
        this.d.repo.setLevelDirection(l.id, l.direction);
        continue;
      }
      const hit = evaluateLevel(l, q.price, this.d.rules.levelDefaultProximityPct);
      if (!hit || hit.type !== 'level') continue;
      if (hit.phase === 'near') {
        if (this.nearSent.has(l.id)) continue;
        this.nearSent.add(l.id);
      } else {
        this.d.repo.deactivateLevel(l.id);
        this.levels.set(s.symbol, (this.levels.get(s.symbol) ?? []).filter((x) => x.id !== l.id));
      }
      fired.push(hit);
    }

    if (pos) {
      for (const hit of evaluatePosition(pos, q.price, this.d.rules.levelDefaultProximityPct)) {
        if (hit.type !== 'position') continue;
        if (this.cooldown.tryFire(positionKey(s.symbol, hit.kind, hit.phase, hit.groupId, hit.target), 1)) fired.push(hit);
      }
    }

    this.emit(s, w?.display_name ?? null, fired, startup, pos);
  }

  /** 분봉 업데이트 → 거래량 급증 평가 */
  onBars(symbol: string, bars: readonly { time: number; volume: number }[]): void {
    const iv = this.d.intradayVolume;
    if (!iv) return;
    const w = this.d.repo.getWatch(symbol);
    if (!w) return;
    const ratio = w.ivol_ratio ?? iv.defaultRatio;
    if (!(ratio > 0)) return;
    const now = this.now();
    if (w.muted_until && new Date(w.muted_until) > now) return;
    const s = this.d.monitor.snapshot(symbol, now);
    if (!s.quote || !s.sessionDate || !s.marketOpen) return;
    const cur = bars.at(-1);
    const spec = this.d.sessionOf?.(symbol);
    if (!cur || !spec) return;
    const hit = evaluateIntradayVolume(
      bars, ratio, now.getTime(), s.delay.delaySec ?? 0, iv,
      barPosition(spec, new Date(cur.time * 1000), iv.timeframeMin),
    );
    if (!hit || !this.cooldown.tryFire(ivolKey(symbol, cur.time), 1)) return;
    this.emit(s, w.display_name, [hit], false, this.d.positionOf?.(symbol));
  }

  private emit(s: Snapshot, displayName: string | null, fired: RuleHit[], startup: boolean, pos: HeldPosition | undefined): void {
    if (fired.length === 0) return;
    const q = s.quote!;
    const bench = this.benchmarkFor(s);
    const events: AlertEvent[] = fired.map((hit) => ({
      alertId: this.d.repo.insertAlert(this.toLog(s, hit)),
      symbol: s.symbol,
      displayName: displayName ?? this.d.nameOf(s.symbol),
      hit,
      snapshot: s,
      startup,
      benchmark: bench,
      position: pos ? positionInfo(pos, q.price) : undefined,
    }));
    this.log.info(
      { symbol: s.symbol, hits: fired.map(hitLabel), startup },
      '알림 발생',
    );
    this.d.sink.deliver(s.symbol, events).catch((e: Error) => this.log.error({ err: e.message }, '알림 전송 실패'));
  }

  private benchmarkFor(s: Snapshot): BenchmarkInfo | undefined {
    const b = this.d.benchmarks[s.market];
    if (!b || b === s.symbol) return undefined;
    const bs = this.d.monitor.snapshot(b);
    return { symbol: b, name: this.d.nameOf(b), r: bs.r, delayed: bs.delay.delayed };
  }

  private toLog(s: Snapshot, hit: RuleHit): NewAlertLog {
    const q = s.quote!;
    const base = {
      symbol: s.symbol,
      trigger_type: hit.type,
      z: s.z,
      ret_pct: s.r === null ? null : s.r * 100,
      volume_ratio: s.volumeRatio,
      price: q.price,
      price_time: q.priceTime.toISOString(),
      delayed: s.delay.delayed ? 1 : 0,
      session_date: s.sessionDate!,
    };
    if (hit.type === 'level') {
      return { ...base, direction: hit.phase, level_reached: hit.level.price, level_id: hit.level.id };
    }
    if (hit.type === 'ivol') {
      // level_id에 봉 시작 시각(Unix 초)을 넣어 재시작 시 같은 봉 중복을 막는다
      return { ...base, direction: 'up', level_reached: hit.threshold, volume_ratio: hit.ratio, level_id: Math.floor(hit.barStart.getTime() / 1000) };
    }
    if (hit.type === 'position') {
      // level_id에 거래 그룹 번호(G<id>의 id)를 넣어 재시작 시 복원한다
      return { ...base, direction: `${hit.kind}_${hit.phase}`, level_reached: hit.target, level_id: Number(hit.groupId.slice(1)) };
    }
    return { ...base, direction: hit.direction, level_reached: hit.level, level_id: null };
  }
}

export function hitLabel(h: RuleHit): string {
  if (h.type === 'level') return `level:${h.phase}`;
  if (h.type === 'position') return `position:${h.kind}_${h.phase}`;
  if (h.type === 'ivol') return `ivol:${h.timeframeMin}m:${h.ratio.toFixed(1)}x`;
  return `${h.type}:${h.direction}:${h.level}`;
}

export function positionInfo(p: HeldPosition, price: number): PositionInfo {
  const unrealized = (price - p.avgPrice) * p.qty;
  const sl = p.group.currentStop;
  const below = p.qty > 0;
  return {
    qty: p.qty,
    avgPrice: p.avgPrice,
    unrealized,
    unrealizedPct: ((price / p.avgPrice - 1) * 100) * Math.sign(p.qty),
    stopDistancePct: sl === null ? null : below ? ((price - sl) / price) * 100 : ((sl - price) / price) * 100,
  };
}

export function fmtLevel(v: number): string {
  return String(Math.round(v * 100) / 100);
}

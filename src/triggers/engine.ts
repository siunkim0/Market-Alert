/**
 * quote 업데이트 → 규칙 평가 → cooldown → AlertEvent.
 * alert_log 기록은 여기서 하고(재시작 복원용), 전송은 AlertSink(notifier)가 한다.
 */
import type { Repo, LevelRow, NewAlertLog, WatchRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { MarketMonitor, Snapshot } from '../market/monitor.js';
import { Cooldown, cooldownKey, type EscalationConfig } from './cooldown.js';
import { evaluateLevel, evaluateWatch, type RuleConfig, type RuleHit } from './rules.js';

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
  now?: () => Date;
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
    const n = this.cooldown.restore(this.d.repo.alertsSince(since));
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
    const unit = w.mode === 'sigma' ? 'σ' : '%';
    const parts: string[] = [];
    for (const [dir, arrow] of [['up', '▲'], ['down', '▼']] as const) {
      const v = this.cooldown.get(cooldownKey(w.symbol, w.mode, dir, sessionDate));
      if (v !== undefined) parts.push(`${arrow}${fmtLevel(v)}${unit}`);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  onSnapshot(s: Snapshot): void {
    const q = s.quote;
    if (!q || !s.sessionDate) return;
    const w = this.d.repo.getWatch(s.symbol);
    const levels = this.levels.get(s.symbol) ?? [];
    if (!w && levels.length === 0) return;
    if (!s.marketOpen) return;

    const now = this.now();
    if (w?.muted_until && new Date(w.muted_until) > now) return;

    const seenKey = `${s.symbol}|${s.sessionDate}`;
    const startup = !this.seen.has(seenKey);
    this.seen.add(seenKey);

    const fired: RuleHit[] = [];

    if (w) {
      for (const hit of evaluateWatch(w, s, this.d.rules)) {
        if (hit.type === 'level') continue;
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

    if (fired.length === 0) return;

    const bench = this.benchmarkFor(s);
    const events: AlertEvent[] = fired.map((hit) => ({
      alertId: this.d.repo.insertAlert(this.toLog(s, hit)),
      symbol: s.symbol,
      displayName: w?.display_name ?? this.d.nameOf(s.symbol),
      hit,
      snapshot: s,
      startup,
      benchmark: bench,
    }));
    this.log.info(
      { symbol: s.symbol, hits: fired.map((h) => (h.type === 'level' ? `level:${h.phase}` : `${h.type}:${h.direction}:${h.level}`)), startup },
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
    return { ...base, direction: hit.direction, level_reached: hit.level, level_id: null };
  }
}

export function fmtLevel(v: number): string {
  return String(Math.round(v * 100) / 100);
}

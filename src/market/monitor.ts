/**
 * 종목별 최신 quote 상태. 지연 판정, 거래일, r·z 계산을 한곳에서 한다.
 * Phase 3의 trigger engine은 addListener로 붙는다.
 */
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import { DelayTracker, type DelayConfig, type DelayState } from './delay.js';
import { computeReturn, computeZ, type HistoryService } from './history.js';
import type { Quote, SymbolMeta } from './marketData.js';
import { isSessionOpen, marketOf, sessionDate, sessionProgress, type MarketKey, type SessionSpec } from './sessions.js';

export interface Snapshot {
  symbol: string;
  quote: Quote | undefined;
  sessionDate: string | undefined;
  marketOpen: boolean;
  prevClose: number | undefined;
  r: number | null;
  sigma: number | null;
  z: number | null;
  /** 거래량 비율 = 오늘 누적 / (20일 평균 × 장 경과 비율). 계산 불가면 null */
  volumeRatio: number | null;
  /** 가격 시각 기준 장 경과 분 (장 밖이면 null) */
  sessionElapsedMin: number | null;
  market: MarketKey;
  delay: DelayState;
}

const FALLBACK_SPEC: SessionSpec = { session: '24x7', timezone: 'Etc/UTC' };

export class MarketMonitor {
  private readonly log: Logger;
  private readonly latest = new Map<string, Quote>();
  private readonly specs = new Map<string, SessionSpec>();
  private readonly delay: DelayTracker;
  private readonly listeners: ((s: Snapshot) => void)[] = [];

  constructor(
    private readonly repo: Repo,
    private readonly history: HistoryService,
    delayCfg: DelayConfig,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'monitor' });
    this.delay = new DelayTracker(delayCfg);
  }

  /** DB의 symbol_meta로 세션·지연 상태 복원 */
  loadMeta(symbol: string): void {
    const m = this.repo.getMeta(symbol);
    if (!m) return;
    if (m.session && m.timezone) this.specs.set(symbol, { session: m.session, timezone: m.timezone });
    this.delay.seed(symbol, m.delayed === 1, m.measured_delay_sec);
  }

  setMeta(meta: SymbolMeta): void {
    this.specs.set(meta.symbol, { session: meta.session, timezone: meta.timezone });
  }

  timezone(symbol: string): string | undefined {
    return this.specs.get(symbol)?.timezone;
  }

  hasMeta(symbol: string): boolean {
    return this.specs.has(symbol);
  }

  addListener(fn: (s: Snapshot) => void): void {
    this.listeners.push(fn);
  }

  private spec(symbol: string): SessionSpec {
    return this.specs.get(symbol) ?? FALLBACK_SPEC;
  }

  onQuote(q: Quote): void {
    this.latest.set(q.symbol, q);
    const now = q.receivedAt.getTime();
    const prevDelay = this.delay.get(q.symbol).delaySec ?? 0;
    const lagSec = (now - q.priceTime.getTime()) / 1000;
    const { changed, state } = this.delay.observe(q.symbol, {
      lagSec,
      updateMode: q.updateMode,
      nowMs: now,
      marketOpen: isSessionOpen(this.spec(q.symbol), q.receivedAt, prevDelay),
    });
    if (changed) {
      this.repo.setDelay(q.symbol, state.delayed, state.delaySec);
      this.log.info({ symbol: q.symbol, ...state }, '지연 상태 변경');
    }
    if (this.listeners.length > 0) {
      const snap = this.snapshot(q.symbol);
      for (const fn of this.listeners) {
        try {
          fn(snap);
        } catch (e) {
          this.log.error({ err: (e as Error).message }, 'listener 오류');
        }
      }
    }
  }

  snapshot(symbol: string, now = new Date()): Snapshot {
    const quote = this.latest.get(symbol);
    const delay = this.delay.get(symbol);
    const spec = this.spec(symbol);
    const delaySec = delay.delaySec ?? 0;
    const marketOpen = isSessionOpen(spec, now, delaySec);
    const market = marketOf(symbol, this.specs.get(symbol)?.timezone);
    if (!quote) {
      return {
        symbol, quote, sessionDate: undefined, marketOpen, prevClose: undefined, r: null, sigma: null, z: null,
        volumeRatio: null, sessionElapsedMin: null, market, delay,
      };
    }
    // 거래일은 가격 시각 기준 (지연 종목은 lp_time이 이미 과거)
    const sd = sessionDate(spec, quote.priceTime);
    const prevClose = quote.prevClose ?? this.history.lastClose(symbol, sd);
    const r = computeReturn(quote.price, prevClose);
    const sigma = this.history.sigma(symbol, sd);
    const progress = sessionProgress(spec, quote.priceTime);
    let volumeRatio: number | null = null;
    if (progress && quote.volume !== undefined && progress.elapsedMin > 0) {
      const avg = this.history.avgVolume(symbol, sd);
      if (avg) volumeRatio = quote.volume / (avg * Math.min(1, progress.elapsedMin / progress.totalMin));
    }
    return {
      symbol, quote, sessionDate: sd, marketOpen, prevClose, r, sigma, z: computeZ(r, sigma),
      volumeRatio, sessionElapsedMin: progress?.elapsedMin ?? null, market, delay,
    };
  }

  /** 장중 종목이 하나라도 있으면 quote가 와야 한다 (무응답 재연결 판단). */
  expectQuotes(symbols: string[], now = new Date()): boolean {
    return symbols.some((s) => this.specs.has(s) && isSessionOpen(this.spec(s), now, this.delay.get(s).delaySec ?? 0));
  }
}

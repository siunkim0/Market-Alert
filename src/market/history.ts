/** 일봉 캐시와 σ 계산. */
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { Bar, MarketData } from './marketData.js';

/** 일간 수익률 close_t / close_{t-1} - 1 */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (prev > 0) out.push(cur / prev - 1);
  }
  return out;
}

/** 표본 표준편차 (n-1) */
export function sampleStd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * 완성된 일봉(오래된 것부터)으로 σ_window. 최근 window개 수익률을 쓴다.
 * 수익률이 window의 절반보다 적으면(신규 상장 등) null.
 */
export function computeSigma(completedBars: Pick<Bar, 'close'>[], window: number): number | null {
  const closes = completedBars.slice(-(window + 1)).map((b) => b.close);
  const rets = dailyReturns(closes);
  if (rets.length < Math.ceil(window / 2)) return null;
  const s = sampleStd(rets);
  return s && s > 0 ? s : null;
}

export function computeReturn(price: number, prevClose: number | undefined): number | null {
  return prevClose && prevClose > 0 ? price / prevClose - 1 : null;
}

export function computeZ(r: number | null, sigma: number | null): number | null {
  return r === null || !sigma ? null : r / sigma;
}

export class HistoryService {
  private readonly log: Logger;
  /** `${symbol}|${sessionDate}` → σ */
  private readonly sigmaCache = new Map<string, number | null>();
  private readonly volCache = new Map<string, number | null>();

  constructor(
    private readonly repo: Repo,
    private readonly md: MarketData,
    private readonly window: number,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'history' });
  }

  /** 일봉을 받아 캐시한다. 오늘 미완성 봉도 저장되지만 σ 계산 때 sessionDate 기준으로 제외된다. */
  async refresh(symbol: string): Promise<number> {
    const bars = await this.md.dailyBars(symbol, this.window + 5);
    this.repo.upsertBars(symbol, bars);
    for (const c of [this.sigmaCache, this.volCache])
      for (const k of c.keys()) if (k.startsWith(`${symbol}|`)) c.delete(k);
    this.log.debug({ symbol, count: bars.length }, '일봉 갱신');
    return bars.length;
  }

  async refreshAll(symbols: string[]): Promise<void> {
    for (const s of symbols) {
      try {
        await this.refresh(s);
      } catch (e) {
        this.log.warn({ symbol: s, err: (e as Error).message }, '일봉 갱신 실패');
      }
    }
  }

  /** sessionDate 이전에 완성된 봉으로 계산한 σ */
  sigma(symbol: string, sessionDate: string): number | null {
    const key = `${symbol}|${sessionDate}`;
    if (this.sigmaCache.has(key)) return this.sigmaCache.get(key) ?? null;
    const bars = this.repo.getBars(symbol, this.window + 1, sessionDate);
    const s = computeSigma(bars, this.window);
    if (bars.length > 0) this.sigmaCache.set(key, s); // 일봉이 아직 없으면 캐시하지 않는다
    return s;
  }

  /** sessionDate 이전 완성 봉 기준 평균 거래량 (window일). 거래량이 없으면 null */
  avgVolume(symbol: string, sessionDate: string): number | null {
    const key = `${symbol}|${sessionDate}`;
    if (this.volCache.has(key)) return this.volCache.get(key) ?? null;
    const bars = this.repo.getBars(symbol, this.window, sessionDate).filter((b) => b.volume > 0);
    const v = bars.length >= Math.ceil(this.window / 2) ? bars.reduce((a, b) => a + b.volume, 0) / bars.length : null;
    if (bars.length > 0) this.volCache.set(key, v);
    return v;
  }

  /** prevClose 대체값: sessionDate 이전 마지막 완성 봉 종가 */
  lastClose(symbol: string, sessionDate: string): number | undefined {
    return this.repo.getBars(symbol, 1, sessionDate)[0]?.close;
  }
}

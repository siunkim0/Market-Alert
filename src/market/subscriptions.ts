/** watchlist (+ benchmark, 이후 보유 포지션) → 구독 목록 동기화. 변경이 몰리면 debounce한다. */
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { MarketData } from './marketData.js';

export class SubscriptionManager {
  private timer: NodeJS.Timeout | undefined;
  private readonly extraSources: (() => string[])[] = [];
  /** 분봉 구독 대상 (없으면 분봉 구독 안 함) */
  barSymbols: (() => string[]) | undefined;

  constructor(
    private readonly repo: Repo,
    private readonly md: MarketData,
    private readonly logger: Logger,
    private readonly debounceMs = 2_000,
  ) {}

  /** 추가 구독 소스 (benchmark, 보유 포지션 등) */
  addSource(fn: () => string[]): void {
    this.extraSources.push(fn);
  }

  desired(): string[] {
    const set = new Set(this.repo.listWatch().map((w) => w.symbol));
    for (const fn of this.extraSources) for (const s of fn()) set.add(s);
    return [...set];
  }

  /** 구독 갱신 요청 (debounce) */
  request(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.md.setSymbols(this.desired()).catch((e: Error) => this.logger.error({ err: e.message }, '구독 갱신 실패'));
      if (this.barSymbols) {
        this.md.setBarSymbols(this.barSymbols()).catch((e: Error) => this.logger.error({ err: e.message }, '분봉 구독 갱신 실패'));
      }
    }, this.debounceMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

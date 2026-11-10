/** 알림 메시지에 붙일 원인 요약. 같은 종목·방향은 20분 동안 재사용해 LLM 호출을 줄인다. */
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { AlertEvent } from '../triggers/engine.js';
import { formatExplanation } from '../bot/format.js';
import type { Explainer, ExplainResult } from './explain.js';

const CACHE_MS = 20 * 60_000;

export interface Enrichment {
  html: string;
  result: ExplainResult;
}

export class AlertEnricher {
  private readonly log: Logger;
  private readonly cache = new Map<string, { at: number; value: Enrichment }>();

  constructor(
    private readonly explainer: Explainer,
    private readonly repo: Repo,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'enricher' });
  }

  async enrich(ev: AlertEvent, alertIds: number[]): Promise<Enrichment | undefined> {
    const dir = ev.snapshot.r === null ? 'flat' : ev.snapshot.r >= 0 ? 'up' : 'down';
    const key = `${ev.symbol}|${dir}`;
    const hit = this.cache.get(key);
    let value: Enrichment;
    if (hit && Date.now() - hit.at < CACHE_MS) {
      value = hit.value;
    } else {
      const result = await this.explainer.explain({
        symbol: ev.symbol,
        name: ev.displayName,
        description: this.repo.getMeta(ev.symbol)?.description ?? undefined,
        snapshot: ev.snapshot,
        benchmark: ev.benchmark,
      });
      value = { html: formatExplanation(result), result };
      // 실패(fallback)는 캐시하지 않아 다음 알림 때 다시 시도한다
      if (!result.fallback) this.cache.set(key, { at: Date.now(), value });
    }
    const e = value.result.explanation;
    this.repo.setAlertExplanation(alertIds, e.summary.join('\n'), JSON.stringify(e.sources));
    this.log.info({ symbol: ev.symbol, confidence: e.confidence, sources: e.sources.length, fallback: value.result.fallback }, '원인 요약');
    return value;
  }
}

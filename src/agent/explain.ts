/**
 * 움직임 원인 요약. 뉴스 검색 → LLM(smart) → JSON 검증 → 입력에 없던 url 제거.
 * 실패해도 예외를 밖으로 던지지 않는다 (숫자 알림은 이미 나간 상태).
 */
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { Snapshot } from '../market/monitor.js';
import { fmtKst } from '../time.js';
import type { LlmClient } from './llm.js';
import { newsQueryFor, type Article, type NewsSource } from './news.js';

export const ExplanationSchema = z.object({
  market_wide: z.boolean(),
  summary: z.array(z.string().min(1)).min(1).max(3),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).max(5).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

export const NO_NEWS = '명확한 관련 뉴스 없음';

export interface ExplainInput {
  symbol: string;
  name: string;
  description: string | undefined;
  snapshot: Snapshot;
  benchmark: { name: string; r: number | null; delayed: boolean } | undefined;
}

export interface ExplainResult {
  explanation: Explanation;
  articles: Article[];
  /** LLM 없이 만든 결과 (키 없음·실패·기사 없음) */
  fallback: boolean;
}

/** 입력 기사에 없던 url은 제거한다. 제목은 입력 기사 제목으로 맞춘다. */
export function sanitizeSources(e: Explanation, articles: Article[]): Explanation {
  const byUrl = new Map(articles.map((a) => [a.url, a]));
  const seen = new Set<string>();
  const sources = e.sources
    .filter((s) => byUrl.has(s.url) && !seen.has(s.url) && seen.add(s.url))
    .map((s) => ({ title: byUrl.get(s.url)!.title, url: s.url }));
  return { ...e, sources };
}

/** 같은 방향이고 벤치마크가 종목 움직임의 절반 이상이면 시장 전체로 본다 (LLM 없을 때) */
export function heuristicMarketWide(r: number | null, benchR: number | null | undefined): boolean {
  if (r === null || benchR === null || benchR === undefined || r === 0) return false;
  return Math.sign(r) === Math.sign(benchR) && Math.abs(benchR) >= Math.abs(r) * 0.5;
}

const pct = (r: number | null | undefined) => (r === null || r === undefined ? '알 수 없음' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`);

const SYSTEM = `너는 금융 시장 알림 봇의 분석 담당이다. 종목 가격 움직임의 원인을 주어진 뉴스 기사에서만 찾아 한국어로 요약한다.
규칙:
- 기사에 없는 원인은 절대 쓰지 않는다. 추측, 일반론, 투자 조언, 매수·매도 추천 금지.
- 이 종목의 움직임과 직접 관련된 기사가 없으면 summary를 ["${NO_NEWS}"]로 하고 sources는 빈 배열, confidence는 "low".
- summary는 최대 3개, 각각 한 문장(60자 안팎). 가장 중요한 원인부터.
- sources에는 근거로 쓴 기사만 넣고, title과 url은 입력 목록에 있는 값을 그대로 복사한다.
- market_wide: 비교 지수도 같은 방향으로 크게 움직였거나 기사가 시장 전체 요인을 말하면 true, 종목 고유 요인이면 false.
- 가격이 지연 데이터라면 그 사이 나온 기사도 원인일 수 있다.
- confidence: 기사들이 움직임을 직접 설명하면 high, 간접적이면 medium, 약하면 low.
출력은 아래 JSON 객체 하나만:
{"market_wide": boolean, "summary": ["..."], "sources": [{"title": "...", "url": "..."}], "confidence": "low"|"medium"|"high"}`;

export function buildPrompt(input: ExplainInput, articles: Article[], now = new Date()): string {
  const s = input.snapshot;
  const q = s.quote!;
  const delayMin = s.delay.delayed && s.delay.delaySec ? Math.round(s.delay.delaySec / 60) : 0;
  const lines = [
    `종목: ${input.name} (${input.symbol})${input.description && input.description !== input.name ? ` — ${input.description}` : ''}`,
    `현재가 ${q.price}, 전일 대비 ${pct(s.r)}` +
      (s.z !== null ? `, ${s.z >= 0 ? '+' : ''}${s.z.toFixed(1)}σ (20일 σ ${s.sigma !== null ? (s.sigma * 100).toFixed(2) : '?'}%)` : ''),
    `가격 시각 ${fmtKst(q.priceTime, now)} KST${delayMin ? ` — 가격은 ${delayMin}분 지연 데이터` : ''}`,
    input.benchmark ? `비교 지수 ${input.benchmark.name}: ${pct(input.benchmark.r)}${input.benchmark.delayed ? ' (지연)' : ''}` : '비교 지수: 없음',
    s.volumeRatio !== null ? `거래량: 평소 대비 ${s.volumeRatio.toFixed(1)}배` : '',
    '',
    `최근 24시간 기사 (${articles.length}건):`,
    ...articles.map(
      (a, i) => `[${i + 1}] ${a.title} | ${a.source ?? '-'} | ${fmtKst(a.publishedAt, now)} KST | ${a.url}`,
    ),
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export class Explainer {
  private readonly log: Logger;

  constructor(
    private readonly llm: LlmClient | undefined,
    private readonly news: NewsSource,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'explain' });
  }

  async explain(input: ExplainInput): Promise<ExplainResult> {
    const s = input.snapshot;
    let articles: Article[] = [];
    try {
      articles = await this.news.search(newsQueryFor(input.symbol, s.market, input.name, input.description));
    } catch (e) {
      this.log.warn({ symbol: input.symbol, err: (e as Error).message }, '뉴스 검색 실패');
    }

    const fallback = (): ExplainResult => ({
      explanation: {
        market_wide: heuristicMarketWide(s.r, input.benchmark?.r),
        summary: [NO_NEWS],
        sources: [],
        confidence: 'low',
      },
      articles,
      fallback: true,
    });

    if (articles.length === 0 || !this.llm || !s.quote) return fallback();

    try {
      const raw = await this.llm.json({ tier: 'smart', system: SYSTEM, user: buildPrompt(input, articles), schema: ExplanationSchema });
      const explanation = sanitizeSources(raw, articles);
      if (explanation.sources.length === 0 && explanation.summary[0] !== NO_NEWS) {
        // 근거를 하나도 대지 못한 요약은 믿지 않는다
        explanation.confidence = 'low';
      }
      return { explanation, articles, fallback: false };
    } catch (e) {
      this.log.warn({ symbol: input.symbol, err: (e as Error).message }, '원인 요약 실패');
      return fallback();
    }
  }
}

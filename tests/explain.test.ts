import { describe, expect, it } from 'vitest';
import { Explainer, NO_NEWS, heuristicMarketWide, sanitizeSources } from '../src/agent/explain.js';
import { extractJson } from '../src/agent/llm.js';
import type { Article, NewsSource } from '../src/agent/news.js';
import { createLogger } from '../src/logger.js';
import type { Snapshot } from '../src/market/monitor.js';
import { makeQuote } from './fakes/fakeMarketData.js';
import { FakeLlm } from './fakes/fakeLlm.js';

const logger = createLogger('silent');
const now = new Date();
const articles: Article[] = [
  { title: 'SK하이닉스, HBM 공급 계약', source: '연합', url: 'https://news.example/a', publishedAt: now },
  { title: '반도체 업황 둔화 우려', source: '매경', url: 'https://news.example/b', publishedAt: now },
];

const snap: Snapshot = {
  symbol: 'KRX:000660',
  quote: makeQuote('KRX:000660', 210000, 200000, now, now, 'delayed_streaming_1200'),
  sessionDate: '2026-11-10', marketOpen: true, prevClose: 200000, r: 0.05, sigma: 0.02, z: 2.5,
  volumeRatio: null, sessionElapsedMin: 100, market: 'KRX',
  delay: { delayed: true, delaySec: 1200, source: 'update_mode', lastLagSec: 1200 },
};

const news = (list: Article[]): NewsSource => ({ search: async () => list });
const input = { symbol: 'KRX:000660', name: 'SK하이닉스', description: 'SK hynix Inc.', snapshot: snap, benchmark: { name: 'KOSPI', r: -0.004, delayed: false } };

describe('원인 요약', () => {
  it('입력에 없던 url은 제거한다', () => {
    const out = sanitizeSources(
      {
        market_wide: false,
        summary: ['HBM 공급 계약'],
        sources: [
          { title: '조작된 제목', url: 'https://news.example/a' },
          { title: '없는 기사', url: 'https://evil.example/x' },
          { title: '중복', url: 'https://news.example/a' },
        ],
        confidence: 'high',
      },
      articles,
    );
    expect(out.sources).toEqual([{ title: 'SK하이닉스, HBM 공급 계약', url: 'https://news.example/a' }]);
  });

  it('LLM 응답(mock)에서 만든 url은 빠지고, 지연·벤치마크가 프롬프트에 들어간다', async () => {
    const llm = new FakeLlm({
      market_wide: false,
      summary: ['HBM 공급 계약 소식', '외국인 순매수'],
      sources: [{ title: 'x', url: 'https://news.example/a' }, { title: 'y', url: 'https://made-up.example/z' }],
      confidence: 'medium',
    });
    const r = await new Explainer(llm, news(articles), logger).explain(input);
    expect(r.fallback).toBe(false);
    expect(r.explanation.sources.map((s) => s.url)).toEqual(['https://news.example/a']);
    expect(llm.prompts[0]!.tier).toBe('smart');
    expect(llm.prompts[0]!.user).toContain('20분 지연');
    expect(llm.prompts[0]!.user).toContain('KOSPI');
    expect(llm.prompts[0]!.user).toContain('https://news.example/b');
  });

  it('관련 기사가 없으면 LLM 없이 "명확한 관련 뉴스 없음"', async () => {
    const llm = new FakeLlm({});
    const r = await new Explainer(llm, news([]), logger).explain(input);
    expect(r.explanation.summary).toEqual([NO_NEWS]);
    expect(r.explanation.sources).toEqual([]);
    expect(llm.prompts).toHaveLength(0);
  });

  it('LLM이 실패해도 예외 없이 fallback', async () => {
    const bad = { json: async () => { throw new Error('boom'); }, tools: async () => ({ kind: 'text' as const, text: '' }) };
    const r = await new Explainer(bad, news(articles), logger).explain(input);
    expect(r.fallback).toBe(true);
    expect(r.articles).toHaveLength(2);
  });

  it('뉴스 검색이 실패해도 예외 없이 fallback', async () => {
    const failing: NewsSource = { search: async () => { throw new Error('network'); } };
    const r = await new Explainer(new FakeLlm({}), failing, logger).explain(input);
    expect(r.explanation.summary).toEqual([NO_NEWS]);
  });

  it('시장 전체 판정 휴리스틱과 JSON 추출', () => {
    expect(heuristicMarketWide(-0.03, -0.02)).toBe(true);
    expect(heuristicMarketWide(-0.03, -0.004)).toBe(false);
    expect(heuristicMarketWide(0.03, -0.02)).toBe(false);
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('결과: {"a":1} 끝')).toBe('{"a":1}');
  });
});

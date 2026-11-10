/** 뉴스 검색. 현재는 Google News RSS (키 불필요). 네이버·Finnhub는 NewsSource를 구현해 추가한다. */
import type { Logger } from '../logger.js';
import type { MarketKey } from '../market/sessions.js';

export interface Article {
  title: string;
  source: string | undefined;
  url: string;
  publishedAt: Date;
}

export interface NewsQuery {
  query: string;
  lang: 'ko' | 'en';
}

export interface NewsSource {
  search(q: NewsQuery, opts?: { maxAgeHours?: number; limit?: number }): Promise<Article[]>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function tag(item: string, name: string): string | undefined {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? decodeEntities(m[1]!).trim() : undefined;
}

/** Google News RSS 파싱. 제목 끝의 ' - 언론사'는 source로 분리한다. */
export function parseGoogleNewsRss(xml: string): Article[] {
  const out: Article[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const rawTitle = tag(item, 'title');
    const url = tag(item, 'link');
    const pub = tag(item, 'pubDate');
    if (!rawTitle || !url || !pub) continue;
    const source = tag(item, 'source');
    const publishedAt = new Date(pub);
    if (Number.isNaN(publishedAt.getTime())) continue;
    let title = rawTitle;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    out.push({ title, source, url, publishedAt });
  }
  return out;
}

export class GoogleNewsRss implements NewsSource {
  private readonly log: Logger;

  constructor(logger: Logger, private readonly fetchImpl: typeof fetch = fetch) {
    this.log = logger.child({ mod: 'news' });
  }

  async search(q: NewsQuery, opts: { maxAgeHours?: number; limit?: number } = {}): Promise<Article[]> {
    const maxAge = opts.maxAgeHours ?? 24;
    const limit = opts.limit ?? 10;
    const loc = q.lang === 'ko' ? { hl: 'ko', gl: 'KR', ceid: 'KR:ko' } : { hl: 'en-US', gl: 'US', ceid: 'US:en' };
    const params = new URLSearchParams({ q: `${q.query} when:1d`, ...loc });
    const url = `https://news.google.com/rss/search?${params.toString()}`;
    let xml = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        xml = await res.text();
        break;
      } catch (e) {
        if (attempt === 1) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const cutoff = Date.now() - maxAge * 3_600_000;
    const seen = new Set<string>();
    const articles = parseGoogleNewsRss(xml)
      .filter((a) => a.publishedAt.getTime() >= cutoff)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .filter((a) => {
        const k = a.title.replace(/\s+/g, '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, limit);
    this.log.debug({ query: q.query, count: articles.length }, '뉴스 검색');
    return articles;
  }
}

/** 종목 → 뉴스 검색어 */
export function newsQueryFor(symbol: string, market: MarketKey, name: string, description?: string): NewsQuery {
  const ticker = symbol.split(':')[1] ?? symbol;
  if (market === 'KRX') return { query: `"${name}"`, lang: 'ko' };
  if (market === 'CRYPTO') {
    // 'Bitcoin / TetherUS' → Bitcoin, 없으면 BTCUSDT → BTC
    const base = description?.split('/')[0]?.trim() || ticker.replace(/(USDT|USDC|USD|BUSD|KRW)(\.P)?$/, '');
    return { query: `${base} crypto`, lang: 'en' };
  }
  const company = (description ?? name).replace(/\b(Inc|Corp|Corporation|Co|Ltd|plc|Class [A-Z])\b\.?,?/gi, '').trim();
  return { query: `${company} ${ticker} stock`, lang: 'en' };
}

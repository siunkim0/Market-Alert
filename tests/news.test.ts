import { describe, expect, it } from 'vitest';
import { decodeEntities, newsQueryFor, parseGoogleNewsRss } from '../src/agent/news.js';

const xml = `<rss><channel>
<item><title>SK하이닉스 세금만 2조 육박…이천시 곳간의 변화 - 연합인포맥스</title><link>https://news.google.com/rss/articles/AAA?oc=5</link><pubDate>Tue, 10 Nov 2026 03:21:01 GMT</pubDate><source url="https://news.einfomax.co.kr">연합인포맥스</source></item>
<item><title>A &amp; B &quot;rally&quot; - Reuters</title><link>https://news.google.com/rss/articles/BBB</link><pubDate>Mon, 09 Nov 2026 23:13:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>no date</title><link>x</link></item>
</channel></rss>`;

describe('Google News RSS', () => {
  it('파싱: 제목에서 언론사 분리, 엔티티 디코드', () => {
    const a = parseGoogleNewsRss(xml);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ title: 'SK하이닉스 세금만 2조 육박…이천시 곳간의 변화', source: '연합인포맥스', url: 'https://news.google.com/rss/articles/AAA?oc=5' });
    expect(a[1]!.title).toBe('A & B "rally"');
    expect(decodeEntities('&#39;x&#x27;')).toBe("'x'");
  });

  it('검색어', () => {
    expect(newsQueryFor('KRX:000660', 'KRX', 'SK하이닉스')).toEqual({ query: '"SK하이닉스"', lang: 'ko' });
    expect(newsQueryFor('BINANCE:BTCUSDT', 'CRYPTO', 'BTC', 'Bitcoin / TetherUS')).toEqual({ query: 'Bitcoin crypto', lang: 'en' });
    expect(newsQueryFor('BINANCE:ETHUSDC.P', 'CRYPTO', 'ETH')).toEqual({ query: 'ETH crypto', lang: 'en' });
    expect(newsQueryFor('NASDAQ:AAPL', 'US', 'Apple', 'Apple Inc.')).toEqual({ query: 'Apple AAPL stock', lang: 'en' });
  });
});

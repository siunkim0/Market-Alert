import { describe, expect, it } from 'vitest';
import { parseAddArgs } from '../src/bot/commands.js';
import { parseAliases } from '../src/config.js';
import { SymbolResolver } from '../src/market/symbols.js';
import { FakeMarketData } from './fakes/fakeMarketData.js';

const aliases = parseAliases({
  'KRX:005930': { name: '삼성전자', aliases: ['삼성', '삼전'] },
  'KRX:000660': { name: 'SK하이닉스', aliases: ['하이닉스', 'sk hynix'] },
});

describe('종목 해석', () => {
  const md = new FakeMarketData();
  const r = new SymbolResolver(aliases, md);

  it('별칭 사전 (대소문자·공백 무시)', async () => {
    expect(await r.resolve('삼성전자')).toEqual({ kind: 'resolved', symbol: 'KRX:005930', displayName: '삼성전자' });
    expect(await r.resolve('하이닉스')).toMatchObject({ symbol: 'KRX:000660' });
    expect(await r.resolve('SK Hynix')).toMatchObject({ symbol: 'KRX:000660' });
    expect(await r.resolve('SK 하이닉스')).toMatchObject({ symbol: 'KRX:000660' });
  });

  it('EXCH:TICKER는 그대로 (대문자화)', async () => {
    expect(await r.resolve('binance:btcusdt')).toMatchObject({ kind: 'resolved', symbol: 'BINANCE:BTCUSDT' });
    expect(await r.resolve('BINANCE:BTCUSDC.P')).toMatchObject({ symbol: 'BINANCE:BTCUSDC.P' });
  });

  it('검색: 주요 거래소 정확한 티커는 바로 선택, 아니면 후보', async () => {
    md.candidates = [
      { symbol: 'NASDAQ:AAPL', description: 'Apple Inc.', type: 'stock', exchange: 'NASDAQ', country: 'US' },
      { symbol: 'TSX:AAPL', description: 'Apple CDR', type: 'dr', exchange: 'TSX', country: 'CA' },
      { symbol: 'BMV:AAPL', description: 'AAPL Futures', type: 'futures', exchange: 'BMV', country: 'MX' },
    ];
    expect(await r.resolve('AAPL')).toMatchObject({ kind: 'resolved', symbol: 'NASDAQ:AAPL' });
    const c = await r.resolve('apple');
    expect(c.kind).toBe('choices');
    md.candidates = [];
    expect(await r.resolve('없는종목')).toEqual({ kind: 'notfound' });
  });

  it('watchlist 매칭', () => {
    expect(r.matches('삼전', 'KRX:005930', '삼성전자')).toBe(true);
    expect(r.matches('005930', 'KRX:005930', null)).toBe(true);
    expect(r.matches('aapl', 'NASDAQ:AAPL', 'Apple Inc.')).toBe(true);
    expect(r.matches('삼전', 'KRX:000660', 'SK하이닉스')).toBe(false);
  });
});

describe('/add 인자', () => {
  it('파싱', () => {
    expect(parseAddArgs('삼성전자')).toEqual({ query: '삼성전자', mode: undefined, threshold: undefined });
    expect(parseAddArgs('SK 하이닉스 pct 4')).toEqual({ query: 'SK 하이닉스', mode: 'pct', threshold: 4 });
    expect(parseAddArgs('AAPL SIGMA 2.5')).toEqual({ query: 'AAPL', mode: 'sigma', threshold: 2.5 });
    expect(parseAddArgs('AAPL pct')).toEqual({ query: 'AAPL', mode: 'pct', threshold: undefined });
    expect(parseAddArgs('AAPL pct -1')).toHaveProperty('error');
    expect(parseAddArgs('')).toHaveProperty('error');
  });
});

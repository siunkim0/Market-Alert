/** 테스트용 MarketData. 녹화한 quote 시퀀스를 재생한다. 엔진 테스트는 이걸로 한다. */
import {
  MarketDataError,
  type Bar,
  type FeedStatus,
  type IntradayBar,
  type MarketData,
  type Quote,
  type SymbolCandidate,
  type SymbolMeta,
  type TvWatchlist,
} from '../../src/market/marketData.js';

export class FakeMarketData implements MarketData {
  symbols: string[] = [];
  private onQuote: ((q: Quote) => void) | undefined;
  bars = new Map<string, Bar[]>();
  metas = new Map<string, SymbolMeta>();
  candidates: SymbolCandidate[] = [];

  async watch(symbols: string[], onQuote: (q: Quote) => void): Promise<void> {
    this.symbols = symbols;
    this.onQuote = onQuote;
  }
  async setSymbols(symbols: string[]): Promise<void> {
    this.symbols = symbols;
  }
  /** 녹화한 quote 재생 */
  replay(quotes: Quote[]): void {
    for (const q of quotes) this.onQuote?.(q);
  }
  barSymbols: string[] = [];
  private onBars: ((s: string, b: readonly IntradayBar[]) => void) | undefined;
  async watchBars(_tf: string, _n: number, onBars: (s: string, b: readonly IntradayBar[]) => void): Promise<void> {
    this.onBars = onBars;
  }
  async setBarSymbols(symbols: string[]): Promise<void> {
    this.barSymbols = symbols;
  }
  replayBars(symbol: string, bars: IntradayBar[]): void {
    this.onBars?.(symbol, bars);
  }
  quotes = new Map<string, Quote>();
  async quote(symbol: string): Promise<Quote> {
    const q = this.quotes.get(symbol);
    if (!q) throw new MarketDataError('QUOTE_ERROR', 'no quote', symbol);
    return q;
  }
  async dailyBars(symbol: string, count: number): Promise<Bar[]> {
    return (this.bars.get(symbol) ?? []).slice(-count);
  }
  async symbolInfo(symbol: string): Promise<SymbolMeta> {
    const m = this.metas.get(symbol);
    if (!m) throw new MarketDataError('SYMBOL_ERROR', 'invalid symbol', symbol);
    return m;
  }
  async search(): Promise<SymbolCandidate[]> {
    return this.candidates;
  }
  async watchlists(): Promise<TvWatchlist[]> {
    return [];
  }
  status(): FeedStatus {
    return { connected: true, symbols: this.symbols, reconnects: 0, lastQuoteAt: undefined, lastConnectAt: undefined, lastError: undefined };
  }
  async close(): Promise<void> {}
}

export function makeQuote(symbol: string, price: number, prevClose: number, priceTime: Date, receivedAt: Date, updateMode?: string): Quote {
  return {
    symbol, price, prevClose, volume: undefined, priceTime, receivedAt,
    changePct: (price / prevClose - 1) * 100, updateMode, raw: {},
  };
}

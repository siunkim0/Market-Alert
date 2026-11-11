/** 시세 소스 추상화. TradingView 외 소스(한투 API 등)를 붙일 때 이 인터페이스만 구현한다. */

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number | undefined;
  volume: number | undefined;
  /** 가격 시각 (lp_time). 지연 종목은 현재 시각보다 과거다. */
  priceTime: Date;
  /** quote를 받은 시각 */
  receivedAt: Date;
  changePct: number | undefined;
  /** 소스가 알려 주는 지연 정보 (TradingView: 'streaming' | 'delayed_streaming_1200' ...) */
  updateMode: string | undefined;
  raw: Record<string, unknown>;
}

export interface Bar {
  /** 거래소 현지 날짜 YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 분봉 (time: 봉 시작 Unix 초) */
export interface IntradayBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolMeta {
  symbol: string;
  description: string;
  localDescription: string | undefined;
  currency: string | undefined;
  timezone: string;
  /** 정규장 세션 문자열. 예: '0900-1535', '24x7' */
  session: string;
  type: string | undefined;
}

export interface SymbolCandidate {
  symbol: string;
  description: string;
  type: string;
  exchange: string;
  country: string | undefined;
}

export interface TvWatchlist {
  id: number;
  name: string;
  symbols: string[];
}

export interface FeedStatus {
  /** 분봉 구독 상태 */
  bars?: { connected: boolean; symbols: string[]; reconnects: number; timeframe: string };
  connected: boolean;
  symbols: string[];
  reconnects: number;
  lastQuoteAt: Date | undefined;
  lastConnectAt: Date | undefined;
  lastError: string | undefined;
}

export class MarketDataError extends Error {
  constructor(
    readonly code: 'SYMBOL_ERROR' | 'QUOTE_ERROR' | 'NO_CREDENTIALS' | 'NETWORK' | 'OTHER',
    message: string,
    readonly symbol?: string,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export interface MarketData {
  watch(symbols: string[], onQuote: (q: Quote) => void, onError: (e: MarketDataError) => void): Promise<void>;
  /** 구독 목록 교체 */
  setSymbols(symbols: string[]): Promise<void>;
  /** 분봉 실시간 구독. onBars는 오래된 것부터 count개(마지막은 만들어지는 중인 봉) */
  watchBars(
    timeframe: string,
    count: number,
    onBars: (symbol: string, bars: readonly IntradayBar[]) => void,
    onError: (e: MarketDataError) => void,
  ): Promise<void>;
  setBarSymbols(symbols: string[]): Promise<void>;
  /** 구독하지 않은 종목의 현재 quote 1회 조회 */
  quote(symbol: string): Promise<Quote>;
  dailyBars(symbol: string, count: number): Promise<Bar[]>;
  symbolInfo(symbol: string): Promise<SymbolMeta>;
  search(query: string): Promise<SymbolCandidate[]>;
  /** 계정 쿠키가 있을 때만 */
  watchlists(): Promise<TvWatchlist[]>;
  status(): FeedStatus;
  close(): Promise<void>;
}

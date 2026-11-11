/**
 * TradingView 래퍼. 이 프로젝트에서 @mathieuc/tradingview를 import하는 유일한 파일이다.
 */
import {
  TradingViewClient,
  watchCandles,
  type CandleWatcher,
  getCandles,
  getQuote,
  getSymbolInfo,
  getWatchlists,
  searchMarkets,
  TradingViewError,
  watchQuotes,
  type QuoteData,
  type QuoteField,
  type QuoteWatcher,
} from '@mathieuc/tradingview';
import { z } from 'zod';
import type { Logger } from '../logger.js';
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
} from './marketData.js';

const QUOTE_FIELDS: QuoteField[] = [
  'lp', 'lp_time', 'prev_close_price', 'volume', 'ch', 'chp', 'update_mode', 'current_session',
  'description', 'local_description', 'short_name', 'pro_name', 'currency_code', 'type', 'timezone',
];

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const STALE_CHECK_MS = 10_000;
const STALE_AFTER_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;

/** quote 원본 중 쓰는 필드만 검증. 숫자가 아니면 undefined로 취급한다. */
const num = z.number().finite().optional().catch(undefined);
const QuoteFieldsSchema = z.object({
  lp: num,
  lp_time: num,
  prev_close_price: num,
  volume: num,
  chp: num,
  update_mode: z.string().optional().catch(undefined),
});

const CandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().catch(0),
});

const SymbolInfoSchema = z.object({
  pro_name: z.string().optional(),
  full_name: z.string().optional(),
  description: z.string().default(''),
  currency_code: z.string().optional(),
  timezone: z.string(),
  session: z.string(),
  type: z.string().optional(),
});

/** 지수 등에서 오는 1e100 같은 무의미한 거래량은 버린다. */
function sanitizeVolume(v: number | undefined): number | undefined {
  return v === undefined || v < 0 || v >= 1e90 ? undefined : v;
}

export function toQuote(symbol: string, data: QuoteData, receivedAt = new Date()): Quote | undefined {
  const f = QuoteFieldsSchema.parse(data);
  if (f.lp === undefined || f.lp_time === undefined) return undefined;
  return {
    symbol,
    price: f.lp,
    prevClose: f.prev_close_price,
    volume: sanitizeVolume(f.volume),
    priceTime: new Date(f.lp_time * 1000),
    receivedAt,
    changePct: f.chp,
    updateMode: f.update_mode,
    raw: { ...data },
  };
}

function toMdError(e: unknown, symbol?: string): MarketDataError {
  if (e instanceof MarketDataError) return e;
  if (e instanceof TradingViewError) {
    if (e.code === 'SYMBOL_ERROR') return new MarketDataError('SYMBOL_ERROR', e.message, symbol);
    if (e.code === 'QUOTE_ERROR') return new MarketDataError('QUOTE_ERROR', e.message, symbol);
    if (['CONNECTION_ERROR', 'DISCONNECTED', 'TIMEOUT'].includes(e.code))
      return new MarketDataError('NETWORK', `${e.code}: ${e.message}`, symbol);
    return new MarketDataError('OTHER', `${e.code}: ${e.message}`, symbol);
  }
  return new MarketDataError('OTHER', e instanceof Error ? e.message : String(e), symbol);
}

/** 일시적 실패만 재시도한다. 존재하지 않는 symbol 등은 바로 실패. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const err = toMdError(e);
      if (err.code === 'SYMBOL_ERROR' || err.code === 'QUOTE_ERROR') throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw toMdError(last);
}

export interface TradingViewOptions {
  logger: Logger;
  credentials?: { session: string; signature?: string };
  /** 지금 quote가 들어와야 하는 시각인지 (장중 종목이 하나라도 있는지). 무응답 재연결 판단용. */
  expectQuotes?: () => boolean;
}

export class TradingViewMarketData implements MarketData {
  private readonly log: Logger;
  private readonly credentials: TradingViewOptions['credentials'];
  private expectQuotes: () => boolean;

  private symbols: string[] = [];
  private onQuote: ((q: Quote) => void) | undefined;
  private onError: ((e: MarketDataError) => void) | undefined;
  private watcher: QuoteWatcher | undefined;
  private running = false;
  private generation = 0;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;
  private readonly rawLogged = new Set<string>();

  private st: Omit<FeedStatus, 'symbols'> = {
    connected: false,
    reconnects: 0,
    lastQuoteAt: undefined,
    lastConnectAt: undefined,
    lastError: undefined,
  };

  constructor(opts: TradingViewOptions) {
    this.log = opts.logger.child({ mod: 'tradingview' });
    this.credentials = opts.credentials;
    this.expectQuotes = opts.expectQuotes ?? (() => true);
  }

  setExpectQuotes(fn: () => boolean): void {
    this.expectQuotes = fn;
  }

  private get connOpts() {
    return this.credentials ? { credentials: this.credentials } : {};
  }

  // ── 실시간 구독 ────────────────────────────────────────────
  async watch(symbols: string[], onQuote: (q: Quote) => void, onError: (e: MarketDataError) => void): Promise<void> {
    this.onQuote = onQuote;
    this.onError = onError;
    this.running = true;
    this.symbols = [...new Set(symbols)];
    this.staleTimer = setInterval(() => this.checkStale(), STALE_CHECK_MS);
    await this.connect('start');
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const next = [...new Set(symbols)].sort();
    if (next.join(',') === [...this.symbols].sort().join(',')) return;
    this.log.info({ symbols: next }, '구독 목록 변경');
    this.symbols = next;
    if (this.running) await this.connect('symbols-changed');
  }

  private async connect(reason: string): Promise<void> {
    if (!this.running) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const gen = ++this.generation;
    await this.stopWatcher();

    if (this.symbols.length === 0) {
      this.st.connected = false;
      this.log.info('구독할 종목 없음');
      return;
    }

    try {
      const w = await watchQuotes(
        { symbols: this.symbols, fields: QUOTE_FIELDS, timeoutMs: CALL_TIMEOUT_MS, ...this.connOpts },
        {
          onData: (symbol, quote) => {
            if (gen === this.generation) this.handleData(symbol, quote);
          },
          onError: (e) => {
            if (gen === this.generation) this.handleError(e);
          },
        },
      );
      if (gen !== this.generation || !this.running) {
        await w.stop();
        return;
      }
      this.watcher = w;
      this.backoffMs = BACKOFF_MIN_MS;
      this.st.connected = true;
      this.st.lastConnectAt = new Date();
      this.st.lastQuoteAt ??= new Date();
      this.log.info({ reason, count: this.symbols.length }, '시세 구독 시작');
      void w.closed.then(() => {
        if (this.watcher !== w || !this.running) return;
        this.watcher = undefined;
        this.st.connected = false;
        this.log.warn('시세 연결이 닫힘 → 재연결 예약');
        this.scheduleReconnect('closed');
      });
    } catch (e) {
      if (gen !== this.generation) return;
      const err = toMdError(e);
      this.st.connected = false;
      this.st.lastError = err.message;
      this.log.error({ err: err.message, code: err.code }, '시세 구독 실패');
      this.onError?.(err);
      this.scheduleReconnect('connect-failed');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.st.reconnects += 1;
    this.log.warn({ reason, delayMs: delay, reconnects: this.st.reconnects }, '재연결 예약');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(`reconnect:${reason}`);
    }, delay);
  }

  private checkStale(): void {
    if (!this.running || !this.watcher || this.symbols.length === 0) return;
    const last = this.st.lastQuoteAt?.getTime() ?? 0;
    if (Date.now() - last > STALE_AFTER_MS && this.expectQuotes()) {
      this.log.warn({ silentSec: Math.round((Date.now() - last) / 1000) }, '장중 quote 무응답 → 재연결');
      this.st.lastQuoteAt = new Date(); // 재연결 직후 반복 방지
      void this.connect('stale');
    }
  }

  private handleData(symbol: string, data: QuoteData): void {
    const now = new Date();
    this.st.lastQuoteAt = now;
    const q = toQuote(symbol, data, now);
    if (!q) return;
    if (!this.rawLogged.has(symbol)) {
      this.rawLogged.add(symbol);
      this.log.info({ symbol, raw: data }, 'quote 원본 (가격 포함 첫 수신)');
    }
    this.onQuote?.(q);
  }

  private handleError(e: TradingViewError): void {
    const err = toMdError(e);
    this.st.lastError = err.message;
    this.log.warn({ code: err.code, err: err.message, details: e.details }, '시세 오류');
    this.onError?.(err);
  }

  private async stopWatcher(): Promise<void> {
    const w = this.watcher;
    this.watcher = undefined;
    if (w) await w.stop().catch(() => undefined);
  }

  status(): FeedStatus {
    return {
      ...this.st,
      symbols: [...this.symbols],
      bars: this.bar.running
        ? { connected: !!this.bar.client?.isOpen, symbols: [...this.bar.symbols], reconnects: this.bar.reconnects, timeframe: this.bar.timeframe }
        : undefined,
    };
  }

  async close(): Promise<void> {
    this.running = false;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.staleTimer);
    await this.stopWatcher();
    this.st.connected = false;
    await this.closeBars();
  }

  // ── 분봉 구독 (연결 하나를 공유, 끊기면 전체 재구성) ─────────
  private bar = {
    running: false,
    client: undefined as TradingViewClient | undefined,
    watchers: new Map<string, CandleWatcher>(),
    symbols: [] as string[],
    timeframe: '15',
    count: 22,
    onBars: undefined as ((s: string, b: readonly IntradayBar[]) => void) | undefined,
    onError: undefined as ((e: MarketDataError) => void) | undefined,
    gen: 0,
    backoffMs: BACKOFF_MIN_MS,
    timer: undefined as NodeJS.Timeout | undefined,
    reconnects: 0,
  };

  async watchBars(
    timeframe: string,
    count: number,
    onBars: (symbol: string, bars: readonly IntradayBar[]) => void,
    onError: (e: MarketDataError) => void,
  ): Promise<void> {
    Object.assign(this.bar, { running: true, timeframe, count, onBars, onError });
    await this.rebuildBars('start');
  }

  async setBarSymbols(symbols: string[]): Promise<void> {
    const next = [...new Set(symbols)].sort();
    if (next.join(',') === [...this.bar.symbols].sort().join(',')) return;
    const removed = this.bar.symbols.filter((s) => !next.includes(s));
    const added = next.filter((s) => !this.bar.symbols.includes(s));
    this.bar.symbols = next;
    if (!this.bar.running) return;
    this.log.info({ added, removed }, '분봉 구독 변경');
    if (!this.bar.client || this.bar.client.isClosed) return void (await this.rebuildBars('symbols-changed'));
    for (const s of removed) {
      const w = this.bar.watchers.get(s);
      this.bar.watchers.delete(s);
      await w?.stop().catch(() => undefined);
    }
    for (const s of added) await this.startBar(s, this.bar.gen);
  }

  private async closeBars(): Promise<void> {
    this.bar.running = false;
    this.bar.gen++;
    clearTimeout(this.bar.timer);
    for (const w of this.bar.watchers.values()) await w.stop().catch(() => undefined);
    this.bar.watchers.clear();
    this.bar.client?.close();
    this.bar.client = undefined;
  }

  private async rebuildBars(reason: string): Promise<void> {
    if (!this.bar.running) return;
    clearTimeout(this.bar.timer);
    this.bar.timer = undefined;
    const gen = ++this.bar.gen;
    for (const w of this.bar.watchers.values()) await w.stop().catch(() => undefined);
    this.bar.watchers.clear();
    this.bar.client?.close();
    this.bar.client = undefined;
    if (this.bar.symbols.length === 0) return;

    const client = new TradingViewClient(this.credentials ? { credentials: this.credentials } : {});
    this.bar.client = client;
    client.on('close', () => {
      if (gen !== this.bar.gen || !this.bar.running) return;
      this.log.warn('분봉 연결이 닫힘 → 재연결 예약');
      this.scheduleBarRebuild('closed');
    });
    let ok = 0;
    for (const s of this.bar.symbols) if (await this.startBar(s, gen)) ok++;
    if (gen !== this.bar.gen) return;
    if (ok > 0) this.bar.backoffMs = BACKOFF_MIN_MS;
    this.log.info({ reason, ok, total: this.bar.symbols.length, timeframe: this.bar.timeframe }, '분봉 구독 시작');
    if (ok === 0) this.scheduleBarRebuild('all-failed');
  }

  private scheduleBarRebuild(reason: string): void {
    if (!this.bar.running || this.bar.timer) return;
    const delay = this.bar.backoffMs;
    this.bar.backoffMs = Math.min(this.bar.backoffMs * 2, BACKOFF_MAX_MS);
    this.bar.reconnects++;
    this.log.warn({ reason, delayMs: delay, reconnects: this.bar.reconnects }, '분봉 재연결 예약');
    this.bar.timer = setTimeout(() => {
      this.bar.timer = undefined;
      void this.rebuildBars(`reconnect:${reason}`);
    }, delay);
  }

  private async startBar(symbol: string, gen: number): Promise<boolean> {
    const client = this.bar.client;
    if (!client || gen !== this.bar.gen) return false;
    try {
      const w = await watchCandles(
        { symbol, timeframe: this.bar.timeframe, count: this.bar.count, client, timeoutMs: CALL_TIMEOUT_MS },
        {
          onData: (candles) => {
            if (gen !== this.bar.gen) return;
            this.bar.onBars?.(symbol, candles.map((c) => ({ ...c, volume: sanitizeVolume(c.volume) ?? 0 })));
          },
          onError: (e) => {
            if (gen === this.bar.gen) this.log.warn({ symbol, code: e.code, err: e.message }, '분봉 오류');
          },
        },
      );
      if (gen !== this.bar.gen || !this.bar.symbols.includes(symbol)) {
        await w.stop();
        return false;
      }
      this.bar.watchers.set(symbol, w);
      // 이 종목만 끊긴 경우(연결은 살아 있음) 잠시 뒤 다시 붙인다
      void w.closed.then(() => {
        if (this.bar.watchers.get(symbol) !== w || gen !== this.bar.gen || !this.bar.running) return;
        this.bar.watchers.delete(symbol);
        if (client.isClosed) return; // 연결 전체 재구성은 close 핸들러가 한다
        setTimeout(() => {
          if (gen === this.bar.gen && this.bar.symbols.includes(symbol) && !this.bar.watchers.has(symbol)) void this.startBar(symbol, gen);
        }, 30_000);
      });
      return true;
    } catch (e) {
      const err = toMdError(e, symbol);
      this.log.warn({ symbol, code: err.code, err: err.message }, '분봉 구독 실패');
      this.bar.onError?.(err);
      return false;
    }
  }

  // ── 단발 조회 ──────────────────────────────────────────────
  async quote(symbol: string): Promise<Quote> {
    const data = await withRetry(() =>
      getQuote({ symbol, fields: QUOTE_FIELDS, timeoutMs: CALL_TIMEOUT_MS, ...this.connOpts }),
    ).catch((e) => {
      throw toMdError(e, symbol);
    });
    const q = toQuote(symbol, data);
    if (!q) throw new MarketDataError('QUOTE_ERROR', '가격 정보가 없습니다', symbol);
    return q;
  }

  async dailyBars(symbol: string, count: number): Promise<Bar[]> {
    const raw = await withRetry(() =>
      getCandles({ symbol, timeframe: 'D', count, timeoutMs: CALL_TIMEOUT_MS, ...this.connOpts }),
    );
    return raw.map((c) => {
      const b = CandleSchema.parse(c);
      // 일봉 time은 거래소 현지 날짜의 00:00 UTC (실측). 미국 장 시작 시각으로 오더라도 UTC 날짜는 같다.
      return {
        date: new Date(b.time * 1000).toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: sanitizeVolume(b.volume) ?? 0,
      };
    });
  }

  async symbolInfo(symbol: string): Promise<SymbolMeta> {
    const [infoRaw, quote] = await Promise.all([
      withRetry(() => getSymbolInfo({ symbol, timeoutMs: CALL_TIMEOUT_MS, ...this.connOpts })).catch((e) => {
        throw toMdError(e, symbol);
      }),
      getQuote({ symbol, fields: ['local_description', 'description'], timeoutMs: CALL_TIMEOUT_MS, ...this.connOpts })
        .catch(() => undefined),
    ]);
    const info = SymbolInfoSchema.parse(infoRaw);
    const local = typeof quote?.local_description === 'string' ? quote.local_description : undefined;
    return {
      symbol,
      description: info.description,
      localDescription: local,
      currency: info.currency_code,
      timezone: info.timezone,
      session: info.session,
      type: info.type,
    };
  }

  async search(query: string): Promise<SymbolCandidate[]> {
    const results = await withRetry(() => searchMarkets(query, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
    return results.map((r) => ({
      symbol: r.id,
      description: r.description,
      type: r.type,
      exchange: r.exchange,
      country: r.country,
    }));
  }

  async watchlists(): Promise<TvWatchlist[]> {
    if (!this.credentials) throw new MarketDataError('NO_CREDENTIALS', 'TV_SESSION/TV_SIGNATURE가 필요합니다');
    const lists = await withRetry(() =>
      getWatchlists({ credentials: this.credentials!, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }),
    );
    return lists.map((l) => ({ id: l.id, name: l.name, symbols: l.symbols.filter((s) => s.includes(':')) }));
  }
}

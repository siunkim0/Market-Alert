/**
 * Binance USDⓈ-M 선물 체결 수집 (조회 전용).
 * 호출하는 엔드포인트는 GET 3개뿐이다: /fapi/v1/userTrades, /fapi/v1/income, /fapi/v2/positionRisk (+ 서버 시각 /fapi/v1/time).
 * 주문 관련 코드는 없다.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Repo } from '../../db/repo.js';
import type { Logger } from '../../logger.js';
import type { Journal, RecordInput } from '../journal.js';

export const SOURCE = 'binance_futures';
const BASE = 'https://fapi.binance.com';
const DAY = 86_400_000;
const WINDOW = 7 * DAY - 1; // userTrades·income 조회 구간 최대 7일
const ALLOWED_PATHS = new Set(['/fapi/v1/userTrades', '/fapi/v1/income', '/fapi/v2/positionRisk', '/fapi/v1/time']);

export function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

/** Binance 'BTCUSDC' → TradingView 'BINANCE:BTCUSDC.P' */
export function toTvSymbol(binanceSymbol: string): string {
  return `BINANCE:${binanceSymbol}.P`;
}

const numStr = z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite());

export const UserTradeSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  positionSide: z.string().optional(),
  price: numStr,
  qty: numStr,
  commission: numStr,
  commissionAsset: z.string(),
  realizedPnl: numStr,
  time: z.number(),
});
export type UserTrade = z.infer<typeof UserTradeSchema>;

const IncomeSchema = z.object({ symbol: z.string(), incomeType: z.string(), time: z.number() });
const PositionRiskSchema = z.object({
  symbol: z.string(),
  positionAmt: numStr,
  entryPrice: numStr,
  unRealizedProfit: numStr,
  leverage: numStr.optional(),
  positionSide: z.string().optional(),
});
const CursorSchema = z.object({ incomeTime: z.number().optional(), symbols: z.record(z.string(), z.number()).default({}) });

export function toRecord(t: UserTrade, leverage?: number): RecordInput {
  return {
    source: SOURCE,
    externalId: String(t.id),
    symbol: toTvSymbol(t.symbol),
    side: t.side === 'BUY' ? 'buy' : 'sell',
    qty: t.qty,
    price: t.price,
    fee: t.commission,
    feeCurrency: t.commissionAsset,
    leverage,
    executedAt: new Date(t.time),
    realizedPnl: t.realizedPnl,
  };
}

export interface BinanceOptions {
  apiKey: string;
  apiSecret: string;
  lookbackDays?: number;
  fetchImpl?: typeof fetch;
}

export class BinanceFuturesImporter {
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private timeOffset = 0;
  private running: Promise<{ inserted: number; symbols: string[] }> | undefined;

  constructor(
    private readonly opts: BinanceOptions,
    private readonly repo: Repo,
    private readonly journal: Journal,
    logger: Logger,
  ) {
    this.log = logger.child({ mod: 'binance' });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get(path: string, params: Record<string, string | number | undefined>, signed = true): Promise<unknown> {
    if (!ALLOWED_PATHS.has(path)) throw new Error(`허용되지 않은 엔드포인트: ${path}`);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    if (signed) {
      qs.set('recvWindow', '10000');
      qs.set('timestamp', String(Date.now() + this.timeOffset));
      qs.set('signature', sign(qs.toString(), this.opts.apiSecret));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchImpl(`${BASE}${path}?${qs.toString()}`, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': this.opts.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const wait = Math.min(Number(res.headers.get('retry-after') ?? 2) * 1000, 30_000);
        this.log.warn({ path, status: res.status, waitMs: wait }, 'Binance 재시도');
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Binance ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    }
    throw new Error(`Binance ${path}: 재시도 초과`);
  }

  private async syncTime(): Promise<number> {
    const r = z.object({ serverTime: z.number() }).parse(await this.get('/fapi/v1/time', {}, false));
    this.timeOffset = r.serverTime - Date.now();
    return r.serverTime;
  }

  /** 동시에 두 번 돌지 않게 한다 */
  sync(): Promise<{ inserted: number; symbols: string[] }> {
    this.running ??= this.doSync().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doSync(): Promise<{ inserted: number; symbols: string[] }> {
    const now = await this.syncTime();
    const cursor = CursorSchema.parse(JSON.parse(this.repo.getSyncState(SOURCE)?.cursor ?? '{}'));
    const lookbackStart = now - (this.opts.lookbackDays ?? 30) * DAY;
    const incomeStart = cursor.incomeTime ?? lookbackStart;

    // 1) 손익·수수료 내역에서 거래한 종목 찾기
    const symbols = new Set<string>();
    for (let start = incomeStart; start < now; start += WINDOW + 1) {
      const end = Math.min(start + WINDOW, now);
      let from = start;
      for (;;) {
        const rows = z.array(IncomeSchema).parse(await this.get('/fapi/v1/income', { startTime: from, endTime: end, limit: 1000 }));
        for (const r of rows) if (r.symbol && ['COMMISSION', 'REALIZED_PNL'].includes(r.incomeType)) symbols.add(r.symbol);
        if (rows.length < 1000) break;
        from = Math.max(...rows.map((r) => r.time)) + 1;
      }
    }

    // 2) 현재 포지션 → 스냅샷, 보유 종목도 동기화 대상
    const risks = z.array(PositionRiskSchema).parse(await this.get('/fapi/v2/positionRisk', {}));
    const leverage = new Map<string, number>();
    const snapshot = [];
    for (const r of risks) {
      if (r.leverage !== undefined) leverage.set(r.symbol, r.leverage);
      if (r.positionAmt === 0) continue;
      if (r.positionSide && r.positionSide !== 'BOTH') this.log.warn({ symbol: r.symbol }, 'hedge mode 포지션: 순수량으로 합산합니다');
      symbols.add(r.symbol);
      snapshot.push({ symbol: toTvSymbol(r.symbol), qty: r.positionAmt, avg_price: r.entryPrice, unrealized_pnl: r.unRealizedProfit });
    }
    this.repo.replacePositionSnapshot(SOURCE, snapshot);

    // 3) 종목별 체결 (7일 구간, 1000건 단위)
    const records: RecordInput[] = [];
    const touched: string[] = [];
    for (const sym of symbols) {
      const startAt = cursor.symbols[sym] !== undefined ? cursor.symbols[sym]! + 1 : lookbackStart;
      let last = cursor.symbols[sym] ?? 0;
      for (let start = startAt; start < now; start += WINDOW + 1) {
        const end = Math.min(start + WINDOW, now);
        let from = start;
        for (;;) {
          const trades = z.array(UserTradeSchema).parse(
            await this.get('/fapi/v1/userTrades', { symbol: sym, startTime: from, endTime: end, limit: 1000 }),
          );
          for (const t of trades) {
            records.push(toRecord(t, leverage.get(sym)));
            last = Math.max(last, t.time);
          }
          if (trades.length < 1000) break;
          from = Math.max(...trades.map((t) => t.time)) + 1;
        }
      }
      cursor.symbols[sym] = last || now - 1;
    }

    const inserted = this.journal.recordMany(records);
    for (const r of records) if (!touched.includes(r.symbol)) touched.push(r.symbol);
    // 다음 income 조회는 겹치게 (지연 반영) 1시간 전부터
    cursor.incomeTime = now - 3_600_000;
    this.repo.setSyncState(SOURCE, JSON.stringify(cursor));
    this.log.info({ fetched: records.length, inserted, symbols: [...symbols], positions: snapshot.length }, 'Binance 동기화');
    return { inserted, symbols: inserted > 0 ? touched : [] };
  }
}

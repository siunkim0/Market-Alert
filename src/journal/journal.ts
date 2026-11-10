/**
 * 매매 기록 서비스. trades를 재생해 포지션·거래 그룹을 계산하고(캐시), /sl·/tp 오버라이드를 얹는다.
 * 기록이 바뀌면 onChange 리스너(구독 갱신 등)를 부른다.
 */
import type { NewTrade, Repo, TradeRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import { computeR, replay, type Position, type ReplayResult, type TradeGroup } from './positions.js';

export interface RecordInput {
  source: 'manual' | 'binance_futures';
  externalId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee?: number;
  feeCurrency?: string;
  leverage?: number;
  executedAt?: Date;
  stopLoss?: number;
  takeProfit?: number;
  note?: string;
  realizedPnl?: number;
}

export class Journal {
  private readonly log: Logger;
  private cache: ReplayResult | undefined;
  private readonly listeners: (() => void)[] = [];
  private readonly recordListeners: ((trades: TradeRow[]) => void)[] = [];

  constructor(private readonly repo: Repo, logger: Logger) {
    this.log = logger.child({ mod: 'journal' });
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** 새 체결이 기록됐을 때 (수동·동기화 모두). 규칙 체크용 */
  onRecorded(fn: (trades: TradeRow[]) => void): void {
    this.recordListeners.push(fn);
  }

  private recorded(ids: number[]): void {
    if (ids.length === 0) return;
    const rows = ids.map((id) => this.repo.getTrade(id)).filter((t): t is TradeRow => !!t);
    for (const fn of this.recordListeners) {
      try {
        fn(rows);
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'record listener 오류');
      }
    }
  }

  private changed(): void {
    this.cache = undefined;
    this.state(); // trade_group 컬럼 갱신
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'journal listener 오류');
      }
    }
  }

  state(): ReplayResult {
    if (this.cache) return this.cache;
    const r = replay(this.repo.listTrades());
    // /sl, /tp 오버라이드 적용
    const stops = new Map(this.repo.listPositionStops().map((s) => [s.trade_group, s]));
    for (const g of r.groups) {
      const o = stops.get(g.id);
      if (!o) continue;
      g.initialStop ??= o.initial_stop;
      if (o.stop_loss !== null) g.currentStop = o.stop_loss;
      if (o.take_profit !== null) g.currentTarget = o.take_profit;
      if (g.closedAt) g.r = computeR(g);
    }
    this.repo.updateTradeGroups(r.tradeGroup);
    this.cache = r;
    return r;
  }

  openPositions(): Position[] {
    return [...this.state().positions.values()];
  }

  position(symbol: string): Position | undefined {
    return this.state().positions.get(symbol);
  }

  openSymbols(): string[] {
    return [...this.state().positions.keys()];
  }

  /** 최근 것부터 */
  groups(): TradeGroup[] {
    return [...this.state().groups].reverse();
  }

  group(id: string): TradeGroup | undefined {
    return this.state().groups.find((g) => g.id === id);
  }

  /** 이 체결의 실현손익 */
  tradeRealized(id: number): number | undefined {
    return this.state().tradeRealized.get(id);
  }

  /** 기록. 중복(source, external_id)이면 null */
  record(i: RecordInput): { trade: TradeRow; position: Position | undefined; group: TradeGroup | undefined } | null {
    const row: NewTrade = {
      source: i.source,
      external_id: i.externalId ?? null,
      symbol: i.symbol,
      side: i.side,
      qty: i.qty,
      price: i.price,
      fee: i.fee ?? null,
      fee_currency: i.feeCurrency ?? null,
      leverage: i.leverage ?? null,
      executed_at: (i.executedAt ?? new Date()).toISOString(),
      stop_loss: i.stopLoss ?? null,
      take_profit: i.takeProfit ?? null,
      note: i.note ?? null,
      realized_pnl: i.realizedPnl ?? null,
    };
    const id = this.repo.insertTrade(row);
    if (id === null) return null;
    this.changed();
    const trade = this.repo.getTrade(id)!;
    const gid = this.state().tradeGroup.get(id);
    this.recorded([id]);
    this.log.info({ id, symbol: i.symbol, side: i.side, qty: i.qty, price: i.price, source: i.source }, '체결 기록');
    return { trade, position: this.position(i.symbol), group: gid ? this.group(gid) : undefined };
  }

  /** 여러 건을 한 번에 (동기화). 새로 들어간 건수 */
  recordMany(items: RecordInput[]): number {
    const ids: number[] = [];
    for (const i of items) {
      const id = this.repo.insertTrade({
        source: i.source,
        external_id: i.externalId ?? null,
        symbol: i.symbol,
        side: i.side,
        qty: i.qty,
        price: i.price,
        fee: i.fee ?? null,
        fee_currency: i.feeCurrency ?? null,
        leverage: i.leverage ?? null,
        executed_at: (i.executedAt ?? new Date()).toISOString(),
        stop_loss: i.stopLoss ?? null,
        take_profit: i.takeProfit ?? null,
        note: i.note ?? null,
        realized_pnl: i.realizedPnl ?? null,
      });
      if (id !== null) ids.push(id);
    }
    if (ids.length > 0) {
      this.changed();
      this.recorded(ids);
    }
    return ids.length;
  }

  /** 보유 포지션의 손절·익절가 설정. 포지션이 없으면 undefined */
  setStop(symbol: string, kind: 'sl' | 'tp', price: number): Position | undefined {
    const p = this.position(symbol);
    if (!p) return undefined;
    this.repo.setPositionStop(p.group.id, symbol, kind, price, p.group.initialStop);
    this.changed();
    return this.position(symbol);
  }

  /** 수동 기록 삭제 (잘못 입력한 경우) */
  deleteManual(id: number): boolean {
    const ok = this.repo.deleteTrade(id);
    if (ok) this.changed();
    return ok;
  }

  setNote(id: number, note: string): boolean {
    return this.repo.setTradeNote(id, note);
  }
}

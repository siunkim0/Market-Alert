/**
 * 체결 기록 → 포지션·거래 그룹 계산 (순수 함수).
 * - 평균단가: 이동평균법. 같은 방향 추가 시 가중평균, 반대 방향은 청산(평균단가 유지).
 * - 선물 숏(음수 수량) 지원. 0을 지나 반대로 넘어가면 그룹을 닫고 남은 수량으로 새 그룹을 연다.
 * - trade_group: 수량이 0에서 시작해 다시 0이 될 때까지.
 * - 실현손익: 거래소 제공값(realized_pnl)이 있으면 그 값, 없으면 평균단가 기준. 수수료는 차감.
 * - R = 손익 / (|진입 평균가 − 최초 손절가| × 진입 수량). 손절가 없으면 null.
 */

export interface TradeInput {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number | null;
  fee_currency: string | null;
  executed_at: string; // ISO
  stop_loss: number | null;
  take_profit: number | null;
  realized_pnl: number | null;
}

export interface TradeGroup {
  id: string; // 'G<첫 체결 id>'
  symbol: string;
  direction: 'long' | 'short';
  tradeIds: number[];
  /** 진입 체결 가중평균가 */
  entryAvg: number;
  entryQty: number;
  /** 청산 체결 가중평균가 (청산 없으면 null) */
  exitAvg: number | null;
  exitQty: number;
  openedAt: string;
  closedAt: string | null;
  /** 실현손익 (수수료 차감) */
  pnl: number;
  fees: number;
  initialStop: number | null;
  currentStop: number | null;
  currentTarget: number | null;
  r: number | null;
}

export interface Position {
  symbol: string;
  /** 부호 있는 수량 (숏은 음수) */
  qty: number;
  avgPrice: number;
  group: TradeGroup;
}

export interface ReplayResult {
  positions: Map<string, Position>;
  /** 오래된 것부터 */
  groups: TradeGroup[];
  /** trade id → group id */
  tradeGroup: Map<number, string>;
  /** trade id → 이 체결의 실현손익 (수수료 차감) */
  tradeRealized: Map<number, number>;
}

const EPS = 1e-9;
/** 수수료를 손익에서 뺄 통화 (그 외 BNB 등은 환산하지 않고 무시) */
const FEE_CURRENCIES_IN_QUOTE = new Set(['USDT', 'USDC', 'USD', 'BUSD', 'KRW']);

export function feeInQuote(t: Pick<TradeInput, 'fee' | 'fee_currency'>): number {
  if (!t.fee) return 0;
  if (t.fee_currency === null || FEE_CURRENCIES_IN_QUOTE.has(t.fee_currency.toUpperCase())) return t.fee;
  return 0;
}

interface Acc {
  group: TradeGroup;
  qty: number;
  avg: number;
  entryNotional: number;
  exitNotional: number;
}

function openGroup(t: TradeInput, signedQty: number, price: number): Acc {
  return {
    group: {
      id: `G${t.id}`,
      symbol: t.symbol,
      direction: signedQty > 0 ? 'long' : 'short',
      tradeIds: [],
      entryAvg: price,
      entryQty: 0,
      exitAvg: null,
      exitQty: 0,
      openedAt: t.executed_at,
      closedAt: null,
      pnl: 0,
      fees: 0,
      initialStop: null,
      currentStop: null,
      currentTarget: null,
      r: null,
    },
    qty: 0,
    avg: price,
    entryNotional: 0,
    exitNotional: 0,
  };
}

function addEntry(a: Acc, qtyAbs: number, price: number, sign: number): void {
  a.avg = (a.avg * Math.abs(a.qty) + price * qtyAbs) / (Math.abs(a.qty) + qtyAbs);
  a.qty += sign * qtyAbs;
  a.entryNotional += price * qtyAbs;
  a.group.entryQty += qtyAbs;
  a.group.entryAvg = a.entryNotional / a.group.entryQty;
}

function applyStops(a: Acc, t: TradeInput): void {
  if (t.stop_loss !== null) {
    a.group.initialStop ??= t.stop_loss;
    a.group.currentStop = t.stop_loss;
  }
  if (t.take_profit !== null) a.group.currentTarget = t.take_profit;
}

export function computeR(g: Pick<TradeGroup, 'pnl' | 'entryAvg' | 'entryQty' | 'initialStop'>): number | null {
  if (g.initialStop === null) return null;
  const risk = Math.abs(g.entryAvg - g.initialStop) * g.entryQty;
  return risk > EPS ? g.pnl / risk : null;
}

function closeGroup(a: Acc, at: string): TradeGroup {
  a.group.closedAt = at;
  a.group.r = computeR(a.group);
  return a.group;
}

/** 체결을 시간순으로 재생한다. 입력 순서와 무관하게 (executed_at, id)로 정렬한다. */
export function replay(trades: TradeInput[]): ReplayResult {
  const sorted = [...trades].sort((x, y) => x.executed_at.localeCompare(y.executed_at) || x.id - y.id);
  const open = new Map<string, Acc>();
  const groups: TradeGroup[] = [];
  const tradeGroup = new Map<number, string>();
  const tradeRealized = new Map<number, number>();

  for (const t of sorted) {
    if (!(t.qty > 0) || !(t.price > 0)) continue;
    const sign = t.side === 'buy' ? 1 : -1;
    const fee = feeInQuote(t);
    let remaining = t.qty;
    let realizedGross = 0;
    let a = open.get(t.symbol);

    if (!a) {
      a = openGroup(t, sign, t.price);
      open.set(t.symbol, a);
      groups.push(a.group);
    }
    a.group.tradeIds.push(t.id);
    a.group.fees += fee;
    tradeGroup.set(t.id, a.group.id);

    if (Math.sign(a.qty) === sign || Math.abs(a.qty) < EPS) {
      addEntry(a, remaining, t.price, sign);
      remaining = 0;
    } else {
      // 반대 방향: 청산
      const closeQty = Math.min(remaining, Math.abs(a.qty));
      const posSign = Math.sign(a.qty);
      realizedGross = (t.price - a.avg) * closeQty * posSign;
      a.qty += sign * closeQty;
      a.exitNotional += t.price * closeQty;
      a.group.exitQty += closeQty;
      a.group.exitAvg = a.exitNotional / a.group.exitQty;
      remaining -= closeQty;
    }

    // 거래소 제공 실현손익이 있으면 우선
    const gross = t.realized_pnl !== null && t.realized_pnl !== undefined ? t.realized_pnl : realizedGross;
    const realized = gross - fee;
    tradeRealized.set(t.id, realized);
    a.group.pnl += realized;
    applyStops(a, t);

    if (Math.abs(a.qty) < EPS) {
      a.qty = 0;
      closeGroup(a, t.executed_at);
      open.delete(t.symbol);
      if (remaining > EPS) {
        // 0을 지나 반대 포지션 진입: 남은 수량으로 새 그룹 (수수료는 앞 그룹에 이미 반영)
        const b = openGroup(t, sign, t.price);
        b.group.tradeIds.push(t.id);
        addEntry(b, remaining, t.price, sign);
        applyStops(b, t);
        open.set(t.symbol, b);
        groups.push(b.group);
        tradeGroup.set(t.id, b.group.id);
      }
    }
  }

  const positions = new Map<string, Position>();
  for (const [symbol, a] of open) {
    a.group.r = null;
    positions.set(symbol, { symbol, qty: a.qty, avgPrice: a.avg, group: a.group });
  }
  return { positions, groups, tradeGroup, tradeRealized };
}

/** 미실현손익 (선형 계약 기준) */
export function unrealizedPnl(p: Pick<Position, 'qty' | 'avgPrice'>, price: number): number {
  return (price - p.avgPrice) * p.qty;
}

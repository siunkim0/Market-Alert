/** 사용자 입력 → TradingView symbol. 별칭 사전 → EXCH:TICKER 그대로 → searchMarkets 후보. */
import type { Aliases } from '../config.js';
import type { MarketData, SymbolCandidate } from './marketData.js';

export type Resolution =
  | { kind: 'resolved'; symbol: string; displayName: string | undefined }
  | { kind: 'choices'; candidates: SymbolCandidate[] }
  | { kind: 'notfound' };

const SYMBOL_RE = /^[A-Z0-9_]+:[A-Z0-9_.!&-]+$/i;
const USEFUL_TYPES = new Set(['stock', 'fund', 'dr', 'index', 'spot', 'crypto', 'swap', 'futures', 'etf']);
const PRIMARY_EXCHANGES = ['KRX', 'NASDAQ', 'NYSE', 'AMEX', 'BINANCE'];
const MAX_CANDIDATES = 6;

export function normalizeName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

export class SymbolResolver {
  private readonly index = new Map<string, string>();

  constructor(
    private readonly aliases: Aliases,
    private readonly md: Pick<MarketData, 'search'>,
  ) {
    for (const [symbol, entry] of Object.entries(aliases)) {
      for (const key of [entry.name, ...entry.aliases]) this.index.set(normalizeName(key), symbol);
    }
  }

  displayName(symbol: string): string | undefined {
    return this.aliases[symbol]?.name;
  }

  /** 별칭 사전·symbol 형식만으로 해석 (네트워크 없음) */
  resolveLocal(input: string): string | undefined {
    const q = input.trim();
    const hit = this.index.get(normalizeName(q));
    if (hit) return hit;
    if (SYMBOL_RE.test(q)) return q.toUpperCase();
    return undefined;
  }

  /** 입력이 해당 symbol을 가리키는지 (watchlist 항목 매칭용) */
  matches(input: string, symbol: string, displayName?: string | null): boolean {
    const n = normalizeName(input);
    const ticker = symbol.split(':')[1] ?? symbol;
    return (
      n === normalizeName(symbol) ||
      n === normalizeName(ticker) ||
      (!!displayName && n === normalizeName(displayName)) ||
      this.index.get(n) === symbol
    );
  }

  async resolve(input: string): Promise<Resolution> {
    const local = this.resolveLocal(input);
    if (local) return { kind: 'resolved', symbol: local, displayName: this.displayName(local) };

    const q = input.trim();
    const found = (await this.md.search(q)).filter((c) => USEFUL_TYPES.has(c.type));
    if (found.length === 0) return { kind: 'notfound' };

    // 티커가 정확히 일치하는 주요 거래소 종목이 하나뿐이면 바로 선택 (AAPL → NASDAQ:AAPL, 000660 → KRX:000660)
    const upper = q.toUpperCase();
    const exact = found.filter(
      (c) => (c.symbol.split(':')[1] ?? '') === upper && PRIMARY_EXCHANGES.includes(c.exchange.toUpperCase()),
    );
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
    if (pick) return { kind: 'resolved', symbol: pick.symbol, displayName: this.displayName(pick.symbol) };

    return { kind: 'choices', candidates: found.slice(0, MAX_CANDIDATES) };
  }
}

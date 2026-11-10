/** 매매 기록 관련 메시지 포맷 (HTML) */
import type { PositionSnapshotRow, TradeRow } from '../db/repo.js';
import type { PeriodStats, Period } from '../journal/pnl.js';
import type { Position, TradeGroup } from '../journal/positions.js';
import type { Snapshot } from '../market/monitor.js';
import { fmtKst } from '../time.js';
import { delayTag, esc, fmtPrice, fmtQty, fmtSignedNum } from './format.js';

export type NameOf = (symbol: string) => string;

function label(symbol: string, nameOf: NameOf): string {
  const n = nameOf(symbol);
  return n && n !== symbol ? `<b>${esc(n)}</b> <code>${esc(symbol)}</code>` : `<code>${esc(symbol)}</code>`;
}

export function fmtR(r: number | null): string {
  return r === null ? 'R -' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 ${min % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

const dirLabel = (q: number) => (q > 0 ? '롱' : '숏');

export function formatRecorded(
  t: TradeRow,
  position: Position | undefined,
  group: TradeGroup | undefined,
  realized: number | undefined,
  nameOf: NameOf,
): string {
  const side = t.side === 'buy' ? '매수' : '매도';
  const extras = [
    t.stop_loss !== null ? `손절 ${fmtPrice(t.stop_loss)}` : '',
    t.take_profit !== null ? `익절 ${fmtPrice(t.take_profit)}` : '',
  ].filter(Boolean);
  const lines = [
    `기록 #${t.id}: ${label(t.symbol, nameOf)} ${side} ${fmtQty(t.qty)} @ ${fmtPrice(t.price)}` +
      (extras.length ? ` (${extras.join(', ')})` : '') +
      (t.note ? `\n메모: ${esc(t.note)}` : ''),
  ];
  if (realized !== undefined && realized !== 0) lines.push(`이 체결 실현손익 ${fmtSignedNum(realized)}`);
  if (position) {
    lines.push(`포지션: ${dirLabel(position.qty)} ${fmtQty(Math.abs(position.qty))} @ ${fmtPrice(position.avgPrice)} · 거래 ${position.group.id}`);
  } else if (group?.closedAt) {
    lines.push(`거래 ${group.id} 청산: 실현 ${fmtSignedNum(group.pnl)} · ${fmtR(group.r)}`);
  }
  return lines.join('\n');
}

export interface PosView {
  position: Position;
  snap: Snapshot;
}

export function formatPositions(views: PosView[], mismatches: string[], nameOf: NameOf, now = new Date()): string {
  if (views.length === 0 && mismatches.length === 0) return '보유 포지션이 없습니다.';
  const blocks = views.map(({ position: p, snap: s }) => {
    const g = p.group;
    const head = `${label(p.symbol, nameOf)} ${dirLabel(p.qty)} ${fmtQty(Math.abs(p.qty))} @ ${fmtPrice(p.avgPrice)}`;
    const lines = [head];
    if (s.quote) {
      const price = s.quote.price;
      const u = (price - p.avgPrice) * p.qty;
      const pct = (price / p.avgPrice - 1) * 100 * Math.sign(p.qty);
      lines.push(
        `  현재 ${fmtPrice(price)} · 미실현 ${fmtSignedNum(u)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` +
          `${delayTag(s)} · ${fmtKst(s.quote.priceTime, now)}`,
      );
    } else lines.push('  현재가 대기 중');
    const dist = (target: number | null) => {
      if (target === null) return '-';
      if (!s.quote) return fmtPrice(target);
      return `${fmtPrice(target)} (${((target / s.quote.price - 1) * 100).toFixed(1)}%)`;
    };
    lines.push(`  손절 ${dist(g.currentStop)} · 익절 ${dist(g.currentTarget)} · 거래 ${g.id} · ${fmtDuration(now.getTime() - new Date(g.openedAt).getTime())}`);
    return lines.join('\n');
  });
  const warn = mismatches.length ? `\n\n⚠️ <b>거래소 잔고와 다름</b>\n${mismatches.join('\n')}` : '';
  return `<b>포지션</b> (${views.length})\n\n${blocks.join('\n\n')}${warn}`;
}

/** 기록 기준 포지션과 거래소 스냅샷 비교 (거래소 source 종목만) */
export function positionMismatches(positions: Position[], snapshot: PositionSnapshotRow[], isExchangeSymbol: (s: string) => boolean): string[] {
  const out: string[] = [];
  const mine = new Map(positions.filter((p) => isExchangeSymbol(p.symbol)).map((p) => [p.symbol, p.qty]));
  const theirs = new Map(snapshot.map((r) => [r.symbol, r.qty]));
  for (const sym of new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(sym) ?? 0;
    const b = theirs.get(sym) ?? 0;
    if (Math.abs(a - b) > 1e-8 * Math.max(1, Math.abs(b))) {
      out.push(`<code>${esc(sym)}</code> 기록 ${fmtQty(a)} / 거래소 ${fmtQty(b)}`);
    }
  }
  return out;
}

export function formatHistory(groups: TradeGroup[], nameOf: NameOf, now = new Date()): string {
  if (groups.length === 0) return '거래 기록이 없습니다.';
  const lines = groups.map((g) => {
    const dir = g.direction === 'long' ? '롱' : '숏';
    const exit = g.exitAvg !== null ? fmtPrice(g.exitAvg) : '-';
    const end = g.closedAt ? new Date(g.closedAt) : now;
    const status = g.closedAt ? `${fmtKst(new Date(g.closedAt), now)} 청산` : '보유 중';
    const pnl = g.closedAt || g.exitQty > 0 ? ` · ${fmtSignedNum(g.pnl)}` : '';
    return (
      `<b>${g.id}</b> ${label(g.symbol, nameOf)} ${dir} ${fmtQty(g.entryQty)}\n` +
      `  ${fmtPrice(g.entryAvg)} → ${exit}${pnl} · ${fmtR(g.r)} · ${fmtDuration(end.getTime() - new Date(g.openedAt).getTime())} · ${status}`
    );
  });
  return `<b>최근 거래</b>\n\n${lines.join('\n')}`;
}

const PERIOD_LABEL: Record<Period, string> = { today: '오늘', week: '이번 주', month: '이번 달', all: '전체' };

export function formatPnl(stats: PeriodStats[], period: Period, nameOf: NameOf): string {
  const title = `<b>${PERIOD_LABEL[period]} 실현손익</b>`;
  if (stats.length === 0) return `${title}\n청산된 거래가 없습니다.`;
  const blocks = stats.map((s) => {
    const lines = [
      `<b>${esc(s.currency)}</b> ${fmtSignedNum(s.pnl)} · ${s.count}건 (승 ${s.wins} / 패 ${s.losses}` +
        `${s.winRate !== null ? `, 승률 ${(s.winRate * 100).toFixed(0)}%` : ''})`,
      `  평균 R ${s.avgR !== null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R (${s.rCount}건)` : '- (손절가 기록 없음)'}`,
    ];
    if (s.best && s.best.pnl > 0) lines.push(`  최고 ${s.best.id} ${esc(nameOf(s.best.symbol))} ${fmtSignedNum(s.best.pnl)}`);
    if (s.worst && s.worst.pnl < 0) lines.push(`  최저 ${s.worst.id} ${esc(nameOf(s.worst.symbol))} ${fmtSignedNum(s.worst.pnl)}`);
    return lines.join('\n');
  });
  return `${title}\n\n${blocks.join('\n\n')}`;
}

const CSV_COLS = [
  'id', 'source', 'external_id', 'symbol', 'side', 'qty', 'price', 'fee', 'fee_currency', 'leverage', 'executed_at',
  'trade_group', 'stop_loss', 'take_profit', 'realized_pnl', 'note',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tradesCsv(trades: TradeRow[]): string {
  const rows = trades.map((t) => CSV_COLS.map((c) => csvCell(t[c])).join(','));
  // Excel에서 한글이 깨지지 않게 BOM
  return `﻿${CSV_COLS.join(',')}\n${rows.join('\n')}\n`;
}

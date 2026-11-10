/** Telegram 메시지 포맷 (parse_mode: HTML) */
import type { WatchRow } from '../db/repo.js';
import type { FeedStatus } from '../market/marketData.js';
import type { Snapshot } from '../market/monitor.js';
import { fmtKst } from '../time.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtPrice(p: number): string {
  const abs = Math.abs(p);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return p.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtPct(r: number | null, digits = 2): string {
  if (r === null) return '-';
  const v = r * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtZ(z: number | null): string {
  if (z === null) return '-σ';
  return `${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`;
}

export function delayTag(s: Pick<Snapshot, 'delay'>): string {
  if (!s.delay.delayed) return '';
  const min = s.delay.delaySec ? Math.round(s.delay.delaySec / 60) : null;
  return min ? ` [${min}분 지연]` : ' [지연]';
}

export function thresholdLabel(w: Pick<WatchRow, 'mode' | 'threshold'>): string {
  return w.mode === 'sigma' ? `${w.threshold}σ` : `${w.threshold}%`;
}

export function formatList(items: { w: WatchRow; s: Snapshot }[], now = new Date()): string {
  if (items.length === 0) return 'watchlist가 비어 있습니다. <code>/add 삼성전자</code> 처럼 추가하세요.';
  const lines = items.map(({ w, s }) => {
    const name = esc(w.display_name ?? w.symbol);
    const muted = w.muted_until && new Date(w.muted_until) > now ? ` 🔇~${fmtKst(new Date(w.muted_until), now)}` : '';
    const head = `<b>${name}</b> <code>${esc(w.symbol)}</code> · 기준 ${thresholdLabel(w)}${muted}`;
    if (!s.quote) return `${head}\n  시세 대기 중`;
    const sigma = s.sigma !== null ? ` (20일σ ${(s.sigma * 100).toFixed(2)}%)` : ' (σ 계산 불가)';
    const closed = s.marketOpen ? '' : ' · 장 마감';
    return (
      `${head}\n  ${fmtPrice(s.quote.price)}  ${fmtPct(s.r)} · ${fmtZ(s.z)}${sigma}\n` +
      `  가격 시각 ${fmtKst(s.quote.priceTime, now)} KST${delayTag(s)}${closed}`
    );
  });
  return `<b>Watchlist</b> (${items.length})\n\n${lines.join('\n\n')}`;
}

export function formatStatus(st: FeedStatus, snaps: Snapshot[], now = new Date()): string {
  const conn = st.connected ? '🟢 연결됨' : '🔴 끊김';
  const head = [
    `<b>시세 연결</b>: ${conn} · 재연결 ${st.reconnects}회`,
    `구독 ${st.symbols.length}종목 · 마지막 quote ${st.lastQuoteAt ? fmtKst(st.lastQuoteAt, now) : '-'}` +
      ` · 마지막 연결 ${st.lastConnectAt ? fmtKst(st.lastConnectAt, now) : '-'}`,
  ];
  if (st.lastError) head.push(`최근 오류: ${esc(st.lastError)}`);
  const rows = snaps.map((s) => {
    if (!s.quote) return `<code>${esc(s.symbol)}</code> quote 없음`;
    const lag = s.delay.lastLagSec !== null ? `lag ${s.delay.lastLagSec}s` : 'lag -';
    const d = s.delay.delayed
      ? `지연 ${s.delay.delaySec ?? '?'}s (${s.delay.source === 'update_mode' ? 'TV 표시' : '측정'})`
      : '실시간';
    return (
      `<code>${esc(s.symbol)}</code> 수신 ${fmtKst(s.quote.receivedAt, now)} · 가격 ${fmtKst(s.quote.priceTime, now)}` +
      ` · ${lag} · ${d}${s.marketOpen ? '' : ' · 장 마감'}`
    );
  });
  return `${head.join('\n')}\n\n<b>종목별</b>\n${rows.join('\n') || '(없음)'}`;
}

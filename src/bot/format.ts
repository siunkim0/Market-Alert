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

export function formatList(items: { w: WatchRow; s: Snapshot; today?: string | undefined }[], now = new Date()): string {
  if (items.length === 0) return 'watchlist가 비어 있습니다. <code>/add 삼성전자</code> 처럼 추가하세요.';
  const lines = items.map(({ w, s, today }) => {
    const name = esc(w.display_name ?? w.symbol);
    const muted = w.muted_until && new Date(w.muted_until) > now ? ` 🔇~${fmtKst(new Date(w.muted_until), now)}` : '';
    const head =
      `<b>${name}</b> <code>${esc(w.symbol)}</code> · 기준 ${thresholdLabel(w)}` +
      `${today ? ` · 오늘 ${today}` : ''}${muted}`;
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

// ── 알림 ─────────────────────────────────────────────────────
import type { AlertEvent } from '../triggers/engine.js';
import { fmtLevel } from '../triggers/engine.js';

function fmtSigned(v: number, unit: string, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;
}

/** 알림 한 건 (숫자만). 원인 요약은 Phase 4에서 edit로 붙는다. */
export function formatAlertBlock(ev: AlertEvent, now = new Date()): string {
  const s = ev.snapshot;
  const q = s.quote!;
  const h = ev.hit;
  const name = `<b>${esc(ev.displayName)}</b> <code>${esc(ev.symbol)}</code>`;
  const startup = ev.startup ? ' (시작 시점 기준)' : '';
  const rPct = s.r === null ? null : s.r * 100;

  let head = `[Alert] ${name}`;
  let tail: string | undefined;
  if (h.type === 'sigma' || h.type === 'pct') {
    const arrow = h.direction === 'up' ? '▲' : '▼';
    const sign = h.direction === 'up' ? '+' : '-';
    const main = h.type === 'sigma' ? fmtSigned(s.z ?? 0, 'σ') : fmtSigned(rPct ?? 0, '%', 2);
    const sub = h.type === 'sigma' ? (rPct === null ? '' : ` (${fmtSigned(rPct, '%', 2)})`) : s.z === null ? '' : ` (${fmtSigned(s.z, 'σ')})`;
    head = `[5σ Alert] ${name}  ${arrow} ${main}${sub}`;
    tail = `다음 알림: ${sign}${fmtLevel(h.next)}${h.type === 'sigma' ? 'σ' : '%'}`;
  } else if (h.type === 'volume') {
    head = `[거래량 Alert] ${name}  거래량 ${h.value.toFixed(1)}x  ${fmtPct(s.r)} · ${fmtZ(s.z)}`;
  } else if (h.type === 'level') {
    const l = h.level;
    const note = l.note ? ` — ${esc(l.note)}` : '';
    if (h.phase === 'reach') {
      const verb = l.direction === 'above' ? '▲ 돌파' : '▼ 이탈';
      head = `[레벨 도달] ${name}  ${fmtPrice(l.price)} ${verb}${note}`;
      tail = '이 레벨 알림은 비활성화했습니다.';
    } else {
      head = `[레벨 근접] ${name}  ${fmtPrice(l.price)}까지 ${Math.abs(h.distancePct).toFixed(2)}%${note}`;
    }
  }

  const info = [
    `가격 시각 ${fmtKst(q.priceTime, now)} KST`,
    `현재가 ${fmtPrice(q.price)}`,
    s.sigma !== null ? `20일 σ ${(s.sigma * 100).toFixed(2)}%` : undefined,
    s.volumeRatio !== null ? `거래량 ${s.volumeRatio.toFixed(1)}x` : undefined,
    ev.benchmark && ev.benchmark.r !== null
      ? `${esc(ev.benchmark.name)} ${fmtPct(ev.benchmark.r)}${ev.benchmark.delayed ? '(지연)' : ''}`
      : undefined,
  ].filter(Boolean);

  return [`${head}${delayTag(s)}${startup}`, info.join(' | '), tail].filter(Boolean).join('\n');
}

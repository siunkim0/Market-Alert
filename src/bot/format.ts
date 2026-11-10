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

export interface StatusRow {
  snap: Snapshot;
  name: string;
  /** watchlist | benchmark(비교 지수) | level(레벨 알림만) */
  role: 'watch' | 'benchmark' | 'level';
}

export function formatStatus(st: FeedStatus, rows: StatusRow[], now = new Date()): string {
  const conn = st.connected ? '🟢 연결됨' : '🔴 끊김';
  const counts = { watch: 0, benchmark: 0, level: 0 };
  for (const r of rows) counts[r.role]++;
  const extra = [counts.benchmark ? `비교 지수 ${counts.benchmark}` : '', counts.level ? `레벨 전용 ${counts.level}` : '']
    .filter(Boolean)
    .join(', ');
  const head = [
    `<b>시세 연결</b>: ${conn} · 재연결 ${st.reconnects}회`,
    `구독 ${st.symbols.length}종목 (watchlist ${counts.watch}${extra ? `, ${extra}` : ''})`,
    `마지막 quote ${st.lastQuoteAt ? fmtKst(st.lastQuoteAt, now) : '-'} · 마지막 연결 ${st.lastConnectAt ? fmtKst(st.lastConnectAt, now) : '-'}`,
  ];
  if (st.lastError) head.push(`최근 오류: ${esc(st.lastError)}`);
  const order = { watch: 0, level: 1, benchmark: 2 };
  const sorted = [...rows].sort((a, b) => order[a.role] - order[b.role]);
  const lines = sorted.map(({ snap: s, role, name }) => {
    const tag = role === 'benchmark' ? ' (비교 지수)' : role === 'level' ? ' (레벨)' : '';
    const label = name && name !== s.symbol ? `<b>${esc(name)}</b> <code>${esc(s.symbol)}</code>` : `<code>${esc(s.symbol)}</code>`;
    if (!s.quote) return `${label}${tag} quote 없음`;
    const d = s.delay.delayed
      ? `지연 ${s.delay.delaySec ?? '?'}s (${s.delay.source === 'update_mode' ? 'TV 표시' : '측정'})`
      : '실시간';
    // 장 마감 중 lag는 마지막 체결 이후 경과 시간일 뿐이라 표시하지 않는다
    const lag = s.marketOpen ? ` · lag ${s.delay.lastLagSec ?? '-'}s` : '';
    return (
      `${label}${tag} ${fmtPrice(s.quote.price)} (${fmtPct(s.r)})\n` +
      `   가격 시각 ${fmtKst(s.quote.priceTime, now)} · 수신 ${fmtKst(s.quote.receivedAt, now)}` +
      `${lag} · ${d}${s.marketOpen ? '' : ' · 장 마감'}`
    );
  });
  return `${head.join('\n')}\n\n<b>종목별</b>\n${lines.join('\n') || '(없음)'}`;
}

// ── 알림 ─────────────────────────────────────────────────────
import type { AlertEvent } from '../triggers/engine.js';
import { fmtLevel } from '../triggers/engine.js';

export function fmtQty(q: number): string {
  return q.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export function fmtSignedNum(v: number): string {
  return `${v >= 0 ? '+' : '-'}${fmtPrice(Math.abs(v))}`;
}

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
  } else if (h.type === 'position') {
    const label = `${h.kind === 'sl' ? '손절' : '익절'} ${h.phase === 'reach' ? '도달' : '근접'}`;
    const what = h.kind === 'sl' ? '손절가' : '익절가';
    head =
      h.phase === 'reach'
        ? `[${label}] ${name}  ${what} ${fmtPrice(h.target)} 도달`
        : `[${label}] ${name}  ${what} ${fmtPrice(h.target)}까지 ${h.distancePct.toFixed(2)}%`;
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

  const p = ev.position;
  const held = p
    ? `보유 중: ${p.qty > 0 ? '' : '숏 '}${fmtQty(Math.abs(p.qty))} @ ${fmtPrice(p.avgPrice)} | 미실현 ${fmtSignedNum(p.unrealized)} (${fmtSigned(p.unrealizedPct, '%', 2)})` +
      (p.stopDistancePct !== null ? ` | 손절가까지 ${p.stopDistancePct.toFixed(1)}%` : '')
    : undefined;

  return [`${head}${delayTag(s)}${startup}`, info.join(' | '), held, tail].filter(Boolean).join('\n');
}

// ── 원인 요약 ────────────────────────────────────────────────
import type { ExplainResult } from '../agent/explain.js';

function link(title: string, url: string): string {
  const t = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  return `<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(t)}</a>`;
}

export function formatExplanation(res: ExplainResult): string {
  const e = res.explanation;
  const scope = e.market_wide ? '→ 시장 전체 움직임' : '→ 종목 고유 움직임';
  if (res.fallback && res.articles.length > 0) {
    // LLM 키 없음·실패: 기사 제목만 보여 준다
    const heads = res.articles.slice(0, 3).map((a) => `• ${link(a.title, a.url)}`);
    return `${scope} (지수 기준 추정)\n원인 요약을 만들지 못했습니다. 최근 기사:\n${heads.join('\n')}`;
  }
  const lines = [scope, `원인 (confidence: ${e.confidence})`, ...e.summary.map((s, i) => `${i + 1}. ${esc(s)}`)];
  if (e.sources.length > 0) lines.push(`근거: ${e.sources.map((s) => link(s.title, s.url)).join(' · ')}`);
  return lines.join('\n');
}

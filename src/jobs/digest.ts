/**
 * 시장별 장 마감 요약. config.yaml digest 시각(KST)에 보낸다.
 * 그날 해당 시장 비교 지수 일봉이 없으면(휴장) 보내지 않는다.
 */
import { Cron } from 'croner';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { HistoryService } from '../market/history.js';
import { computeZ } from '../market/history.js';
import { marketOf, sessionDate, type MarketKey } from '../market/sessions.js';
import type { Journal } from '../journal/journal.js';
import { RULE_LABEL, type RuleName } from '../journal/rulesCheck.js';
import { esc, fmtPct, fmtPrice, fmtSignedNum, fmtZ } from '../bot/format.js';
import { fmtR } from '../bot/journalFormat.js';
import { fmtKst, KST } from '../time.js';

export type DigestMarket = 'krx' | 'us' | 'crypto';
const MARKET_KEY: Record<DigestMarket, MarketKey> = { krx: 'KRX', us: 'US', crypto: 'CRYPTO' };
const TITLE: Record<DigestMarket, string> = { krx: 'KRX 장 마감', us: '미국 장 마감', crypto: '크립토 일봉 마감' };

export interface DigestDeps {
  repo: Repo;
  history: HistoryService;
  journal: Journal;
  benchmarks: Record<string, string>;
  /** watchlist + 보유 종목 */
  symbols: () => string[];
  nameOf: (s: string) => string;
  send: (html: string) => Promise<void>;
  logger: Logger;
}

export const DIGEST_SETTING = 'digest_enabled';

export class DigestService {
  private readonly log: Logger;

  constructor(private readonly d: DigestDeps) {
    this.log = d.logger.child({ mod: 'digest' });
  }

  enabled(): boolean {
    return this.d.repo.getSetting(DIGEST_SETTING) !== 'off';
  }

  setEnabled(on: boolean): void {
    this.d.repo.setSetting(DIGEST_SETTING, on ? 'on' : 'off');
  }

  private spec(symbol: string) {
    const m = this.d.repo.getMeta(symbol);
    return m?.session && m.timezone ? { session: m.session, timezone: m.timezone } : undefined;
  }

  /** 요약 메시지. 휴장이거나 대상이 없으면 undefined (reason 포함) */
  async build(market: DigestMarket, now = new Date()): Promise<{ html?: string; reason?: string }> {
    const mk = MARKET_KEY[market];
    const all = this.d.symbols();
    const symbols = all.filter((s) => marketOf(s, this.d.repo.getMeta(s)?.timezone ?? undefined) === mk);
    const bench = this.d.benchmarks[mk];
    const ref = bench ?? symbols[0];
    if (!ref) return { reason: '대상 종목 없음' };
    const spec = this.spec(ref);
    if (!spec) return { reason: `${ref} 세션 정보 없음` };
    // 마감 직후에 보내므로 1시간 전 시각의 거래일 (크립토 09:05 → 전날 UTC 일봉)
    const day = sessionDate(spec, new Date(now.getTime() - 3_600_000));

    await this.d.history.refreshAll([...new Set([ref, ...symbols])]);
    const bar = (s: string) => {
      const bars = this.d.repo.getBars(s, 2, addDays(day, 1));
      const today = bars.at(-1);
      if (!today || today.date !== day) return undefined;
      const prev = bars.length === 2 ? bars[0]! : undefined;
      const r = prev && prev.close > 0 ? today.close / prev.close - 1 : null;
      return { close: today.close, r, z: computeZ(r, this.d.history.sigma(s, day)) };
    };
    const refBar = bar(ref);
    if (!refBar) return { reason: `${day} ${ref} 일봉 없음 (휴장)` };

    const lines: string[] = [`<b>[${TITLE[market]} 요약]</b> ${day}`];
    if (bench) lines.push(`${esc(this.d.nameOf(bench))} ${fmtPct(refBar.r)}`);

    if (symbols.length) {
      lines.push('');
      const held = new Set(this.d.journal.openSymbols());
      const rows = symbols
        .map((s) => ({ s, b: bar(s) }))
        .sort((a, b) => Math.abs(b.b?.z ?? 0) - Math.abs(a.b?.z ?? 0));
      for (const { s, b } of rows) {
        const name = `${esc(this.d.nameOf(s))}${held.has(s) ? ' (보유)' : ''}`;
        lines.push(b ? `${name} ${fmtPrice(b.close)} ${fmtPct(b.r)} · ${fmtZ(b.z)}` : `${name} 일봉 없음`);
      }
    }

    const alerts = this.d.repo.alertsForSession(day, symbols);
    if (alerts.length) {
      lines.push('', `<b>오늘 알림 ${alerts.length}건</b>`);
      for (const a of alerts.slice(-10)) {
        const kind = a.trigger_type === 'sigma' || a.trigger_type === 'pct'
          ? `${a.direction === 'up' ? '▲' : '▼'}${a.level_reached}${a.trigger_type === 'sigma' ? 'σ' : '%'}`
          : `${a.trigger_type}${a.direction ? `:${a.direction}` : ''}`;
        lines.push(`• ${esc(this.d.nameOf(a.symbol))} ${kind} · ${fmtKst(new Date(a.created_at), now)}`);
      }
    }

    // 최근 24시간 이 시장 매매
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const inMarket = (s: string) => marketOf(s, this.d.repo.getMeta(s)?.timezone ?? undefined) === mk;
    const trades = this.d.repo.listTrades().filter((t) => t.executed_at >= since && inMarket(t.symbol));
    const closed = this.d.journal.groups().filter((g) => g.closedAt && g.closedAt >= since && inMarket(g.symbol));
    if (trades.length || closed.length) {
      lines.push('', `<b>매매</b> 체결 ${trades.length}건 · 청산 ${closed.length}건`);
      for (const g of closed) lines.push(`• ${g.id} ${esc(this.d.nameOf(g.symbol))} ${fmtSignedNum(g.pnl)} · ${fmtR(g.r)}`);
    }

    const viol = this.d.repo.violationsSince(since).filter((v) => inMarket(v.symbol));
    if (viol.length) {
      lines.push('', `<b>규칙 위반 ${viol.length}건</b>`);
      for (const v of viol) lines.push(`• ${RULE_LABEL[v.rule as RuleName] ?? v.rule} — ${esc(this.d.nameOf(v.symbol))} ${esc(v.detail)}`);
    }
    return { html: lines.join('\n') };
  }

  async run(market: DigestMarket, force = false): Promise<string | undefined> {
    if (!force && !this.enabled()) return 'digest 꺼짐';
    try {
      const r = await this.build(market);
      if (!r.html) {
        this.log.info({ market, reason: r.reason }, 'digest 건너뜀');
        return r.reason;
      }
      await this.d.send(r.html);
      this.log.info({ market }, 'digest 전송');
      return undefined;
    } catch (e) {
      this.log.error({ market, err: (e as Error).message }, 'digest 실패');
      return (e as Error).message;
    }
  }

  schedule(times: Record<DigestMarket, string>): Cron[] {
    return (Object.entries(times) as [DigestMarket, string][]).map(([market, hm]) => {
      const [h, m] = hm.split(':');
      return new Cron(`${Number(m)} ${Number(h)} * * *`, { timezone: KST, protect: true }, () => void this.run(market));
    });
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}


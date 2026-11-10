import type { Bot, Context } from 'grammy';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repo, WatchMode } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { HistoryService } from '../market/history.js';
import { MarketDataError, type MarketData, type SymbolCandidate } from '../market/marketData.js';
import type { MarketMonitor } from '../market/monitor.js';
import type { SubscriptionManager } from '../market/subscriptions.js';
import type { SymbolResolver } from '../market/symbols.js';
import type { TriggerEngine } from '../triggers/engine.js';
import type { Explainer } from '../agent/explain.js';
import { fmtLevel } from '../triggers/engine.js';
import { fmtKst } from '../time.js';
import type { Choices } from './confirm.js';
import { delayTag, esc, fmtPct, fmtPrice, fmtZ, formatExplanation, formatList, formatStatus, thresholdLabel } from './format.js';

type ChoiceRun = (ctx: Context) => Promise<void>;

/** 명령 실행 단위. 슬래시 명령과 자연어 의도(intents)가 같이 쓴다. */
export interface Actions {
  add(ctx: Context, args: AddArgs): Promise<void>;
  remove(ctx: Context, query: string): Promise<void>;
  list(ctx: Context): Promise<void>;
  mode(ctx: Context, query: string, mode: WatchMode, threshold: number): Promise<void>;
  level(ctx: Context, args: LevelArgs): Promise<void>;
  /** ms=0이면 해제 */
  mute(ctx: Context, query: string, ms: number): Promise<void>;
  why(ctx: Context, query: string): Promise<void>;
}

export interface BotDeps {
  cfg: AppConfig;
  repo: Repo;
  md: MarketData;
  monitor: MarketMonitor;
  history: HistoryService;
  subs: SubscriptionManager;
  resolver: SymbolResolver;
  choices: Choices;
  engine: TriggerEngine;
  explainer: Explainer;
  logger: Logger;
}

export const COMMANDS: { command: string; description: string }[] = [
  { command: 'add', description: '종목 추가: /add <종목> [sigma|pct] [값]' },
  { command: 'remove', description: '종목 제거: /remove <종목>' },
  { command: 'list', description: 'watchlist와 현재 움직임' },
  { command: 'mode', description: '기준 변경: /mode <종목> sigma|pct <값>' },
  { command: 'level', description: '레벨 알림: /level <종목> <가격> [근접%] [메모]' },
  { command: 'levels', description: '레벨 알림 목록' },
  { command: 'unlevel', description: '레벨 알림 삭제: /unlevel <id>' },
  { command: 'mute', description: '음소거: /mute <종목> <2h|30m|1d|off>' },
  { command: 'why', description: '지금 움직임의 원인 요약: /why <종목>' },
  { command: 'status', description: '시세 연결·지연 상태' },
  { command: 'help', description: '사용법' },
];

const HELP = [
  '<b>5σ Alert</b>',
  '',
  '<code>/add &lt;종목&gt; [sigma|pct] [값]</code> — watchlist 추가',
  '  예: <code>/add 삼성전자</code>, <code>/add 하이닉스 pct 4</code>, <code>/add AAPL sigma 2.5</code>, <code>/add BINANCE:BTCUSDT</code>',
  '<code>/remove &lt;종목&gt;</code> — 제거',
  '<code>/list</code> — 종목별 기준, 현재가·r·z, 오늘 단계, 지연 여부',
  '<code>/mode &lt;종목&gt; sigma|pct &lt;값&gt;</code> — 기준 변경',
  '<code>/level &lt;종목&gt; &lt;가격&gt; [근접%] [메모]</code> — 레벨 알림 (근접 1회 + 도달 1회)',
  '<code>/levels</code>, <code>/unlevel &lt;id&gt;</code> — 레벨 알림 목록·삭제',
  '<code>/mute &lt;종목&gt; &lt;2h|30m|1d|off&gt;</code> — 일시 음소거',
  '<code>/why &lt;종목&gt;</code> — 지금 움직임의 원인 요약 (뉴스 + AI)',
  '',
  '명령어 대신 문장으로도 됩니다. 예: "하이닉스 4% 움직이면 알려줘", "삼성전자 19만원 깨지면 알려줘". 실행 전에 확인 버튼이 나옵니다.',
  '<code>/status</code> — 시세 연결 상태, 종목별 마지막 quote·측정 지연',
  '',
  '알림은 기준을 처음 넘을 때 오고, 같은 날에는 다음 단계를 넘을 때만 다시 옵니다 (σ: 3→4→5→6, %: 5→7.5→10).',
  '시각은 모두 KST, 가격 시각(lp_time) 기준입니다. 지연 종목에는 [N분 지연]이 붙습니다.',
].join('\n');

// ── 인자 파싱 ────────────────────────────────────────────────
const ModeSchema = z.enum(['sigma', 'pct']);
const ThresholdSchema = z.coerce.number().positive().max(100);

export interface AddArgs {
  query: string;
  mode: WatchMode | undefined;
  threshold: number | undefined;
}

/** '/add SK 하이닉스 pct 4' → { query: 'SK 하이닉스', mode: 'pct', threshold: 4 } */
export function parseAddArgs(text: string): AddArgs | { error: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let mode: WatchMode | undefined;
  let threshold: number | undefined;
  const last = tokens.at(-1);
  const prev = tokens.at(-2);
  if (prev && ModeSchema.safeParse(prev.toLowerCase()).success && last !== undefined) {
    const t = ThresholdSchema.safeParse(last);
    if (!t.success) return { error: `기준값이 올바르지 않습니다: ${last}` };
    mode = prev.toLowerCase() as WatchMode;
    threshold = t.data;
    tokens.splice(-2, 2);
  } else if (last && ModeSchema.safeParse(last.toLowerCase()).success) {
    mode = last.toLowerCase() as WatchMode;
    tokens.pop();
  }
  const query = tokens.join(' ');
  if (!query) return { error: '종목을 입력하세요. 예: <code>/add 삼성전자 sigma 3</code>' };
  return { query, mode, threshold };
}

/** '2h' | '30m' | '1d' | '1.5h' → ms. 'off'는 0 */
export function parseDuration(s: string): number | undefined {
  if (/^(off|해제|0)$/i.test(s.trim())) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|분|h|시간|d|일)$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  const mult = u.startsWith('m') || u === '분' ? 60_000 : u.startsWith('h') || u === '시간' ? 3_600_000 : 86_400_000;
  const ms = n * mult;
  return ms > 0 && ms <= 30 * 86_400_000 ? ms : undefined;
}

const PriceSchema = z.coerce.number().positive();

export interface LevelArgs {
  query: string;
  price: number;
  proximityPct: number | undefined;
  note: string | undefined;
}

/** '/level 삼성전자 190,000 2 ELS 배리어' → 가격 앞까지가 종목, 가격 다음 숫자(옵션)는 근접%, 나머지는 메모 */
export function parseLevelArgs(text: string): LevelArgs | { error: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const isNum = (t: string) => /^\d[\d,]*(\.\d+)?%?$/.test(t);
  const pi = tokens.findIndex((t, i) => i > 0 && isNum(t) && !t.endsWith('%'));
  if (pi < 1) return { error: '형식: <code>/level &lt;종목&gt; &lt;가격&gt; [근접%] [메모]</code>' };
  const price = PriceSchema.safeParse(tokens[pi]!.replace(/,/g, ''));
  if (!price.success) return { error: `가격이 올바르지 않습니다: ${tokens[pi]}` };
  let rest = tokens.slice(pi + 1);
  let proximityPct: number | undefined;
  if (rest[0] && isNum(rest[0])) {
    const p = z.coerce.number().min(0).max(50).safeParse(rest[0].replace(/[%,]/g, ''));
    if (!p.success) return { error: `근접%가 올바르지 않습니다: ${rest[0]}` };
    proximityPct = p.data;
    rest = rest.slice(1);
  }
  return { query: tokens.slice(0, pi).join(' '), price: price.data, proximityPct, note: rest.join(' ') || undefined };
}

// ── 핸들러 ──────────────────────────────────────────────────
export function registerCommands(bot: Bot, d: BotDeps): Actions {
  const log = d.logger.child({ mod: 'commands' });
  const html = { parse_mode: 'HTML' as const };

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, html));

  const findWatch = (q: string) => d.repo.listWatch().find((w) => d.resolver.matches(q, w.symbol, w.display_name));

  /** 종목 정보 조회·저장. 알 수 없는 symbol이면 후보 버튼을 보내고 undefined */
  async function ensureMeta(ctx: Context, symbol: string, onPick: (c: SymbolCandidate) => ChoiceRun) {
    try {
      const meta = await d.md.symbolInfo(symbol);
      d.repo.upsertMeta({
        symbol,
        description: meta.description,
        currency: meta.currency ?? null,
        timezone: meta.timezone,
        session: meta.session,
      });
      d.monitor.setMeta(meta);
      return meta;
    } catch (e) {
      if (e instanceof MarketDataError && e.code === 'SYMBOL_ERROR') {
        const ticker = symbol.split(':')[1] ?? symbol;
        const cands = (await d.md.search(ticker).catch(() => [])).slice(0, 6);
        if (cands.length === 0) {
          await ctx.reply(`알 수 없는 종목입니다: <code>${esc(symbol)}</code>`, html);
          return undefined;
        }
        await ctx.reply(`알 수 없는 종목입니다: <code>${esc(symbol)}</code>\n이 중에 있나요?`, {
          ...html,
          reply_markup: d.choices.keyboard(
            ctx.chat!.id,
            cands.map((c) => ({ label: `${c.symbol} · ${c.description}`.slice(0, 60), run: onPick(c) })),
          ),
        });
        return;
      }
      throw e;
    }
  }

  async function addSymbol(ctx: Context, symbol: string, aliasName: string | undefined, args: AddArgs): Promise<void> {
    const meta = await ensureMeta(ctx, symbol, (c) => (c2) => addSymbol(c2, c.symbol, d.resolver.displayName(c.symbol), args));
    if (!meta) return;

    const mode = args.mode ?? d.cfg.defaults.mode;
    const threshold = args.threshold ?? (mode === 'sigma' ? d.cfg.defaults.sigma_threshold : d.cfg.defaults.pct_threshold);
    const isUs = meta.timezone === 'America/New_York';
    const displayName = aliasName ?? meta.localDescription ?? meta.description ?? symbol;
    const res = d.repo.addWatch({
      symbol,
      displayName,
      mode,
      threshold,
      volumeEnabled: isUs ? d.cfg.defaults.volume_enabled_us : true,
    });
    if (res === 'exists') {
      const w = d.repo.getWatch(symbol);
      await ctx.reply(
        `이미 등록된 종목입니다: <b>${esc(w?.display_name ?? symbol)}</b> <code>${esc(symbol)}</code> (기준 ${w ? thresholdLabel(w) : '-'})`,
        html,
      );
      return;
    }
    log.info({ symbol, mode, threshold }, 'watchlist 추가');
    d.subs.request();
    const bars = await d.history.refresh(symbol).catch((e: Error) => {
      log.warn({ symbol, err: e.message }, '일봉 갱신 실패');
      return 0;
    });
    await ctx.reply(
      `추가했습니다: <b>${esc(displayName)}</b> <code>${esc(symbol)}</code>\n` +
        `기준 ${thresholdLabel({ mode, threshold })} · ${esc(meta.timezone)} ${esc(meta.session)}` +
        (bars === 0 ? '\n⚠️ 일봉을 받지 못해 σ 계산이 아직 안 됩니다.' : ''),
      html,
    );
  }

  async function addLevel(ctx: Context, symbol: string, a: LevelArgs): Promise<void> {
    const meta = await ensureMeta(ctx, symbol, (c) => (c2) => addLevel(c2, c.symbol, a));
    if (!meta) return;
    const snap = d.monitor.snapshot(symbol);
    const price = snap.quote?.price;
    const direction = price === undefined ? 'cross' : price < a.price ? 'above' : 'below';
    const id = d.repo.addLevel({ symbol, price: a.price, direction, proximityPct: a.proximityPct ?? null, note: a.note ?? null });
    d.engine.reloadLevels();
    d.subs.request();
    const name = d.repo.getWatch(symbol)?.display_name ?? d.resolver.displayName(symbol) ?? meta.localDescription ?? meta.description;
    const prox = a.proximityPct ?? d.cfg.level_default_proximity_pct;
    const dirText =
      direction === 'above' ? '위로 돌파 시' : direction === 'below' ? '아래로 이탈 시' : '방향은 첫 시세로 결정';
    await ctx.reply(
      `레벨 알림 #${id}: <b>${esc(name)}</b> <code>${esc(symbol)}</code> ${fmtPrice(a.price)} (${dirText})\n` +
        `근접 ${prox}% 이내 1회 + 도달 1회` +
        (price !== undefined ? ` · 현재가 ${fmtPrice(price)}` : '') +
        (a.note ? `\n메모: ${esc(a.note)}` : ''),
      html,
    );
  }

  // ── 액션 (슬래시 명령과 자연어 의도가 같이 쓴다) ─────────────
  async function resolveOrAsk(ctx: Context, query: string, run: (c: Context, symbol: string, aliasName: string | undefined) => Promise<void>): Promise<void> {
    const w = findWatch(query);
    if (w) return run(ctx, w.symbol, w.display_name ?? undefined);
    const r = await d.resolver.resolve(query).catch((e: Error) => {
      log.warn({ err: e.message }, '종목 검색 실패');
      return { kind: 'error' as const, message: e.message };
    });
    switch (r.kind) {
      case 'resolved':
        return run(ctx, r.symbol, r.displayName);
      case 'choices':
        await ctx.reply(`"${esc(query)}" 후보가 여러 개입니다. 선택하세요.`, {
          ...html,
          reply_markup: d.choices.keyboard(
            ctx.chat!.id,
            r.candidates.map((c) => ({
              label: `${c.symbol} · ${c.description}`.slice(0, 60),
              run: (c2) => run(c2, c.symbol, d.resolver.displayName(c.symbol)),
            })),
          ),
        });
        return;
      case 'notfound':
        await ctx.reply(
          `"${esc(query)}"에 해당하는 종목을 찾지 못했습니다.\n` +
            `<code>KRX:005930</code> 처럼 거래소:코드로 입력하거나 aliases.yaml에 별칭을 추가하세요.`,
          html,
        );
        return;
      case 'error':
        await ctx.reply(`종목 검색 중 오류가 났습니다: ${esc(r.message)}`, html);
    }
  }

  const actions: Actions = {
    add: (ctx, args) => resolveOrAsk(ctx, args.query, (c, sym, name) => addSymbol(c, sym, name, args)),

    async remove(ctx, q) {
      const hit = findWatch(q);
      if (!hit) return void (await ctx.reply(`watchlist에 없는 종목입니다: ${esc(q)}`, html));
      d.repo.removeWatch(hit.symbol);
      d.subs.request();
      log.info({ symbol: hit.symbol }, 'watchlist 제거');
      await ctx.reply(`제거했습니다: <b>${esc(hit.display_name ?? hit.symbol)}</b> <code>${esc(hit.symbol)}</code>`, html);
    },

    async list(ctx) {
      const items = d.repo.listWatch().map((w) => {
        const snap = d.monitor.snapshot(w.symbol);
        return { w, s: snap, today: d.engine.todaySteps(w, snap.sessionDate) };
      });
      await ctx.reply(formatList(items), html);
    },

    async mode(ctx, q, mode, threshold) {
      const w = findWatch(q);
      if (!w) return void (await ctx.reply(`watchlist에 없는 종목입니다: ${esc(q)}`, html));
      d.repo.updateWatchMode(w.symbol, mode, threshold);
      log.info({ symbol: w.symbol, mode, threshold }, '기준 변경');
      await ctx.reply(
        `<b>${esc(w.display_name ?? w.symbol)}</b> 기준: ${thresholdLabel(w)} → ${thresholdLabel({ mode, threshold })}\n` +
          '오늘 이미 보낸 단계보다 높은 단계부터 알립니다.',
        html,
      );
    },

    level: (ctx, a) => resolveOrAsk(ctx, a.query, (c, sym) => addLevel(c, sym, a)),

    async mute(ctx, q, ms) {
      const w = findWatch(q);
      if (!w) return void (await ctx.reply(`watchlist에 없는 종목입니다: ${esc(q)}`, html));
      const name = esc(w.display_name ?? w.symbol);
      if (ms === 0) {
        d.repo.setMuted(w.symbol, null);
        return void (await ctx.reply(`<b>${name}</b> 음소거를 해제했습니다.`, html));
      }
      const until = new Date(Date.now() + ms);
      d.repo.setMuted(w.symbol, until.toISOString());
      await ctx.reply(`<b>${name}</b> ${fmtKst(until)} KST까지 음소거합니다.`, html);
    },

    why: (ctx, q) => resolveOrAsk(ctx, q, (c, sym, name) => why(c, sym, name)),
  };

  /** /why: trigger 없이 지금 움직임의 원인 요약 */
  async function why(ctx: Context, symbol: string, aliasName: string | undefined): Promise<void> {
    let snap = d.monitor.snapshot(symbol);
    let meta = d.repo.getMeta(symbol);
    if (!snap.quote) {
      // 구독하지 않은 종목: 메타·일봉·quote를 직접 받는다
      const m = await ensureMeta(ctx, symbol, (c) => (c2) => why(c2, c.symbol, d.resolver.displayName(c.symbol)));
      if (!m) return;
      await d.history.refresh(symbol).catch(() => 0);
      snap = d.monitor.snapshotWith(await d.md.quote(symbol));
      meta = d.repo.getMeta(symbol);
    }
    const name = aliasName ?? d.repo.getWatch(symbol)?.display_name ?? d.resolver.displayName(symbol) ?? meta?.description ?? symbol;
    const q = snap.quote!;
    const head =
      `<b>${esc(name)}</b> <code>${esc(symbol)}</code>  ${fmtPrice(q.price)}  ${fmtPct(snap.r)} · ${fmtZ(snap.z)}` +
      `${delayTag(snap)}\n가격 시각 ${fmtKst(q.priceTime)} KST`;
    const msg = await ctx.reply(`${head}\n\n<i>원인 분석 중…</i>`, { ...html, link_preview_options: { is_disabled: true } });
    const benchSym = d.cfg.benchmarks[snap.market];
    const bench =
      benchSym && benchSym !== symbol
        ? (() => {
            const b = d.monitor.snapshot(benchSym);
            return { name: d.resolver.displayName(benchSym) ?? benchSym, r: b.r, delayed: b.delay.delayed };
          })()
        : undefined;
    const res = await d.explainer.explain({ symbol, name, description: meta?.description ?? undefined, snapshot: snap, benchmark: bench });
    log.info({ symbol, confidence: res.explanation.confidence, sources: res.explanation.sources.length, fallback: res.fallback }, '/why');
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, `${head}\n\n${formatExplanation(res)}`, {
      ...html,
      link_preview_options: { is_disabled: true },
    });
  }

  // ── 슬래시 명령 ─────────────────────────────────────────────
  bot.command('add', async (ctx) => {
    const args = parseAddArgs(ctx.match);
    if ('error' in args) return void (await ctx.reply(args.error, html));
    await actions.add(ctx, args);
  });

  bot.command('remove', async (ctx) => {
    const q = ctx.match.trim();
    if (!q) return void (await ctx.reply('제거할 종목을 입력하세요. 예: <code>/remove 삼성전자</code>', html));
    await actions.remove(ctx, q);
  });

  bot.command('list', (ctx) => actions.list(ctx));

  bot.command('mode', async (ctx) => {
    const tokens = ctx.match.trim().split(/\s+/).filter(Boolean);
    const usage = '형식: <code>/mode &lt;종목&gt; sigma|pct &lt;값&gt;</code>';
    if (tokens.length < 3) return void (await ctx.reply(usage, html));
    const mode = ModeSchema.safeParse(tokens.at(-2)!.toLowerCase());
    const th = ThresholdSchema.safeParse(tokens.at(-1));
    if (!mode.success || !th.success) return void (await ctx.reply(usage, html));
    await actions.mode(ctx, tokens.slice(0, -2).join(' '), mode.data, th.data);
  });

  bot.command('level', async (ctx) => {
    const a = parseLevelArgs(ctx.match);
    if ('error' in a) return void (await ctx.reply(a.error, html));
    await actions.level(ctx, a);
  });

  bot.command('levels', async (ctx) => {
    const rows = d.repo.listLevels(true);
    if (rows.length === 0) return void (await ctx.reply('활성 레벨 알림이 없습니다.'));
    const lines = rows.map((l) => {
      const snap = d.monitor.snapshot(l.symbol);
      const cur = snap.quote ? ` · 현재 ${fmtPrice(snap.quote.price)} (${fmtPct(l.price / snap.quote.price - 1)} 남음)` : '';
      const dir = l.direction === 'above' ? '▲' : l.direction === 'below' ? '▼' : '↕';
      const name = d.repo.getWatch(l.symbol)?.display_name ?? d.resolver.displayName(l.symbol) ?? l.symbol;
      return `#${l.id} ${esc(name)} <code>${esc(l.symbol)}</code> ${dir} ${fmtPrice(l.price)}${cur}${l.note ? ` — ${esc(l.note)}` : ''}`;
    });
    await ctx.reply(`<b>레벨 알림</b>\n${lines.join('\n')}`, html);
  });

  bot.command('unlevel', async (ctx) => {
    const id = z.coerce.number().int().positive().safeParse(ctx.match.trim().replace(/^#/, ''));
    if (!id.success) return void (await ctx.reply('형식: <code>/unlevel &lt;id&gt;</code> (id는 /levels 참고)', html));
    if (!d.repo.deactivateLevel(id.data)) return void (await ctx.reply(`활성 레벨 알림 #${id.data}이 없습니다.`));
    d.engine.reloadLevels();
    d.subs.request();
    await ctx.reply(`레벨 알림 #${id.data}을 삭제했습니다.`);
  });

  bot.command('mute', async (ctx) => {
    const tokens = ctx.match.trim().split(/\s+/).filter(Boolean);
    const usage = '형식: <code>/mute &lt;종목&gt; &lt;2h|30m|1d|off&gt;</code>';
    if (tokens.length < 2) return void (await ctx.reply(usage, html));
    const ms = parseDuration(tokens.at(-1)!);
    if (ms === undefined) return void (await ctx.reply(usage, html));
    await actions.mute(ctx, tokens.slice(0, -1).join(' '), ms);
  });

  bot.command('why', async (ctx) => {
    const q = ctx.match.trim();
    if (!q) return void (await ctx.reply('형식: <code>/why &lt;종목&gt;</code>', html));
    await actions.why(ctx, q);
  });

  bot.command('status', async (ctx) => {
    const st = d.md.status();
    const watch = new Map(d.repo.listWatch().map((w) => [w.symbol, w]));
    const benches = new Set(Object.values(d.cfg.benchmarks));
    const rows = st.symbols.map((s) => ({
      snap: d.monitor.snapshot(s),
      name: watch.get(s)?.display_name ?? d.resolver.displayName(s) ?? d.repo.getMeta(s)?.description ?? s,
      role: watch.has(s) ? ('watch' as const) : benches.has(s) ? ('benchmark' as const) : ('level' as const),
    }));
    await ctx.reply(formatStatus(st, rows), html);
  });

  return actions;
}

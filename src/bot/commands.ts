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
import type { Choices } from './confirm.js';
import { esc, formatList, formatStatus, thresholdLabel } from './format.js';

export interface BotDeps {
  cfg: AppConfig;
  repo: Repo;
  md: MarketData;
  monitor: MarketMonitor;
  history: HistoryService;
  subs: SubscriptionManager;
  resolver: SymbolResolver;
  choices: Choices;
  logger: Logger;
}

export const COMMANDS: { command: string; description: string }[] = [
  { command: 'add', description: '종목 추가: /add <종목> [sigma|pct] [값]' },
  { command: 'remove', description: '종목 제거: /remove <종목>' },
  { command: 'list', description: 'watchlist와 현재 움직임' },
  { command: 'status', description: '시세 연결·지연 상태' },
  { command: 'help', description: '사용법' },
];

const HELP = [
  '<b>5σ Alert</b>',
  '',
  '<code>/add &lt;종목&gt; [sigma|pct] [값]</code> — watchlist 추가',
  '  예: <code>/add 삼성전자</code>, <code>/add 하이닉스 pct 4</code>, <code>/add AAPL sigma 2.5</code>, <code>/add BINANCE:BTCUSDT</code>',
  '<code>/remove &lt;종목&gt;</code> — 제거',
  '<code>/list</code> — 종목별 기준, 현재가·r·z, 지연 여부',
  '<code>/status</code> — 시세 연결 상태, 종목별 마지막 quote·측정 지연',
  '',
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

// ── 핸들러 ──────────────────────────────────────────────────
export function registerCommands(bot: Bot, d: BotDeps): void {
  const log = d.logger.child({ mod: 'commands' });
  const html = { parse_mode: 'HTML' as const };

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, html));

  const candidateButtons = (ctx: Context, cands: SymbolCandidate[], args: AddArgs) =>
    d.choices.keyboard(
      ctx.chat!.id,
      cands.map((c) => ({
        label: `${c.symbol} · ${c.description}`.slice(0, 60),
        run: (c2) => addSymbol(c2, c.symbol, d.resolver.displayName(c.symbol), args),
      })),
    );

  async function addSymbol(ctx: Context, symbol: string, aliasName: string | undefined, args: AddArgs): Promise<void> {
    let meta;
    try {
      meta = await d.md.symbolInfo(symbol);
    } catch (e) {
      if (e instanceof MarketDataError && e.code === 'SYMBOL_ERROR') {
        const ticker = symbol.split(':')[1] ?? symbol;
        const cands = (await d.md.search(ticker).catch(() => [])).slice(0, 6);
        if (cands.length === 0) {
          await ctx.reply(`알 수 없는 종목입니다: <code>${esc(symbol)}</code>`, html);
          return;
        }
        await ctx.reply(`알 수 없는 종목입니다: <code>${esc(symbol)}</code>\n이 중에 있나요?`, {
          ...html,
          reply_markup: candidateButtons(ctx, cands, args),
        });
        return;
      }
      throw e;
    }

    d.repo.upsertMeta({
      symbol,
      description: meta.description,
      currency: meta.currency ?? null,
      timezone: meta.timezone,
      session: meta.session,
    });
    d.monitor.setMeta(meta);

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

  bot.command('add', async (ctx) => {
    const args = parseAddArgs(ctx.match);
    if ('error' in args) return void (await ctx.reply(args.error, html));
    const r = await d.resolver.resolve(args.query).catch((e: Error) => {
      log.warn({ err: e.message }, '종목 검색 실패');
      return { kind: 'error' as const, message: e.message };
    });
    switch (r.kind) {
      case 'resolved':
        return addSymbol(ctx, r.symbol, r.displayName, args);
      case 'choices':
        await ctx.reply(`"${esc(args.query)}" 후보가 여러 개입니다. 선택하세요.`, {
          ...html,
          reply_markup: candidateButtons(ctx, r.candidates, args),
        });
        return;
      case 'notfound':
        await ctx.reply(
          `"${esc(args.query)}"에 해당하는 종목을 찾지 못했습니다.\n` +
            `<code>KRX:005930</code> 처럼 거래소:코드로 입력하거나 aliases.yaml에 별칭을 추가하세요.`,
          html,
        );
        return;
      case 'error':
        await ctx.reply(`종목 검색 중 오류가 났습니다: ${esc(r.message)}`, html);
    }
  });

  bot.command('remove', async (ctx) => {
    const q = ctx.match.trim();
    if (!q) return void (await ctx.reply('제거할 종목을 입력하세요. 예: <code>/remove 삼성전자</code>', html));
    const hit = d.repo.listWatch().find((w) => d.resolver.matches(q, w.symbol, w.display_name));
    if (!hit) return void (await ctx.reply(`watchlist에 없는 종목입니다: ${esc(q)}`, html));
    d.repo.removeWatch(hit.symbol);
    d.subs.request();
    log.info({ symbol: hit.symbol }, 'watchlist 제거');
    await ctx.reply(`제거했습니다: <b>${esc(hit.display_name ?? hit.symbol)}</b> <code>${esc(hit.symbol)}</code>`, html);
  });

  bot.command('list', async (ctx) => {
    const items = d.repo.listWatch().map((w) => ({ w, s: d.monitor.snapshot(w.symbol) }));
    await ctx.reply(formatList(items), html);
  });

  bot.command('status', async (ctx) => {
    const st = d.md.status();
    const snaps = st.symbols.map((s) => d.monitor.snapshot(s));
    await ctx.reply(formatStatus(st, snaps), html);
  });
}

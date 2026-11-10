import { Api } from 'grammy';
import { createBot, startBot } from './bot/bot.js';
import { AlertNotifier } from './bot/notifier.js';
import { TriggerEngine } from './triggers/engine.js';
import { AlertEnricher } from './agent/alertEnricher.js';
import { Explainer } from './agent/explain.js';
import { GroqClient } from './agent/llm.js';
import { GoogleNewsRss } from './agent/news.js';
import { Journal } from './journal/journal.js';
import { BinanceFuturesImporter } from './journal/importers/binanceFutures.js';
import { scheduleSync } from './jobs/sync.js';
import { DigestService } from './jobs/digest.js';
import { RulesChecker } from './journal/rulesCheck.js';
import { PendingStops } from './bot/naturalLanguage.js';
import { esc } from './bot/format.js';
import { Choices } from './bot/confirm.js';
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { scheduleDailyBars } from './jobs/dailyBars.js';
import { createLogger } from './logger.js';
import { HistoryService } from './market/history.js';
import { MarketMonitor } from './market/monitor.js';
import { SubscriptionManager } from './market/subscriptions.js';
import { SymbolResolver } from './market/symbols.js';
import { TradingViewMarketData } from './market/tradingview.js';

async function main(): Promise<void> {
  const conf = loadConfig();
  const logger = createLogger(conf.env.LOG_LEVEL);
  const { env, cfg } = conf;

  const repo = new Repo(conf.dbPath);
  logger.info({ db: conf.dbPath }, 'DB 열림');

  const credentials = env.TV_SESSION ? { session: env.TV_SESSION, signature: env.TV_SIGNATURE } : undefined;
  const md = new TradingViewMarketData({ logger, credentials });
  logger.info({ tvAuth: credentials ? 'cookie' : 'anonymous' }, 'TradingView 접근 방식');

  const history = new HistoryService(repo, md, cfg.defaults.sigma_window, logger);
  const monitor = new MarketMonitor(
    repo,
    history,
    { lagThresholdSec: cfg.delay.lag_threshold_sec, lagPersistMin: cfg.delay.lag_persist_min },
    logger,
  );
  const subs = new SubscriptionManager(repo, md, logger);
  const benchmarks = Object.values(cfg.benchmarks);
  subs.addSource(() => benchmarks);
  const resolver = new SymbolResolver(conf.aliases, md);
  const choices = new Choices(logger);

  const features = cfg.features;
  logger.info({ features }, '기능 스위치');
  const journal = new Journal(repo, logger);
  if (features.journal) {
    // 보유 종목은 watchlist에 없어도 구독
    subs.addSource(() => journal.openSymbols());
    journal.onChange(() => subs.request());
  }
  const syncer =
    features.journal && env.BINANCE_API_KEY && env.BINANCE_API_SECRET
      ? new BinanceFuturesImporter({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET }, repo, journal, logger)
      : undefined;
  logger.info({ binance: syncer ? 'on' : 'off' }, 'Binance 동기화');

  const llm = env.GROQ_API_KEY
    ? new GroqClient(env.GROQ_API_KEY, { fast: env.GROQ_MODEL_FAST, smart: env.GROQ_MODEL_SMART }, logger)
    : undefined;
  logger.info({ llm: llm ? `groq (${env.GROQ_MODEL_FAST} / ${env.GROQ_MODEL_SMART})` : 'none' }, 'LLM 설정');
  const explainer = new Explainer(llm, new GoogleNewsRss(logger), logger);
  const enricher = new AlertEnricher(explainer, repo, logger);
  const notifier = new AlertNotifier(new Api(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_ALLOWED_CHAT_IDS, repo, logger, 60_000, enricher);
  const engine = new TriggerEngine({
    repo,
    monitor,
    sink: notifier,
    logger,
    rules: {
      esc: {
        sigmaSteps: cfg.escalation.sigma_steps,
        pctStep: cfg.escalation.pct_step,
        pctBase: cfg.defaults.pct_threshold,
      },
      volumeRatio: cfg.defaults.volume_ratio,
      volumeWarmupMin: 30,
      levelDefaultProximityPct: cfg.level_default_proximity_pct,
    },
    benchmarks: cfg.benchmarks,
    nameOf: (s) => resolver.displayName(s) ?? repo.getMeta(s)?.description ?? s,
    positionOf: features.journal ? (s) => journal.position(s) : undefined,
    defaultWatch: {
      mode: cfg.defaults.mode,
      threshold: cfg.defaults.mode === 'sigma' ? cfg.defaults.sigma_threshold : cfg.defaults.pct_threshold,
    },
  });
  engine.start();
  subs.addSource(() => engine.levelSymbols());

  // 구독 대상 메타(세션·지연) 준비: DB 복원 → 없으면 조회
  const symbols = subs.desired();
  for (const s of symbols) {
    monitor.loadMeta(s);
    if (!monitor.hasMeta(s)) {
      try {
        const meta = await md.symbolInfo(s);
        repo.upsertMeta({ symbol: s, description: meta.description, currency: meta.currency ?? null, timezone: meta.timezone, session: meta.session });
        monitor.setMeta(meta);
      } catch (e) {
        logger.warn({ symbol: s, err: (e as Error).message }, '종목 정보 조회 실패');
      }
    }
  }
  await history.refreshAll(symbols);

  md.setExpectQuotes(() => monitor.expectQuotes(md.status().symbols));
  await md.watch(
    symbols,
    (q) => monitor.onQuote(q),
    (e) => logger.warn({ code: e.code, symbol: e.symbol, err: e.message }, '시세 오류'),
  );

  const telegram = new Api(env.TELEGRAM_BOT_TOKEN);
  const nameOf = (s: string) => repo.getWatch(s)?.display_name ?? resolver.displayName(s) ?? repo.getMeta(s)?.description ?? s;
  const broadcast = async (html: string, keyboardFor?: (chatId: number) => ReturnType<Choices['keyboard']>) => {
    for (const chatId of env.TELEGRAM_ALLOWED_CHAT_IDS) {
      await telegram
        .sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboardFor?.(chatId) })
        .catch((e: Error) => logger.error({ err: e.message }, '메시지 전송 실패'));
    }
  };

  // 매매 규칙 체크: 새 체결마다
  const rules = new RulesChecker(repo, journal, cfg.trading_rules, logger);
  const pendingStops = new PendingStops();
  if (features.journal && features.rules_digest) journal.onRecorded((trades) => {
    const warnings = rules.check(trades);
    // 기록 확인 메시지 뒤에 오도록 잠깐 늦춘다
    setTimeout(() => {
      for (const w of warnings) {
        const text = `${w.text}\n<b>${esc(nameOf(w.symbol))}</b> <code>${esc(w.symbol)}</code> · 거래 ${w.groupId}`;
        void broadcast(
          text,
          w.askStop
            ? (chatId) =>
                choices.keyboard(chatId, [
                  {
                    label: '손절가 입력',
                    run: async (c) => {
                      pendingStops.set(chatId, w.symbol);
                      await c.reply(`${nameOf(w.symbol)} 손절가를 숫자로 보내 주세요. (예: 190000)`);
                    },
                  },
                ], '나중에')
            : undefined,
        );
      }
    }, 500);
  });

  const digest = new DigestService({
    repo, history, journal, benchmarks: cfg.benchmarks,
    symbols: () => [...new Set([...repo.listWatch().map((w) => w.symbol), ...(features.journal ? journal.openSymbols() : [])])],
    nameOf,
    send: (html) => broadcast(html),
    logger,
  });

  const crons = scheduleDailyBars(cfg.daily_bars_refresh, history, () => subs.desired(), logger);
  if (features.rules_digest) crons.push(...digest.schedule(cfg.digest));
  if (syncer) {
    crons.push(scheduleSync(cfg.journal_sync_minutes, syncer, logger));
    void syncer.sync().catch((e: Error) => logger.warn({ err: e.message }, '첫 Binance 동기화 실패'));
  }

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALLOWED_CHAT_IDS, {
    cfg, repo, md, monitor, history, subs, resolver, choices, engine, explainer, journal, syncer, rules, digest, logger,
  }, llm, pendingStops);
  await startBot(bot, logger, features);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ sig }, '종료 중');
    for (const c of crons) c.stop();
    engine.stop();
    subs.stop();
    await bot.stop().catch(() => undefined);
    await md.close();
    repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

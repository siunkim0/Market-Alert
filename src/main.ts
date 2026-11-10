import { Api } from 'grammy';
import { createBot, startBot } from './bot/bot.js';
import { AlertNotifier } from './bot/notifier.js';
import { TriggerEngine } from './triggers/engine.js';
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

  const notifier = new AlertNotifier(new Api(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_ALLOWED_CHAT_IDS, repo, logger);
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

  const crons = scheduleDailyBars(cfg.daily_bars_refresh, history, () => subs.desired(), logger);

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALLOWED_CHAT_IDS, {
    cfg, repo, md, monitor, history, subs, resolver, choices, engine, logger,
  });
  await startBot(bot, logger);

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

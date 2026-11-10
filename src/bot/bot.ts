import { Bot, GrammyError, HttpError } from 'grammy';
import type { Logger } from '../logger.js';
import type { LlmClient } from '../agent/llm.js';
import { COMMANDS, registerCommands, type BotDeps } from './commands.js';
import { registerNaturalLanguage } from './naturalLanguage.js';

export function createBot(token: string, allowedChatIds: number[], deps: BotDeps, llm: LlmClient | undefined): Bot {
  const log = deps.logger.child({ mod: 'bot' });
  const allowed = new Set(allowedChatIds);
  const bot = new Bot(token);

  // 허용된 chat 외의 업데이트는 전부 무시한다.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !allowed.has(chatId)) {
      log.debug({ chatId }, '허용되지 않은 chat 무시');
      return;
    }
    await next();
  });

  deps.choices.register(bot);
  const actions = registerCommands(bot, deps);
  // 명령어 핸들러 뒤에 등록해야 명령어가 먼저 처리된다
  registerNaturalLanguage(bot, { llm, actions, choices: deps.choices, resolver: deps.resolver, logger: deps.logger });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error({ desc: e.description }, 'Telegram API 오류');
    else if (e instanceof HttpError) log.error({ err: e.message }, 'Telegram 연결 오류');
    else log.error({ err: (e as Error)?.message, stack: (e as Error)?.stack }, '핸들러 오류');
    void err.ctx.reply('처리 중 오류가 발생했습니다. 로그를 확인하세요.').catch(() => undefined);
  });

  return bot;
}

export async function startBot(bot: Bot, logger: Logger): Promise<void> {
  await bot.api.setMyCommands(COMMANDS).catch((e: Error) => logger.warn({ err: e.message }, 'setMyCommands 실패'));
  bot
    .start({
      drop_pending_updates: false,
      onStart: (me) => logger.info({ bot: me.username }, '봇 시작'),
    })
    .catch((e: Error) => {
      // 종료 중 bot.stop()이 polling 대기를 끊으면 'Aborted delay'가 온다 — 정상
      if (/Aborted/.test(e.message)) logger.debug('봇 polling 중단');
      else logger.error({ err: e.message }, '봇 polling 실패');
    });
}

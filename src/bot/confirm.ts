/** 인라인 버튼 선택 흐름. 버튼마다 실행할 함수를 메모리에 잠시 보관한다. */
import { randomBytes } from 'node:crypto';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Logger } from '../logger.js';

export interface ChoiceOption {
  label: string;
  run: (ctx: Context) => Promise<void>;
}

interface Pending {
  chatId: number;
  options: ChoiceOption[];
  expiresAt: number;
}

const TTL_MS = 10 * 60_000;

export class Choices {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly logger: Logger) {}

  /** 선택지 키보드를 만든다. 마지막 줄에 [취소]가 붙는다. */
  keyboard(chatId: number, options: ChoiceOption[], cancelLabel = '취소'): InlineKeyboard {
    this.gc();
    const id = randomBytes(6).toString('hex');
    this.pending.set(id, { chatId, options, expiresAt: Date.now() + TTL_MS });
    const kb = new InlineKeyboard();
    options.forEach((o, i) => kb.text(o.label, `ch:${id}:${i}`).row());
    kb.text(cancelLabel, `ch:${id}:x`);
    return kb;
  }

  register(bot: Bot): void {
    bot.callbackQuery(/^ch:([0-9a-f]+):(\d+|x)$/, async (ctx) => {
      const [, id, idx] = ctx.match;
      const p = id ? this.pending.get(id) : undefined;
      if (!p || p.expiresAt < Date.now() || p.chatId !== ctx.chat?.id) {
        await ctx.answerCallbackQuery({ text: '만료된 선택입니다. 다시 시도해 주세요.' });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        return;
      }
      this.pending.delete(id!);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      if (idx === 'x') {
        await ctx.reply('취소했습니다.');
        return;
      }
      const opt = p.options[Number(idx)];
      if (!opt) return;
      try {
        await opt.run(ctx);
      } catch (e) {
        this.logger.error({ err: (e as Error).message }, '선택 처리 실패');
        await ctx.reply(`처리 중 오류: ${(e as Error).message}`);
      }
    });
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
  }
}

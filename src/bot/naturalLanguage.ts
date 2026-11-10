/** 명령어가 아닌 텍스트 메시지 처리: 의도 분류 → 확인 버튼 → Actions 실행 */
import type { Bot, Context } from 'grammy';
import { isReadOnly, parseIntent, type Intent } from '../agent/intents.js';
import type { LlmClient } from '../agent/llm.js';
import type { Logger } from '../logger.js';
import type { SymbolResolver } from '../market/symbols.js';
import { fmtLevel } from '../triggers/engine.js';
import { parseDuration, type Actions } from './commands.js';
import type { Choices } from './confirm.js';
import { esc, fmtPrice, fmtQty } from './format.js';

export function describeIntent(i: Intent, resolver: SymbolResolver): string {
  const target = (q: string) => {
    const s = resolver.resolveLocal(q);
    const name = s ? resolver.displayName(s) : undefined;
    return s ? `<b>${esc(name ?? q)}</b>(<code>${esc(s)}</code>)` : `<b>${esc(q)}</b>`;
  };
  switch (i.name) {
    case 'add_watch': {
      const crit = i.args.mode ? ` 기준 ${fmtLevel(i.args.threshold ?? (i.args.mode === 'sigma' ? 3 : 5))}${i.args.mode === 'sigma' ? 'σ' : '%'}` : '';
      return `${target(i.args.symbol_query)}을 watchlist에 추가할까요?${crit}`;
    }
    case 'remove_watch':
      return `${target(i.args.symbol_query)}을 watchlist에서 뺄까요?`;
    case 'set_mode':
      return `${target(i.args.symbol_query)} 알림 기준을 ${fmtLevel(i.args.threshold)}${i.args.mode === 'sigma' ? 'σ' : '%'}로 바꿀까요?`;
    case 'add_level':
      return (
        `${target(i.args.symbol_query)} ${fmtPrice(i.args.price)} 레벨 알림을 걸까요?` +
        (i.args.proximity_pct !== undefined ? ` (근접 ${i.args.proximity_pct}%)` : '') +
        (i.args.note ? ` 메모: ${esc(i.args.note)}` : '')
      );
    case 'mute':
      return i.args.duration === 'off'
        ? `${target(i.args.symbol_query)} 음소거를 해제할까요?`
        : `${target(i.args.symbol_query)} 알림을 ${esc(i.args.duration)} 동안 끌까요?`;
    case 'record_trade': {
      const a = i.args;
      const extra = [
        a.stop_loss !== undefined ? `손절 ${fmtPrice(a.stop_loss)}` : '',
        a.take_profit !== undefined ? `익절 ${fmtPrice(a.take_profit)}` : '',
      ].filter(Boolean);
      return (
        `${target(a.symbol_query)} ${fmtQty(a.qty)} @ ${fmtPrice(a.price)} ${a.side === 'buy' ? '매수' : '매도'}` +
        `${extra.length ? `, ${extra.join(', ')}` : ''}으로 기록할까요?` +
        (a.note ? `\n메모: ${esc(a.note)}` : '')
      );
    }
    case 'set_stop':
      return `${target(i.args.symbol_query)} ${i.args.kind === 'sl' ? '손절' : '익절'}가를 ${fmtPrice(i.args.price)}로 설정할까요?`;
    case 'why':
      return `${target(i.args.symbol_query)} 원인 요약`;
    case 'show_list':
      return 'watchlist 보기';
  }
}

export function runIntent(i: Intent, ctx: Context, actions: Actions): Promise<void> {
  switch (i.name) {
    case 'add_watch':
      return actions.add(ctx, { query: i.args.symbol_query, mode: i.args.mode, threshold: i.args.threshold });
    case 'remove_watch':
      return actions.remove(ctx, i.args.symbol_query);
    case 'set_mode':
      return actions.mode(ctx, i.args.symbol_query, i.args.mode, i.args.threshold);
    case 'add_level':
      return actions.level(ctx, {
        query: i.args.symbol_query,
        price: i.args.price,
        proximityPct: i.args.proximity_pct,
        note: i.args.note,
      });
    case 'mute':
      return actions.mute(ctx, i.args.symbol_query, parseDuration(i.args.duration) ?? 0);
    case 'record_trade':
      return actions.trade(ctx, i.args.side, {
        query: i.args.symbol_query,
        qty: i.args.qty,
        price: i.args.price,
        stopLoss: i.args.stop_loss,
        takeProfit: i.args.take_profit,
        fee: undefined,
        note: i.args.note,
      });
    case 'set_stop':
      return actions.stop(ctx, i.args.symbol_query, i.args.kind, i.args.price);
    case 'why':
      return actions.why(ctx, i.args.symbol_query);
    case 'show_list':
      return actions.list(ctx);
  }
}

export function registerNaturalLanguage(
  bot: Bot,
  deps: { llm: LlmClient | undefined; actions: Actions; choices: Choices; resolver: SymbolResolver; logger: Logger },
): void {
  const log = deps.logger.child({ mod: 'nl' });
  const html = { parse_mode: 'HTML' as const };

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('알 수 없는 명령어입니다. /help 를 참고하세요.');
      return;
    }
    if (!deps.llm) {
      await ctx.reply('문장 명령을 쓰려면 GROQ_API_KEY가 필요합니다. 지금은 /help 의 명령어를 써 주세요.');
      return;
    }
    if (text.length > 500) {
      await ctx.reply('메시지가 너무 깁니다.');
      return;
    }
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    let r;
    try {
      r = await parseIntent(deps.llm, text);
    } catch (e) {
      log.warn({ err: (e as Error).message }, '의도 분류 실패');
      await ctx.reply('지금 문장을 해석하지 못했습니다(LLM 오류). /help 의 명령어를 써 주세요.');
      return;
    }
    log.info({ kind: r.kind, intent: r.kind === 'intent' ? r.intent.name : undefined }, '자연어 의도');

    if (r.kind === 'text') {
      const t = r.text || '이해하지 못했습니다.';
      await ctx.reply(`${esc(t.slice(0, 500))}\n\n(명령 목록: /help)`, html);
      return;
    }
    if (r.kind === 'invalid') {
      await ctx.reply(`요청을 이해했지만 값이 올바르지 않습니다: ${esc(r.reason)}\n/help 의 명령어 형식을 참고하세요.`, html);
      return;
    }
    const intent = r.intent;
    if (isReadOnly(intent)) {
      await runIntent(intent, ctx, deps.actions);
      return;
    }
    await ctx.reply(describeIntent(intent, deps.resolver), {
      ...html,
      reply_markup: deps.choices.keyboard(ctx.chat.id, [{ label: '확인', run: (c) => runIntent(intent, c, deps.actions) }]),
    });
  });
}

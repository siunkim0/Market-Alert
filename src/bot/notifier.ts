/**
 * 알림 전송. 같은 종목에서 60초 안에 여러 규칙이 걸리면 첫 메시지를 edit해서 하나로 합친다.
 * (첫 알림은 지연 없이 바로 나간다.)
 */
import type { Api } from 'grammy';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { AlertEvent, AlertSink } from '../triggers/engine.js';
import { formatAlertBlock } from './format.js';

interface OpenMessage {
  blocks: string[];
  messages: { chatId: number; messageId: number }[];
  until: number;
}

export class AlertNotifier implements AlertSink {
  private readonly log: Logger;
  private readonly open = new Map<string, OpenMessage>();
  /** 종목별 직렬화 (같은 종목 전송이 겹치지 않게) */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly api: Api,
    private readonly chatIds: number[],
    private readonly repo: Repo,
    logger: Logger,
    private readonly mergeWindowMs = 60_000,
  ) {
    this.log = logger.child({ mod: 'notifier' });
  }

  deliver(symbol: string, events: AlertEvent[]): Promise<void> {
    const prev = this.chains.get(symbol) ?? Promise.resolve();
    const next = prev.then(() => this.doDeliver(symbol, events)).catch((e: Error) => {
      this.log.error({ symbol, err: e.message }, '알림 전송 실패');
    });
    this.chains.set(symbol, next);
    return next;
  }

  private async doDeliver(symbol: string, events: AlertEvent[]): Promise<void> {
    const blocks = events.map((e) => formatAlertBlock(e));
    const ids = events.map((e) => e.alertId);
    const cur = this.open.get(symbol);

    if (cur && Date.now() < cur.until) {
      cur.blocks.push(...blocks);
      const text = cur.blocks.join('\n\n');
      let ok = true;
      for (const m of cur.messages) {
        try {
          await this.api.editMessageText(m.chatId, m.messageId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (e) {
          ok = false;
          this.log.warn({ symbol, err: (e as Error).message }, '알림 합치기(edit) 실패 → 새 메시지');
        }
      }
      if (ok) {
        if (cur.messages[0]) this.repo.setAlertMessageId(ids, cur.messages[0].messageId);
        return;
      }
    }

    const text = blocks.join('\n\n');
    const messages: OpenMessage['messages'] = [];
    for (const chatId of this.chatIds) {
      const msg = await this.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      messages.push({ chatId, messageId: msg.message_id });
    }
    if (messages[0]) this.repo.setAlertMessageId(ids, messages[0].messageId);
    this.open.set(symbol, { blocks, messages, until: Date.now() + this.mergeWindowMs });
  }
}

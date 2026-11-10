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
  /** 원인 요약 (준비 전이면 undefined, 실패하면 '') */
  explanation: string | undefined;
}

/** 숫자 알림 뒤에 붙일 원인 요약을 만든다 (Phase 4) */
export interface Enricher {
  enrich(ev: AlertEvent, alertIds: number[]): Promise<{ html: string } | undefined>;
}

const PENDING = '<i>원인 분석 중…</i>';

function render(m: Pick<OpenMessage, 'blocks' | 'explanation'>, enrich: boolean): string {
  const body = m.blocks.join('\n\n');
  if (!enrich || m.explanation === '') return body;
  return `${body}\n\n${m.explanation ?? PENDING}`;
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
    private readonly enricher?: Enricher,
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
      if (await this.editAll(symbol, cur)) {
        if (cur.messages[0]) this.repo.setAlertMessageId(ids, cur.messages[0].messageId);
        if (cur.explanation !== undefined && cur.explanation !== '' && this.enricher) {
          // 합쳐진 알림에도 원인을 기록 (캐시 재사용)
          void this.enricher.enrich(events[0]!, ids).catch(() => undefined);
        }
        return;
      }
    }

    const m: OpenMessage = { blocks, messages: [], until: Date.now() + this.mergeWindowMs, explanation: undefined };
    const text = render(m, !!this.enricher);
    for (const chatId of this.chatIds) {
      const msg = await this.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      m.messages.push({ chatId, messageId: msg.message_id });
    }
    if (m.messages[0]) this.repo.setAlertMessageId(ids, m.messages[0].messageId);
    this.open.set(symbol, m);

    // 원인 요약은 숫자 알림이 나간 뒤 비동기로 붙인다
    if (this.enricher) void this.attachExplanation(symbol, m, events[0]!, ids);
  }

  private async attachExplanation(symbol: string, m: OpenMessage, ev: AlertEvent, ids: number[]): Promise<void> {
    let html = '';
    try {
      html = (await this.enricher!.enrich(ev, ids))?.html ?? '';
    } catch (e) {
      this.log.warn({ symbol, err: (e as Error).message }, '원인 요약 실패');
    }
    m.explanation = html;
    // 같은 종목 전송과 겹치지 않게 체인에 넣는다
    const prev = this.chains.get(symbol) ?? Promise.resolve();
    const next = prev.then(() => this.editAll(symbol, m)).then(() => undefined);
    this.chains.set(symbol, next);
    await next;
  }

  private async editAll(symbol: string, m: OpenMessage): Promise<boolean> {
    const text = render(m, !!this.enricher);
    let ok = true;
    for (const msg of m.messages) {
      try {
        await this.api.editMessageText(msg.chatId, msg.messageId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        const desc = (e as Error).message;
        if (/message is not modified/.test(desc)) continue;
        ok = false;
        this.log.warn({ symbol, err: desc }, '알림 edit 실패');
      }
    }
    return ok;
  }
}

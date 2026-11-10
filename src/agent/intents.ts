/**
 * 명령어가 아닌 메시지 → LLM(fast) tool use로 의도 분류 → 인자 zod 검증 → 확인 버튼 → 실행.
 * 조회성 의도(why, list)는 확인 없이 바로 실행한다.
 */
import { z } from 'zod';
import type { LlmClient, ToolDef } from './llm.js';

const SymbolQuery = z.string().trim().min(1).max(40);

export const IntentSchemas = {
  add_watch: z.object({
    symbol_query: SymbolQuery,
    mode: z.enum(['sigma', 'pct']).optional(),
    threshold: z.number().positive().max(100).optional(),
  }),
  remove_watch: z.object({ symbol_query: SymbolQuery }),
  set_mode: z.object({ symbol_query: SymbolQuery, mode: z.enum(['sigma', 'pct']), threshold: z.number().positive().max(100) }),
  add_level: z.object({
    symbol_query: SymbolQuery,
    price: z.number().positive(),
    proximity_pct: z.number().min(0).max(50).optional(),
    note: z.string().max(100).optional(),
  }),
  mute: z.object({ symbol_query: SymbolQuery, duration: z.string().regex(/^(\d+(\.\d+)?(m|h|d)|off)$/) }),
  why: z.object({ symbol_query: SymbolQuery }),
  show_list: z.object({}).passthrough(),
} as const;

export type IntentName = keyof typeof IntentSchemas;
export type Intent = { [K in IntentName]: { name: K; args: z.infer<(typeof IntentSchemas)[K]> } }[IntentName];

const sym = { type: 'string', description: '사용자가 말한 종목 이름이나 코드 그대로 (예: "하이닉스", "삼성전자", "AAPL", "비트코인")' };

export const TOOLS: ToolDef[] = [
  {
    name: 'add_watch',
    description: '종목을 watchlist에 추가해 큰 움직임을 감시한다.',
    parameters: {
      type: 'object',
      properties: {
        symbol_query: sym,
        mode: { type: 'string', enum: ['sigma', 'pct'], description: 'σ(표준편차) 기준이면 sigma, 퍼센트 기준이면 pct' },
        threshold: { type: 'number', description: '기준값. "4% 움직이면" → 4 (pct), "3시그마" → 3 (sigma)' },
      },
      required: ['symbol_query'],
    },
  },
  {
    name: 'remove_watch',
    description: 'watchlist에서 종목을 뺀다.',
    parameters: { type: 'object', properties: { symbol_query: sym }, required: ['symbol_query'] },
  },
  {
    name: 'set_mode',
    description: '이미 감시 중인 종목의 알림 기준(sigma|pct, 값)을 바꾼다.',
    parameters: {
      type: 'object',
      properties: { symbol_query: sym, mode: { type: 'string', enum: ['sigma', 'pct'] }, threshold: { type: 'number' } },
      required: ['symbol_query', 'mode', 'threshold'],
    },
  },
  {
    name: 'add_level',
    description: '특정 가격에 도달·돌파·이탈하면 알리는 레벨 알림을 건다. "19만원 깨지면", "8만 달러 넘으면" 등.',
    parameters: {
      type: 'object',
      properties: {
        symbol_query: sym,
        price: { type: 'number', description: '가격 숫자. "19만원" → 190000, "8만 달러" → 80000' },
        proximity_pct: { type: 'number', description: '근접 알림 범위(%). 말하지 않았으면 생략' },
        note: { type: 'string', description: '메모 (예: "ELS 배리어"). 없으면 생략' },
      },
      required: ['symbol_query', 'price'],
    },
  },
  {
    name: 'mute',
    description: '종목 알림을 일정 시간 끈다. duration은 "30m", "2h", "1d" 형식, 해제는 "off".',
    parameters: {
      type: 'object',
      properties: { symbol_query: sym, duration: { type: 'string' } },
      required: ['symbol_query', 'duration'],
    },
  },
  {
    name: 'why',
    description: '종목이 지금 왜 움직이는지(오르는지/내리는지) 뉴스로 원인을 찾아 요약한다.',
    parameters: { type: 'object', properties: { symbol_query: sym }, required: ['symbol_query'] },
  },
  {
    name: 'show_list',
    description: '감시 중인 종목 목록과 현재 움직임을 보여 준다.',
    parameters: { type: 'object', properties: {} },
  },
];

const SYSTEM = `너는 Telegram 마켓 알림 봇의 명령 해석기다. 사용자의 한국어/영어 메시지를 도구 하나로 바꾼다.
- 메시지에 맞는 도구가 있으면 반드시 도구를 호출한다. 종목 이름은 사용자가 쓴 그대로 symbol_query에 넣는다.
- 한국어 숫자 단위를 풀어서 넣는다: 19만원 → 190000, 1.5만 → 15000, 8만 달러 → 80000.
- 매매 기록(샀다/팔았다/매수/매도), 손절가·익절가 설정 요청이면 도구를 호출하지 말고 정확히 "매매 기록 기능은 아직 준비 중입니다. 기록되지 않았습니다."라고만 답한다.
- 그 밖에 도구가 없는 요청이나 잡담이면 도구를 호출하지 말고 한 문장으로 답한다.
- 매수·매도 추천이나 투자 조언은 하지 않는다.`;

export type ParseResult =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'text'; text: string }
  | { kind: 'invalid'; reason: string };

export async function parseIntent(llm: LlmClient, message: string): Promise<ParseResult> {
  const r = await llm.tools({ tier: 'fast', system: SYSTEM, user: message, tools: TOOLS });
  if (r.kind === 'text') return { kind: 'text', text: r.text.trim() };
  if (!(r.name in IntentSchemas)) return { kind: 'invalid', reason: `알 수 없는 도구: ${r.name}` };
  const name = r.name as IntentName;
  // LLM이 숫자를 문자열로 주는 경우를 흡수
  const args = coerceNumbers(r.args);
  const parsed = IntentSchemas[name].safeParse(args);
  if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ') };
  return { kind: 'intent', intent: { name, args: parsed.data } as Intent };
}

function coerceNumbers(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (['threshold', 'price', 'proximity_pct'].includes(k) && typeof x === 'string') {
      const n = Number(x.replace(/[,%\s]/g, ''));
      out[k] = Number.isFinite(n) ? n : x;
    } else if (x !== null) out[k] = x;
  }
  return out;
}

/** 확인 없이 바로 실행해도 되는 조회성 의도 */
export function isReadOnly(i: Intent): boolean {
  return i.name === 'why' || i.name === 'show_list';
}

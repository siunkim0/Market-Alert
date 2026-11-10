/**
 * LLM 클라이언트. 현재 Groq(OpenAI 호환 chat completions)만 구현한다.
 * 다른 provider는 LlmClient를 구현하면 된다.
 */
import { z } from 'zod';
import type { Logger } from '../logger.js';

export type ModelTier = 'fast' | 'smart';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export type ToolResult = { kind: 'tool'; name: string; args: unknown } | { kind: 'text'; text: string };

export interface LlmClient {
  /** JSON 객체만 받아 zod로 검증한다. */
  json<T>(o: { tier: ModelTier; system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T>;
  /** tool 하나를 고르게 한다 (없으면 텍스트). */
  tools(o: { tier: ModelTier; system: string; user: string; tools: ToolDef[] }): Promise<ToolResult>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

const ChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
});

const TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

export class GroqClient implements LlmClient {
  private readonly log: Logger;
  private readonly url = 'https://api.groq.com/openai/v1/chat/completions';

  constructor(
    private readonly apiKey: string,
    private readonly models: Record<ModelTier, string>,
    logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.log = logger.child({ mod: 'llm' });
  }

  private async call(body: Record<string, unknown>): Promise<z.infer<typeof ChatResponseSchema>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20_000) : 1000 * 2 ** attempt;
          lastErr = new LlmError(`HTTP ${res.status}`, res.status);
          this.log.warn({ status: res.status, waitMs: wait }, 'LLM 재시도');
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const text = await res.text();
        if (!res.ok) {
          // 본문에 키가 들어 있을 일은 없지만 길이는 제한한다
          throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        }
        return ChatResponseSchema.parse(JSON.parse(text));
      } catch (e) {
        if (e instanceof LlmError && e.status && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
        if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
  }

  async json<T>(o: { tier: ModelTier; system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T> {
    const messages = [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call({
        model: this.models[o.tier],
        messages,
        temperature: 0.1,
        max_tokens: o.maxTokens ?? 1500,
        response_format: { type: 'json_object' },
      });
      const content = res.choices[0]!.message.content ?? '';
      try {
        return o.schema.parse(JSON.parse(extractJson(content)));
      } catch (e) {
        this.log.warn({ err: (e as Error).message.slice(0, 200) }, 'LLM JSON 검증 실패 → 재요청');
        messages.push({ role: 'assistant', content }, { role: 'user', content: `형식 오류: ${(e as Error).message.slice(0, 300)}\n지정한 JSON 형식으로만 다시 답하세요.` });
      }
    }
    throw new LlmError('LLM이 올바른 JSON을 돌려주지 않았습니다');
  }

  async tools(o: { tier: ModelTier; system: string; user: string; tools: ToolDef[] }): Promise<ToolResult> {
    const res = await this.call({
      model: this.models[o.tier],
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
      temperature: 0,
      max_tokens: 800,
      tools: o.tools.map((t) => ({ type: 'function', function: t })),
      tool_choice: 'auto',
    });
    const msg = res.choices[0]!.message;
    const call = msg.tool_calls?.[0];
    if (call) {
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        throw new LlmError(`tool 인자 JSON 파싱 실패: ${call.function.arguments.slice(0, 200)}`);
      }
      return { kind: 'tool', name: call.function.name, args };
    }
    return { kind: 'text', text: msg.content ?? '' };
  }
}

/** ```json ... ``` 감싼 응답도 처리 */
export function extractJson(s: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) return fence[1]!.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

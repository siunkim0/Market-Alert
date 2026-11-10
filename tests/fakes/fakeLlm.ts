import type { z } from 'zod';
import type { LlmClient, ModelTier, ToolDef, ToolResult } from '../../src/agent/llm.js';

/** 정해 둔 응답을 돌려주는 LLM. 받은 프롬프트를 기록한다. */
export class FakeLlm implements LlmClient {
  prompts: { tier: ModelTier; user: string }[] = [];
  constructor(private readonly jsonReply: unknown = {}, private readonly toolReply: ToolResult = { kind: 'text', text: '' }) {}
  async json<T>(o: { tier: ModelTier; system: string; user: string; schema: z.ZodType<T> }): Promise<T> {
    this.prompts.push({ tier: o.tier, user: o.user });
    return o.schema.parse(this.jsonReply);
  }
  async tools(o: { tier: ModelTier; user: string; tools: ToolDef[] }): Promise<ToolResult> {
    this.prompts.push({ tier: o.tier, user: o.user });
    return this.toolReply;
  }
}

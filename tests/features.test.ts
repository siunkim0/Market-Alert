import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/agent/intents.js';
import { enabledCommands, helpText } from '../src/bot/commands.js';
import { FakeLlm } from './fakes/fakeLlm.js';
import type { ToolDef } from '../src/agent/llm.js';

describe('기능 스위치', () => {
  it('Phase 5·6 끄면 명령어 메뉴·도움말에서 빠진다', () => {
    const off = enabledCommands({ journal: false, rules_digest: false }).map((c) => c.command);
    expect(off).toEqual(expect.arrayContaining(['add', 'remove', 'list', 'mode', 'level', 'levels', 'unlevel', 'mute', 'why', 'status', 'help']));
    for (const c of ['buy', 'sell', 'sl', 'tp', 'pos', 'history', 'pnl', 'note', 'deltrade', 'export', 'sync', 'rules', 'digest', 'import_tv']) {
      expect(off).not.toContain(c);
    }
    const on = enabledCommands({ journal: true, rules_digest: true }).map((c) => c.command);
    expect(on).toEqual(expect.arrayContaining(['buy', 'pos', 'rules', 'digest']));

    const h = helpText({ journal: false, rules_digest: false });
    expect(h).not.toContain('/buy');
    expect(h).not.toContain('/rules');
    expect(h).toContain('/why');
    expect(h).toContain('/status');
    expect(h).not.toContain('@@');
    expect(helpText({ journal: true, rules_digest: true })).toContain('/buy');
  });

  it('journal 끄면 매매 도구를 LLM에 주지 않고, 와도 거부', async () => {
    let seen: ToolDef[] = [];
    const llm = new FakeLlm({}, { kind: 'tool', name: 'record_trade', args: { symbol_query: 'x', side: 'buy', qty: 1, price: 1 } });
    const orig = llm.tools.bind(llm);
    llm.tools = async (o) => {
      seen = o.tools;
      return orig(o);
    };
    const r = await parseIntent(llm, '하이닉스 10주 샀어', { journal: false });
    expect(seen.map((t) => t.name)).not.toContain('record_trade');
    expect(seen.map((t) => t.name)).not.toContain('set_stop');
    expect(r.kind).toBe('invalid');
  });
});

import { describe, expect, it } from 'vitest';
import { isReadOnly, parseIntent } from '../src/agent/intents.js';
import { describeIntent } from '../src/bot/naturalLanguage.js';
import { parseAliases } from '../src/config.js';
import { SymbolResolver } from '../src/market/symbols.js';
import { FakeLlm } from './fakes/fakeLlm.js';
import { FakeMarketData } from './fakes/fakeMarketData.js';

const resolver = new SymbolResolver(parseAliases({ 'KRX:000660': { name: 'SK하이닉스', aliases: ['하이닉스'] } }), new FakeMarketData());

describe('자연어 의도', () => {
  it('tool 호출 → zod 검증 → 확인 문구', async () => {
    const llm = new FakeLlm({}, { kind: 'tool', name: 'add_watch', args: { symbol_query: '하이닉스', mode: 'pct', threshold: '4' } });
    const r = await parseIntent(llm, '하이닉스 4% 움직이면 알려줘');
    expect(r).toEqual({ kind: 'intent', intent: { name: 'add_watch', args: { symbol_query: '하이닉스', mode: 'pct', threshold: 4 } } });
    expect(llm.prompts[0]!.tier).toBe('fast');
    if (r.kind === 'intent') {
      expect(isReadOnly(r.intent)).toBe(false);
      expect(describeIntent(r.intent, resolver)).toContain('KRX:000660');
    }
  });

  it('레벨: 가격 문자열 "190,000"도 숫자로', async () => {
    const llm = new FakeLlm({}, { kind: 'tool', name: 'add_level', args: { symbol_query: '삼성전자', price: '190,000', note: null } });
    const r = await parseIntent(llm, '삼성전자 19만원 깨지면 알려줘');
    expect(r).toMatchObject({ kind: 'intent', intent: { name: 'add_level', args: { price: 190000 } } });
  });

  it('잘못된 인자는 invalid, 모르는 도구도 invalid', async () => {
    expect((await parseIntent(new FakeLlm({}, { kind: 'tool', name: 'set_mode', args: { symbol_query: 'x', mode: 'zz', threshold: 1 } }), 'm')).kind).toBe('invalid');
    expect((await parseIntent(new FakeLlm({}, { kind: 'tool', name: 'place_order', args: {} }), 'm')).kind).toBe('invalid');
  });

  it('도구 없이 텍스트 응답', async () => {
    const r = await parseIntent(new FakeLlm({}, { kind: 'text', text: '매매 기록은 아직 지원하지 않습니다.' }), '하이닉스 10주 샀어');
    expect(r).toEqual({ kind: 'text', text: '매매 기록은 아직 지원하지 않습니다.' });
  });

  it('why는 확인 없이 실행', async () => {
    const r = await parseIntent(new FakeLlm({}, { kind: 'tool', name: 'why', args: { symbol_query: '삼성전자' } }), '삼성전자 왜 올라?');
    expect(r.kind === 'intent' && isReadOnly(r.intent)).toBe(true);
  });
});

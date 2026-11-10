import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { DigestService } from '../src/jobs/digest.js';
import { Journal } from '../src/journal/journal.js';
import { createLogger } from '../src/logger.js';
import { HistoryService } from '../src/market/history.js';
import { FakeMarketData } from './fakes/fakeMarketData.js';

const logger = createLogger('silent');

function bars(lastDate: string, n: number, start = 100) {
  const out = [];
  const end = new Date(`${lastDate}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const c = start * (1 + (i % 2 ? 0.01 : -0.01)) + (n - i);
    out.push({ date: d, open: c, high: c, low: c, close: c, volume: 1 });
  }
  return out;
}

describe('digest', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  function setup() {
    repo = new Repo(':memory:');
    const md = new FakeMarketData();
    for (const s of ['KRX:KOSPI', 'KRX:005930']) {
      repo.upsertMeta({ symbol: s, description: s, currency: 'KRW', timezone: 'Asia/Seoul', session: '0900-1535' });
    }
    repo.addWatch({ symbol: 'KRX:005930', displayName: '삼성전자', mode: 'sigma', threshold: 3, volumeEnabled: true });
    const sent: string[] = [];
    const svc = new DigestService({
      repo, history: new HistoryService(repo, md, 20, logger), journal: new Journal(repo, logger),
      benchmarks: { KRX: 'KRX:KOSPI' }, symbols: () => ['KRX:005930'], nameOf: (s) => (s === 'KRX:005930' ? '삼성전자' : 'KOSPI'),
      send: async (h) => void sent.push(h), logger,
    });
    return { md, svc, sent };
  }

  it('그날 일봉이 있으면 요약, 없으면(휴장) 건너뜀', async () => {
    const { md, svc } = setup();
    const now = new Date('2026-11-10T07:00:00Z'); // 16:00 KST
    md.bars.set('KRX:KOSPI', bars('2026-11-10', 25));
    md.bars.set('KRX:005930', bars('2026-11-10', 25, 200));
    const r = await svc.build('krx', now);
    expect(r.html).toContain('KRX 장 마감 요약');
    expect(r.html).toContain('2026-11-10');
    expect(r.html).toContain('삼성전자');

    md.bars.set('KRX:KOSPI', bars('2026-11-09', 25)); // 오늘 일봉 없음
    repo.db.prepare("DELETE FROM daily_bars WHERE date = '2026-11-10'").run();
    const h = await svc.build('krx', now);
    expect(h.html).toBeUndefined();
    expect(h.reason).toContain('휴장');
  });

  it('on/off 설정', async () => {
    const { svc } = setup();
    expect(svc.enabled()).toBe(true);
    svc.setEnabled(false);
    expect(await svc.run('krx')).toBe('digest 꺼짐');
  });
});

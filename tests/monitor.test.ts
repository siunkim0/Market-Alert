import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { createLogger } from '../src/logger.js';
import { HistoryService } from '../src/market/history.js';
import { MarketMonitor } from '../src/market/monitor.js';
import { FakeMarketData, makeQuote } from './fakes/fakeMarketData.js';

const logger = createLogger('silent');

describe('MarketMonitor + 일봉 캐시 (FakeMarketData)', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  it('오늘 미완성 봉을 제외한 σ로 z를 계산하고, 지연 상태를 DB에 저장한다', async () => {
    repo = new Repo(':memory:');
    const md = new FakeMarketData();
    const sym = 'KRX:005930';
    // 11/01~11/10 일봉 (11/10은 오늘 미완성 봉 → 이상치로 넣어도 σ에 반영되면 안 된다)
    const closes = [100, 101, 99, 102, 100, 103, 101, 104, 102, 500];
    md.bars.set(sym, closes.map((close, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1 })));
    md.metas.set(sym, { symbol: sym, description: 'Samsung', localDescription: undefined, currency: 'KRW', timezone: 'Asia/Seoul', session: '0900-1535', type: 'stock' });

    const history = new HistoryService(repo, md, 8, logger);
    await history.refresh(sym);
    const monitor = new MarketMonitor(repo, history, { lagThresholdSec: 60, lagPersistMin: 5 }, logger);
    monitor.setMeta((await md.symbolInfo(sym)));
    await md.watch([sym], (q) => monitor.onQuote(q));

    const received = new Date('2026-11-10T04:20:00Z'); // 13:20 KST
    const priceTime = new Date(received.getTime() - 1200_000);
    md.replay([makeQuote(sym, 108.12, 102, priceTime, received, 'delayed_streaming_1200')]);

    const snap = monitor.snapshot(sym, received);
    expect(snap.sessionDate).toBe('2026-11-10');
    expect(snap.marketOpen).toBe(true);
    expect(snap.r).toBeCloseTo(0.06, 10);
    // σ는 11/01~11/09 종가(8개 수익률)로만
    const rets = closes.slice(0, 9).map((c, i, a) => (i === 0 ? null : c / a[i - 1]! - 1)).filter((x): x is number => x !== null);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1));
    expect(snap.sigma).toBeCloseTo(sd, 12);
    expect(snap.z).toBeCloseTo(0.06 / sd, 8);
    expect(snap.delay).toMatchObject({ delayed: true, delaySec: 1200 });
    expect(repo.getMeta(sym)).toMatchObject({ delayed: 1, measured_delay_sec: 1200 });
  });

  it('watchlist CRUD', () => {
    repo = new Repo(':memory:');
    const w = { symbol: 'KRX:005930', displayName: '삼성전자', criteria: { sigma: 3, pct: null }, volumeEnabled: true };
    expect(repo.addWatch(w)).toBe('added');
    expect(repo.addWatch(w)).toBe('exists');
    expect(repo.listWatch()).toHaveLength(1);
    expect(repo.removeWatch('KRX:005930')).toBe(true);
    expect(repo.removeWatch('KRX:005930')).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { createLogger } from '../src/logger.js';
import { HistoryService } from '../src/market/history.js';
import type { Bar } from '../src/market/marketData.js';
import { MarketMonitor } from '../src/market/monitor.js';
import { TriggerEngine, hitLabel, type AlertEvent, type AlertSink } from '../src/triggers/engine.js';
import { evaluateLevel } from '../src/triggers/rules.js';
import { FakeMarketData, makeQuote } from './fakes/fakeMarketData.js';

const logger = createLogger('silent');
const SYM = 'BINANCE:BTCUSDT';

class MemorySink implements AlertSink {
  events: AlertEvent[] = [];
  async deliver(_s: string, evs: AlertEvent[]) {
    this.events.push(...evs);
  }
  labels() {
    return this.events.map((e) => `${hitLabel(e.hit)}${e.startup && e.hit.type !== 'level' && e.hit.type !== 'position' ? '*' : ''}`);
  }
}

/** 수익률이 +1%/-1% 교대 → σ ≈ 1.026% */
function bars(): Bar[] {
  const out: Bar[] = [];
  let c = 100;
  for (let i = 0; i < 25; i++) {
    out.push({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c, volume: 1000 });
    c = i % 2 === 0 ? c * 1.01 : c * 0.99;
  }
  return out;
}

async function setup(repo: Repo, positionOf?: (s: string) => import('../src/triggers/engine.js').HeldPosition | undefined) {
  const md = new FakeMarketData();
  md.bars.set(SYM, bars());
  md.metas.set(SYM, { symbol: SYM, description: 'BTC', localDescription: undefined, currency: 'USDT', timezone: 'Etc/UTC', session: '24x7', type: 'spot' });
  const history = new HistoryService(repo, md, 20, logger);
  await history.refresh(SYM);
  const monitor = new MarketMonitor(repo, history, { lagThresholdSec: 60, lagPersistMin: 5 }, logger);
  monitor.setMeta(await md.symbolInfo(SYM));
  const sink = new MemorySink();
  const engine = new TriggerEngine({
    repo, monitor, sink, logger,
    rules: { esc: { sigmaSteps: [3, 4, 5, 6], pctStep: 2.5, pctBase: 5 }, volumeRatio: 3, volumeWarmupMin: 30, levelDefaultProximityPct: 2 },
    benchmarks: {},
    nameOf: (s) => s,
    positionOf,
    defaultWatch: { mode: "sigma", threshold: 3 },
  });
  engine.start();
  engine.stop(); // prune 타이머만 끈다 (listener는 유지)
  await md.watch([SYM], (q) => monitor.onQuote(q));
  const prev = 100;
  const t0 = new Date('2026-11-10T05:00:00Z').getTime();
  let i = 0;
  const feed = (pct: number, day = 0) => {
    const t = new Date(t0 + day * 86_400_000 + i++ * 1000);
    md.replay([makeQuote(SYM, prev * (1 + pct / 100), prev, t, t, 'streaming')]);
  };
  return { md, engine, sink, feed };
}

describe('TriggerEngine (FakeMarketData 재생)', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  it('pct 0.3%: 같은 단계 반복 없음, 다음 단계에서만, 반대 방향 별도, 재시작 후 유지', async () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: SYM, displayName: 'BTC', criteria: { sigma: null, pct: 0.3 }, volumeEnabled: false });
    const a = await setup(repo);
    a.feed(0.1);
    a.feed(0.31); // 0.3
    a.feed(0.35); // 같은 단계
    a.feed(0.46); // 0.45
    a.feed(0.4);
    a.feed(-0.32); // 반대 방향 0.3
    expect(a.sink.labels()).toEqual(['pct:up:0.3', 'pct:up:0.45', 'pct:down:0.3']);
    expect(repo.alertsSince('2000-01-01')).toHaveLength(3);

    // 재시작: 새 engine이 alert_log에서 오늘 단계를 복원
    const b = await setup(repo);
    b.feed(0.47); // 이미 0.45까지 보냄 → 없음
    b.feed(0.61); // 0.6
    expect(b.sink.labels()).toEqual(['pct:up:0.6']);
  });

  it('첫 quote가 이미 넘은 상태면 (시작 시점 기준) 표시, 다음 거래일 리셋', async () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: SYM, displayName: 'BTC', criteria: { sigma: 0.5, pct: null }, volumeEnabled: false });
    const a = await setup(repo);
    a.feed(1.0); // z ≈ 0.97 → 0.5σ, 시작 시점
    a.feed(1.6); // z ≈ 1.56 → 1.5σ
    a.feed(1.0, 1); // 다음 날 첫 quote → 리셋, 다시 시작 시점 표시
    expect(a.sink.labels()).toEqual(['sigma:up:0.5*', 'sigma:up:1.5', 'sigma:up:0.5*']);
  });

  it('σ와 % 기준을 둘 다 걸면 각각 따로 알린다', async () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: SYM, displayName: 'BTC', criteria: { sigma: 0.5, pct: 0.3 }, volumeEnabled: false });
    const a = await setup(repo);
    a.feed(0.35); // pct 0.3 (z ≈ 0.34 → σ 아직)
    a.feed(0.6); // z ≈ 0.58 → σ 0.5, pct 0.6
    expect(a.sink.labels()).toEqual(['pct:up:0.3*', 'sigma:up:0.5', 'pct:up:0.6']);
    const w = repo.getWatch(SYM)!;
    expect(a.engine.todaySteps(w, '2026-11-10')).toBe('▲0.5σ · ▲0.6%'.replace(' · ', ' '));
  });

  it('기준 변경: 하나만 바꾸고 다른 기준은 유지, 둘 다 끄기는 거부', () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: SYM, displayName: 'BTC', criteria: { sigma: 3, pct: null }, volumeEnabled: false });
    expect(repo.updateCriteria(SYM, { pct: 5 })).toEqual({ sigma: 3, pct: 5 });
    expect(repo.updateCriteria(SYM, { sigma: null })).toEqual({ sigma: null, pct: 5 });
    expect(() => repo.updateCriteria(SYM, { pct: null })).toThrow();
    expect(repo.getWatch(SYM)).toMatchObject({ sigma_threshold: null, pct_threshold: 5, mode: 'pct', threshold: 5 });
  });

  it('기존 DB 마이그레이션: mode/threshold → sigma_threshold/pct_threshold', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).join(mkdtempSync((await import('node:path')).join(tmpdir(), 'fs-')), 'old.db');
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(path);
    old.exec(`CREATE TABLE watchlist (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, display_name TEXT,
      mode TEXT NOT NULL DEFAULT 'sigma', threshold REAL NOT NULL, volume_enabled INTEGER NOT NULL DEFAULT 1,
      muted_until TEXT, created_at TEXT NOT NULL);
      INSERT INTO watchlist (symbol, mode, threshold, created_at) VALUES ('A:B', 'sigma', 3, 'x'), ('C:D', 'pct', 5, 'x');`);
    old.close();
    repo = new Repo(path);
    expect(repo.getWatch('A:B')).toMatchObject({ sigma_threshold: 3, pct_threshold: null });
    expect(repo.getWatch('C:D')).toMatchObject({ sigma_threshold: null, pct_threshold: 5 });
  });

  it('음소거 중이면 알리지 않는다', async () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: SYM, displayName: 'BTC', criteria: { sigma: null, pct: 0.3 }, volumeEnabled: false });
    repo.setMuted(SYM, new Date(Date.now() + 3_600_000).toISOString());
    const a = await setup(repo);
    a.feed(1);
    expect(a.sink.events).toHaveLength(0);
  });

  it('레벨: 근접 1회 + 도달 1회 후 비활성화', async () => {
    repo = new Repo(':memory:');
    const id = repo.addLevel({ symbol: SYM, price: 101, direction: 'cross', proximityPct: 0.5, note: '테스트' });
    const a = await setup(repo);
    a.engine.reloadLevels();
    a.feed(0); // 100 → 방향 결정(above)
    expect(repo.getLevel(id)?.direction).toBe('above');
    a.feed(0.6); // 100.6: 0.4% 남음 → 근접
    a.feed(0.7); // 근접 반복 없음
    a.feed(1.1); // 도달
    a.feed(1.2);
    expect(a.sink.labels()).toEqual(['level:near', 'level:reach']);
    expect(repo.getLevel(id)?.active).toBe(0);
  });

  it('보유 포지션: watchlist에 없어도 감시, 손절 근접·도달 1회씩, 재시작 후 유지', async () => {
    repo = new Repo(':memory:');
    const { Journal } = await import('../src/journal/journal.js');
    const j = new Journal(repo, logger);
    j.record({ source: 'manual', symbol: SYM, side: 'buy', qty: 1, price: 100, stopLoss: 99, takeProfit: 105 });
    const a = await setup(repo, (s) => j.position(s));
    a.feed(0.5); // 100.5: 손절까지 1.49% → 근접 (기본 2%)
    a.feed(0.4); // 반복 없음
    a.feed(-1.2); // 98.8 → 손절 도달
    a.feed(-1.5);
    expect(a.sink.labels()).toEqual(['position:sl_near', 'position:sl_reach']);
    expect(a.sink.events[0]!.position).toMatchObject({ qty: 1, avgPrice: 100 });
    expect(a.sink.events[0]!.position!.stopDistancePct).toBeCloseTo((100.5 - 99) / 100.5 * 100, 8);

    const b = await setup(repo, (s) => j.position(s));
    b.feed(-1.3);
    expect(b.sink.labels()).toEqual([]);
    // 손절가를 옮기면 새 목표로 다시 알림
    j.setStop(SYM, 'sl', 98);
    b.feed(-1.4); // 98.6: 98까지 0.6% → 근접
    expect(b.sink.labels()).toEqual(['position:sl_near']);
  });

  it('evaluateLevel below', () => {
    const l = { id: 1, symbol: 'X:Y', price: 190000, direction: 'below' as const, proximity_pct: null, note: null, active: 1, created_at: '' };
    expect(evaluateLevel(l, 195000, 2)).toBeUndefined();
    expect(evaluateLevel(l, 193000, 2)).toMatchObject({ phase: 'near' });
    expect(evaluateLevel(l, 189900, 2)).toMatchObject({ phase: 'reach' });
  });
});

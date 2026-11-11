import { afterEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { createLogger } from '../src/logger.js';
import { HistoryService } from '../src/market/history.js';
import { MarketMonitor } from '../src/market/monitor.js';
import { barPosition } from '../src/market/sessions.js';
import { TriggerEngine, hitLabel, type AlertEvent } from '../src/triggers/engine.js';
import { evaluateIntradayVolume } from '../src/triggers/rules.js';
import { FakeMarketData, makeQuote } from './fakes/fakeMarketData.js';

const logger = createLogger('silent');
const krx = { session: '0900-1535', timezone: 'Asia/Seoul' };
const cfg = { timeframeMin: 15, lookback: 20, skipOpenBars: 1, skipCloseBars: 1 };
const T = (iso: string) => Date.parse(iso) / 1000;

/** 마지막 봉 시작 lastStart, 15분 간격 21개 + 마지막 거래량 lastVol (나머지 100) */
function bars(lastStart: number, lastVol: number) {
  return Array.from({ length: 21 }, (_, i) => ({ time: lastStart - (20 - i) * 900, volume: i === 20 ? lastVol : 100 }));
}

describe('분봉 위치', () => {
  it('KRX 첫 봉·마지막 봉', () => {
    expect(barPosition(krx, new Date('2026-11-10T00:00:00Z'), 15)).toMatchObject({ openIndex: 0 }); // 09:00
    expect(barPosition(krx, new Date('2026-11-10T00:15:00Z'), 15)).toMatchObject({ openIndex: 1 });
    expect(barPosition(krx, new Date('2026-11-10T06:30:00Z'), 15)).toMatchObject({ closeIndex: 0 }); // 15:30 동시호가
    expect(barPosition(krx, new Date('2026-11-10T06:15:00Z'), 15)).toMatchObject({ closeIndex: 1 }); // 15:15
    expect(barPosition(krx, new Date('2026-11-10T07:00:00Z'), 15)).toBeUndefined(); // 16:00 장 밖
    expect(barPosition({ session: '24x7', timezone: 'Etc/UTC' }, new Date(), 15)).toEqual({ openIndex: Infinity, closeIndex: Infinity });
  });
});

describe('분봉 거래량 규칙', () => {
  const start = T('2026-11-10T04:00:00Z'); // 13:00 KST
  const pos = barPosition(krx, new Date(start * 1000), 15);

  it('직전 20봉 평균의 배수 이상이면 hit', () => {
    const now = (start + 300) * 1000; // 봉 시작 5분 뒤
    expect(evaluateIntradayVolume(bars(start, 199), 2, now, 0, cfg, pos)).toBeUndefined();
    expect(evaluateIntradayVolume(bars(start, 250), 2, now, 0, cfg, pos)).toMatchObject({ type: 'ivol', ratio: 2.5, avg: 100, volume: 250 });
  });

  it('지금 봉이 아니면(장 마감 뒤 멈춘 봉) 평가하지 않음, 지연 종목은 now - delay 기준', () => {
    const later = (start + 3600) * 1000;
    expect(evaluateIntradayVolume(bars(start, 500), 2, later, 0, cfg, pos)).toBeUndefined();
    // 20분 지연: 실제 시각 13:25 → 가격 시각 13:05 → 13:00 봉이 지금 봉
    expect(evaluateIntradayVolume(bars(start, 500), 2, (start + 1500) * 1000, 1200, cfg, pos)).toBeDefined();
  });

  it('장 시작 첫 봉·마감 동시호가 봉 제외', () => {
    const open = T('2026-11-10T00:00:00Z');
    expect(evaluateIntradayVolume(bars(open, 999), 2, (open + 60) * 1000, 0, cfg, barPosition(krx, new Date(open * 1000), 15))).toBeUndefined();
    const close = T('2026-11-10T06:30:00Z');
    expect(evaluateIntradayVolume(bars(close, 999), 2, (close + 60) * 1000, 0, cfg, barPosition(krx, new Date(close * 1000), 15))).toBeUndefined();
    expect(evaluateIntradayVolume(bars(open, 999), 2, (open + 60) * 1000, 0, { ...cfg, skipOpenBars: 0 }, barPosition(krx, new Date(open * 1000), 15))).toBeDefined();
  });
});

describe('engine.onBars', () => {
  let repo: Repo;
  afterEach(() => repo?.close());

  async function setup(nowIso: string) {
    const SYM = 'BINANCE:BTCUSDT';
    const md = new FakeMarketData();
    md.metas.set(SYM, { symbol: SYM, description: 'BTC', localDescription: undefined, currency: 'USDT', timezone: 'Etc/UTC', session: '24x7', type: 'spot' });
    repo.upsertMeta({ symbol: SYM, description: 'BTC', currency: 'USDT', timezone: 'Etc/UTC', session: '24x7' });
    const history = new HistoryService(repo, md, 20, logger);
    const monitor = new MarketMonitor(repo, history, { lagThresholdSec: 60, lagPersistMin: 5 }, logger);
    monitor.setMeta(await md.symbolInfo(SYM));
    const events: AlertEvent[] = [];
    let now = new Date(nowIso);
    const engine = new TriggerEngine({
      repo, monitor, logger, sink: { deliver: async (_s, e) => void events.push(...e) },
      rules: { esc: { sigmaSteps: [3, 4, 5, 6], pctStep: 2.5, pctBase: 5 }, volumeRatio: 3, volumeWarmupMin: 30, levelDefaultProximityPct: 2 },
      benchmarks: {}, nameOf: (s) => s,
      intradayVolume: { ...cfg, defaultRatio: 2 },
      sessionOf: () => ({ session: '24x7', timezone: 'Etc/UTC' }),
      now: () => now,
    });
    engine.start();
    engine.stop();
    monitor.onQuote(makeQuote(SYM, 100, 100, now, now, 'streaming'));
    return { SYM, engine, events, setNow: (iso: string) => (now = new Date(iso)) };
  }

  it('같은 봉에서는 한 번만, 다음 봉에서 다시. 재시작 후에도 같은 봉 중복 없음. off·음소거 존중', async () => {
    repo = new Repo(':memory:');
    repo.addWatch({ symbol: 'BINANCE:BTCUSDT', displayName: 'BTC', criteria: { sigma: 3, pct: null }, volumeEnabled: false });
    const a = await setup('2026-11-10T04:05:00Z');
    const b1 = T('2026-11-10T04:00:00Z');
    a.engine.onBars(a.SYM, bars(b1, 150));
    a.engine.onBars(a.SYM, bars(b1, 210)); // 2.1x → 알림
    a.engine.onBars(a.SYM, bars(b1, 400)); // 같은 봉 → 없음
    expect(a.events.map((e) => hitLabel(e.hit))).toEqual(['ivol:15m:2.1x']);
    expect(repo.alertsSince('2000-01-01')[0]).toMatchObject({ trigger_type: 'ivol', level_id: b1, volume_ratio: 2.1 });

    const b = await setup('2026-11-10T04:06:00Z'); // 재시작
    b.engine.onBars(b.SYM, bars(b1, 500));
    expect(b.events).toHaveLength(0);
    b.setNow('2026-11-10T04:16:00Z');
    b.engine.onBars(b.SYM, bars(b1 + 900, 300)); // 다음 봉
    expect(b.events).toHaveLength(1);

    repo.setIvolRatio(b.SYM, 0); // 끔
    b.setNow('2026-11-10T04:31:00Z');
    b.engine.onBars(b.SYM, bars(b1 + 1800, 900));
    expect(b.events).toHaveLength(1);

    repo.setIvolRatio(b.SYM, 5); // 종목별 배수
    b.engine.onBars(b.SYM, bars(b1 + 1800, 450));
    expect(b.events).toHaveLength(1);
    b.engine.onBars(b.SYM, bars(b1 + 1800, 520));
    expect(b.events).toHaveLength(2);
  });
});

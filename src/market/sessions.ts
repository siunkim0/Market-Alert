/**
 * 장 시간 / 거래일 경계. getSymbolInfo의 session('0900-1535', '0930-1600:23456', '24x7')과
 * timezone으로 계산하므로 서머타임이 자동 반영된다. 휴장일은 별도로 다루지 않는다.
 */
import { localClock, localDate } from '../time.js';

export interface SessionSpec {
  session: string;
  timezone: string;
}

interface Range {
  start: number; // 0시 기준 분
  end: number;
  days: Set<number>; // 1=일 … 7=토
}

const DEFAULT_DAYS = '23456'; // 월~금

export function parseSession(session: string): Range[] | 'always' {
  const s = session.trim();
  if (s === '24x7' || s === '0000-0000:1234567' || s === '') return 'always';
  const ranges: Range[] = [];
  for (const part of s.split(',')) {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const [, sh, sm, eh, em, days] = m;
    ranges.push({
      start: Number(sh) * 60 + Number(sm),
      end: Number(eh) * 60 + Number(em),
      days: new Set((days ?? DEFAULT_DAYS).split('').map(Number)),
    });
  }
  return ranges.length > 0 ? ranges : 'always';
}

/**
 * `at` 시점에 정규장인지. 지연 종목은 delaySec만큼 과거 시각으로 판단한다
 * (KRX 20분 지연이면 15:35 + 20분까지 장중으로 본다).
 */
export function isSessionOpen(spec: SessionSpec, at: Date, delaySec = 0): boolean {
  const ranges = parseSession(spec.session);
  if (ranges === 'always') return true;
  const t = new Date(at.getTime() - delaySec * 1000);
  const { weekday, minutes } = localClock(t, spec.timezone);
  const prevWeekday = weekday === 1 ? 7 : weekday - 1;
  return ranges.some((r) => {
    if (r.start < r.end) return r.days.has(weekday) && minutes >= r.start && minutes < r.end;
    // 자정을 넘는 세션: 시작일 기준 요일
    return (r.days.has(weekday) && minutes >= r.start) || (r.days.has(prevWeekday) && minutes < r.end);
  });
}

/** 거래일(session_date). 지연을 고려한 가격 시각의 거래소 현지 날짜. 크립토(Etc/UTC)는 KST 09:00 경계. */
export function sessionDate(spec: SessionSpec, at: Date, delaySec = 0): string {
  return localDate(new Date(at.getTime() - delaySec * 1000), spec.timezone);
}

/**
 * `at`(가격 시각) 기준 오늘 정규장 경과 분과 전체 분. 장 밖이면 undefined.
 * 24x7은 현지(UTC) 0시부터 1440분.
 */
export function sessionProgress(spec: SessionSpec, at: Date): { elapsedMin: number; totalMin: number } | undefined {
  const ranges = parseSession(spec.session);
  const { weekday, minutes } = localClock(at, spec.timezone);
  if (ranges === 'always') return { elapsedMin: minutes, totalMin: 1440 };
  for (const r of ranges) {
    if (r.start < r.end && r.days.has(weekday) && minutes >= r.start && minutes < r.end) {
      return { elapsedMin: minutes - r.start, totalMin: r.end - r.start };
    }
  }
  return undefined;
}

export type MarketKey = 'KRX' | 'US' | 'CRYPTO' | 'OTHER';

const CRYPTO_EXCHANGES = new Set(['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'UPBIT', 'BITHUMB', 'BITGET', 'KRAKEN', 'CRYPTO']);

/** benchmark·digest 구분용 시장 */
export function marketOf(symbol: string, timezone: string | undefined): MarketKey {
  const exch = symbol.split(':')[0]?.toUpperCase() ?? '';
  if (exch === 'KRX' || timezone === 'Asia/Seoul') return 'KRX';
  if (CRYPTO_EXCHANGES.has(exch)) return 'CRYPTO';
  if (timezone === 'America/New_York' || ['NASDAQ', 'NYSE', 'AMEX', 'BATS', 'CBOE'].includes(exch)) return 'US';
  return 'OTHER';
}

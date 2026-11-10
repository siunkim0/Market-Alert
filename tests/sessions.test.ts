import { describe, expect, it } from 'vitest';
import { isSessionOpen, parseSession, sessionDate } from '../src/market/sessions.js';

const krx = { session: '0900-1535', timezone: 'Asia/Seoul' };
const us = { session: '0930-1600', timezone: 'America/New_York' };
const crypto = { session: '24x7', timezone: 'Etc/UTC' };

describe('장 시간', () => {
  it('세션 문자열 파싱', () => {
    expect(parseSession('24x7')).toBe('always');
    const r = parseSession('0930-1600:23456');
    expect(r).not.toBe('always');
    if (r !== 'always') expect(r[0]).toMatchObject({ start: 570, end: 960 });
  });

  it('KRX 장중/마감과 20분 지연 연장', () => {
    // 2026-11-10(화) 13:00 KST = 04:00Z
    expect(isSessionOpen(krx, new Date('2026-11-10T04:00:00Z'))).toBe(true);
    // 15:45 KST: 실시간 기준 마감, 20분 지연이면 아직 장중(15:25 가격)
    const t = new Date('2026-11-10T06:45:00Z');
    expect(isSessionOpen(krx, t)).toBe(false);
    expect(isSessionOpen(krx, t, 1200)).toBe(true);
    // 15:56 KST + 20분 지연 → 15:36 → 마감
    expect(isSessionOpen(krx, new Date('2026-11-10T06:56:00Z'), 1200)).toBe(false);
    // 토요일
    expect(isSessionOpen(krx, new Date('2026-11-14T04:00:00Z'))).toBe(false);
  });

  it('미국 장은 서머타임을 자동 반영', () => {
    // 11/10은 EST(UTC-5): 09:30 ET = 14:30Z
    expect(isSessionOpen(us, new Date('2026-11-10T14:29:00Z'))).toBe(false);
    expect(isSessionOpen(us, new Date('2026-11-10T14:30:00Z'))).toBe(true);
    // 7월은 EDT(UTC-4): 09:30 ET = 13:30Z
    expect(isSessionOpen(us, new Date('2026-07-14T13:30:00Z'))).toBe(true);
  });

  it('거래일 경계: 크립토는 KST 09:00, KRX는 현지 날짜', () => {
    expect(sessionDate(crypto, new Date('2026-11-09T23:59:00Z'))).toBe('2026-11-09'); // KST 11/10 08:59
    expect(sessionDate(crypto, new Date('2026-11-10T00:00:00Z'))).toBe('2026-11-10'); // KST 09:00
    expect(sessionDate(krx, new Date('2026-11-09T15:30:00Z'))).toBe('2026-11-10'); // KST 00:30
    expect(isSessionOpen(crypto, new Date('2026-11-14T04:00:00Z'))).toBe(true);
  });
});

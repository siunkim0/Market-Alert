export const KST = 'Asia/Seoul';

export function nowIso(): string {
  return new Date().toISOString();
}

function parts(d: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** 특정 timezone의 현지 날짜 'YYYY-MM-DD'. */
export function localDate(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 현지 요일(TradingView 규칙: 1=일 … 7=토)과 0시 기준 분. */
export function localClock(d: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const p = parts(d, timeZone);
  const weekday = WEEKDAYS.indexOf(p.weekday ?? '') + 1;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** KST 표시: 오늘이면 'HH:MM', 아니면 'MM/DD HH:MM'. */
export function fmtKst(d: Date, now: Date = new Date()): string {
  const p = parts(d, KST);
  const hm = `${p.hour}:${p.minute}`;
  return localDate(d, KST) === localDate(now, KST) ? hm : `${p.month}/${p.day} ${hm}`;
}

/** 각 시장 개장 전 일봉 갱신 (config.daily_bars_refresh, KST) */
import { Cron } from 'croner';
import type { Logger } from '../logger.js';
import type { HistoryService } from '../market/history.js';
import { KST } from '../time.js';

export function scheduleDailyBars(times: string[], history: HistoryService, symbols: () => string[], logger: Logger): Cron[] {
  const log = logger.child({ mod: 'job:dailyBars' });
  return times.map((hm) => {
    const [h, m] = hm.split(':');
    return new Cron(`${Number(m)} ${Number(h)} * * *`, { timezone: KST, protect: true }, async () => {
      const list = symbols();
      log.info({ count: list.length, at: hm }, '일봉 갱신 시작');
      await history.refreshAll(list);
      log.info('일봉 갱신 완료');
    });
  });
}

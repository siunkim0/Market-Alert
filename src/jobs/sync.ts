/** journal_sync_minutes마다 Binance 체결 동기화 */
import { Cron } from 'croner';
import type { Logger } from '../logger.js';

export function scheduleSync(minutes: number, syncer: { sync(): Promise<{ inserted: number }> }, logger: Logger): Cron {
  const log = logger.child({ mod: 'job:sync' });
  const every = Math.max(1, Math.round(minutes));
  return new Cron(`*/${every} * * * *`, { protect: true }, async () => {
    try {
      const r = await syncer.sync();
      if (r.inserted > 0) log.info({ inserted: r.inserted }, '정기 동기화');
    } catch (e) {
      log.warn({ err: (e as Error).message }, '정기 동기화 실패');
    }
  });
}

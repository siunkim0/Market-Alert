import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { nowIso } from '../time.js';

export type WatchMode = 'sigma' | 'pct';

export interface WatchRow {
  id: number;
  symbol: string;
  display_name: string | null;
  mode: WatchMode;
  threshold: number;
  volume_enabled: number;
  muted_until: string | null;
  created_at: string;
}

export interface SymbolMetaRow {
  symbol: string;
  description: string | null;
  currency: string | null;
  timezone: string | null;
  session: string | null;
  delayed: number;
  measured_delay_sec: number | null;
  updated_at: string | null;
}

export type LevelDirection = 'above' | 'below' | 'cross';

export interface LevelRow {
  id: number;
  symbol: string;
  price: number;
  direction: LevelDirection;
  proximity_pct: number | null;
  note: string | null;
  active: number;
  created_at: string;
}

export type TriggerType = 'sigma' | 'pct' | 'volume' | 'level' | 'position';

export interface AlertLogRow {
  id: number;
  symbol: string;
  trigger_type: TriggerType;
  direction: string | null;
  level_reached: number | null;
  z: number | null;
  ret_pct: number | null;
  volume_ratio: number | null;
  price: number | null;
  price_time: string | null;
  delayed: number;
  telegram_message_id: number | null;
  level_id: number | null;
  session_date: string;
  created_at: string;
}

export type NewAlertLog = Omit<AlertLogRow, 'id' | 'created_at' | 'telegram_message_id'>;

export interface BarRow {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export class Repo {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.migrate();
  }

  /** 기존 DB에 나중에 추가된 컬럼을 붙인다. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(alert_log)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('level_id')) this.db.exec('ALTER TABLE alert_log ADD COLUMN level_id INTEGER');
  }

  close(): void {
    this.db.close();
  }

  // ── watchlist ──────────────────────────────────────────────
  addWatch(w: { symbol: string; displayName: string | null; mode: WatchMode; threshold: number; volumeEnabled: boolean }):
    'added' | 'exists' {
    const r = this.db
      .prepare(
        `INSERT INTO watchlist (symbol, display_name, mode, threshold, volume_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(w.symbol, w.displayName, w.mode, w.threshold, w.volumeEnabled ? 1 : 0, nowIso());
    return r.changes > 0 ? 'added' : 'exists';
  }

  removeWatch(symbol: string): boolean {
    return this.db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol).changes > 0;
  }

  listWatch(): WatchRow[] {
    return this.db.prepare('SELECT * FROM watchlist ORDER BY id').all() as WatchRow[];
  }

  getWatch(symbol: string): WatchRow | undefined {
    return this.db.prepare('SELECT * FROM watchlist WHERE symbol = ?').get(symbol) as WatchRow | undefined;
  }

  updateWatchMode(symbol: string, mode: WatchMode, threshold: number): boolean {
    return this.db.prepare('UPDATE watchlist SET mode = ?, threshold = ? WHERE symbol = ?').run(mode, threshold, symbol).changes > 0;
  }

  setMuted(symbol: string, untilIso: string | null): boolean {
    return this.db.prepare('UPDATE watchlist SET muted_until = ? WHERE symbol = ?').run(untilIso, symbol).changes > 0;
  }

  // ── level_alerts ───────────────────────────────────────────
  addLevel(l: { symbol: string; price: number; direction: LevelDirection; proximityPct: number | null; note: string | null }): number {
    const r = this.db
      .prepare(
        `INSERT INTO level_alerts (symbol, price, direction, proximity_pct, note, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(l.symbol, l.price, l.direction, l.proximityPct, l.note, nowIso());
    return Number(r.lastInsertRowid);
  }

  listLevels(activeOnly = true): LevelRow[] {
    return this.db
      .prepare(`SELECT * FROM level_alerts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY symbol, price`)
      .all() as LevelRow[];
  }

  getLevel(id: number): LevelRow | undefined {
    return this.db.prepare('SELECT * FROM level_alerts WHERE id = ?').get(id) as LevelRow | undefined;
  }

  setLevelDirection(id: number, direction: LevelDirection): void {
    this.db.prepare('UPDATE level_alerts SET direction = ? WHERE id = ?').run(direction, id);
  }

  deactivateLevel(id: number): boolean {
    return this.db.prepare('UPDATE level_alerts SET active = 0 WHERE id = ? AND active = 1').run(id).changes > 0;
  }

  // ── alert_log ──────────────────────────────────────────────
  insertAlert(a: NewAlertLog): number {
    const r = this.db
      .prepare(
        `INSERT INTO alert_log (symbol, trigger_type, direction, level_reached, z, ret_pct, volume_ratio, price,
           price_time, delayed, level_id, session_date, created_at)
         VALUES (@symbol, @trigger_type, @direction, @level_reached, @z, @ret_pct, @volume_ratio, @price,
           @price_time, @delayed, @level_id, @session_date, @created_at)`,
      )
      .run({ ...a, created_at: nowIso() });
    return Number(r.lastInsertRowid);
  }

  setAlertMessageId(ids: number[], messageId: number): void {
    const stmt = this.db.prepare('UPDATE alert_log SET telegram_message_id = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) stmt.run(messageId, id);
    })();
  }

  setAlertExplanation(ids: number[], explanation: string, sourcesJson: string): void {
    const stmt = this.db.prepare('UPDATE alert_log SET explanation = ?, sources_json = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) stmt.run(explanation, sourcesJson, id);
    })();
  }

  /** cooldown 복원용: 최근 생성된 알림 */
  alertsSince(sinceIso: string): AlertLogRow[] {
    return this.db.prepare('SELECT * FROM alert_log WHERE created_at >= ? ORDER BY id').all(sinceIso) as AlertLogRow[];
  }

  /** 레벨 알림의 근접 알림이 이미 나갔는지 */
  levelNearSent(levelId: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM alert_log WHERE level_id = ? AND trigger_type = 'level' AND direction = 'near' LIMIT 1")
      .get(levelId);
  }

  // ── symbol_meta ────────────────────────────────────────────
  upsertMeta(m: { symbol: string; description: string | null; currency: string | null; timezone: string; session: string }): void {
    this.db
      .prepare(
        `INSERT INTO symbol_meta (symbol, description, currency, timezone, session, updated_at)
         VALUES (@symbol, @description, @currency, @timezone, @session, @updated_at)
         ON CONFLICT(symbol) DO UPDATE SET description = excluded.description, currency = excluded.currency,
           timezone = excluded.timezone, session = excluded.session, updated_at = excluded.updated_at`,
      )
      .run({ ...m, updated_at: nowIso() });
  }

  getMeta(symbol: string): SymbolMetaRow | undefined {
    return this.db.prepare('SELECT * FROM symbol_meta WHERE symbol = ?').get(symbol) as SymbolMetaRow | undefined;
  }

  setDelay(symbol: string, delayed: boolean, delaySec: number | null): void {
    this.db
      .prepare(
        `INSERT INTO symbol_meta (symbol, delayed, measured_delay_sec, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET delayed = excluded.delayed,
           measured_delay_sec = excluded.measured_delay_sec, updated_at = excluded.updated_at`,
      )
      .run(symbol, delayed ? 1 : 0, delaySec, nowIso());
  }

  // ── daily_bars ─────────────────────────────────────────────
  upsertBars(symbol: string, bars: Omit<BarRow, 'symbol'>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO daily_bars (symbol, date, open, high, low, close, volume)
       VALUES (@symbol, @date, @open, @high, @low, @close, @volume)
       ON CONFLICT(symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high,
         low = excluded.low, close = excluded.close, volume = excluded.volume`,
    );
    this.db.transaction(() => {
      for (const b of bars) stmt.run({ symbol, ...b });
    })();
  }

  /** 오래된 것부터 정렬된 최근 n개 일봉. `beforeDate`가 있으면 그 날짜 미만만. */
  getBars(symbol: string, limit: number, beforeDate?: string): BarRow[] {
    const rows = (
      beforeDate
        ? this.db
            .prepare('SELECT * FROM daily_bars WHERE symbol = ? AND date < ? ORDER BY date DESC LIMIT ?')
            .all(symbol, beforeDate, limit)
        : this.db.prepare('SELECT * FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?').all(symbol, limit)
    ) as BarRow[];
    return rows.reverse();
  }
}

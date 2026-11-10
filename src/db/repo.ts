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

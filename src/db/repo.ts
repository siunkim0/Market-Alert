import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { nowIso } from '../time.js';

export type WatchMode = 'sigma' | 'pct';

/** 종목 알림 기준. null이면 그 기준은 꺼짐. 둘 다 켤 수 있다. */
export interface Criteria {
  sigma: number | null;
  pct: number | null;
}

/** watchlist 행의 켜진 기준 목록 (σ 먼저) */
export function criteriaOf(w: Pick<WatchRow, 'mode' | 'threshold' | 'sigma_threshold' | 'pct_threshold'>): { mode: WatchMode; threshold: number }[] {
  const out: { mode: WatchMode; threshold: number }[] = [];
  if (w.sigma_threshold !== null && w.sigma_threshold !== undefined) out.push({ mode: 'sigma', threshold: w.sigma_threshold });
  if (w.pct_threshold !== null && w.pct_threshold !== undefined) out.push({ mode: 'pct', threshold: w.pct_threshold });
  // 마이그레이션 전 행 대비
  if (out.length === 0 && w.sigma_threshold === undefined && w.pct_threshold === undefined) out.push({ mode: w.mode, threshold: w.threshold });
  return out;
}

function legacy(c: Criteria): { mode: WatchMode; threshold: number } {
  return c.sigma !== null ? { mode: 'sigma', threshold: c.sigma } : { mode: 'pct', threshold: c.pct ?? 0 };
}

export interface WatchRow {
  id: number;
  symbol: string;
  display_name: string | null;
  /** (구) 대표 기준. 실제 기준은 sigma_threshold / pct_threshold (criteriaOf 사용) */
  mode: WatchMode;
  threshold: number;
  sigma_threshold: number | null;
  pct_threshold: number | null;
  /** 분봉 거래량 배수. null이면 config 기본값, 0이면 끔 */
  ivol_ratio: number | null;
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

export type TriggerType = 'sigma' | 'pct' | 'volume' | 'ivol' | 'level' | 'position';

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

export interface TradeRow {
  id: number;
  source: string;
  external_id: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number | null;
  fee_currency: string | null;
  leverage: number | null;
  executed_at: string;
  trade_group: string | null;
  stop_loss: number | null;
  take_profit: number | null;
  note: string | null;
  realized_pnl: number | null;
  created_at: string;
}

export type NewTrade = Omit<TradeRow, 'id' | 'created_at' | 'trade_group'>;

export interface PositionStopRow {
  trade_group: string;
  symbol: string;
  initial_stop: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  updated_at: string;
}

export interface PositionSnapshotRow {
  source: string;
  symbol: string;
  qty: number;
  avg_price: number;
  unrealized_pnl: number | null;
  fetched_at: string;
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
    this.migrate();
  }

  /** 기존 DB에 나중에 추가된 컬럼을 붙인다. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(alert_log)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('level_id')) this.db.exec('ALTER TABLE alert_log ADD COLUMN level_id INTEGER');
    const wcols = (this.db.prepare('PRAGMA table_info(watchlist)').all() as { name: string }[]).map((c) => c.name);
    if (!wcols.includes('sigma_threshold')) {
      this.db.exec(`
        ALTER TABLE watchlist ADD COLUMN sigma_threshold REAL;
        ALTER TABLE watchlist ADD COLUMN pct_threshold REAL;
        UPDATE watchlist SET sigma_threshold = threshold WHERE mode = 'sigma';
        UPDATE watchlist SET pct_threshold = threshold WHERE mode = 'pct';
      `);
    }
    if (!wcols.includes('ivol_ratio')) this.db.exec('ALTER TABLE watchlist ADD COLUMN ivol_ratio REAL');
  }

  close(): void {
    this.db.close();
  }

  // ── watchlist ──────────────────────────────────────────────
  addWatch(w: { symbol: string; displayName: string | null; criteria: Criteria; volumeEnabled: boolean }): 'added' | 'exists' {
    if (w.criteria.sigma === null && w.criteria.pct === null) throw new Error('기준이 하나 이상 있어야 합니다');
    const l = legacy(w.criteria);
    const r = this.db
      .prepare(
        `INSERT INTO watchlist (symbol, display_name, mode, threshold, sigma_threshold, pct_threshold, volume_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(w.symbol, w.displayName, l.mode, l.threshold, w.criteria.sigma, w.criteria.pct, w.volumeEnabled ? 1 : 0, nowIso());
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

  /** 기준 변경. 값이 undefined인 기준은 그대로, null은 끔. 둘 다 꺼지면 에러 */
  updateCriteria(symbol: string, patch: Partial<Criteria>): Criteria {
    const w = this.getWatch(symbol);
    if (!w) throw new Error(`watchlist에 없는 종목: ${symbol}`);
    const cur = criteriaOf(w);
    const next: Criteria = {
      sigma: patch.sigma !== undefined ? patch.sigma : (cur.find((c) => c.mode === 'sigma')?.threshold ?? null),
      pct: patch.pct !== undefined ? patch.pct : (cur.find((c) => c.mode === 'pct')?.threshold ?? null),
    };
    if (next.sigma === null && next.pct === null) throw new Error('σ와 % 기준을 둘 다 끌 수는 없습니다');
    const l = legacy(next);
    this.db
      .prepare('UPDATE watchlist SET sigma_threshold = ?, pct_threshold = ?, mode = ?, threshold = ? WHERE symbol = ?')
      .run(next.sigma, next.pct, l.mode, l.threshold, symbol);
    return next;
  }

  /** 분봉 거래량 배수. null이면 기본값, 0이면 끔 */
  setIvolRatio(symbol: string, ratio: number | null): boolean {
    return this.db.prepare('UPDATE watchlist SET ivol_ratio = ? WHERE symbol = ?').run(ratio, symbol).changes > 0;
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

  // ── trades ─────────────────────────────────────────────────
  /** (source, external_id) 중복이면 null */
  insertTrade(t: NewTrade): number | null {
    const r = this.db
      .prepare(
        `INSERT INTO trades (source, external_id, symbol, side, qty, price, fee, fee_currency, leverage, executed_at,
           stop_loss, take_profit, note, realized_pnl, created_at)
         VALUES (@source, @external_id, @symbol, @side, @qty, @price, @fee, @fee_currency, @leverage, @executed_at,
           @stop_loss, @take_profit, @note, @realized_pnl, @created_at)
         ON CONFLICT(source, external_id) DO NOTHING`,
      )
      .run({ ...t, created_at: nowIso() });
    return r.changes > 0 ? Number(r.lastInsertRowid) : null;
  }

  listTrades(): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY executed_at, id').all() as TradeRow[];
  }

  getTrade(id: number): TradeRow | undefined {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as TradeRow | undefined;
  }

  deleteTrade(id: number): boolean {
    return this.db.prepare("DELETE FROM trades WHERE id = ? AND source = 'manual'").run(id).changes > 0;
  }

  updateTradeGroups(map: Map<number, string>): void {
    const stmt = this.db.prepare('UPDATE trades SET trade_group = ? WHERE id = ? AND (trade_group IS NOT ? )');
    this.db.transaction(() => {
      for (const [id, g] of map) stmt.run(g, id, g);
    })();
  }

  setTradeNote(id: number, note: string): boolean {
    return this.db.prepare('UPDATE trades SET note = ? WHERE id = ?').run(note, id).changes > 0;
  }

  // ── position_stops ─────────────────────────────────────────
  listPositionStops(): PositionStopRow[] {
    return this.db.prepare('SELECT * FROM position_stops').all() as PositionStopRow[];
  }

  setPositionStop(group: string, symbol: string, kind: 'sl' | 'tp', price: number, initialIfUnset: number | null): void {
    const cur = this.db.prepare('SELECT * FROM position_stops WHERE trade_group = ?').get(group) as PositionStopRow | undefined;
    const row: PositionStopRow = cur ?? { trade_group: group, symbol, initial_stop: null, stop_loss: null, take_profit: null, updated_at: '' };
    if (kind === 'sl') {
      row.stop_loss = price;
      row.initial_stop ??= initialIfUnset ?? price;
    } else row.take_profit = price;
    row.updated_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO position_stops (trade_group, symbol, initial_stop, stop_loss, take_profit, updated_at)
         VALUES (@trade_group, @symbol, @initial_stop, @stop_loss, @take_profit, @updated_at)
         ON CONFLICT(trade_group) DO UPDATE SET initial_stop = excluded.initial_stop, stop_loss = excluded.stop_loss,
           take_profit = excluded.take_profit, updated_at = excluded.updated_at`,
      )
      .run(row);
  }

  // ── positions_snapshot / sync_state ────────────────────────
  replacePositionSnapshot(source: string, rows: Omit<PositionSnapshotRow, 'source' | 'fetched_at'>[]): void {
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM positions_snapshot WHERE source = ?').run(source);
      const stmt = this.db.prepare(
        `INSERT INTO positions_snapshot (source, symbol, qty, avg_price, unrealized_pnl, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) stmt.run(source, r.symbol, r.qty, r.avg_price, r.unrealized_pnl, at);
    })();
  }

  listPositionSnapshot(source?: string): PositionSnapshotRow[] {
    return (
      source
        ? this.db.prepare('SELECT * FROM positions_snapshot WHERE source = ?').all(source)
        : this.db.prepare('SELECT * FROM positions_snapshot').all()
    ) as PositionSnapshotRow[];
  }

  getSyncState(source: string): { last_synced_at: string | null; cursor: string | null } | undefined {
    return this.db.prepare('SELECT last_synced_at, cursor FROM sync_state WHERE source = ?').get(source) as
      | { last_synced_at: string | null; cursor: string | null }
      | undefined;
  }

  setSyncState(source: string, cursor: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (source, last_synced_at, cursor) VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET last_synced_at = excluded.last_synced_at, cursor = excluded.cursor`,
      )
      .run(source, nowIso(), cursor);
  }

  // ── rule_violations ────────────────────────────────────────
  /** 같은 (rule, trade_group)은 한 번만. 새로 기록되면 true */
  addViolation(v: { rule: string; symbol: string; tradeGroup: string | null; detail: string; at?: Date }): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO rule_violations (rule, symbol, trade_group, detail, occurred_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(rule, trade_group) DO NOTHING`,
        )
        .run(v.rule, v.symbol, v.tradeGroup, v.detail, (v.at ?? new Date()).toISOString()).changes > 0
    );
  }

  violationsSince(sinceIso: string): { rule: string; symbol: string; trade_group: string | null; detail: string; occurred_at: string }[] {
    return this.db
      .prepare('SELECT rule, symbol, trade_group, detail, occurred_at FROM rule_violations WHERE occurred_at >= ? ORDER BY occurred_at')
      .all(sinceIso) as { rule: string; symbol: string; trade_group: string | null; detail: string; occurred_at: string }[];
  }

  // ── settings ───────────────────────────────────────────────
  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  alertsForSession(sessionDate: string, symbols: string[]): AlertLogRow[] {
    if (symbols.length === 0) return [];
    const ph = symbols.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM alert_log WHERE session_date = ? AND symbol IN (${ph}) ORDER BY id`)
      .all(sessionDate, ...symbols) as AlertLogRow[];
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

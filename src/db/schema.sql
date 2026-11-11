CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,         -- 'KRX:005930'
  display_name TEXT,                   -- '삼성전자'
  mode TEXT NOT NULL DEFAULT 'sigma',  -- (구) 대표 기준. sigma_threshold/pct_threshold가 실제 기준
  threshold REAL NOT NULL,
  sigma_threshold REAL,                -- σ 기준 (NULL이면 끔)
  pct_threshold REAL,                  -- % 기준 (NULL이면 끔)
  ivol_ratio REAL,                     -- 분봉 거래량 배수 (NULL이면 config 기본값, 0이면 끔)
  volume_enabled INTEGER NOT NULL DEFAULT 1,
  muted_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS level_alerts (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  direction TEXT NOT NULL,             -- 'above' | 'below' | 'cross'
  proximity_pct REAL,
  note TEXT,                           -- 'ELS KI 배리어' 등
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,                  -- 거래소 현지 날짜
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS symbol_meta (
  symbol TEXT PRIMARY KEY,
  description TEXT,
  currency TEXT,
  timezone TEXT,
  session TEXT,                        -- getSymbolInfo의 session 문자열
  delayed INTEGER NOT NULL DEFAULT 0,
  measured_delay_sec INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  trigger_type TEXT NOT NULL,          -- sigma | pct | volume | level | position
  direction TEXT,                      -- up | down
  level_reached REAL,
  z REAL, ret_pct REAL, volume_ratio REAL, price REAL,
  price_time TEXT,                     -- lp_time (지연 반영 시각)
  delayed INTEGER NOT NULL DEFAULT 0,
  explanation TEXT,
  sources_json TEXT,
  telegram_message_id INTEGER,         -- 원인 요약 edit용
  level_id INTEGER,                    -- level 알림이면 level_alerts.id
  session_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,                -- manual | binance_futures
  external_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,                  -- buy | sell
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL DEFAULT 0,
  fee_currency TEXT,
  leverage REAL,
  executed_at TEXT NOT NULL,
  trade_group TEXT,
  stop_loss REAL,
  take_profit REAL,
  note TEXT,
  realized_pnl REAL,                   -- 거래소 제공값 우선
  created_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS positions_snapshot (
  source TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty REAL, avg_price REAL, unrealized_pnl REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, symbol)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  last_synced_at TEXT,
  cursor TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_log_session ON alert_log (session_date, symbol);

-- /sl, /tp로 바꾼 손절·익절가 (거래 그룹 단위). initial_stop은 R 계산용 최초 손절가
CREATE TABLE IF NOT EXISTS position_stops (
  trade_group TEXT PRIMARY KEY,        -- 'G<첫 체결 id>'
  symbol TEXT NOT NULL,
  initial_stop REAL,
  stop_loss REAL,
  take_profit REAL,
  updated_at TEXT NOT NULL
);

-- 매매 규칙 위반 (config.yaml trading_rules)
CREATE TABLE IF NOT EXISTS rule_violations (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,                  -- max_trades_per_day | max_loss_R | require_stop_loss
  symbol TEXT NOT NULL,
  trade_group TEXT,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (rule, trade_group)
);

-- 봇 설정 (digest on/off 등)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

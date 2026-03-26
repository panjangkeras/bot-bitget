-- ═══════════════════════════════════════════════════════════
--  SCHEMA SUPABASE — Bitget Scalping Santai
--  Jalankan ini di Supabase SQL Editor
--  (Database → SQL Editor → New query → paste → Run)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. TABEL TRADES ─────────────────────────────────────
-- Menyimpan setiap trade yang di-close oleh bot.
-- Sinkron dengan trades.json tapi persisten di cloud.

CREATE TABLE IF NOT EXISTS trades (
  id            BIGSERIAL PRIMARY KEY,
  external_id   TEXT UNIQUE,           -- ID dari bot (timestamp-based)
  ts            TIMESTAMPTZ NOT NULL,  -- waktu close trade
  symbol        TEXT NOT NULL,         -- e.g. "SOLUSDT"
  side          TEXT NOT NULL,         -- "long" | "short"
  entry_price   NUMERIC NOT NULL,
  exit_price    NUMERIC NOT NULL,
  size          NUMERIC NOT NULL,
  leverage      INT NOT NULL DEFAULT 10,
  pnl           NUMERIC NOT NULL,      -- realized PnL dalam USDT
  pnl_pct       NUMERIC NOT NULL,      -- % PnL (sudah dikali leverage)
  close_reason  TEXT,                  -- "SL", "TP1", "TP2", "RSI_EXTREME", dll
  strategy      TEXT DEFAULT 'TF',     -- "TF" | "MR" | "AUTO"
  win           BOOLEAN NOT NULL,
  price_source  TEXT DEFAULT 'estimated',  -- "exchange" | "estimated"
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index untuk query yang sering dipakai
CREATE INDEX IF NOT EXISTS idx_trades_symbol     ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_ts         ON trades(ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts  ON trades(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_win        ON trades(win);

-- ─── 2. TABEL SIGNALS ────────────────────────────────────
-- Log semua sinyal AI — berguna untuk audit dan tuning.
-- Entry yang di-HOLD pun dicatat (kalau SIGNALS_LOG=true di .env)

CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol        TEXT NOT NULL,
  action        TEXT,         -- "BUY" | "SELL" | "HOLD"
  position      TEXT,         -- "LONG" | "SHORT" | "NONE"
  confidence    NUMERIC,      -- 0.0 – 1.0
  reason        TEXT,
  grade         TEXT,         -- "A" | "B" | "C" | "D"
  leverage_used INT,
  sl_pct        NUMERIC,
  tp1_pct       NUMERIC,
  tp2_pct       NUMERIC,
  rsi           NUMERIC,
  trend         TEXT,
  atr_pct       NUMERIC,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_ts     ON signals(ts DESC);

-- ─── 3. ROW LEVEL SECURITY (RLS) ─────────────────────────
-- Aktifkan RLS tapi izinkan semua operasi dari service role.
-- Bot pakai anon key → izinkan INSERT dan SELECT saja.

ALTER TABLE trades  ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

-- Policy: anon key boleh baca dan insert (tidak boleh update/delete)
CREATE POLICY "anon_read_trades"
  ON trades FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_trades"
  ON trades FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon_read_signals"
  ON signals FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_signals"
  ON signals FOR INSERT
  TO anon
  WITH CHECK (true);

-- ─── 4. VIEW BERGUNA (opsional) ──────────────────────────
-- Win-rate per symbol — bisa dilihat langsung di Supabase dashboard

CREATE OR REPLACE VIEW win_stats_by_symbol AS
SELECT
  symbol,
  COUNT(*)                                           AS total_trades,
  SUM(CASE WHEN win THEN 1 ELSE 0 END)               AS wins,
  SUM(CASE WHEN NOT win THEN 1 ELSE 0 END)           AS losses,
  ROUND(AVG(CASE WHEN win THEN 1.0 ELSE 0.0 END) * 100, 1) AS win_rate_pct,
  ROUND(SUM(pnl)::NUMERIC, 2)                        AS total_pnl,
  ROUND(AVG(pnl)::NUMERIC, 4)                        AS avg_pnl,
  ROUND(AVG(CASE WHEN side = 'long'  AND win THEN 1.0 WHEN side = 'long'  THEN 0.0 END) * 100, 1) AS long_wr,
  ROUND(AVG(CASE WHEN side = 'short' AND win THEN 1.0 WHEN side = 'short' THEN 0.0 END) * 100, 1) AS short_wr,
  MODE() WITHIN GROUP (ORDER BY close_reason)        AS top_close_reason,
  ROUND(AVG(leverage), 0)                            AS avg_leverage,
  MAX(ts)                                            AS last_trade
FROM trades
GROUP BY symbol
ORDER BY total_trades DESC;

-- Recent trades view (50 terakhir)
CREATE OR REPLACE VIEW recent_trades AS
SELECT
  ts, symbol, side, entry_price, exit_price,
  pnl, pnl_pct, close_reason, win, leverage, price_source
FROM trades
ORDER BY ts DESC
LIMIT 50;

-- ─── 5. MIGRASI DATA LAMA (opsional) ─────────────────────
-- Kalau mau import trades.json yang sudah ada:
-- 1. Buka trades.json
-- 2. Convert ke CSV atau pakai script import di bawah
-- (script terpisah: importTrades.js)

-- ═══════════════════════════════════════════════════════════
--  SELESAI — Cek di Table Editor, harusnya ada:
--  - Table: trades, signals
--  - View:  win_stats_by_symbol, recent_trades
-- ═══════════════════════════════════════════════════════════

-- Leaderboard schema for 借用凱達格蘭大道大作戰.
-- Apply: npx wrangler d1 execute no-party-leaderboard --file=schema.sql [--local|--remote]

-- A run is opened when the player presses 開始計時; the server's clock is the source of truth.
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,          -- server epoch ms
  ip_hash     TEXT,                      -- salted SHA-256, never the raw IP
  finished    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_ip_started ON runs (ip_hash, started_at);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);  -- cleanup without a full scan

CREATE TABLE IF NOT EXISTS scores (
  id          TEXT PRIMARY KEY,          -- same id as the run
  player      TEXT NOT NULL,
  time_ms     INTEGER NOT NULL,          -- server-measured duration
  penalty_ms  INTEGER NOT NULL,
  errors      INTEGER NOT NULL,
  total_ms    INTEGER NOT NULL,          -- time_ms + penalty_ms (ranking key)
  created_at  INTEGER NOT NULL,
  seed        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS scores_total ON scores (total_ms, created_at);

-- D1 bills every scanned row, so never COUNT(*) the scores table on a request path.
-- Total count lives in `stats`; rank = SUM over 100 ms buckets faster than yours
-- + an index range scan inside your own bucket.
CREATE TABLE IF NOT EXISTS stats (
  key    TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS score_buckets (
  bucket INTEGER PRIMARY KEY,           -- floor(total_ms / 100)
  n      INTEGER NOT NULL
);

-- The record everyone competes against.
INSERT OR IGNORE INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed)
VALUES ('seed-wanna-talk', 'Say Goodnight', 350, 0, 0, 350, 1795651200000, 1);

-- Initialise counters from existing rows (no-op when they already exist).
INSERT OR IGNORE INTO stats (key, value) SELECT 'total', COUNT(*) FROM scores;
INSERT OR IGNORE INTO score_buckets (bucket, n) SELECT total_ms / 100, COUNT(*) FROM scores GROUP BY total_ms / 100;

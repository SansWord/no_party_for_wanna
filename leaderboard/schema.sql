-- Leaderboard schema for 借用凱達格蘭大道大作戰.
-- Fresh database: npx wrangler d1 execute no-party-leaderboard --file=schema.sql [--local|--remote]
-- Existing database created before divisions: apply migrations/0002_divisions.sql instead.

-- Legacy: runs opened before stateless run tokens. New runs are not stored here; the table can be
-- dropped once no pre-token runs remain unfinished (they expire after an hour).
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
  seed        INTEGER NOT NULL DEFAULT 0,
  division    INTEGER NOT NULL DEFAULT 0,  -- 0 人類組, 1 至尊組 (see migrations/0002_divisions.sql)
  flags       INTEGER NOT NULL DEFAULT 0,  -- 1 under 20 s, 2 errors/penalty mismatch, 4 not from a browser page
  client      INTEGER                      -- 1 browser, 0 not, NULL unknown (pre-signal records)
);
CREATE INDEX IF NOT EXISTS scores_total ON scores (total_ms, created_at);
CREATE INDEX IF NOT EXISTS scores_div ON scores (division, total_ms, created_at);

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

-- Coarse 5 s buckets on top of the 100 ms ones: rank reads ≤ ~170 rows at any board size.
CREATE TABLE IF NOT EXISTS score_buckets_coarse (
  bucket INTEGER PRIMARY KEY,           -- floor(total_ms / 5000)
  n      INTEGER NOT NULL
);

-- Per-division rank counters (what the Worker maintains). The division-less tables above are
-- legacy and no longer updated.
CREATE TABLE IF NOT EXISTS score_buckets_div (
  division INTEGER NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (division, bucket)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS score_buckets_coarse_div (
  division INTEGER NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (division, bucket)
) WITHOUT ROWID;

-- The record everyone competes against.
INSERT OR IGNORE INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed, division, flags)
VALUES ('seed-wanna-talk', 'Say Goodnight', 350, 0, 0, 350, 1795651200000, 1, 1, 1);
-- Say Goodnight leads both divisions: a second seed row labelled 人類組 (exempt from flags).
INSERT OR IGNORE INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed, division, flags)
VALUES ('seed-wanna-talk-human', 'Say Goodnight', 350, 0, 0, 350, 1795651200000, 1, 0, 0);


-- Initialise counters from existing rows (no-op when they already exist).
INSERT OR IGNORE INTO stats (key, value) SELECT 'total', COUNT(*) FROM scores;
INSERT OR IGNORE INTO score_buckets (bucket, n) SELECT total_ms / 100, COUNT(*) FROM scores GROUP BY total_ms / 100;
INSERT OR IGNORE INTO score_buckets_coarse (bucket, n) SELECT total_ms / 5000, COUNT(*) FROM scores GROUP BY total_ms / 5000;
INSERT OR IGNORE INTO score_buckets_div (division, bucket, n) SELECT division, total_ms / 100, COUNT(*) FROM scores GROUP BY division, total_ms / 100;
INSERT OR IGNORE INTO score_buckets_coarse_div (division, bucket, n) SELECT division, total_ms / 5000, COUNT(*) FROM scores GROUP BY division, total_ms / 5000;
INSERT OR IGNORE INTO stats (key, value) SELECT 'div0', COUNT(*) FROM scores WHERE division = 0;
INSERT OR IGNORE INTO stats (key, value) SELECT 'div1', COUNT(*) FROM scores WHERE division = 1;

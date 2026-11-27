-- Best-per-nickname boards: one row per (division, nickname) at its best run, with its own rank
-- counters (best_buckets*, stats best0/best1). Idempotent full rebuild from scores: run once
-- before deploying the Worker that maintains it, and once after (picks up runs in between).
-- name_key = lower(player): ASCII-only lowercase, the same as nameKey() in src/logic.js.
CREATE TABLE IF NOT EXISTS best_scores (
  division   INTEGER NOT NULL,
  name_key   TEXT NOT NULL,
  id         TEXT NOT NULL,      -- the run (scores.id) holding the best time
  player     TEXT NOT NULL,      -- nickname as typed in that run
  time_ms    INTEGER NOT NULL,
  penalty_ms INTEGER NOT NULL,
  errors     INTEGER NOT NULL,
  total_ms   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  seed       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (division, name_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS best_rank ON best_scores (division, total_ms, created_at);
CREATE TABLE IF NOT EXISTS best_buckets (
  division INTEGER NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (division, bucket)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS best_buckets_coarse (
  division INTEGER NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (division, bucket)
) WITHOUT ROWID;

DELETE FROM best_scores;
INSERT INTO best_scores (division, name_key, id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed)
SELECT division, lower(player), id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY division, lower(player) ORDER BY total_ms, created_at) AS rn FROM scores
) WHERE rn = 1;
DELETE FROM best_buckets;
INSERT INTO best_buckets (division, bucket, n) SELECT division, total_ms / 100, COUNT(*) FROM best_scores GROUP BY division, total_ms / 100;
DELETE FROM best_buckets_coarse;
INSERT INTO best_buckets_coarse (division, bucket, n) SELECT division, total_ms / 5000, COUNT(*) FROM best_scores GROUP BY division, total_ms / 5000;
INSERT INTO stats (key, value) SELECT 'best0', COUNT(*) FROM best_scores WHERE division = 0 AND true
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO stats (key, value) SELECT 'best1', COUNT(*) FROM best_scores WHERE division = 1 AND true
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

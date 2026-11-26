-- 0002: label-based divisions (人類組 / 至尊組) instead of a pure time cut.
-- Run once:  npx wrangler d1 execute no-party-leaderboard --remote --file=migrations/0002_divisions.sql
-- Then deploy the Worker and run 0002b_resync.sql (re-labels rows the old Worker wrote meanwhile).
--
-- division: 0 = 人類組, 1 = 至尊組.  flags: 1 = under 20 s, 2 = errors/penalty mismatch,
-- 4 = start or finish request not from a browser page.  client: 1 browser, 0 not, NULL unknown
-- (records from before the browser signal existed; judged on time + payload only).

ALTER TABLE scores ADD COLUMN division INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scores ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scores ADD COLUMN client INTEGER;

UPDATE scores SET
  flags = (CASE WHEN total_ms < 20000 THEN 1 ELSE 0 END)
        | (CASE WHEN (errors = 0 AND penalty_ms <> 0)
                  OR (errors > 0 AND (penalty_ms < errors * 2000 OR penalty_ms > errors * 10000)) THEN 2 ELSE 0 END),
  division = CASE WHEN total_ms < 20000
                  OR (errors = 0 AND penalty_ms <> 0)
                  OR (errors > 0 AND (penalty_ms < errors * 2000 OR penalty_ms > errors * 10000)) THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS scores_div ON scores (division, total_ms, created_at);

-- Say Goodnight leads both divisions: a second seed row labelled 人類組 (exempt from flags).
INSERT OR IGNORE INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed, division, flags)
VALUES ('seed-wanna-talk-human', 'Say Goodnight', 350, 0, 0, 350, 1795651200000, 1, 0, 0);


CREATE TABLE IF NOT EXISTS score_buckets_div (
  division INTEGER NOT NULL,
  bucket   INTEGER NOT NULL,             -- floor(total_ms / 100)
  n        INTEGER NOT NULL,
  PRIMARY KEY (division, bucket)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS score_buckets_coarse_div (
  division INTEGER NOT NULL,
  bucket   INTEGER NOT NULL,             -- floor(total_ms / 5000)
  n        INTEGER NOT NULL,
  PRIMARY KEY (division, bucket)
) WITHOUT ROWID;

DELETE FROM score_buckets_div;
DELETE FROM score_buckets_coarse_div;
INSERT INTO score_buckets_div (division, bucket, n) SELECT division, total_ms / 100, COUNT(*) FROM scores GROUP BY division, total_ms / 100;
INSERT INTO score_buckets_coarse_div (division, bucket, n) SELECT division, total_ms / 5000, COUNT(*) FROM scores GROUP BY division, total_ms / 5000;
INSERT OR REPLACE INTO stats (key, value) VALUES
  ('div0', (SELECT COUNT(*) FROM scores WHERE division = 0)),
  ('div1', (SELECT COUNT(*) FROM scores WHERE division = 1));

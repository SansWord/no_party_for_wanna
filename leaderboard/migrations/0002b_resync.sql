-- 0002b: run right after deploying the division-aware Worker. Rows the old Worker inserted after
-- 0002 have client IS NULL and default labels: label them, then rebuild the division counters
-- from scratch (each statement is a full recompute, so it is safe to re-run).
UPDATE scores SET
  flags = (CASE WHEN total_ms < 20000 THEN 1 ELSE 0 END)
        | (CASE WHEN (errors = 0 AND penalty_ms <> 0)
                  OR (errors > 0 AND (penalty_ms < errors * 2000 OR penalty_ms > errors * 10000)) THEN 2 ELSE 0 END),
  division = CASE WHEN total_ms < 20000
                  OR (errors = 0 AND penalty_ms <> 0)
                  OR (errors > 0 AND (penalty_ms < errors * 2000 OR penalty_ms > errors * 10000)) THEN 1 ELSE 0 END
WHERE client IS NULL AND flags = 0 AND division = 0 AND seed = 0
  AND (total_ms < 20000 OR (errors = 0 AND penalty_ms <> 0)
       OR (errors > 0 AND (penalty_ms < errors * 2000 OR penalty_ms > errors * 10000)));
DELETE FROM score_buckets_div;
DELETE FROM score_buckets_coarse_div;
INSERT INTO score_buckets_div (division, bucket, n) SELECT division, total_ms / 100, COUNT(*) FROM scores GROUP BY division, total_ms / 100;
INSERT INTO score_buckets_coarse_div (division, bucket, n) SELECT division, total_ms / 5000, COUNT(*) FROM scores GROUP BY division, total_ms / 5000;
INSERT OR REPLACE INTO stats (key, value) VALUES
  ('div0', (SELECT COUNT(*) FROM scores WHERE division = 0)),
  ('div1', (SELECT COUNT(*) FROM scores WHERE division = 1));

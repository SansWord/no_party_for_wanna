-- Move the 我是人類123/456/789/ABC scripted runs into 至尊組 (division 1), flag 16.
CREATE TABLE _name_move AS SELECT id, total_ms FROM scores WHERE seed = 0 AND division = 0 AND player IN ('我是人類123','我是人類456','我是人類789','我是人類ABC');
UPDATE score_buckets_div SET n = n - (SELECT COUNT(*) FROM _name_move m WHERE m.total_ms / 100 = score_buckets_div.bucket)
  WHERE division = 0 AND bucket IN (SELECT total_ms / 100 FROM _name_move);
INSERT INTO score_buckets_div (division, bucket, n) SELECT 1, total_ms / 100, COUNT(*) FROM _name_move WHERE true GROUP BY 2
  ON CONFLICT(division, bucket) DO UPDATE SET n = n + excluded.n;
UPDATE score_buckets_coarse_div SET n = n - (SELECT COUNT(*) FROM _name_move m WHERE m.total_ms / 5000 = score_buckets_coarse_div.bucket)
  WHERE division = 0 AND bucket IN (SELECT total_ms / 5000 FROM _name_move);
INSERT INTO score_buckets_coarse_div (division, bucket, n) SELECT 1, total_ms / 5000, COUNT(*) FROM _name_move WHERE true GROUP BY 2
  ON CONFLICT(division, bucket) DO UPDATE SET n = n + excluded.n;
UPDATE stats SET value = value - (SELECT COUNT(*) FROM _name_move) WHERE key = 'div0';
UPDATE stats SET value = value + (SELECT COUNT(*) FROM _name_move) WHERE key = 'div1';
UPDATE scores SET division = 1, flags = flags | 16 WHERE id IN (SELECT id FROM _name_move);
UPDATE scores SET flags = flags | 16 WHERE seed = 0 AND division = 1 AND player IN ('我是人類123','我是人類456','我是人類789','我是人類ABC');
DROP TABLE _name_move;

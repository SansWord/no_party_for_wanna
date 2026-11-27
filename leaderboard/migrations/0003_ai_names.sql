-- Move AI-nicknamed scores into 至尊組 (division 1), flag 8. Generated from isAiName.
CREATE TABLE _ai_move AS SELECT id, total_ms FROM scores WHERE seed = 0 AND division = 0 AND player IN ('Claude','GrokBot','AI','Gemini 4 Neon','克勞低歐普斯','llmmaster','克勞迪','Claude_let_be_a_huma','克勞低參戰人類','克勞低參戰人類XXX','Codex API測試','克勞德','codex_皮炎','如果Claude念克勞低，請問code念','Claude唸克勞德，就像code不唸扣','Claude不唸克勞低，就像code不唸','Claude不唸克勞低，想想code不唸','Claude不唸克勞低，請想想code不','Claude不唸克勞低，想想code怎唸','Grok扮演三姓家奴','ClaudeBot','Claude腳本測試','Claude Opus 5.5','Codex');
UPDATE score_buckets_div SET n = n - (SELECT COUNT(*) FROM _ai_move m WHERE m.total_ms / 100 = score_buckets_div.bucket)
  WHERE division = 0 AND bucket IN (SELECT total_ms / 100 FROM _ai_move);
INSERT INTO score_buckets_div (division, bucket, n) SELECT 1, total_ms / 100, COUNT(*) FROM _ai_move WHERE true GROUP BY 2
  ON CONFLICT(division, bucket) DO UPDATE SET n = n + excluded.n;
UPDATE score_buckets_coarse_div SET n = n - (SELECT COUNT(*) FROM _ai_move m WHERE m.total_ms / 5000 = score_buckets_coarse_div.bucket)
  WHERE division = 0 AND bucket IN (SELECT total_ms / 5000 FROM _ai_move);
INSERT INTO score_buckets_coarse_div (division, bucket, n) SELECT 1, total_ms / 5000, COUNT(*) FROM _ai_move WHERE true GROUP BY 2
  ON CONFLICT(division, bucket) DO UPDATE SET n = n + excluded.n;
UPDATE stats SET value = value - (SELECT COUNT(*) FROM _ai_move) WHERE key = 'div0';
UPDATE stats SET value = value + (SELECT COUNT(*) FROM _ai_move) WHERE key = 'div1';
UPDATE scores SET division = 1, flags = flags | 8 WHERE id IN (SELECT id FROM _ai_move);
UPDATE scores SET flags = flags | 8 WHERE seed = 0 AND division = 1 AND player IN ('Claude','GrokBot','AI','Gemini 4 Neon','克勞低歐普斯','llmmaster','克勞迪','Claude_let_be_a_huma','克勞低參戰人類','克勞低參戰人類XXX','Codex API測試','克勞德','codex_皮炎','如果Claude念克勞低，請問code念','Claude唸克勞德，就像code不唸扣','Claude不唸克勞低，就像code不唸','Claude不唸克勞低，想想code不唸','Claude不唸克勞低，請想想code不','Claude不唸克勞低，想想code怎唸','Grok扮演三姓家奴','ClaudeBot','Claude腳本測試','Claude Opus 5.5','Codex');
DROP TABLE _ai_move;

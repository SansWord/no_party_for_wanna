import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const {
  submitResult, getLeaderboardPage, getHistogram, sampleNames, beginRun, isReservedName, classify, flagReasons,
} = await import('../js/scores.js');

beforeEach(() => store.clear());

// Human-division times start at 20 s.
const rec = (i, ms) => ({ id: `p${i}`, player: `P${i}`, timeMs: ms, penaltyMs: 0, errors: 0 });
const span = (p) => [p.rows[0].rank, p.rows.at(-1).rank];

test('classification: under 20 s or inconsistent payload → 至尊組', () => {
  assert.deepEqual(classify({ timeMs: 19_999, penaltyMs: 0, errors: 0 }), { flags: 1, division: 'supreme' });
  assert.deepEqual(classify({ timeMs: 20_000, penaltyMs: 0, errors: 0 }), { flags: 0, division: 'human' });
  assert.deepEqual(classify({ timeMs: 40_000, penaltyMs: 0, errors: 87 }), { flags: 2, division: 'supreme' });
  assert.deepEqual(classify({ timeMs: 40_000, penaltyMs: 5000, errors: 0 }), { flags: 2, division: 'supreme' });
  assert.deepEqual(classify({ timeMs: 40_000, penaltyMs: 15000, errors: 2 }), { flags: 0, division: 'human' });
  assert.deepEqual(flagReasons(1 | 4), ['完成時間少於 20 秒', '請求不是從遊戲網頁送出']);
  assert.deepEqual(classify({ player: '克勞低參戰人類', timeMs: 40_000, penaltyMs: 0, errors: 0 }), { flags: 8, division: 'supreme' });
  assert.deepEqual(flagReasons(8), ['暱稱表明是 AI 參賽']);
});

test('offline: Say Goodnight (0.35s) leads both 至尊組 and 人類組', async () => {
  for (const division of ['supreme', 'human']) {
    const p = await getLeaderboardPage({ division });
    assert.equal(p.online, false);
    assert.deepEqual(p.rows.map((r) => [r.rank, r.player]), [[1, 'Say Goodnight']]);
    assert.equal(p.rows[0].timeMs + p.rows[0].penaltyMs, 350);
  }
});

test('offline: a finish is ranked inside its own division', async () => {
  assert.equal(await beginRun(), null);
  await submitResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1 }, null);
  const fast = await submitResult({ id: 'b', player: 'B', timeMs: 15_200, penaltyMs: 0, errors: 0 }, null);
  assert.equal(fast.division, 'supreme');
  assert.equal(fast.rank, 2); // behind Say Goodnight
  const human = await submitResult({ id: 'c', player: 'C', timeMs: 30_000, penaltyMs: 0, errors: 0 }, null);
  assert.equal(human.division, 'human');
  assert.equal(human.rank, 2); // behind Say Goodnight, ahead of A (65 s); B is in 至尊組
  assert.deepEqual(human.page.rows.map((r) => r.player), ['Say Goodnight', 'C', 'A']);
  const forged = await submitResult({ id: 'd', player: 'D', timeMs: 40_000, penaltyMs: 0, errors: 87 }, null);
  assert.deepEqual([forged.division, forged.flags], ['supreme', 2]);
});

test('offline: paging walks a division 10 at a time, both directions', async () => {
  for (let i = 0; i < 24; i++) await submitResult(rec(i, 20_000 + i * 1000), null); // + seed = 25
  const p1 = await getLeaderboardPage({ division: 'human' });
  assert.deepEqual([...span(p1), p1.total], [1, 10, 25]);
  const p2 = await getLeaderboardPage({ division: 'human', after: p1.next });
  assert.deepEqual(span(p2), [11, 20]);
  const p3 = await getLeaderboardPage({ division: 'human', after: p2.next });
  assert.deepEqual([...span(p3), p3.next], [21, 25, null]);
  const back = await getLeaderboardPage({ division: 'human', before: p3.prev });
  assert.deepEqual(span(back), [11, 20]);
  assert.equal(new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).size, 25);
  const last = await getLeaderboardPage({ division: 'human', last: true });
  assert.deepEqual(span(last), [21, 25]);
});

test('offline: result page is the aligned page containing the record (rank 33 → 31–40)', async () => {
  for (let i = 0; i < 40; i++) await submitResult(rec(i, 20_000 + i * 1000), null);
  const page = await getLeaderboardPage({ division: 'human', around: 'p31' }); // rank 33 (seed is #1)
  assert.ok(page.rows.some((r) => r.id === 'p31' && r.rank === 33));
  assert.deepEqual(span(page), [31, 40]);
});

test('offline: histogram bins by 5 s and samples names from a range', async () => {
  await submitResult(rec(1, 15_100), null);
  await submitResult(rec(2, 15_900), null);
  await submitResult(rec(3, 42_000), null);
  const h = await getHistogram();
  assert.equal(h.total, 4);
  assert.deepEqual(h.bins.map((b) => [b.fromMs, b.n, b.human, b.supreme]), [[0, 1, 0, 1], [15_000, 2, 0, 2], [40_000, 1, 1, 0]]);
  assert.equal(h.record.player, 'Say Goodnight');
  const s = await sampleNames(15_000, 20_000);
  assert.deepEqual(s.names.sort(), ['P1', 'P2']);
});

test('Say Goodnight is a reserved nickname', () => {
  assert.ok(isReservedName(' say   GOODNIGHT '));
  assert.ok(!isReservedName('Say Goodnights'));
});

test('offline: a division board lists each nickname once, at its best', async () => {
  await submitResult({ id: 'w1', player: 'weich', timeMs: 30_000, penaltyMs: 0, errors: 0 }, null);
  const better = await submitResult({ id: 'w2', player: 'Weich', timeMs: 25_000, penaltyMs: 0, errors: 0 }, null);
  assert.deepEqual([better.improved, better.rank, better.total], [true, 2, 2]);
  const slower = await submitResult({ id: 'w3', player: 'weich', timeMs: 40_000, penaltyMs: 0, errors: 0 }, null);
  assert.deepEqual([slower.improved, slower.best.id, slower.rank, slower.total], [false, 'w2', 2, 2]);
  assert.deepEqual(slower.page.rows.map((r) => r.id), ['seed-wanna-talk', 'w2']);
  const h = await getHistogram();
  assert.equal(h.total, 4); // the histogram still counts every run (+ seed)
});

test('offline: jump straight to page n (clamped to the last page)', async () => {
  for (let i = 0; i < 24; i++) await submitResult(rec(i, 20_000 + i * 1000), null); // + seed = 25
  assert.deepEqual(span(await getLeaderboardPage({ division: 'human', page: 2 })), [11, 20]);
  assert.deepEqual(span(await getLeaderboardPage({ division: 'human', page: 99 })), [21, 25]);
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { submitResult, getLeaderboardPage, beginRun, isReservedName } = await import('../js/scores.js');

beforeEach(() => store.clear());

const rec = (i, ms) => ({ id: `p${i}`, player: `P${i}`, timeMs: ms, penaltyMs: 0, errors: 0 });

test('offline: Say Goodnight (0.35s) is always on the board', async () => {
  const page = await getLeaderboardPage();
  assert.equal(page.online, false);
  assert.equal(page.total, 1);
  assert.deepEqual(page.rows.map((r) => [r.rank, r.player]), [[1, 'Say Goodnight']]);
  assert.equal(page.rows[0].timeMs + page.rows[0].penaltyMs, 350);
  assert.equal(page.prev, null);
  assert.equal(page.next, null);
});

test('offline: players rank against the seed by penalty-inclusive time', async () => {
  assert.equal(await beginRun(), null);
  await submitResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1 }, null);
  const res = await submitResult({ id: 'b', player: 'B', timeMs: 200, penaltyMs: 0, errors: 0 }, null);
  assert.equal(res.rank, 1);
  assert.deepEqual(res.page.rows.map((r) => r.player), ['B', 'Say Goodnight', 'A']);
});

test('offline: paging walks the whole board 10 at a time, both directions', async () => {
  for (let i = 0; i < 24; i++) await submitResult(rec(i, 10_000 + i * 1000), null); // 25 rows incl. seed
  const p1 = await getLeaderboardPage();
  assert.deepEqual([p1.rows[0].rank, p1.rows.at(-1).rank, p1.total], [1, 10, 25]);
  const p2 = await getLeaderboardPage({ after: p1.next });
  assert.deepEqual([p2.rows[0].rank, p2.rows.at(-1).rank], [11, 20]);
  const p3 = await getLeaderboardPage({ after: p2.next });
  assert.deepEqual([p3.rows[0].rank, p3.rows.at(-1).rank, p3.next], [21, 25, null]);
  const back = await getLeaderboardPage({ before: p3.prev });
  assert.deepEqual([back.rows[0].rank, back.rows.at(-1).rank], [11, 20]);
  const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
  assert.equal(new Set(seen).size, 25);
});

test('offline: result page is the aligned page containing the new record', async () => {
  for (let i = 0; i < 30; i++) await submitResult(rec(i, 10_000 + i * 1000), null);
  const res = await submitResult(rec(99, 25_500), null); // between P15 and P16 → rank 18
  assert.equal(res.rank, 18);
  assert.ok(res.page.rows.some((r) => r.id === 'p99' && r.rank === 18));
  assert.deepEqual([res.page.rows[0].rank, res.page.rows.at(-1).rank], [11, 20]);
  // Paging on from there stays aligned.
  const next = await getLeaderboardPage({ after: res.page.next });
  assert.deepEqual([next.rows[0].rank, next.rows.at(-1).rank], [21, 30]);
  const prev = await getLeaderboardPage({ before: res.page.prev });
  assert.deepEqual([prev.rows[0].rank, prev.rows.at(-1).rank], [1, 10]);
});

test('offline: rank 33 lands on page 31–40', async () => {
  for (let i = 0; i < 39; i++) await submitResult(rec(i, 10_000 + i * 1000), null); // ranks 2..40
  const page = await getLeaderboardPage({ around: 'p31' }); // p31 is rank 33
  assert.ok(page.rows.some((r) => r.id === 'p31' && r.rank === 33));
  assert.deepEqual([page.rows[0].rank, page.rows.at(-1).rank], [31, 40]);
});

test('offline: last page is aligned (39 records → 31–39)', async () => {
  for (let i = 0; i < 38; i++) await submitResult(rec(i, 10_000 + i * 1000), null);
  const last = await getLeaderboardPage({ last: true });
  assert.deepEqual([last.rows[0].rank, last.rows.at(-1).rank, last.next], [31, 39, null]);
  const prev = await getLeaderboardPage({ before: last.prev });
  assert.deepEqual([prev.rows[0].rank, prev.rows.at(-1).rank], [21, 30]);
});

test('Say Goodnight is a reserved nickname', () => {
  assert.ok(isReservedName(' say   GOODNIGHT '));
  assert.ok(!isReservedName('Say Goodnights'));
});

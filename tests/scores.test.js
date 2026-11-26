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

test('offline: Wanna Talk (0.33s) is always on the board', async () => {
  const page = await getLeaderboardPage();
  assert.equal(page.online, false);
  assert.equal(page.total, 1);
  assert.deepEqual(page.rows.map((r) => [r.rank, r.player]), [[1, 'Wanna Talk']]);
  assert.equal(page.prev, null);
  assert.equal(page.next, null);
});

test('offline: players rank against the seed by penalty-inclusive time', async () => {
  assert.equal(await beginRun(), null);
  await submitResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1 }, null);
  const res = await submitResult({ id: 'b', player: 'B', timeMs: 200, penaltyMs: 0, errors: 0 }, null);
  assert.equal(res.rank, 1);
  assert.deepEqual(res.page.rows.map((r) => r.player), ['B', 'Wanna Talk', 'A']);
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

test('offline: result page is centred on the new record', async () => {
  for (let i = 0; i < 30; i++) await submitResult(rec(i, 10_000 + i * 1000), null);
  const res = await submitResult(rec(99, 25_500), null); // between P15 and P16 → rank 18
  assert.equal(res.rank, 18);
  assert.ok(res.page.rows.some((r) => r.id === 'p99' && r.rank === 18));
  assert.equal(res.page.rows[0].rank, 14);
});

test('Wanna Talk is a reserved nickname', () => {
  assert.ok(isReservedName(' wanna   TALK '));
  assert.ok(!isReservedName('Wanna Talker'));
});

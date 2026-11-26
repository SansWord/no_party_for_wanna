import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const {
  submitResult, getLeaderboardPage, getHistogram, sampleNames, beginRun, isReservedName, divisionOf,
} = await import('../js/scores.js');

beforeEach(() => store.clear());

// Human-division times start at 20 s.
const rec = (i, ms) => ({ id: `p${i}`, player: `P${i}`, timeMs: ms, penaltyMs: 0, errors: 0 });
const span = (p) => [p.rows[0].rank, p.rows.at(-1).rank];

test('divisions split at 20 s', () => {
  assert.equal(divisionOf(350), 'supreme');
  assert.equal(divisionOf(19_999), 'supreme');
  assert.equal(divisionOf(20_000), 'human');
});

test('offline: Say Goodnight (0.35s) leads 至尊組; 人類組 starts empty', async () => {
  const sup = await getLeaderboardPage({ division: 'supreme' });
  assert.equal(sup.online, false);
  assert.deepEqual(sup.rows.map((r) => [r.rank, r.player]), [[1, 'Say Goodnight']]);
  assert.equal(sup.rows[0].timeMs + sup.rows[0].penaltyMs, 350);
  const hum = await getLeaderboardPage({ division: 'human' });
  assert.equal(hum.total, 0);
});

test('offline: a finish is ranked inside its own division', async () => {
  assert.equal(await beginRun(), null);
  await submitResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1 }, null);
  const fast = await submitResult({ id: 'b', player: 'B', timeMs: 15_200, penaltyMs: 0, errors: 0 }, null);
  assert.equal(fast.division, 'supreme');
  assert.equal(fast.rank, 2); // behind Say Goodnight
  const human = await submitResult({ id: 'c', player: 'C', timeMs: 30_000, penaltyMs: 0, errors: 0 }, null);
  assert.equal(human.division, 'human');
  assert.equal(human.rank, 1); // ahead of A (65 s); B and the seed are in 至尊組
  assert.deepEqual(human.page.rows.map((r) => r.player), ['C', 'A']);
});

test('offline: paging walks a division 10 at a time, both directions', async () => {
  for (let i = 0; i < 25; i++) await submitResult(rec(i, 20_000 + i * 1000), null);
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
  const page = await getLeaderboardPage({ division: 'human', around: 'p32' }); // rank 33
  assert.ok(page.rows.some((r) => r.id === 'p32' && r.rank === 33));
  assert.deepEqual(span(page), [31, 40]);
});

test('offline: histogram bins by 5 s and samples names from a range', async () => {
  await submitResult(rec(1, 15_100), null);
  await submitResult(rec(2, 15_900), null);
  await submitResult(rec(3, 42_000), null);
  const h = await getHistogram();
  assert.equal(h.total, 4);
  assert.deepEqual(h.bins.map((b) => [b.fromMs, b.n]), [[0, 1], [15_000, 2], [40_000, 1]]);
  assert.equal(h.record.player, 'Say Goodnight');
  const s = await sampleNames(15_000, 20_000);
  assert.deepEqual(s.names.sort(), ['P1', 'P2']);
});

test('Say Goodnight is a reserved nickname', () => {
  assert.ok(isReservedName(' say   GOODNIGHT '));
  assert.ok(!isReservedName('Say Goodnights'));
});

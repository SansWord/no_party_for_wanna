import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { submitResult, getLeaderboard, beginRun, isReservedName } = await import('../js/scores.js');

beforeEach(() => store.clear());

test('offline: Wanna Talk (0.33s) is always on the board', async () => {
  const board = await getLeaderboard();
  assert.equal(board.online, false);
  assert.equal(board.total, 1);
  assert.equal(board.top[0].player, 'Wanna Talk');
  assert.equal(board.top[0].timeMs + board.top[0].penaltyMs, 330);
});

test('offline: players rank against the seed by penalty-inclusive time', async () => {
  assert.equal(await beginRun(), null);
  await submitResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1 }, null);
  const res = await submitResult({ id: 'b', player: 'B', timeMs: 200, penaltyMs: 0, errors: 0 }, null);
  assert.equal(res.online, false);
  assert.equal(res.rank, 1);
  assert.deepEqual(res.top.map((r) => r.player), ['B', 'Wanna Talk', 'A']);
});

test('Wanna Talk is a reserved nickname', () => {
  assert.ok(isReservedName(' wanna   TALK '));
  assert.ok(!isReservedName('Wanna Talker'));
});

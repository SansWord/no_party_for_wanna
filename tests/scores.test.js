import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { saveResult, getRankedResults } = await import('../js/scores.js');

beforeEach(() => store.clear());

test('Wanna Talk (0.33s) is always on the board, even with no local runs', async () => {
  const ranked = await getRankedResults();
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].player, 'Wanna Talk');
  assert.equal(ranked[0].timeMs + ranked[0].penaltyMs, 330);
});

test('players rank against the seed record by penalty-inclusive time', async () => {
  await saveResult({ id: 'a', player: 'A', timeMs: 60000, penaltyMs: 5000, errors: 1, success: true });
  await saveResult({ id: 'b', player: 'B', timeMs: 200, penaltyMs: 0, errors: 0, success: true });
  const names = (await getRankedResults()).map((r) => r.player);
  assert.deepEqual(names, ['B', 'Wanna Talk', 'A']);
});

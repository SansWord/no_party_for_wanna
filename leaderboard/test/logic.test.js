import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlayer, isReservedName, validateFinish, corsOrigin, clampLimit, bucketOf } from '../src/logic.js';

test('sanitizePlayer trims, strips control chars, caps at 20 code points', () => {
  assert.equal(sanitizePlayer('  凱道\u0000快手  '), '凱道快手');
  assert.equal(sanitizePlayer('a‮b'), 'ab');
  assert.equal(sanitizePlayer('x'.repeat(30)).length, 20);
  assert.equal([...sanitizePlayer('🚀'.repeat(30))].length, 20);
  assert.equal(sanitizePlayer('   '), '匿名');
  assert.equal(sanitizePlayer(undefined), '匿名');
});

test('Wanna Talk is reserved in any casing/spacing', () => {
  assert.ok(isReservedName('Wanna Talk'));
  assert.ok(isReservedName('  wanna   TALK '));
  assert.ok(!isReservedName('Wanna Talk 2'));
});

test('validateFinish enforces server time window and sane penalties', () => {
  const base = { elapsedMs: 60_000, player: '玩家', penaltyMs: 5000, errors: 1 };
  assert.deepEqual(validateFinish(base), {
    ok: true, value: { player: '玩家', timeMs: 60_000, penaltyMs: 5000, errors: 1, totalMs: 65_000 },
  });
  assert.equal(validateFinish({ ...base, elapsedMs: 3000 }).error, 'too_fast');
  assert.equal(validateFinish({ ...base, elapsedMs: 4_000_000 }).error, 'expired');
  assert.equal(validateFinish({ ...base, penaltyMs: 1500 }).error, 'bad_penalty');
  assert.equal(validateFinish({ ...base, penaltyMs: -1000 }).error, 'bad_penalty');
  assert.equal(validateFinish({ ...base, errors: 1.5 }).error, 'bad_errors');
  assert.equal(validateFinish({ ...base, player: 'wanna talk' }).error, 'name_reserved');
});

test('CORS only echoes allowed origins', () => {
  const allowed = 'https://sansword.github.io, http://localhost:8080';
  assert.equal(corsOrigin('http://localhost:8080', allowed), 'http://localhost:8080');
  assert.equal(corsOrigin('https://evil.example', allowed), null);
  assert.equal(corsOrigin(null, allowed), null);
});

test('clampLimit', () => {
  assert.equal(clampLimit('5'), 5);
  assert.equal(clampLimit('999'), 50);
  assert.equal(clampLimit('nope'), 10);
});

test('bucketOf groups totals into 100 ms buckets', () => {
  assert.equal(bucketOf(330), 3);
  assert.equal(bucketOf(65_099), 650);
  assert.equal(bucketOf(65_100), 651);
});

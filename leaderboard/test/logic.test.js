import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlayer, isReservedName, validateFinish, corsOrigin, clampLimit, bucketOf, encodeCursor, decodeCursor } from '../src/logic.js';

test('sanitizePlayer trims, strips control chars, caps at 20 code points', () => {
  assert.equal(sanitizePlayer('  凱道\u0000快手  '), '凱道快手');
  assert.equal(sanitizePlayer('a‮b'), 'ab');
  assert.equal(sanitizePlayer('x'.repeat(30)).length, 20);
  assert.equal([...sanitizePlayer('🚀'.repeat(30))].length, 20);
  assert.equal(sanitizePlayer('   '), '匿名');
  assert.equal(sanitizePlayer(undefined), '匿名');
});

test('Say Goodnight is reserved in any casing/spacing', () => {
  assert.ok(isReservedName('Say Goodnight'));
  assert.ok(isReservedName('  say   GOODNIGHT '));
  assert.ok(!isReservedName('Say Goodnight 2'));
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
  assert.equal(validateFinish({ ...base, player: 'say goodnight' }).error, 'name_reserved');
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

test('cursor round-trips and rejects junk', () => {
  const c = encodeCursor({ total_ms: 65000, created_at: 1795651200000 }, 12);
  assert.equal(c, '65000_1795651200000_12');
  assert.deepEqual(decodeCursor(c), { totalMs: 65000, createdAt: 1795651200000, rank: 12 });
  for (const bad of ['', 'x', '1_2', '1_2_0', '1_2_3;DROP', null, undefined]) assert.equal(decodeCursor(bad), null);
});

import { signRunToken, verifyRunToken, coarseOf, parseBody, LEGACY_RUN_RE } from '../src/logic.js';

test('run tokens verify, and tampering or a wrong secret fails', async () => {
  const id = '0f8c2a6e-1b2c-4d3e-8f90-123456789abc';
  const t = await signRunToken('s3cret', id, 1795700000000);
  assert.deepEqual(await verifyRunToken('s3cret', t), { runId: id, startedAt: 1795700000000 });
  assert.equal(await verifyRunToken('other', t), null);
  const later = t.replace('.1795700000000.', '.1795700099999.'); // move the start time
  assert.equal(await verifyRunToken('s3cret', later), null);
  assert.equal(await verifyRunToken('s3cret', id), null);        // legacy UUID is not a token
  assert.equal(await verifyRunToken('s3cret', 'x.y.z'), null);
  assert.equal(await verifyRunToken('', t), null);
  assert.ok(LEGACY_RUN_RE.test(id));
});

test('coarse buckets are 5 s', () => {
  assert.equal(coarseOf(350), 0);
  assert.equal(coarseOf(64_999), 12);
  assert.equal(coarseOf(65_000), 13);
});

test('parseBody accepts JSON text and rejects junk', () => {
  assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseBody(''), {});
  assert.equal(parseBody('nope'), null);
  assert.equal(parseBody('3'), null);
});

import { SUPREME_MS, SUPREME_COARSE, parseDivision, divisionOf, parseRange } from '../src/logic.js';

test('divisions split at 20 s on a coarse-bucket boundary', () => {
  assert.equal(SUPREME_MS % 5000, 0);
  assert.equal(SUPREME_COARSE, 4);
  assert.equal(divisionOf(350), 'supreme');
  assert.equal(divisionOf(19_999), 'supreme');
  assert.equal(divisionOf(20_000), 'human');
  assert.equal(parseDivision('human'), 'human');
  assert.equal(parseDivision('x'), null);
  assert.deepEqual(parseRange('15000', '20000'), { from: 15000, to: 20000 });
  assert.equal(parseRange('20000', '15000'), null);
  assert.equal(parseRange('a', '1'), null);
});

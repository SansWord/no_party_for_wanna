// Cloudflare Worker: online leaderboard for 借用凱達格蘭大道大作戰.
//
//   POST /api/runs                → { runId }   (player pressed 開始計時; runId is a signed token)
//   POST /api/runs/:token/finish  → { record, rank, division, flags, total, page }
//   GET  /api/leaderboard         → page: first page, or ?after=<cursor> / ?before=<cursor> /
//                                   ?around=<id> / ?last=1; optional &division=human|supreme
//   GET  /api/histogram           → { bins: [{ fromMs, toMs, n, human, supreme }], total, record }
//   GET  /api/histogram/sample    → ?from=<ms>&to=<ms> → { names } (≈5 random nicknames)
//
// Divisions are labels stored on each score (scores.division): a run is 人類組 (0) only if no
// flag applies, otherwise 至尊組 (1). Flags: under 20 s, an errors/penalty combination the game
// can't produce, a start/finish request that didn't come from a browser page, or an AI nickname (see
// classifyRun in logic.js). Without `division` the leaderboard is global (cached old clients).
//
// A page is { total, rows: [{ rank, ... }], prev, next } with keyset cursors, so every page
// reads only `limit` rows from an index (no OFFSET, which D1 would bill row by row). Ranks in a
// division page are ranks within that division.
//
// The server measures the run time (finish − start), so a client can't just post a fake time.
//
// Cost notes (D1 bills rows read/written, indexes included):
//  - Starting a run writes nothing: the start time (and the start request's browser signal)
//    travel in an HMAC-signed token; scores.id = runId (PRIMARY KEY) makes it finishable once.
//    Rate limiting uses the Workers rate-limit binding.
//  - Ranks use per-division 5 s + 100 ms bucket tables, so they read a bounded number of rows;
//    division sizes live in stats rows div0/div1.
//  - Request bodies are text/plain, so browsers skip the CORS preflight request.
//  - Spend guard: a stats row per Taiwan day counts new scores; past DAILY_SCORE_CAP the finish
//    is refused (503 daily_cap) and the game keeps the score on the device.
// Legacy: runs created by the old start endpoint (bare UUIDs in the runs table) still finish.

import {
  validateFinish, corsOrigin, clampLimit, bucketOf, coarseOf, BUCKET_MS, COARSE_MS, FINE_PER_COARSE,
  encodeCursor, decodeCursor, signRunToken, verifyRunToken, parseBody, LEGACY_RUN_RE, parseRange,
  browserSignal, classifyRun, DIV_HUMAN, DIV_SUPREME, DIVISION_NAME, divisionIndex, dayKey, dailyCap,
} from './logic.js';

const TOP_N = 10;
// Say Goodnight is seeded twice (one row per division) so it leads both boards. Views spanning
// both divisions (histogram, the global board for cached old clients) skip the 人類組 copy.
const SEED_HUMAN_ID = 'seed-wanna-talk-human';
const BOARD_CACHE_MS = 10_000;
const HISTOGRAM_CACHE_MS = 30_000;
const SAMPLE_SIZE = 5;
const boardCache = new Map(); // per-isolate cache of first pages: key `${division}:${limit}` → { at, body }
let histogramCache = null;     // { at, body }
let capReachedDay = null;      // dayKey once this isolate has seen the daily cap hit (skips D1)

export default {
  async fetch(request, env) {
    const origin = corsOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
    const cors = {
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Browsers from other sites are refused; non-browser clients have no Origin and are allowed
    // (the server-side clock still applies to them, and they land in 至尊組).
    if (request.headers.get('Origin') && !origin) return json({ error: 'origin_not_allowed' }, 403);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const q = url.searchParams;

    try {
      if (request.method === 'GET' && path === '/api/leaderboard') {
        const limit = clampLimit(q.get('limit'), TOP_N);
        const division = divisionIndex(q.get('division'));
        if (q.has('after') || q.has('before')) {
          const cursor = decodeCursor(q.get('after') ?? q.get('before'));
          if (!cursor) return json({ error: 'bad_cursor' }, 400);
          const div = await divisionInfo(env, division);
          return json(await pageFrom(env, cursor, q.has('after') ? 'after' : 'before', limit, div));
        }
        if (q.has('around')) return json(await pageAround(env, q.get('around'), limit, division));
        if (q.has('last')) return json(await lastPage(env, limit, await divisionInfo(env, division)));
        const key = `${division}:${limit}`;
        const hit = boardCache.get(key);
        if (hit && Date.now() - hit.at < BOARD_CACHE_MS) return json(hit.body);
        const body = await firstPage(env, limit, await divisionInfo(env, division));
        boardCache.set(key, { at: Date.now(), body });
        return json(body);
      }

      if (request.method === 'GET' && path === '/api/histogram') {
        if (!histogramCache || Date.now() - histogramCache.at > HISTOGRAM_CACHE_MS) {
          histogramCache = { at: Date.now(), body: await histogram(env) };
        }
        return json(histogramCache.body);
      }

      if (request.method === 'GET' && path === '/api/histogram/sample') {
        const range = parseRange(q.get('from'), q.get('to'));
        if (!range) return json({ error: 'bad_range' }, 400);
        return json(await sampleNames(env, range));
      }

      if (request.method === 'POST' && path === '/api/runs') {
        if (env.START_LIMITER) {
          const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || 'unknown', env.IP_SALT || '');
          const { success } = await env.START_LIMITER.limit({ key: ipHash });
          if (!success) return json({ error: 'rate_limited' }, 429);
        }
        const browser = browserSignal(request.headers, !!origin);
        const runId = await signRunToken(env.RUN_SECRET, crypto.randomUUID(), Date.now(), browser);
        return json({ runId }, 201);
      }

      const m = path.match(/^\/api\/runs\/([A-Za-z0-9._-]{36,130})\/finish$/);
      if (request.method === 'POST' && m) {
        const now = Date.now();
        const body = parseBody(await request.text());
        if (!body) return json({ error: 'bad_json' }, 400);

        let runId;
        let startedAt;
        let startBrowser = null; // unknown for tokens issued before the signal and for legacy runs
        const token = await verifyRunToken(env.RUN_SECRET, m[1]);
        if (token) {
          ({ runId, startedAt } = token);
          startBrowser = token.browser;
        } else if (LEGACY_RUN_RE.test(m[1])) {
          // Run opened before stateless tokens: claim it in the runs table, as before.
          const claim = await env.DB.prepare('UPDATE runs SET finished = 1 WHERE id = ? AND finished = 0 RETURNING started_at')
            .bind(m[1]).first();
          if (!claim) return json({ error: 'unknown_or_finished_run' }, 404);
          runId = m[1];
          startedAt = claim.started_at;
        } else {
          return json({ error: 'unknown_or_finished_run' }, 404);
        }

        const check = validateFinish({
          elapsedMs: now - startedAt,
          player: body.player,
          penaltyMs: body.penaltyMs,
          errors: body.errors,
        });
        if (!check.ok) return json({ error: check.error }, 422);
        const r = check.value;

        // Daily spend guard, checked before any score row is written.
        const day = dayKey(now);
        if (capReachedDay === day) return json({ error: 'daily_cap' }, 503);
        const counted = await env.DB.prepare(
          'INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value',
        ).bind(day).first();
        if (counted.value > dailyCap(env.DAILY_SCORE_CAP)) {
          capReachedDay = day;
          return json({ error: 'daily_cap' }, 503);
        }

        const browser = browserSignal(request.headers, !!origin) && startBrowser !== false;
        const { flags, division } = classifyRun({ totalMs: r.totalMs, errors: r.errors, penaltyMs: r.penaltyMs, browser, player: r.player });

        try {
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at, division, flags, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).bind(runId, r.player, r.timeMs, r.penaltyMs, r.errors, r.totalMs, now, division, flags, browser ? 1 : 0),
            env.DB.prepare('UPDATE stats SET value = value + 1 WHERE key = ?').bind(`div${division}`),
            env.DB.prepare('INSERT INTO score_buckets_div (division, bucket, n) VALUES (?, ?, 1) ON CONFLICT(division, bucket) DO UPDATE SET n = n + 1')
              .bind(division, bucketOf(r.totalMs)),
            env.DB.prepare('INSERT INTO score_buckets_coarse_div (division, bucket, n) VALUES (?, ?, 1) ON CONFLICT(division, bucket) DO UPDATE SET n = n + 1')
              .bind(division, coarseOf(r.totalMs)),
          ]);
        } catch (err) {
          // scores.id is the PRIMARY KEY: a second finish with the same token is rejected (batch rolls back).
          if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message ?? err))) {
            return json({ error: 'unknown_or_finished_run' }, 404);
          }
          throw err;
        }

        boardCache.clear();
        const div = await divisionInfo(env, division);
        const rank = (await countFaster(env, division, r.totalMs, now)) + 1;
        const page = await pageAroundRow(env, { total_ms: r.totalMs, created_at: now }, rank, TOP_N, div);
        return json({
          record: { id: runId, ...r },
          rank,
          division: DIVISION_NAME[division],
          flags,
          total: div.total,
          page,
          top: page.rows, // keeps pre-pagination clients (cached pages) rendering a board
        }, 201);
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

const COLS = 'id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed, division';

async function divisionTotals(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM stats WHERE key IN ('div0', 'div1')").all();
  const t = [0, 0];
  for (const row of results) t[row.key === 'div1' ? 1 : 0] = row.value;
  return t;
}

/**
 * How to query a division: SQL filter + binds, and its size. null = the whole board, ordered by
 * the global (total_ms, created_at) index for cached clients that don't send a division.
 */
async function divisionInfo(env, division) {
  const [d0, d1] = await divisionTotals(env);
  if (division == null) return { where: 'id <> ?', binds: [SEED_HUMAN_ID], division: null, total: d0 + d1 - 1 };
  return { where: 'division = ?', binds: [division], division, total: division === DIV_HUMAN ? d0 : d1 };
}

/**
 * Rows in `division` that rank ahead of (totalMs, createdAt), without scanning the table:
 * Σ 5 s buckets below + Σ 100 ms buckets below within our 5 s bucket + an index range inside our
 * own 100 ms bucket. One round trip via batch.
 */
async function countFaster(env, division, totalMs, createdAt) {
  const fine = bucketOf(totalMs);
  const coarse = coarseOf(totalMs);
  const [a, b, c] = await env.DB.batch([
    env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS s FROM score_buckets_coarse_div WHERE division = ? AND bucket < ?')
      .bind(division, coarse),
    env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS s FROM score_buckets_div WHERE division = ? AND bucket >= ? AND bucket < ?')
      .bind(division, coarse * FINE_PER_COARSE, fine),
    env.DB.prepare('SELECT COUNT(*) AS s FROM scores WHERE division = ? AND total_ms >= ? AND (total_ms, created_at) < (?, ?)')
      .bind(division, fine * BUCKET_MS, totalMs, createdAt),
  ]);
  return a.results[0].s + b.results[0].s + c.results[0].s;
}

async function rowsAfter(env, key, limit, div, inclusive = false) {
  const op = inclusive ? '>=' : '>';
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE ${div.where} AND (total_ms, created_at) ${op} (?, ?) ORDER BY total_ms, created_at LIMIT ?`,
  ).bind(...div.binds, key.total_ms, key.created_at, limit).all();
  return results;
}

async function rowsBefore(env, key, limit, div) {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE ${div.where} AND (total_ms, created_at) < (?, ?) ORDER BY total_ms DESC, created_at DESC LIMIT ?`,
  ).bind(...div.binds, key.total_ms, key.created_at, limit).all();
  return results.reverse();
}

function toPage(rows, firstRank, total) {
  const out = rows.map((row, i) => ({
    rank: firstRank + i,
    id: row.id,
    player: row.player,
    timeMs: row.time_ms,
    penaltyMs: row.penalty_ms,
    errors: row.errors,
    seed: !!row.seed,
    division: DIVISION_NAME[row.division ?? DIV_HUMAN],
  }));
  const last = out.at(-1);
  return {
    total,
    rows: out,
    prev: out.length && firstRank > 1 ? encodeCursor(rows[0], firstRank) : null,
    next: last && last.rank < total ? encodeCursor(rows.at(-1), last.rank) : null,
  };
}

async function firstPage(env, limit, div) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE ${div.where} ORDER BY total_ms, created_at LIMIT ?`,
  ).bind(...div.binds, limit).all();
  const page = toPage(results, 1, div.total);
  return { ...page, top: page.rows }; // `top`: alias for pre-pagination clients (cached pages)
}

/** Last aligned page: with 39 records and limit 10 → ranks 31–39. Reads only those rows. */
async function lastPage(env, limit, div) {
  if (!div.total) return toPage([], 1, 0);
  const count = ((div.total - 1) % limit) + 1;
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE ${div.where} ORDER BY total_ms DESC, created_at DESC LIMIT ?`,
  ).bind(...div.binds, count).all();
  return toPage(results.reverse(), div.total - results.length + 1, div.total);
}

async function pageFrom(env, cursor, dir, limit, div) {
  const key = { total_ms: cursor.totalMs, created_at: cursor.createdAt };
  if (dir === 'after') return toPage(await rowsAfter(env, key, limit, div), cursor.rank + 1, div.total);
  const rows = await rowsBefore(env, key, Math.min(limit, cursor.rank - 1), div);
  return toPage(rows, cursor.rank - rows.length, div.total);
}

/** Page containing a row, aligned to fixed pages: rank 33 with limit 10 → ranks 31–40. */
async function pageAroundRow(env, key, rank, limit, div) {
  const before = await rowsBefore(env, key, (rank - 1) % limit, div);
  const from = await rowsAfter(env, key, limit - before.length, div, true);
  return toPage([...before, ...from], rank - before.length, div.total);
}

async function pageAround(env, id, limit, division) {
  const row = await env.DB.prepare('SELECT total_ms, created_at, division FROM scores WHERE id = ?').bind(String(id)).first();
  if (!row) return firstPage(env, limit, await divisionInfo(env, division));
  if (division == null) {
    // Global board (cached old clients): rank across both divisions.
    // Both per-division counts include a Say Goodnight row ahead of everyone: count it once.
    const faster = (await countFaster(env, DIV_HUMAN, row.total_ms, row.created_at))
      + (await countFaster(env, DIV_SUPREME, row.total_ms, row.created_at));
    const rank = faster - (faster > 0 && row.total_ms > 350 ? 1 : 0) + 1;
    return pageAroundRow(env, row, rank, limit, await divisionInfo(env, null));
  }
  // A division-scoped request shows the row's own division (that's where its rank lives).
  const rank = (await countFaster(env, row.division, row.total_ms, row.created_at)) + 1;
  return pageAroundRow(env, row, rank, limit, await divisionInfo(env, row.division));
}

/** Counts per 5 s bin split by division (from the coarse table) + the #1 record. */
async function histogram(env) {
  const [bins, totals, top] = await env.DB.batch([
    env.DB.prepare('SELECT division, bucket, n FROM score_buckets_coarse_div WHERE n > 0 ORDER BY bucket'),
    env.DB.prepare("SELECT key, value FROM stats WHERE key IN ('div0', 'div1')"),
    env.DB.prepare(`SELECT ${COLS} FROM scores ORDER BY total_ms, created_at LIMIT 1`),
  ]);
  const byBucket = new Map();
  for (const b of bins.results) {
    const e = byBucket.get(b.bucket) || { fromMs: b.bucket * COARSE_MS, toMs: (b.bucket + 1) * COARSE_MS, n: 0, human: 0, supreme: 0 };
    e[DIVISION_NAME[b.division]] += b.n;
    e.n += b.n;
    byBucket.set(b.bucket, e);
  }
  const t = { human: 0, supreme: 0 };
  for (const row of totals.results) t[row.key === 'div1' ? 'supreme' : 'human'] = row.value;
  // Don't count the 人類組 copy of the seed twice in the distribution.
  const dup = byBucket.get(0);
  if (dup && dup.human > 0) { dup.human -= 1; dup.n -= 1; t.human -= 1; }
  const best = top.results[0];
  return {
    total: t.human + t.supreme,
    totals: t,
    binMs: COARSE_MS,
    bins: [...byBucket.values()],
    record: best ? { player: best.player, timeMs: best.time_ms, penaltyMs: best.penalty_ms, errors: best.errors } : null,
  };
}

/** ≈5 nicknames from random points in [from, to): one indexed row per probe. */
async function sampleNames(env, { from, to }) {
  const probes = Array.from({ length: SAMPLE_SIZE * 2 }, () => from + Math.floor(Math.random() * (to - from)));
  const results = await env.DB.batch(probes.map((p) => env.DB.prepare(
    'SELECT player FROM scores WHERE total_ms >= ? AND total_ms < ? ORDER BY total_ms, created_at LIMIT 1',
  ).bind(p, to)));
  const names = [...new Set(results.map((r) => r.results[0]?.player).filter(Boolean))].slice(0, SAMPLE_SIZE);
  if (names.length < SAMPLE_SIZE) {
    // Sparse range: fill from its start.
    const { results: more } = await env.DB.prepare(
      'SELECT player FROM scores WHERE total_ms >= ? AND total_ms < ? ORDER BY total_ms, created_at LIMIT ?',
    ).bind(from, to, SAMPLE_SIZE * 2).all();
    for (const r of more) if (names.length < SAMPLE_SIZE && !names.includes(r.player)) names.push(r.player);
  }
  return { names };
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

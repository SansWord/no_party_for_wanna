// Cloudflare Worker: online leaderboard for 借用凱達格蘭大道大作戰.
//
//   POST /api/runs                → { runId }   (player pressed 開始計時; runId is a signed token)
//   POST /api/runs/:token/finish  → { record, rank, total, page }   (page = rows around the player)
//   GET  /api/leaderboard        → page: first page, or ?after=<cursor> / ?before=<cursor> / ?around=<id> / ?last=1
//
// A page is { total, rows: [{ rank, ... }], prev, next } with keyset cursors, so every page
// reads only `limit` rows from the index (no OFFSET, which D1 would bill row by row).
//
// The server measures the run time (finish − start), so a client can't just post a fake time.
//
// Cost notes (D1 bills rows read/written, indexes included):
//  - Starting a run writes nothing: the start time travels in an HMAC-signed token, and
//    scores.id = runId (PRIMARY KEY) makes each token finishable once. Rate limiting uses the
//    Workers rate-limit binding instead of a table.
//  - Rank uses 5 s + 100 ms bucket tables, so it reads a bounded number of rows.
//  - Request bodies are text/plain, so browsers skip the CORS preflight request.
// Legacy: runs created by the old start endpoint (bare UUIDs in the runs table) still finish.

import {
  validateFinish, corsOrigin, clampLimit, bucketOf, coarseOf, BUCKET_MS, FINE_PER_COARSE,
  encodeCursor, decodeCursor, signRunToken, verifyRunToken, parseBody, LEGACY_RUN_RE,
} from './logic.js';

const TOP_N = 10;
const BOARD_CACHE_MS = 10_000;
let boardCache = null; // per-isolate cache for the first leaderboard page: { at, limit, body }

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
    // (the server-side clock still applies to them).
    if (request.headers.get('Origin') && !origin) return json({ error: 'origin_not_allowed' }, 403);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    try {
      if (request.method === 'GET' && path === '/api/leaderboard') {
        const limit = clampLimit(url.searchParams.get('limit'), TOP_N);
        const q = url.searchParams;
        if (q.has('after') || q.has('before')) {
          const cursor = decodeCursor(q.get('after') ?? q.get('before'));
          if (!cursor) return json({ error: 'bad_cursor' }, 400);
          return json(await pageFrom(env, cursor, q.has('after') ? 'after' : 'before', limit));
        }
        if (q.has('around')) return json(await pageAround(env, q.get('around'), limit));
        if (q.has('last')) return json(await lastPage(env, limit));
        if (!boardCache || boardCache.limit !== limit || Date.now() - boardCache.at > BOARD_CACHE_MS) {
          boardCache = { at: Date.now(), limit, body: await firstPage(env, limit) };
        }
        return json(boardCache.body);
      }

      if (request.method === 'POST' && path === '/api/runs') {
        if (env.START_LIMITER) {
          const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || 'unknown', env.IP_SALT || '');
          const { success } = await env.START_LIMITER.limit({ key: ipHash });
          if (!success) return json({ error: 'rate_limited' }, 429);
        }
        const runId = await signRunToken(env.RUN_SECRET, crypto.randomUUID(), Date.now());
        return json({ runId }, 201);
      }

      const m = path.match(/^\/api\/runs\/([A-Za-z0-9._-]{36,120})\/finish$/);
      if (request.method === 'POST' && m) {
        const now = Date.now();
        const body = parseBody(await request.text());
        if (!body) return json({ error: 'bad_json' }, 400);

        let runId;
        let startedAt;
        const token = await verifyRunToken(env.RUN_SECRET, m[1]);
        if (token) {
          ({ runId, startedAt } = token);
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

        try {
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO scores (id, player, time_ms, penalty_ms, errors, total_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).bind(runId, r.player, r.timeMs, r.penaltyMs, r.errors, r.totalMs, now),
            env.DB.prepare("UPDATE stats SET value = value + 1 WHERE key = 'total'"),
            env.DB.prepare('INSERT INTO score_buckets (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1')
              .bind(bucketOf(r.totalMs)),
            env.DB.prepare('INSERT INTO score_buckets_coarse (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1')
              .bind(coarseOf(r.totalMs)),
          ]);
        } catch (err) {
          // scores.id is the PRIMARY KEY: a second finish with the same token is rejected (batch rolls back).
          if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message ?? err))) {
            return json({ error: 'unknown_or_finished_run' }, 404);
          }
          throw err;
        }

        boardCache = null;
        const rank = await rankOf(env, r.totalMs, now);
        const page = await pageAroundRow(env, { total_ms: r.totalMs, created_at: now }, rank, TOP_N);
        // `top` keeps pre-pagination clients (cached pages) rendering a board.
        return json({ record: { id: runId, ...r }, rank, total: page.total, page, top: page.rows }, 201);
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

const COLS = 'id, player, time_ms, penalty_ms, errors, total_ms, created_at, seed';

async function totalCount(env) {
  return (await env.DB.prepare("SELECT value FROM stats WHERE key = 'total'").first('value')) ?? 0;
}

/**
 * Rank without scanning the table: Σ 5 s buckets below ours + Σ 100 ms buckets below ours within
 * our 5 s bucket + an index range inside our own 100 ms bucket. One round trip via batch.
 */
async function rankOf(env, totalMs, createdAt) {
  const fine = bucketOf(totalMs);
  const coarse = coarseOf(totalMs);
  const [a, b, c] = await env.DB.batch([
    env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS s FROM score_buckets_coarse WHERE bucket < ?').bind(coarse),
    env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS s FROM score_buckets WHERE bucket >= ? AND bucket < ?')
      .bind(coarse * FINE_PER_COARSE, fine),
    env.DB.prepare('SELECT COUNT(*) AS s FROM scores WHERE total_ms >= ? AND (total_ms, created_at) < (?, ?)')
      .bind(fine * BUCKET_MS, totalMs, createdAt),
  ]);
  return a.results[0].s + b.results[0].s + c.results[0].s + 1;
}

async function rowsAfter(env, key, limit, inclusive = false) {
  const op = inclusive ? '>=' : '>';
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE (total_ms, created_at) ${op} (?, ?) ORDER BY total_ms, created_at LIMIT ?`,
  ).bind(key.total_ms, key.created_at, limit).all();
  return results;
}

async function rowsBefore(env, key, limit) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores WHERE (total_ms, created_at) < (?, ?) ORDER BY total_ms DESC, created_at DESC LIMIT ?`,
  ).bind(key.total_ms, key.created_at, limit).all();
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
  }));
  const last = out.at(-1);
  return {
    total,
    rows: out,
    prev: out.length && firstRank > 1 ? encodeCursor(rows[0], firstRank) : null,
    next: last && last.rank < total ? encodeCursor(rows.at(-1), last.rank) : null,
  };
}

async function firstPage(env, limit) {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM scores ORDER BY total_ms, created_at LIMIT ?`)
    .bind(limit).all();
  const page = toPage(results, 1, await totalCount(env));
  return { ...page, top: page.rows }; // `top`: alias for pre-pagination clients (cached pages)
}

/** Last aligned page: with 39 records and limit 10 → ranks 31–39. Reads only those rows. */
async function lastPage(env, limit) {
  const total = await totalCount(env);
  if (!total) return toPage([], 1, 0);
  const count = ((total - 1) % limit) + 1;
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM scores ORDER BY total_ms DESC, created_at DESC LIMIT ?`,
  ).bind(count).all();
  return toPage(results.reverse(), total - results.length + 1, total);
}

async function pageFrom(env, cursor, dir, limit) {
  const key = { total_ms: cursor.totalMs, created_at: cursor.createdAt };
  const total = await totalCount(env);
  if (dir === 'after') return toPage(await rowsAfter(env, key, limit), cursor.rank + 1, total);
  const rows = await rowsBefore(env, key, Math.min(limit, cursor.rank - 1));
  return toPage(rows, cursor.rank - rows.length, total);
}

/** Page containing a row, aligned to fixed pages: rank 33 with limit 10 → ranks 31–40. */
async function pageAroundRow(env, key, rank, limit) {
  const before = await rowsBefore(env, key, (rank - 1) % limit);
  const from = await rowsAfter(env, key, limit - before.length, true);
  return toPage([...before, ...from], rank - before.length, await totalCount(env));
}

async function pageAround(env, id, limit) {
  const row = await env.DB.prepare('SELECT total_ms, created_at FROM scores WHERE id = ?').bind(String(id)).first();
  if (!row) return firstPage(env, limit);
  return pageAroundRow(env, row, await rankOf(env, row.total_ms, row.created_at), limit);
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

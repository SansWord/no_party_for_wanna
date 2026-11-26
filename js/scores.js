// Score storage: the online leaderboard (Cloudflare Worker, see leaderboard/) when
// LEADERBOARD_API is configured and reachable, otherwise localStorage on this device.

import { LEADERBOARD_API } from './config.js';

const KEY = 'ketagalan-sim:scores:v2';
const TOP_N = 10;

/** Built-in record every player competes against (the online DB is seeded with the same row). */
export const SEED_RECORDS = [
  {
    id: 'seed-wanna-talk',
    player: 'Say Goodnight',
    timeMs: 350,
    penaltyMs: 0,
    errors: 0,
    success: true,
    caseNo: null,
    at: '2026-11-26T00:00:00.000Z',
    seed: true,
  },
];

/** Names players may not use (they would impersonate the seed record). */
export function isReservedName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'say goodnight';
}

/**
 * @typedef {{ id: string, player: string, timeMs: number, penaltyMs: number, errors: number,
 *             success?: boolean, caseNo?: string|null, at?: string, seed?: boolean }} ScoreRecord
 * @typedef {ScoreRecord & { rank: number }} RankedRow
 * @typedef {{ online: boolean, rows: RankedRow[], total: number, prev: string|null, next: string|null }} Page
 *   prev/next are opaque cursors for getLeaderboardPage({ before }) / ({ after }).
 * @typedef {{ online: boolean, record: ScoreRecord, division: 'human'|'supreme', rank: number, total: number, page: Page, error?: string }} SubmitResult
 */

function apiBase() {
  // ?api=<url> override is for local testing against `wrangler dev`.
  const search = typeof location === 'undefined' ? '' : location.search;
  const override = new URLSearchParams(search).get('api');
  return (override || LEADERBOARD_API || '').replace(/\/+$/, '');
}

export function isOnlineConfigured() {
  return !!apiBase();
}

// POST bodies go out as text/plain and GETs carry no Content-Type, so these are CORS "simple
// requests": the browser skips the OPTIONS preflight (one fewer billed Worker request each).
async function api(path, options = {}) {
  const res = await fetch(apiBase() + path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.error });
  return body;
}

// ---------- Divisions ----------
/** 至尊組: total < 20 s. 人類組: total ≥ 20 s. (Matches SUPREME_MS in the Worker.) */
export const SUPREME_MS = 20_000;
export const DIVISIONS = { human: '人類組', supreme: '至尊組' };
const total = (r) => r.timeMs + r.penaltyMs;
export function divisionOf(totalMs) {
  return totalMs < SUPREME_MS ? 'supreme' : 'human';
}

// ---------- Local fallback ----------
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function localRanked(division = null) {
  return [...SEED_RECORDS, ...readAll()]
    .filter((r) => r.success !== false)
    .filter((r) => !division || divisionOf(total(r)) === division)
    .sort((a, b) => total(a) - total(b));
}

/** Slice of the local ranking starting at 0-based index `start`; cursors are "L<division>:<rank>". */
function localPage(start, division = null, limit = TOP_N) {
  const ranked = localRanked(division);
  const from = Math.max(0, Math.min(start, Math.max(0, ranked.length - 1)));
  const rows = ranked.slice(from, from + limit).map((r, i) => ({ ...r, rank: from + i + 1 }));
  const last = rows.at(-1);
  const tag = `L${division || ''}:`;
  return {
    online: false,
    division,
    total: ranked.length,
    rows,
    prev: from > 0 ? `${tag}${from + 1}` : null,
    next: last && last.rank < ranked.length ? `${tag}${last.rank}` : null,
  };
}

/** Page containing a record, aligned to fixed pages (rank 33 → ranks 31–40). */
function localPageAround(id, division = null, limit = TOP_N) {
  const idx = localRanked(division).findIndex((r) => r.id === id);
  return localPage(idx < 0 ? 0 : idx - (idx % limit), division, limit);
}

function localSubmit(record) {
  const all = readAll();
  all.push(record);
  localStorage.setItem(KEY, JSON.stringify(all.slice(-200)));
  const division = divisionOf(total(record));
  const ranked = localRanked(division);
  const page = localPageAround(record.id, division);
  return { online: false, record, division, rank: ranked.findIndex((r) => r.id === record.id) + 1, total: ranked.length, page };
}

function localHistogram() {
  const ranked = localRanked();
  const bins = new Map();
  for (const r of ranked) {
    const b = Math.floor(total(r) / 5000);
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  const best = ranked[0];
  return {
    online: false,
    total: ranked.length,
    supremeMs: SUPREME_MS,
    binMs: 5000,
    bins: [...bins].sort((a, b) => a[0] - b[0]).map(([b, n]) => ({ fromMs: b * 5000, toMs: (b + 1) * 5000, n })),
    record: best ? { player: best.player, timeMs: best.timeMs, penaltyMs: best.penaltyMs, errors: best.errors } : null,
  };
}

function localSample(from, to) {
  const pool = [...new Set(localRanked().filter((r) => total(r) >= from && total(r) < to).map((r) => r.player))];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { names: pool.slice(0, 5) };
}

// ---------- Public API ----------

/** Called when the timer starts. Returns a run handle for submitResult (null when offline). */
export async function beginRun() {
  if (!apiBase()) return null;
  try {
    const { runId } = await api('/api/runs', { method: 'POST', body: '{}' });
    return { runId };
  } catch (err) {
    console.warn('[leaderboard] start failed, falling back to local', err);
    return null;
  }
}

/**
 * Submit a finished run. Online: the server measures the time and returns the official record,
 * the player's division, their rank within it, and the aligned page around them.
 * @returns {Promise<SubmitResult>}
 */
export async function submitResult(record, run) {
  if (apiBase() && run) {
    try {
      const res = await api(`/api/runs/${run.runId}/finish`, {
        method: 'POST',
        body: JSON.stringify({ player: record.player, penaltyMs: record.penaltyMs, errors: record.errors }),
      });
      const division = res.division || divisionOf(res.record.totalMs);
      return {
        online: true,
        record: { ...res.record, caseNo: record.caseNo },
        division,
        rank: res.rank,
        total: res.total,
        page: { online: true, division, ...res.page },
      };
    } catch (err) {
      console.warn('[leaderboard] finish failed, saved locally', err);
      return { ...localSubmit(record), error: err.code || 'network' };
    }
  }
  return { ...localSubmit(record), error: apiBase() ? 'not_started' : undefined };
}

/**
 * One page of a division's leaderboard (`division`: 'human' | 'supreme'). Pass nothing else for
 * the first page, `{ after }` / `{ before }` with a cursor from a previous page, `{ around: id }`
 * for the page containing a record, or `{ last: true }`. Pages are aligned to ranks 10n+1.
 * @returns {Promise<Page>}
 */
export async function getLeaderboardPage({ division = 'human', after, before, around, last } = {}) {
  const local = (after && after.startsWith('L')) || (before && before.startsWith('L'));
  if (apiBase() && !local) {
    try {
      const q = new URLSearchParams({ limit: String(TOP_N), division });
      if (after) q.set('after', after);
      else if (before) q.set('before', before);
      else if (around) q.set('around', around);
      else if (last) q.set('last', '1');
      return { online: true, division, ...(await api(`/api/leaderboard?${q}`)) };
    } catch (err) {
      console.warn('[leaderboard] fetch failed, showing local', err);
    }
  }
  const rankOf = (cursor) => Number(cursor.split(':')[1]);
  if (after) return localPage(rankOf(after), division);
  if (before) return localPage(Math.max(0, rankOf(before) - 1 - TOP_N), division);
  if (around) return localPageAround(around, division);
  if (last) {
    const n = localRanked(division).length;
    return localPage(Math.floor(Math.max(0, n - 1) / TOP_N) * TOP_N, division);
  }
  return localPage(0, division);
}

/** Finish-time distribution in 5 s bins, plus the #1 record. */
export async function getHistogram() {
  if (apiBase()) {
    try {
      return { online: true, ...(await api('/api/histogram')) };
    } catch (err) {
      console.warn('[leaderboard] histogram failed, showing local', err);
    }
  }
  return localHistogram();
}

/** ≈5 random nicknames with a finish time in [fromMs, toMs). */
export async function sampleNames(fromMs, toMs, online = true) {
  if (apiBase() && online) {
    try {
      return await api(`/api/histogram/sample?from=${fromMs}&to=${toMs}`);
    } catch (err) {
      console.warn('[leaderboard] sample failed', err);
    }
  }
  return localSample(fromMs, toMs);
}

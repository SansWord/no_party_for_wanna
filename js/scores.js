// Score storage: the online leaderboard (Cloudflare Worker, see leaderboard/) when
// LEADERBOARD_API is configured and reachable, otherwise localStorage on this device.

import { LEADERBOARD_API } from './config.js';

const KEY = 'ketagalan-sim:scores:v2';
const TOP_N = 10;

/** Built-in record every player competes against (the online DB is seeded with the same row). */
export const SEED_RECORDS = [
  {
    id: 'seed-wanna-talk',
    player: 'Wanna Talk',
    timeMs: 330,
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
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'wanna talk';
}

/**
 * @typedef {{ id: string, player: string, timeMs: number, penaltyMs: number, errors: number,
 *             success?: boolean, caseNo?: string|null, at?: string, seed?: boolean }} ScoreRecord
 * @typedef {ScoreRecord & { rank: number }} RankedRow
 * @typedef {{ online: boolean, rows: RankedRow[], total: number, prev: string|null, next: string|null }} Page
 *   prev/next are opaque cursors for getLeaderboardPage({ before }) / ({ after }).
 * @typedef {{ online: boolean, record: ScoreRecord, rank: number, total: number, page: Page, error?: string }} SubmitResult
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

async function api(path, options = {}) {
  const res = await fetch(apiBase() + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.error });
  return body;
}

// ---------- Local fallback ----------
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function localRanked() {
  return [...SEED_RECORDS, ...readAll()]
    .filter((r) => r.success !== false)
    .sort((a, b) => a.timeMs + a.penaltyMs - (b.timeMs + b.penaltyMs));
}

/** Slice of the local ranking starting at 0-based index `start`; cursors are 1-based ranks. */
function localPage(start, limit = TOP_N) {
  const ranked = localRanked();
  const from = Math.max(0, Math.min(start, Math.max(0, ranked.length - 1)));
  const rows = ranked.slice(from, from + limit).map((r, i) => ({ ...r, rank: from + i + 1 }));
  const last = rows.at(-1);
  return {
    online: false,
    total: ranked.length,
    rows,
    prev: from > 0 ? `L${from + 1}` : null,
    next: last && last.rank < ranked.length ? `L${last.rank}` : null,
  };
}

function localPageAround(id, limit = TOP_N) {
  const idx = localRanked().findIndex((r) => r.id === id);
  return localPage(idx < 0 ? 0 : Math.max(0, idx - Math.floor((limit - 1) / 2)), limit);
}

function localSubmit(record) {
  const all = readAll();
  all.push(record);
  localStorage.setItem(KEY, JSON.stringify(all.slice(-200)));
  const ranked = localRanked();
  const page = localPageAround(record.id);
  return { online: false, record, rank: ranked.findIndex((r) => r.id === record.id) + 1, total: ranked.length, page };
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
 * Submit a finished run. Online: the server measures the time and returns the official record.
 * @returns {Promise<SubmitResult>}
 */
export async function submitResult(record, run) {
  if (apiBase() && run) {
    try {
      const res = await api(`/api/runs/${run.runId}/finish`, {
        method: 'POST',
        body: JSON.stringify({ player: record.player, penaltyMs: record.penaltyMs, errors: record.errors }),
      });
      return {
        online: true,
        record: { ...res.record, caseNo: record.caseNo },
        rank: res.rank,
        total: res.total,
        page: { online: true, ...res.page },
      };
    } catch (err) {
      console.warn('[leaderboard] finish failed, saved locally', err);
      return { ...localSubmit(record), error: err.code || 'network' };
    }
  }
  return { ...localSubmit(record), error: apiBase() ? 'not_started' : undefined };
}

/**
 * One page of the leaderboard. Pass nothing for the first page, `{ after }` / `{ before }`
 * with a cursor from a previous page, or `{ around: id }` for the page containing a record.
 * Cursors from the local fallback start with "L".
 * @returns {Promise<Page>}
 */
export async function getLeaderboardPage({ after, before, around } = {}) {
  const local = (after && after.startsWith('L')) || (before && before.startsWith('L'));
  if (apiBase() && !local) {
    try {
      const q = new URLSearchParams({ limit: String(TOP_N) });
      if (after) q.set('after', after);
      else if (before) q.set('before', before);
      else if (around) q.set('around', around);
      return { online: true, ...(await api(`/api/leaderboard?${q}`)) };
    } catch (err) {
      console.warn('[leaderboard] fetch failed, showing local', err);
    }
  }
  if (after) return localPage(Number(after.slice(1)));
  if (before) return localPage(Math.max(0, Number(before.slice(1)) - 1 - TOP_N));
  if (around) return localPageAround(around);
  return localPage(0);
}

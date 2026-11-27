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

/** Names players may not use (same list as RESERVED_NAMES in the Worker; spaces and case ignored). */
const RESERVED_NAMES = ['say goodnight', 'sansword'];
export function isReservedName(name) {
  const squash = (n) => String(n || '').toLowerCase().replace(/\s+/g, '');
  return RESERVED_NAMES.some((r) => squash(r) === squash(name));
}

/**
 * @typedef {{ id: string, player: string, timeMs: number, penaltyMs: number, errors: number,
 *             success?: boolean, caseNo?: string|null, at?: string, seed?: boolean }} ScoreRecord
 * @typedef {ScoreRecord & { rank: number }} RankedRow
 * @typedef {{ online: boolean, rows: RankedRow[], total: number, prev: string|null, next: string|null }} Page
 *   prev/next are opaque cursors for getLeaderboardPage({ before }) / ({ after }).
 * @typedef {{ online: boolean, record: ScoreRecord, best: ScoreRecord, improved: boolean, division: 'human'|'supreme',
 *             rank: number, total: number, page: Page, error?: string }} SubmitResult
 *   rank/total/page are about the nickname's best run (division boards list each nickname once).
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
// 人類組 only when nothing flags the run; otherwise 至尊組. Mirrors classifyRun in the Worker
// (the server also checks that start/finish came from a browser page; offline runs always do).
export const SUPREME_MS = 20_000;
export const DIVISIONS = { human: '人類組', supreme: '至尊組' };
export const FLAG_FAST = 1;
export const FLAG_PAYLOAD = 2;
export const FLAG_CLIENT = 4;
export const FLAG_AI_NAME = 8;
// Same list as AI_NAME_PARTS in leaderboard/src/logic.js.
const AI_NAME_PARTS = [
  'claude', '克勞低', '克勞德', '克勞迪', 'codex', 'gemini', 'gpt', 'grok', 'llm', 'copilot',
  'deepseek', 'openai', 'anthropic', 'opus', 'sonnet',
];
export function isAiName(name) {
  const n = String(name || '').toLowerCase();
  return AI_NAME_PARTS.some((p) => n.includes(p)) || /(^|[^a-z])ai([^a-z]|$)/.test(n);
}
const total = (r) => r.timeMs + r.penaltyMs;

export function isConsistentPayload(errors, penaltyMs) {
  if (errors === 0) return penaltyMs === 0;
  return penaltyMs >= errors * 2000 && penaltyMs <= errors * 10000;
}

export function classify(r) {
  let flags = 0;
  if (total(r) < SUPREME_MS) flags |= FLAG_FAST;
  if (!isConsistentPayload(r.errors, r.penaltyMs)) flags |= FLAG_PAYLOAD;
  if (isAiName(r.player)) flags |= FLAG_AI_NAME;
  return { flags, division: flags ? 'supreme' : 'human' };
}

/** Why a run is in 至尊組, for the result screen. */
export function flagReasons(flags) {
  const out = [];
  if (flags & FLAG_FAST) out.push('完成時間少於 20 秒');
  if (flags & FLAG_PAYLOAD) out.push('錯誤次數和罰秒對不上');
  if (flags & FLAG_CLIENT) out.push('請求不是從遊戲網頁送出');
  if (flags & FLAG_AI_NAME) out.push('暱稱表明是 AI 參賽');
  if (flags & 16) out.push('這個暱稱曾以腳本登錄成績');
  return out;
}

/** Division of a record; the seed (Say Goodnight) belongs to both. */
function inDivision(r, division) {
  return !division || r.seed || classify(r).division === division;
}

// ---------- Local fallback ----------
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

/** Same merge rule as nameKey() in the Worker: ASCII case-insensitive. */
const nameKey = (player) => String(player).replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Every run (division null), or a division board with each nickname once at its best. */
function localRanked(division = null) {
  const runs = [...SEED_RECORDS, ...readAll()]
    .filter((r) => r.success !== false)
    .filter((r) => inDivision(r, division))
    .sort((a, b) => total(a) - total(b));
  if (!division) return runs;
  const seen = new Set();
  return runs.filter((r) => !seen.has(nameKey(r.player)) && seen.add(nameKey(r.player)));
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

/** Offline twin of ?name=: the page of that nickname's best ('auto': 人類組 first), else random. */
function localPageOfName(name, division) {
  const key = nameKey(String(name).trim().replace(/\s+/g, ' '));
  for (const d of division === 'auto' ? ['human', 'supreme'] : [division]) {
    const best = localRanked(d).find((r) => !r.seed && nameKey(r.player) === key);
    if (best) return { ...localPageAround(best.id, d), division: d, mine: best.id };
  }
  const d = division === 'auto' ? 'human' : division;
  const pages = Math.max(1, Math.ceil(localRanked(d).length / TOP_N));
  return { ...localPage(Math.floor(Math.random() * pages) * TOP_N, d), division: d, mine: null };
}

function localSubmit(record) {
  const all = readAll();
  all.push(record);
  localStorage.setItem(KEY, JSON.stringify(all.slice(-200)));
  const { division, flags } = classify(record);
  const ranked = localRanked(division);
  const best = ranked.find((r) => nameKey(r.player) === nameKey(record.player)) || record;
  const page = localPageAround(best.id, division);
  return {
    online: false, record, best, improved: best.id === record.id,
    division, flags, rank: ranked.indexOf(best) + 1, total: ranked.length, page,
  };
}

function localHistogram() {
  const ranked = localRanked();
  const bins = new Map();
  for (const r of ranked) {
    const b = Math.floor(total(r) / 5000);
    const e = bins.get(b) || { fromMs: b * 5000, toMs: (b + 1) * 5000, n: 0, human: 0, supreme: 0 };
    e[r.seed ? 'supreme' : classify(r).division] += 1;
    e.n += 1;
    bins.set(b, e);
  }
  const best = ranked[0];
  return {
    online: false,
    total: ranked.length,
    binMs: 5000,
    bins: [...bins.values()].sort((a, b) => a.fromMs - b.fromMs),
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
      const division = res.division || classify({ ...record, timeMs: res.record.timeMs }).division;
      return {
        online: true,
        record: { ...res.record, caseNo: record.caseNo },
        best: res.best || res.record,
        improved: res.improved ?? true,
        division,
        flags: res.flags ?? 0,
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
 * for the page containing a record, `{ last: true }`, `{ page: n | 'random' }`, or `{ name }` for the
 * page holding that nickname's best (`division: 'auto'` picks 人類組, else 至尊組; the result has
 * `division` and `mine`, the id to highlight, or null with a random page when there's no record). Pages are aligned to ranks 10n+1.
 * @returns {Promise<Page>}
 */
export async function getLeaderboardPage({ division = 'human', after, before, around, last, page, name } = {}) {
  const local = (after && after.startsWith('L')) || (before && before.startsWith('L'));
  if (apiBase() && !local) {
    try {
      const q = new URLSearchParams({ limit: String(TOP_N) });
      if (division !== 'auto') q.set('division', division);
      if (name) {
        q.set('name', name);
        const res = await api(`/api/leaderboard?${q}`);
        return { online: true, ...res, division: res.division || division };
      }
      if (after) q.set('after', after);
      else if (before) q.set('before', before);
      else if (around) q.set('around', around);
      else if (last) q.set('last', '1');
      else if (page) q.set('page', String(page));
      return { online: true, division, ...(await api(`/api/leaderboard?${q}`)) };
    } catch (err) {
      console.warn('[leaderboard] fetch failed, showing local', err);
    }
  }
  if (name) return localPageOfName(name, division);
  const rankOf = (cursor) => Number(cursor.split(':')[1]);
  if (after) return localPage(rankOf(after), division);
  if (before) return localPage(Math.max(0, rankOf(before) - 1 - TOP_N), division);
  if (around) return localPageAround(around, division);
  if (page) {
    const pages = Math.max(1, Math.ceil(localRanked(division).length / TOP_N));
    const n = page === 'random' ? 1 + Math.floor(Math.random() * pages) : Math.min(page, pages);
    return localPage((n - 1) * TOP_N, division);
  }
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

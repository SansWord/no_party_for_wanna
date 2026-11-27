// Pure validation helpers for the leaderboard Worker (unit-tested with node --test).

export const MAX_NAME_LENGTH = 20;
export const MIN_RUN_MS = 360;             // 10 ms slower than the seed (Say Goodnight, 350 ms); anything this fast is a script and lands in 至尊組 anyway
export const MAX_RUN_MS = 60 * 60 * 1000;  // runs expire after an hour
export const MAX_PENALTY_MS = 600_000;
export const MAX_ERRORS = 200;
export const RESERVED_NAMES = ['say goodnight'];
export const STARTS_PER_MINUTE = 20;
// Spend guard: at most this many new scores per Taiwan calendar day (≈7 D1 row writes each,
// so 150k ≈ 1M writes ≈ $1/day if all billed). Override with the DAILY_SCORE_CAP var.
export const DAILY_SCORE_CAP = 150_000;

/** stats key counting today's scores, by Taiwan date (UTC+8), e.g. "day:2026-11-27". */
export function dayKey(nowMs) {
  return `day:${new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)}`;
}

/** The configured daily cap: a positive integer from the env var, else the default. */
export function dailyCap(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DAILY_SCORE_CAP;
}

/** Normalize a nickname: strip control chars, collapse spaces, cap length (by code point). */
export function sanitizePlayer(name) {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = [...cleaned].slice(0, MAX_NAME_LENGTH).join('').trim();
  return capped || '匿名';
}

export function isReservedName(name) {
  const key = sanitizePlayer(name).toLowerCase().replace(/\s+/g, ' ');
  return RESERVED_NAMES.includes(key);
}

/**
 * Validate a finish request. `elapsedMs` is measured by the server.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateFinish({ elapsedMs, player, penaltyMs, errors }) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_RUN_MS) return { ok: false, error: 'too_fast' };
  if (elapsedMs > MAX_RUN_MS) return { ok: false, error: 'expired' };
  if (!Number.isInteger(penaltyMs) || penaltyMs < 0 || penaltyMs > MAX_PENALTY_MS || penaltyMs % 1000 !== 0)
    return { ok: false, error: 'bad_penalty' };
  if (!Number.isInteger(errors) || errors < 0 || errors > MAX_ERRORS) return { ok: false, error: 'bad_errors' };
  if (isReservedName(player)) return { ok: false, error: 'name_reserved' };
  const name = sanitizePlayer(player);
  return {
    ok: true,
    value: { player: name, timeMs: Math.round(elapsedMs), penaltyMs, errors, totalMs: Math.round(elapsedMs) + penaltyMs },
  };
}

/** Parse the ALLOWED_ORIGINS env var and decide which origin to echo back. */
export function corsOrigin(requestOrigin, allowed) {
  const list = String(allowed || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!requestOrigin) return null;
  return list.includes(requestOrigin) ? requestOrigin : null;
}

export function clampLimit(raw, def = 10, max = 50) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

export const BUCKET_MS = 100;

/** Bucket index used by the score_buckets rank table. */
export function bucketOf(totalMs) {
  return Math.floor(totalMs / BUCKET_MS);
}

/**
 * Keyset-pagination cursor: "<total_ms>_<created_at>_<rank>". The rank is only used to number
 * rows on the next page; ordering comes from (total_ms, created_at), which the index serves.
 */
export function encodeCursor(row, rank) {
  return `${row.total_ms}_${row.created_at}_${rank}`;
}

export function decodeCursor(raw) {
  const m = /^(\d{1,12})_(\d{1,15})_(\d{1,9})$/.exec(String(raw ?? ''));
  if (!m) return null;
  const [totalMs, createdAt, rank] = m.slice(1).map(Number);
  if (rank < 1) return null;
  return { totalMs, createdAt, rank };
}

// ---------- Two-level rank buckets ----------
// Rank = Σ coarse buckets (5 s) below yours + Σ fine buckets (100 ms) below yours inside your
// coarse bucket + an index range inside your own fine bucket. Reads stay ~≤ 170 rows however
// large the board gets (vs. one row per occupied 100 ms bucket before).
export const COARSE_MS = 5000;
export const FINE_PER_COARSE = COARSE_MS / BUCKET_MS;

export function coarseOf(totalMs) {
  return Math.floor(totalMs / COARSE_MS);
}

// ---------- Stateless run tokens ----------
// Starting a run writes nothing: the Worker signs "<runId>.<startedAt>" with HMAC-SHA256 and the
// client sends the token back on finish. Replays are stopped by scores.id = runId (PRIMARY KEY).

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signRunToken(secret, runId, startedAt, browser = null) {
  if (!secret) throw new Error('RUN_SECRET missing');
  const body = browser == null ? `${runId}.${startedAt}` : `${runId}.${startedAt}.${browser ? 1 : 0}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

const TOKEN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{13})(?:\.([01]))?\.([A-Za-z0-9_-]{43})$/;

/**
 * Returns { runId, startedAt, browser } for a genuine token, else null (constant-time verify).
 * `browser` is the start request's browser signal, or null for tokens issued before it existed.
 */
export async function verifyRunToken(secret, token) {
  if (!secret) return null;
  const m = TOKEN_RE.exec(String(token ?? ''));
  if (!m) return null;
  let sig;
  try { sig = fromB64url(m[4]); } catch { return null; }
  const body = m[3] == null ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(body));
  return ok ? { runId: m[1], startedAt: Number(m[2]), browser: m[3] == null ? null : m[3] === '1' } : null;
}

export const LEGACY_RUN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Request bodies arrive as text/plain (no CORS preflight); parse leniently. */
export function parseBody(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ---------- Divisions ----------
// 至尊組 (supreme): total < SUPREME_MS. 人類組 (human): total >= SUPREME_MS.
// Must be a multiple of COARSE_MS so the division sizes come straight from coarse buckets.
export const SUPREME_MS = 20_000;
export const SUPREME_COARSE = SUPREME_MS / COARSE_MS;

export function parseDivision(raw) {
  return raw === 'human' || raw === 'supreme' ? raw : null;
}

export function divisionOf(totalMs) {
  return totalMs < SUPREME_MS ? 'supreme' : 'human';
}

/** Validate a [from, to) ms range for nickname sampling. */
export function parseRange(fromRaw, toRaw) {
  const from = Number.parseInt(fromRaw, 10);
  const to = Number.parseInt(toRaw, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 24 * 3600_000) return null;
  return { from, to };
}

// ---------- Human vs script classification ----------
// A run is 人類組 only if nothing flags it; any flag puts it in 至尊組.
export const DIV_HUMAN = 0;
export const DIV_SUPREME = 1;
export const FLAG_FAST = 1;     // total under SUPREME_MS
export const FLAG_PAYLOAD = 2;  // errors / penalty combination the game can't produce
export const FLAG_CLIENT = 4;   // start or finish request didn't come from a browser page
export const FLAG_AI_NAME = 8;  // nickname says it's an AI (Claude/克勞低, Codex, Gemini, GPT…)

// Lowercased substrings that mark an AI nickname, plus "AI" as a standalone word (so Kai,
// Taipei, Daisy don't match). 機器人/bot are left out: mostly humans joking at normal speed.
export const AI_NAME_PARTS = [
  'claude', '克勞低', '克勞德', '克勞迪', 'codex', 'gemini', 'gpt', 'grok', 'llm', 'copilot',
  'deepseek', 'openai', 'anthropic', 'opus', 'sonnet',
];
export function isAiName(name) {
  const n = String(name || '').toLowerCase();
  return AI_NAME_PARTS.some((p) => n.includes(p)) || /(^|[^a-z])ai([^a-z]|$)/.test(n);
}

/**
 * The game adds 2–10 s of penalty per mistake (and never a penalty without a mistake), so
 * errors and penalty must agree. Hand-written requests often get this wrong.
 */
export function isConsistentPayload(errors, penaltyMs) {
  if (errors === 0) return penaltyMs === 0;
  return penaltyMs >= errors * 2000 && penaltyMs <= errors * 10000;
}

/**
 * Browser signal for a request whose Origin already passed the allow-list: a browser page's
 * fetch always carries Origin and a User-Agent, and Sec-Fetch-Mode (when sent) is "cors".
 * Plain HTTP clients usually send none of these. (A determined script can fake them.)
 */
export function browserSignal(headers, originAllowed) {
  if (!originAllowed) return false;
  const ua = (headers.get('User-Agent') || '').trim();
  const mode = headers.get('Sec-Fetch-Mode');
  return ua.length > 0 && (mode == null || mode === 'cors');
}

/** `browser`: true / false / null (unknown, e.g. records from before the signal existed). */
export function classifyRun({ totalMs, errors, penaltyMs, browser, player }) {
  let flags = 0;
  if (isAiName(player)) flags |= FLAG_AI_NAME;
  if (totalMs < SUPREME_MS) flags |= FLAG_FAST;
  if (!isConsistentPayload(errors, penaltyMs)) flags |= FLAG_PAYLOAD;
  if (browser === false) flags |= FLAG_CLIENT;
  return { flags, division: flags ? DIV_SUPREME : DIV_HUMAN };
}

export const DIVISION_NAME = ['human', 'supreme'];
export function divisionIndex(name) {
  return name === 'human' ? DIV_HUMAN : name === 'supreme' ? DIV_SUPREME : null;
}

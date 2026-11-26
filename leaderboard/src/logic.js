// Pure validation helpers for the leaderboard Worker (unit-tested with node --test).

export const MAX_NAME_LENGTH = 20;
export const MIN_RUN_MS = 15_000;          // no human finishes the full form faster than this
export const MAX_RUN_MS = 60 * 60 * 1000;  // runs expire after an hour
export const MAX_PENALTY_MS = 600_000;
export const MAX_ERRORS = 200;
export const RESERVED_NAMES = ['wanna talk'];
export const STARTS_PER_MINUTE = 20;

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

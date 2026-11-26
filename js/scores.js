// Score storage. v1 keeps records in localStorage.
// To add a global leaderboard later, implement these functions against an API
// (e.g. POST /api/scores, GET /api/scores?limit=10) — keep the
// record shape and the sort order (penalty-inclusive time, ascending) and swap the export.

const KEY = 'ketagalan-sim:scores:v2';

/**
 * Built-in records every player competes against. Not stored in localStorage;
 * a future online leaderboard should seed its database with the same rows.
 */
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

/**
 * @typedef {{ id: string, player: string, timeMs: number, penaltyMs: number, errors: number,
 *             success: boolean, caseNo: string|null, at: string }} ScoreRecord
 */

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

/** @param {ScoreRecord} record */
export async function saveResult(record) {
  const all = readAll();
  all.push(record);
  localStorage.setItem(KEY, JSON.stringify(all.slice(-200)));
  return record;
}

/** All successful runs, fastest first (time includes penalties). */
export async function getRankedResults() {
  return [...SEED_RECORDS, ...readAll()]
    .filter((r) => r.success)
    .sort((a, b) => a.timeMs + a.penaltyMs - (b.timeMs + b.penaltyMs));
}

export async function clearResults() {
  localStorage.removeItem(KEY);
}

# 借用凱達格蘭大道大作戰

凱道路權申請計時模擬遊戲（repo / package: `no_party_for_wanna`）

A parody timing game: how fast can a human manually complete a road-use assembly application for 凱達格蘭大道? The flow is modeled loosely on Taipei's road-use assembly portal. Unofficial; no data leaves the browser.

## Run

```sh
npm start          # python3 -m http.server 8080 → http://localhost:8080
npm test           # validator unit tests (node --test)
```

ES modules need an HTTP server; opening `index.html` via `file://` won't work.

## Game flow

大廳 (nickname, disclaimer) → 首頁「下一步」 → 隱私權政策（同意） → 申請規定（scroll to bottom, 確定） → 登入（身分證字號、手機、人機驗證） → 選擇申請類型（集會申請） → 申請書 → 確認送出（勾選聲明、人機驗證） → 結果

- **Stopwatch**: fixed bar above everything; green while running, gold on success, red on failure.
- **No real personal data**: the lobby shows a red disclaimer that must be ticked before starting. Each run generates a fake persona (checksum-valid fake ID, `@example.com` email, etc.), shown in the lobby and as a floating card during the run. Personal-data fields (`data-fake`) ignore the actual keys: each keystroke types the next character of the persona; paste/drop are blocked.
- **Uploads**: an 上傳 button with 0.6–1.5 s simulated latency; no real file is selected.
- **Always a game**: the HUD carries a `🎮 借用凱達格蘭大道大作戰 模擬遊戲` badge; every portal screen has a sticky sim strip, 遊戲模擬 tags on dialogs, and a faint watermark; the result shows a 模擬案件編號 and states that nothing was submitted.
- **Mission hints**: the mission's option in each dropdown (start/end time, 行政區, 路段) is marked `★ …（任務指定）`, a hint line sits under each mission field, and a select turns green once set correctly.
- **Human check**: simulated checkbox CAPTCHA with 1.2–2.8 s random latency (`HUMAN_CHECK_*_MS` in `js/app.js`).
- **Penalties**: wrong application type +10s, privacy decline +5s, rejected form +5s, skipped human check +3s, unchecked declaration +2s.
- **Rules enforced**: TW ID checksum, applicant ≥ 20, 1 marshal per 50 people, required attachments, agent fields when 代理人 is checked, plus the fixed mission target (中正區, full stretch of 凱達格蘭大道, 2026-11-25 08:00 to 2026-11-27 22:00). No advance-notice rule.
- **Scoring**: pure time trial, no fail state. Score = actual time + penalties. The result screen shows the breakdown, the run's rank, and the ranked list (top 10, current run highlighted and appended if outside the top 10).

## Files

- `index.html`, `styles.css` — UI
- `js/app.js` — screen flow, timer, fake typing, uploads, human check, results
- `js/validators.js` — pure validation (unit-tested)
- `js/scores.js` — online leaderboard client with localStorage fallback; `js/config.js` — API URL (written at deploy)
- `tests/validators.test.js`

## 人類組 / 至尊組

Each score is labelled when it's saved (`scores.division`, `scores.flags`). A run is **人類組** only if no flag applies; any flag puts it in **至尊組** (scripts welcome there):

| Flag | Rule | Applies to |
|---|---|---|
| 1 | total under 20 s | all records |
| 2 | errors/penalty combination the game can't produce (each mistake adds 2–10 s; no penalty without a mistake) | all records |
| 4 | start **or** finish request didn't come from a browser page (allowed `Origin` + `User-Agent`, `Sec-Fetch-Mode: cors` when sent). The start's signal is signed into the run token | runs after 2026-11-26 (`client` column; older rows are `NULL` = unknown) |

Say Goodnight is seeded in both divisions (`seed-wanna-talk` 至尊組, `seed-wanna-talk-human` 人類組); the histogram and the division-less board count it once. Ranks use per-division counters (`score_buckets_div`, `score_buckets_coarse_div`, `stats.div0/div1`). Migration for an existing DB: `migrations/0002_divisions.sql`, deploy, then `migrations/0002b_resync.sql`.

## Seed record

`SEED_RECORDS` in `js/scores.js` puts **Say Goodnight — 00:00.35** at the top of every board; players compete against it. `leaderboard/schema.sql` seeds the online database with the same row.

## Social preview image

`og.png` (1200×630) is rendered from `og/og.html` with headless Chrome (Playwright screenshot at 1200×630). The Pages workflow makes `og:image` / `og:url` absolute at deploy.

## Online leaderboard (`leaderboard/`)

Cloudflare Worker + D1. The server measures each run (start request → finish request), so clients can't post arbitrary times.

| Endpoint | Purpose |
|---|---|
| `POST /api/runs` | Player pressed 開始計時 → `{ runId }`: an HMAC-signed token carrying the start time, so starting a run writes nothing to D1. Rate-limited per hashed IP with the Workers rate-limit binding |
| `POST /api/runs/:id/finish` | `{ player, penaltyMs, errors }` → official record, rank, and the page around it. One finish per run (scores.id = run id is the PRIMARY KEY; legacy UUID runs in the `runs` table still finish); < 15 s or > 1 h is rejected; `Say Goodnight` is a reserved name. Rank comes from 5 s `score_buckets_coarse` + 100 ms `score_buckets` + an index range, and the total from `stats`, so no request scans the scores table (D1 bills per row scanned) |
| `GET /api/leaderboard?limit=10[&after=<cursor>\|&before=<cursor>\|&around=<id>\|&last=1]` | Optional `&division=human\|supreme` (人類組 ≥ 20 s / 至尊組 < 20 s; omitted = global, for cached old clients). One page, aligned to ranks 10n+1 (`around` → the page containing that record; `last` → final page) `{ total, rows[{rank,…}], prev, next }`. Keyset cursors (`total_ms_created_at_rank`), so each page reads only `limit` index rows — no OFFSET |
| `GET /api/histogram` | Finish-time counts per 5 s bin (from `score_buckets_coarse`), total, and the #1 record. Cached 30 s per isolate |
| `GET /api/histogram/sample?from=<ms>&to=<ms>` | ≈5 random nicknames in that range (one indexed row per probe) |

Bodies are sent as `text/plain` and GETs without a Content-Type, so browsers skip CORS preflights. The game falls back to localStorage (with a notice) when the API is unset, unreachable, or rejects a run.

Local dev:

```sh
cd leaderboard && npm install
npm run db:init:local   # schema + Say Goodnight seed
npm run dev             # http://localhost:8787
# game: http://localhost:8080/?api=http://localhost:8787
```

Deploy (once):

```sh
cd leaderboard
npx wrangler login
npx wrangler d1 create no-party-leaderboard      # paste database_id into wrangler.jsonc
npm run db:init:remote
npx wrangler secret put RUN_SECRET               # random; signs run tokens
npx wrangler secret put IP_SALT                  # random; salts rate-limit keys
npm run deploy                                   # prints https://no-party-leaderboard.<account>.workers.dev
```

Live: `https://no-party-leaderboard.no-party-leaderboard.workers.dev`. Re-run `npm run db:init:remote` after schema changes (idempotent).

Then set the repo variable `LEADERBOARD_API` to that URL (GitHub → Settings → Variables → Actions) and re-run the Pages workflow. `ALLOWED_ORIGINS` in `wrangler.jsonc` must include the Pages origin.

## GitHub Pages

`.github/workflows/pages.yml` runs the tests, copies the static files to `_site/`, writes `js/config.js` from `LEADERBOARD_API`, adds `?v=<commit>` to every CSS/JS reference (cache-busting), and rewrites `og:url` / `og:image` to absolute URLs.

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

## Seed record

`SEED_RECORDS` in `js/scores.js` puts **Wanna Talk — 00:00.33** at the top of every board; players compete against it. `leaderboard/schema.sql` seeds the online database with the same row.

## Social preview image

`og.png` (1200×630) is rendered from `og/og.html` with headless Chrome (Playwright screenshot at 1200×630). The Pages workflow makes `og:image` / `og:url` absolute at deploy.

## Online leaderboard (`leaderboard/`)

Cloudflare Worker + D1. The server measures each run (start request → finish request), so clients can't post arbitrary times.

| Endpoint | Purpose |
|---|---|
| `POST /api/runs` | Player pressed 開始計時 → `{ runId }` (rate-limited per hashed IP) |
| `POST /api/runs/:id/finish` | `{ player, penaltyMs, errors }` → official record, rank, top 10. One finish per run; < 15 s or > 1 h is rejected; `Wanna Talk` is a reserved name |
| `GET /api/leaderboard?limit=10` | Top list + total |

The game falls back to localStorage (with a notice) when the API is unset, unreachable, or rejects a run.

Local dev:

```sh
cd leaderboard && npm install
npm run db:init:local   # schema + Wanna Talk seed
npm run dev             # http://localhost:8787
# game: http://localhost:8080/?api=http://localhost:8787
```

Deploy (once):

```sh
cd leaderboard
npx wrangler login
npx wrangler d1 create no-party-leaderboard      # paste database_id into wrangler.jsonc
npm run db:init:remote
npx wrangler secret put IP_SALT                  # any random string
npm run deploy                                   # prints https://no-party-leaderboard.<account>.workers.dev
```

Then set the repo variable `LEADERBOARD_API` to that URL (GitHub → Settings → Variables → Actions) and re-run the Pages workflow. `ALLOWED_ORIGINS` in `wrangler.jsonc` must include the Pages origin.

## GitHub Pages

`.github/workflows/pages.yml` runs the tests, copies the static files to `_site/`, writes `js/config.js` from `LEADERBOARD_API`, adds `?v=<commit>` to every CSS/JS reference (cache-busting), and rewrites `og:url` / `og:image` to absolute URLs.

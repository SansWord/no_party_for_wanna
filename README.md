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
- `js/scores.js` — score storage; localStorage now, swap for an API to build the global leaderboard
- `tests/validators.test.js`

## Seed record

`SEED_RECORDS` in `js/scores.js` puts **Wanna Talk — 00:00.33** at the top of every board; players compete against it. Seed the online leaderboard's database with the same row.

## Social preview image

`og.png` (1200×630) is rendered from `og/og.html` with headless Chrome (Playwright screenshot at 1200×630). Before deploying, make `og:image` / `og:url` in `index.html` absolute URLs.

## Leaderboard (next)

`js/scores.js` exposes `saveResult(record)` / `getRankedResults()` (records carry an `id` so the current run can be highlighted). Replace with `fetch` calls to a backend. Since the timer runs client-side, a public board will need server-side timing (server issues a run token at start, stamps time at submit) to deter faked scores.

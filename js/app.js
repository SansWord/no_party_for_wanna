import {
  isValidTwId, isValidPhone, validateApplication, makeMission, formatDuration, makePersona,
  missionPeriodLabel,
} from './validators.js';
import {
  beginRun, submitResult, getLeaderboardPage, getHistogram, sampleNames, isReservedName, isOnlineConfigured,
  DIVISIONS, SUPREME_MS, flagReasons, SEED_RECORDS,
} from './scores.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Config ----------
const PENALTY = {
  privacyDecline: 5000,
  wrongType: 10000,
  humanCheck: 3000,
  formRejected: 5000,
  confirmUnchecked: 2000,
};
// Simulated human-verification latency (ms), like a real checkbox CAPTCHA round-trip.
const HUMAN_CHECK_MIN_MS = 1200;
const HUMAN_CHECK_MAX_MS = 2800;
// Simulated upload latency (ms).
const UPLOAD_MIN_MS = 600;
const UPLOAD_MAX_MS = 1500;
const UPLOAD_FILENAMES = {
  applicationForm: '集會申請書.pdf',
  venueConsent: '場地管理機關同意文件.pdf',
  idCopy: '身分證影本.jpg',
  marshalRoster: '糾察員名冊.xlsx',
  agentConsent: '代理人同意書.pdf',
};

const LOCATIONS = {
  daan: [['xinsheng', '新生南路三段'], ['renai4', '仁愛路四段']],
  xinyi: [['shifu', '市府路'], ['songgao', '松高路']],
  zhongzheng: [
    ['ketagalan-east', '凱達格蘭大道（公園路至中山南路）'],
    ['ketagalan-full', '凱達格蘭大道（重慶南路至中山南路全段）'],
    ['ketagalan-west', '凱達格蘭大道（重慶南路至公園路）'],
    ['zhongshan-s', '中山南路'],
    ['zhongxiao-w', '忠孝西路一段'],
    ['jingfu', '景福門圓環'],
  ],
  zhongshan: [['zhongshan-n', '中山北路一段']],
  wanhua: [['ximen', '成都路']],
};
const LOCATION_LABEL = Object.fromEntries(Object.values(LOCATIONS).flat());
const DISTRICT_LABEL = { daan: '大安區', xinyi: '信義區', zhongzheng: '中正區', zhongshan: '中山區', wanhua: '萬華區' };

// ---------- State ----------
const today = new Date();
today.setHours(0, 0, 0, 0);
const mission = makeMission();

const state = {
  player: '',
  startedAt: 0,
  penaltyMs: 0,
  errors: 0,
  running: false,
  rafId: 0,
  formData: null,
  run: null,
  runPromise: null,
  persona: makePersona(),
};

// ---------- Screens ----------
const portalScreens = ['screen-home', 'screen-login', 'screen-type', 'screen-form', 'screen-confirm'];

function showTop(which) {
  $('#screen-lobby').hidden = which !== 'lobby';
  $('#portal').hidden = which !== 'portal';
  $('#screen-result').hidden = which !== 'result';
  window.scrollTo(0, 0);
}

function showPortal(id) {
  showTop('portal');
  for (const s of portalScreens) $('#' + s).hidden = s !== id;
  window.scrollTo(0, 0);
}

function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }

// ---------- Toasts / penalties ----------
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
}

function penalize(ms, reason) {
  state.penaltyMs += ms;
  state.errors += 1;
  $('#hud-errors').textContent = state.errors;
  $('#hud-penalty').textContent = `+${Math.round(state.penaltyMs / 1000)}s`;
  toast(`${reason}（罰 ${ms / 1000} 秒）`, 'warn');
}

// ---------- Timer ----------
function elapsed() {
  return performance.now() - state.startedAt;
}

function tick() {
  $('#hud-time').textContent = formatDuration(elapsed() + state.penaltyMs);
  state.rafId = requestAnimationFrame(tick);
}

function startRun() {
  state.startedAt = performance.now();
  state.penaltyMs = 0;
  state.errors = 0;
  state.running = true;
  state.formData = null;
  $('#hud-errors').textContent = '0';
  $('#hud-penalty').textContent = '+0s';
  setHudState('running', '計時中');
  resetPortal();
  showPortal('screen-home');
  tick();
  // Open a server-timed run in the background; the local timer doesn't wait for it.
  state.run = null;
  state.runPromise = beginRun().then((run) => (state.run = run));
}

function setHudState(cls, label) {
  const hud = $('#hud');
  hud.classList.remove('running', 'done');
  if (cls) hud.classList.add(cls);
  $('#hud-state').textContent = label;
}

function stopRun() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
}

// ---------- Ending ----------
async function finish(caseNo) {
  if (!state.running) return; // guard against double-submit
  const timeMs = elapsed();
  stopRun();
  closeModal('modal-privacy');
  closeModal('modal-rules');
  const total = timeMs + state.penaltyMs;
  $('#hud-time').textContent = formatDuration(total);
  setHudState('done', '完成');
  $('#result-time').textContent = formatDuration(total);
  $('#result-breakdown').innerHTML = '';
  $('#result-rank').textContent = '成績登錄中…';
  resultPanel.clear();
  showTop('result');

  await state.runPromise;
  const res = await submitResult({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    player: state.player,
    timeMs,
    penaltyMs: state.penaltyMs,
    errors: state.errors,
    success: true,
    caseNo,
    at: new Date().toISOString(),
  }, state.run);

  const official = res.record.timeMs + res.record.penaltyMs;
  $('#result-time').textContent = formatDuration(official);
  $('#result-breakdown').innerHTML = `
    <dt>${res.online ? '伺服器計時' : '實際操作'}</dt><dd>${formatDuration(res.record.timeMs)}</dd>
    <dt>罰秒</dt><dd>+${(res.record.penaltyMs / 1000).toFixed(0)} 秒</dd>
    <dt>錯誤次數</dt><dd>${res.record.errors}</dd>
    ${res.online ? `<dt>本機計時</dt><dd>${formatDuration(total)}</dd>` : ''}
    <dt>模擬案件編號</dt><dd>${caseNo}</dd>`;
  const scope = res.online ? '線上' : '本機';
  const division = res.division;
  const bestMs = res.best.timeMs + res.best.penaltyMs;
  $('#result-rank').textContent = res.improved
    ? `${scope}${DIVISIONS[division]}：第 ${res.rank} 名（共 ${res.total} 位玩家）・個人最佳！`
    : `${scope}${DIVISIONS[division]}：個人最佳 ${formatDuration(bestMs)}，第 ${res.rank} 名（共 ${res.total} 位玩家）`;
  const why = res.division === 'supreme' ? flagReasons(res.flags || 0) : [];
  const note = [why.length ? `這次歸入至尊組：${why.join('、')}。` : '', boardNote(res)].filter(Boolean).join(' ');
  resultPanel.showResult(res, official, note);
  renderBoard();
}

function makeCaseNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return ymd + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
}

// ---------- Home → privacy → rules ----------
$('#btn-home-next').addEventListener('click', () => openModal('modal-privacy'));

$('#btn-privacy-no').addEventListener('click', () => {
  penalize(PENALTY.privacyDecline, '不同意隱私權政策將無法進行申請');
});

$('#btn-privacy-yes').addEventListener('click', () => {
  closeModal('modal-privacy');
  const body = $('#rules-body');
  body.scrollTop = 0;
  $('#btn-rules-ok').disabled = true;
  openModal('modal-rules');
});

$('#rules-body').addEventListener('scroll', (ev) => {
  const el = ev.currentTarget;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) $('#btn-rules-ok').disabled = false;
});

$('#btn-rules-ok').addEventListener('click', () => {
  closeModal('modal-rules');
  showPortal('screen-login');
  $('#login-form [name=loginId]').focus();
});

// ---------- Human check (simulated checkbox CAPTCHA) ----------
// States: idle → verifying (random latency) → verified. Expires on page change via resetHumanChecks().
function setupHumanCheck(root) {
  const box = $('.hc-box', root);
  box.addEventListener('click', () => {
    if (root.dataset.state === 'verifying' || root.dataset.state === 'verified') return;
    root.dataset.state = 'verifying';
    box.setAttribute('aria-busy', 'true');
    const wait = HUMAN_CHECK_MIN_MS + Math.random() * (HUMAN_CHECK_MAX_MS - HUMAN_CHECK_MIN_MS);
    root._timer = setTimeout(() => {
      root.dataset.state = 'verified';
      box.removeAttribute('aria-busy');
      box.setAttribute('aria-checked', 'true');
    }, wait);
  });
}

function isHumanVerified(name) {
  return $(`.human-check[data-check="${name}"]`).dataset.state === 'verified';
}

function resetHumanCheck(name) {
  const root = $(`.human-check[data-check="${name}"]`);
  clearTimeout(root._timer);
  root.dataset.state = 'idle';
  const box = $('.hc-box', root);
  box.removeAttribute('aria-busy');
  box.setAttribute('aria-checked', 'false');
}

$$('.human-check').forEach((el) => { setupHumanCheck(el); el.dataset.state = 'idle'; });

// ---------- Login ----------
$('#login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const err = $('#login-error');
  const id = f.loginId.value.trim();
  const phone = f.loginPhone.value.trim();
  if (!isValidTwId(id)) { err.textContent = '身分證字號格式錯誤'; return; }
  if (!/^09\d{8}$/.test(phone)) { err.textContent = '手機號碼格式錯誤（09 開頭共 10 碼）'; return; }
  if (!isHumanVerified('login')) {
    err.textContent = '請完成人機驗證';
    penalize(PENALTY.humanCheck, '尚未完成人機驗證');
    return;
  }
  err.textContent = '';
  // Carry login identity into the form like a real portal would.
  const form = $('#app-form');
  form.idNumber.value = id.toUpperCase();
  form.phone.value = phone;
  updateAllFakeProgress();
  showPortal('screen-type');
});

// ---------- Type ----------
$$('.type-card').forEach((btn) =>
  btn.addEventListener('click', () => {
    const t = btn.dataset.type;
    if (t === 'assembly') { showPortal('screen-form'); return; }
    if (t === 'march') penalize(PENALTY.wrongType, '凱道定點集會不需遊行路線，應選「集會申請」');
    else penalize(PENALTY.wrongType, '臨時使用道路不適用於集會活動');
  }),
);

// ---------- Form ----------
function fillTimeSelects() {
  const opts = ['<option value="">--:--</option>'];
  for (let h = 6; h <= 22; h++) {
    for (const m of ['00', '30']) {
      const v = `${String(h).padStart(2, '0')}:${m}`;
      opts.push(`<option value="${v}">${v}</option>`);
    }
  }
  $$('.time-select').forEach((s) => (s.innerHTML = opts.join('')));
  markMissionOption($('#app-form [name=startTime]'), mission.start);
  markMissionOption($('#app-form [name=endTime]'), mission.end);
}

// Highlight the option the mission asks for, and the select once it's set correctly.
function markMissionOption(sel, value) {
  sel.dataset.mission = value;
  const opt = [...sel.options].find((o) => o.value === value);
  if (opt) {
    opt.textContent = `★ ${opt.textContent}（任務指定）`;
    opt.classList.add('mission-opt');
  }
  updateMissionSelect(sel);
}

function updateMissionSelect(sel) {
  sel.classList.toggle('is-mission', !!sel.value && sel.value === sel.dataset.mission);
}

for (const sel of $$('#app-form select')) sel.addEventListener('change', () => updateMissionSelect(sel));

function fillLocations(district) {
  const sel = $('#app-form [name=location]');
  const list = LOCATIONS[district];
  if (!list) {
    sel.innerHTML = '<option value="">請先選擇行政區</option>';
    sel.disabled = true;
    updateMissionSelect(sel);
    return;
  }
  sel.innerHTML = '<option value="">請選擇</option>' + list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.disabled = false;
  markMissionOption(sel, mission.location);
}

$('#app-form [name=district]').addEventListener('change', (ev) => fillLocations(ev.target.value));

$('#app-form [name=hasAgent]').addEventListener('change', (ev) => {
  $('#agent-fields').hidden = !ev.target.checked;
  $('#agent-consent-field').hidden = !ev.target.checked;
});

function readForm() {
  const f = $('#app-form');
  const data = Object.fromEntries(new FormData(f).entries());
  data.hasAgent = f.hasAgent.checked;
  data.files = {};
  for (const box of $$('.upload[data-uploaded]', f)) {
    data.files[box.dataset.file] = UPLOAD_FILENAMES[box.dataset.file];
  }
  delete data[''];
  return data;
}

function clearErrors(form) {
  $$('.field.has-error', form).forEach((el) => el.classList.remove('has-error'));
  $$('.field-msg', form).forEach((el) => el.remove());
}

function fieldContainer(form, key) {
  if (key.startsWith('file_')) {
    const box = $(`.upload[data-file="${key.slice(5)}"]`, form);
    return box && box.closest('.field');
  }
  const wrapper = $(`[data-field="${key}"]`, form);
  if (wrapper) return wrapper;
  const input = form.elements[key];
  return input && input.closest && input.closest('.field');
}

function showErrors(form, errors) {
  clearErrors(form);
  let first = null;
  for (const [key, msg] of Object.entries(errors)) {
    const box = fieldContainer(form, key);
    if (!box) continue;
    box.classList.add('has-error');
    const p = document.createElement('small');
    p.className = 'field-msg';
    p.textContent = msg;
    box.appendChild(p);
    first ||= box;
  }
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#app-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const data = readForm();
  const errors = validateApplication(data, { today, mission });
  const count = Object.keys(errors).length;
  if (count) {
    showErrors(form, errors);
    $('#form-error').textContent = `共 ${count} 個欄位有誤，請修正後再送出。`;
    penalize(PENALTY.formRejected, '申請資料有誤，系統退回');
    return;
  }
  clearErrors(form);
  $('#form-error').textContent = '';
  state.formData = data;
  renderConfirm(data);
  showPortal('screen-confirm');
});

// ---------- Confirm ----------
function maskId(id) {
  return id.slice(0, 3) + '****' + id.slice(-3);
}

function renderConfirm(d) {
  const rows = [
    ['負責人', d.name],
    ['身分證字號', maskId(d.idNumber.toUpperCase())],
    ['聯絡電話', d.phone],
    ['電子信箱', d.email],
    ['集會目的', d.purpose],
    ['集會期間', `${d.startDate} ${d.startTime} 至 ${d.endDate} ${d.endTime}`],
    ['地點', `${DISTRICT_LABEL[d.district]}・${LOCATION_LABEL[d.location]}`],
    ['預估人數／糾察員', `${d.headcount} 人／${d.marshals} 名`],
    ['代理人', d.hasAgent ? d.agentName : '無'],
    ['附件', Object.values(d.files).join('、')],
  ];
  const dl = $('#confirm-list');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $('#confirm-agree').checked = false;
  $('#confirm-error').textContent = '';
  resetHumanCheck('submit');
}

$('#btn-back-edit').addEventListener('click', () => showPortal('screen-form'));

$('#btn-submit').addEventListener('click', () => {
  if (!$('#confirm-agree').checked) {
    $('#confirm-error').textContent = '請勾選同意聲明';
    penalize(PENALTY.confirmUnchecked, '未勾選聲明');
    return;
  }
  if (!isHumanVerified('submit')) {
    $('#confirm-error').textContent = '請完成人機驗證';
    penalize(PENALTY.humanCheck, '尚未完成人機驗證');
    return;
  }
  finish(makeCaseNo());
});

// ---------- Reset ----------
function resetPortal() {
  const form = $('#app-form');
  form.reset();
  $$('select', form).forEach(updateMissionSelect);
  clearErrors(form);
  fillLocations('');
  $('#agent-fields').hidden = true;
  $('#agent-consent-field').hidden = true;
  $('#login-form').reset();
  $('#login-error').textContent = '';
  resetHumanCheck('login');
  resetHumanCheck('submit');
  $('#form-error').textContent = '';
  $('#approved-list').innerHTML = '<tr class="empty"><td colspan="3">查無資料</td></tr>';
  $$('.upload').forEach(resetUpload);
  updateAllFakeProgress();
}

// ---------- Fake persona & fake typing ----------
// Personal-data fields ignore what the player types: each keystroke reveals the next
// character of the run's fake persona, so real personal data can never be entered.
const PERSONA_LABELS = [
  ['name', '姓名'], ['idNumber', '身分證字號'], ['birthDate', '出生日期'], ['phone', '手機／電話'],
  ['address', '通訊地址'], ['email', '電子信箱'], ['bankCode', '銀行代碼'], ['bankAccount', '帳號'],
  ['agentName', '代理人姓名'], ['agentId', '代理人身分證'], ['agentPhone', '代理人電話'],
];

function renderPersona() {
  for (const dl of $$('[data-persona-list]')) {
    dl.replaceChildren();
    for (const [key, label] of PERSONA_LABELS) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = state.persona[key];
      dl.append(dt, dd);
    }
  }
}

function newPersona() {
  state.persona = makePersona();
  renderPersona();
}

function reconcileFake(el) {
  const fake = state.persona[el.dataset.fake] || '';
  el.value = fake.slice(0, Math.min(el.value.length, fake.length));
  updateFakeProgress(el.closest('.field'));
}

// Progress hint under each auto-typed field, so players know how many keys are left.
// A field with several fake inputs (bank code + account) gets one combined hint.
function fakeProgressEl(field) {
  let el = field.querySelector(':scope > .fake-progress');
  if (!el) {
    el = document.createElement('div');
    el.className = 'fake-progress';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="bar"><i></i></span><span class="txt"></span>';
    field.appendChild(el);
  }
  return el;
}

function updateFakeProgress(field) {
  if (!field) return;
  const inputs = $$('[data-fake]', field);
  const total = inputs.reduce((n, el) => n + [...(state.persona[el.dataset.fake] || '')].length, 0);
  const typed = inputs.reduce((n, el) => n + [...el.value].length, 0);
  const done = total > 0 && typed >= total;
  const el = fakeProgressEl(field);
  el.classList.toggle('done', done);
  field.classList.toggle('fake-done', done);
  el.querySelector('i').style.width = `${total ? Math.round((typed / total) * 100) : 0}%`;
  el.querySelector('.txt').textContent = done
    ? '✓ 輸入完成'
    : typed === 0 ? `⌨️ 按任意鍵輸入，共 ${total} 字` : `⌨️ 繼續打字…還差 ${total - typed} 字`;
}

function updateAllFakeProgress() {
  new Set($$('[data-fake]').map((el) => el.closest('.field'))).forEach(updateFakeProgress);
}

for (const el of $$('[data-fake]')) {
  el.addEventListener('input', (ev) => { if (!ev.isComposing) reconcileFake(el); });
  el.addEventListener('compositionend', () => reconcileFake(el));
  el.addEventListener('paste', (ev) => ev.preventDefault());
  el.addEventListener('drop', (ev) => ev.preventDefault());
}

// ---------- Simulated uploads ----------
function resetUpload(box) {
  clearTimeout(box._timer);
  delete box.dataset.uploaded;
  delete box.dataset.state;
  $('.btn-upload', box).disabled = false;
  $('.upload-status', box).textContent = '尚未上傳';
}

$$('.upload').forEach((box) => {
  $('.btn-upload', box).addEventListener('click', () => {
    if (box.dataset.state === 'uploading' || box.dataset.uploaded) return;
    box.dataset.state = 'uploading';
    $('.btn-upload', box).disabled = true;
    $('.upload-status', box).textContent = '上傳中…';
    const wait = UPLOAD_MIN_MS + Math.random() * (UPLOAD_MAX_MS - UPLOAD_MIN_MS);
    box._timer = setTimeout(() => {
      box.dataset.state = 'done';
      box.dataset.uploaded = '1';
      $('.upload-status', box).textContent = `✓ ${UPLOAD_FILENAMES[box.dataset.file]}`;
    }, wait);
  });
});

// ---------- Lobby ----------
const BOARD_SIZE = 10;

const ERROR_NOTES = {
  too_fast: '這次完成得太快，伺服器無法採計，成績只存在本機。',
  expired: '這局超過一小時，線上成績已失效，成績只存在本機。',
  rate_limited: '開局次數太頻繁，這局未登錄線上排行榜。',
  not_started: '開局時無法連上線上排行榜，成績只存在本機。',
  daily_cap: '今天的線上排行榜登錄名額已滿，成績先存在本機，明天再來挑戰！',
};

function boardNote(res) {
  if (res.online) return '';
  if (!isOnlineConfigured()) return '';
  return ERROR_NOTES[res.error] || '線上排行榜暫時無法連線，成績只存在本機。';
}

// ---------- Leaderboard panels (histogram + 人類組/至尊組 board) ----------

/** Display ranges for the histogram; edges are multiples of the server's 5 s bins. */
const HISTO_RANGES = [
  { from: 0, to: SUPREME_MS, label: '20 秒內' },
  { from: 20_000, to: 30_000, label: '20–30 秒' },
  { from: 30_000, to: 40_000, label: '30–40 秒' },
  { from: 40_000, to: 50_000, label: '40–50 秒' },
  { from: 50_000, to: 60_000, label: '50–60 秒' },
  { from: 60_000, to: 75_000, label: '60–75 秒' },
  { from: 75_000, to: 90_000, label: '75–90 秒' },
  { from: 90_000, to: 120_000, label: '1.5–2 分' },
  { from: 120_000, to: 180_000, label: '2–3 分' },
  { from: 180_000, to: 300_000, label: '3–5 分' },
  { from: 300_000, to: 24 * 3600_000, label: '5 分以上' },
];

function histogramRows(hist) {
  const rows = HISTO_RANGES.map((r) => ({ ...r, n: 0, human: 0, supreme: 0 }));
  for (const b of hist.bins) {
    const row = rows.find((r) => b.fromMs >= r.from && b.fromMs < r.to);
    if (!row) continue;
    row.n += b.n;
    row.human += b.human ?? 0;
    row.supreme += b.supreme ?? 0;
  }
  return rows;
}

/**
 * One leaderboard panel: pinned record, tappable histogram (with "你" marker on the result
 * screen), 人類組/至尊組 tabs and a paged board. Built for touch: every control is a full-width
 * or ≥44px tap target, nothing depends on hover.
 */
/** 「總共有 x 人嘗試借用凱道」 under the title: every online run, minus the Say Goodnight seed. */
function showAttemptCount(hist) {
  const el = $('#attempt-count');
  if (!hist.online) { el.hidden = true; return; }
  const n = Math.max(0, hist.total - 1);
  el.textContent = `總共有 ${n.toLocaleString('zh-TW')} 人嘗試借用凱道`;
  el.hidden = false;
}

function makePanel(root, { onPage = () => {} } = {}) {
  const ol = $('[data-board]', root);
  const pager = $('[data-pager]', root);
  const [firstBtn, prevBtn, randomBtn, nextBtn, lastBtn] = ['first', 'prev', 'random', 'next', 'last'].map((d) => $(`[data-dir=${d}]`, pager));
  const pageCount = (page) => Math.ceil((page?.total || 0) / BOARD_SIZE);
  const info = $('.pager-info', pager);
  const tabs = $$('[data-div]', root);
  const histoEl = $('[data-histo]', root);
  let division = 'human';
  let current = null;
  let highlight = null;
  let hist = null;
  let mine = null; // official total ms of the player's own run (result screen)
  let myDivision = null;
  let openRow = null;

  function setTab(div) {
    division = div;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.div === div));
    root.dataset.division = div;
  }

  function renderBoard(page) {
    current = page;
    ol.replaceChildren();
    // Say Goodnight (#1) stays pinned on top of every page. It never changes, so it's drawn
    // from SEED_RECORDS without a database read; page 1 already has it as its first row.
    const onBoard = page.rows.some((r) => r.seed);
    const pinned = !onBoard && page.rows.length ? [{ ...SEED_RECORDS[0], rank: 1, pinned: true }] : [];
    for (const r of [...pinned, ...page.rows]) {
      const li = document.createElement('li');
      li.classList.toggle('me', !!(highlight && r.id === highlight));
      li.classList.toggle('seed', !!r.seed);
      li.classList.toggle('pinned', !!r.pinned);
      const no = document.createElement('span');
      no.className = 'rank';
      no.textContent = r.rank;
      const name = document.createElement('span');
      name.className = 'who';
      name.textContent = r.player;
      const errs = document.createElement('small');
      errs.textContent = r.errors ? `錯 ${r.errors}` : '零失誤';
      const t = document.createElement('b');
      t.textContent = formatDuration(r.timeMs + r.penaltyMs);
      li.append(no, name, errs, t);
      ol.appendChild(li);
      if (r.pinned && page.rows[0].rank > 2) {
        const gap = document.createElement('li');
        gap.className = 'gap';
        gap.setAttribute('aria-hidden', 'true');
        gap.textContent = '⋯';
        ol.appendChild(gap);
      }
    }
    if (!page.rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '這組還沒有紀錄';
      ol.appendChild(li);
    }
    const first = page.rows[0];
    const last = page.rows.at(-1);
    info.textContent = first ? `第 ${first.rank}–${last.rank} 名（共 ${page.total.toLocaleString('zh-TW')} 位玩家）` : '';
    firstBtn.disabled = prevBtn.disabled = !page.prev;
    nextBtn.disabled = lastBtn.disabled = !page.next;
    randomBtn.disabled = pageCount(page) < 2;
    pager.hidden = !page.prev && !page.next;
    $('[data-board-title]', root).textContent = `${page.online ? '線上' : '本機'}排行榜`;
    onPage(page);
  }

  async function go(params) {
    firstBtn.disabled = prevBtn.disabled = randomBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
    ol.classList.add('loading');
    try {
      renderBoard(await getLeaderboardPage({ division, ...params }));
    } finally {
      ol.classList.remove('loading');
    }
  }

  function renderHistogram() {
    if (!hist) return;
    const rows = histogramRows(hist);
    const max = Math.max(1, ...rows.map((r) => r.n));
    $('[data-histo-total]', root).textContent = `共 ${hist.total} 筆`;
    const rec = hist.record;
    const pin = $('[data-record]', root);
    pin.hidden = !rec;
    if (rec) {
      pin.innerHTML = '<span class="rp-crown" aria-hidden="true">👑</span>'
        + '<span class="rp-body"><span class="rp-label">全站最快</span><span class="rp-name"></span></span>'
        + '<span class="rp-time"></span>';
      $('.rp-name', pin).textContent = rec.player;
      $('.rp-time', pin).textContent = formatDuration(rec.timeMs + rec.penaltyMs);
      pin.setAttribute('aria-label', `全站最快：${rec.player}，${formatDuration(rec.timeMs + rec.penaltyMs)}`);
    }
    histoEl.replaceChildren();
    for (const r of rows) {
      const isMine = mine != null && mine >= r.from && mine < r.to;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `histo-row${isMine ? ' me' : ''}`;
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', `${r.label}，${r.n} 筆（人類組 ${r.human}、至尊組 ${r.supreme}）${isMine ? '，你在這裡' : ''}。點一下看暱稱`);
      btn.innerHTML = `<span class="h-label"></span><span class="h-track"><span class="h-fill h-human"></span><span class="h-fill h-supreme"></span></span><span class="h-n"></span>`;
      $('.h-label', btn).textContent = r.label;
      // Stacked: 人類組 then 至尊組, each segment at least 3px when non-zero so small counts stay visible.
      const seg = (n) => (n ? `max(3px, ${(n / max) * 100}%)` : '0');
      $('.h-human', btn).style.width = seg(r.human);
      $('.h-supreme', btn).style.width = seg(r.supreme);
      $('.h-track', btn).classList.toggle('both', r.human > 0 && r.supreme > 0);
      $('.h-n', btn).textContent = `${r.n}${isMine ? ' ◀ 你' : ''}`;
      const detail = document.createElement('div');
      detail.className = 'histo-detail';
      detail.hidden = true;
      btn.addEventListener('click', () => toggleDetail(btn, detail, r));
      histoEl.append(btn, detail);
    }
  }

  async function toggleDetail(btn, detail, r) {
    const opening = detail.hidden;
    if (openRow && openRow.detail !== detail) {
      openRow.detail.hidden = true;
      openRow.btn.setAttribute('aria-expanded', 'false');
    }
    detail.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
    openRow = opening ? { btn, detail } : null;
    if (!opening) return;
    if (!r.n) {
      detail.textContent = '這個區間還沒有人。';
      return;
    }
    const pct = hist.total ? ((r.n / hist.total) * 100).toFixed(1) : '0';
    detail.innerHTML = `<p class="d-head"></p><p class="d-names">抽樣中…</p><button type="button" class="d-more">🔀 換一批</button>`;
    $('.d-head', detail).textContent = `${r.label}・${r.n} 筆（${pct}%）・人類組 ${r.human}／至尊組 ${r.supreme}`;
    const load = async () => {
      const names = $('.d-names', detail);
      names.textContent = '抽樣中…';
      const { names: list } = await sampleNames(r.from, r.to, hist.online !== false);
      names.replaceChildren(...(list.length ? list : ['（沒有暱稱）']).map((n) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = n;
        return chip;
      }));
    };
    $('.d-more', detail).addEventListener('click', load);
    load();
  }

  async function loadHistogram() {
    hist = await getHistogram();
    renderHistogram();
    showAttemptCount(hist);
  }

  for (const t of tabs) {
    t.addEventListener('click', () => {
      if (t.dataset.div === division) return;
      setTab(t.dataset.div);
      go(highlight && myDivision === division ? { around: highlight } : { page: 'random' });
    });
  }
  prevBtn.addEventListener('click', () => current?.prev && go({ before: current.prev }));
  nextBtn.addEventListener('click', () => current?.next && go({ after: current.next }));
  firstBtn.addEventListener('click', () => current?.prev && go({}));
  lastBtn.addEventListener('click', () => current?.next && go({ last: true }));
  // Any other page, before or after this one.
  randomBtn.addEventListener('click', () => {
    const pages = pageCount(current);
    if (pages < 2) return;
    const here = Math.ceil((current.rows[0]?.rank || 1) / BOARD_SIZE);
    let n = 1 + Math.floor(Math.random() * (pages - 1));
    if (n >= here) n += 1;
    go({ page: n });
  });

  return {
    /** Lobby: histogram + a random page of the selected division (the 👑 card shows #1). */
    load() {
      mine = null;
      myDivision = null;
      highlight = null;
      return Promise.all([loadHistogram(), go({ page: 'random' })]);
    },
    /** Result screen: open the player's division on their page, mark them in the histogram. */
    showResult(res, officialMs, note) {
      mine = officialMs;
      myDivision = res.division;
      highlight = res.best.id; // the board lists the nickname's best run
      setTab(res.division);
      $('[data-note]', root).textContent = note;
      renderBoard(res.page);
      loadHistogram();
    },
    clear() {
      current = null;
      ol.replaceChildren();
      info.textContent = '';
      pager.hidden = true;
      histoEl.replaceChildren();
      $('[data-note]', root).textContent = '';
    },
  };
}

const lobbyPanel = makePanel($('[data-panel=lobby]'), {
  onPage: (page) => {
    $('[data-panel=lobby] [data-note]').textContent = page.online
      ? '伺服器計時。20 秒內完成、或不是從遊戲網頁送出的成績，歸入至尊組。'
      : isOnlineConfigured() ? '線上排行榜暫時無法連線，顯示本機紀錄。' : '成績只存在你的瀏覽器。';
  },
});
const resultPanel = makePanel($('[data-panel=result]'));

function renderBoard() {
  return lobbyPanel.load();
}

function initLobby() {
  $('#lobby-district').textContent = mission.districtLabel;
  $('#lobby-location').textContent = mission.locationLabel;
  $('#lobby-period').textContent = missionPeriodLabel(mission);
  $('#hud-mission-text').textContent = `${missionPeriodLabel(mission)}・${mission.districtLabel}・凱達格蘭大道全段`;
  const saved = localStorage.getItem('ketagalan-sim:player');
  if (saved) $('#player-name').value = saved;
  renderPersona();
  renderBoard();
}

$('#lobby-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const name = f.player.value.trim() || '匿名';
  if (isReservedName(name)) {
    toast('「Say Goodnight」是紀錄保持人的名字，請換一個暱稱', 'warn');
    f.player.focus();
    return;
  }
  state.player = name;
  localStorage.setItem('ketagalan-sim:player', state.player);
  startRun();
});

$('#hud-quit').addEventListener('click', () => {
  if (!state.running) return;
  stopRun();
  $('#hud-time').textContent = '00:00.00';
  setHudState('', '準備');
  closeModal('modal-privacy');
  closeModal('modal-rules');
  newPersona();
  showTop('lobby');
  renderBoard();
});

$('#btn-again').addEventListener('click', () => {
  $('#hud-time').textContent = '00:00.00';
  setHudState('', '準備');
  newPersona();
  showTop('lobby');
  $('#player-name').focus();
});

// Keep the HUD (and toasts under it) glued to what the player actually sees: on mobile, pinch-zoom
// and the on-screen keyboard move the visual viewport, while position:fixed stays on the layout
// viewport. Offsetting by visualViewport.offsetTop/Left and undoing the zoom pins it back on top.
function pinHudToVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const hud = $('#hud');
  const toasts = $('#toast-stack');
  let queued = false;
  const update = () => {
    queued = false;
    const moved = vv.scale !== 1 || vv.offsetTop !== 0 || vv.offsetLeft !== 0;
    hud.style.transform = moved ? `translate(${vv.offsetLeft}px, ${vv.offsetTop}px) scale(${1 / vv.scale})` : '';
    // Toasts are right-aligned: shift them so their right edge follows the visible area's right edge.
    const rightGap = document.documentElement.clientWidth - (vv.offsetLeft + vv.width);
    toasts.style.transform = moved ? `translate(${-rightGap}px, ${vv.offsetTop}px)` : '';
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
}

pinHudToVisualViewport();
updateAllFakeProgress();
fillTimeSelects();
markMissionOption($('#app-form [name=district]'), mission.district);
for (const el of $$('[data-mission]')) {
  if (el.tagName !== 'SPAN') continue;
  el.textContent = { startDate: mission.startDate, start: mission.start, endDate: mission.endDate, end: mission.end, district: mission.districtLabel, location: mission.locationLabel }[el.dataset.mission];
}
initLobby();
showTop('lobby');

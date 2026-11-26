// Pure validation helpers — no DOM access, so they can be unit-tested with `node --test`.

const LETTER_CODES = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18,
  K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27,
  U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

/** Taiwan national ID checksum (e.g. A123456789). */
export function isValidTwId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim().toUpperCase();
  if (!/^[A-Z][12]\d{8}$/.test(s)) return false;
  const code = LETTER_CODES[s[0]];
  const digits = [Math.floor(code / 10), code % 10, ...s.slice(1).split('').map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 10 === 0;
}

/** Parse "YYYY-MM-DD" into a local-midnight Date, or null. */
export function parseDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** Whole calendar days from `from` to `to`. */
export function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

export function ageOn(birth, onDate) {
  let age = onDate.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    onDate.getMonth() < birth.getMonth() ||
    (onDate.getMonth() === birth.getMonth() && onDate.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function isValidPhone(s) {
  const v = (s || '').replace(/[\s-]/g, '');
  return /^09\d{8}$/.test(v) || /^0[2-8]\d{7,8}$/.test(v);
}

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
}

/** 3-digit bank code + 10–16 digit account number. */
export function isValidBankAccount(code, account) {
  return /^\d{3}$/.test(code || '') && /^\d{10,16}$/.test((account || '').replace(/-/g, ''));
}

/** "HH:MM" → minutes, or NaN. */
export function toMinutes(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export const MIN_AGE = 20;

/**
 * Validate the application form against the rules and the mission.
 * Returns an object { fieldName: errorMessage }. Empty object = valid.
 */
export function validateApplication(f, { today, mission }) {
  const e = {};
  const req = (key, label) => {
    if (!f[key] || !String(f[key]).trim()) e[key] = `請填寫${label}`;
  };

  // 申請人
  req('name', '姓名');
  if (!isValidTwId(f.idNumber)) e.idNumber = '身分證字號格式錯誤';
  const birth = parseDate(f.birthDate);
  if (!birth) e.birthDate = '請選擇出生日期';
  else if (ageOn(birth, today) < MIN_AGE) e.birthDate = `負責人須年滿 ${MIN_AGE} 歲`;
  req('address', '通訊地址');
  if (!isValidPhone(f.phone)) e.phone = '聯絡電話格式錯誤';
  if (!isValidEmail(f.email)) e.email = '電子信箱格式錯誤';
  if (!isValidBankAccount(f.bankCode, f.bankAccount)) e.bankAccount = '銀行代碼須 3 碼、帳號須 10–16 碼數字';

  // 集會內容
  req('purpose', '集會目的');
  if (f.purpose && f.purpose.trim().length < 10) e.purpose = '集會目的請至少填寫 10 個字';
  // 集會期間（可跨日）
  const startDate = parseDate(f.startDate);
  const endDate = parseDate(f.endDate);
  if (!startDate) e.startDate = '請選擇集會起日';
  else if (mission && f.startDate !== mission.startDate) e.startDate = `任務起日為 ${mission.startDate}`;
  if (!endDate) e.endDate = '請選擇集會迄日';
  else if (startDate && endDate < startDate) e.endDate = '迄日不可早於起日';
  else if (mission && f.endDate !== mission.endDate) e.endDate = `任務迄日為 ${mission.endDate}`;

  const start = toMinutes(f.startTime);
  const end = toMinutes(f.endTime);
  if (Number.isNaN(start)) e.startTime = '請選擇開始時間';
  else if (mission && f.startTime !== mission.start) e.startTime = `任務開始時間為 ${mission.start}`;
  if (Number.isNaN(end)) e.endTime = '請選擇結束時間';
  else if (startDate && endDate && !Number.isNaN(start) && daysBetween(startDate, endDate) * 1440 + end - start <= 0)
    e.endTime = '結束時間須晚於開始時間';
  else if (mission && f.endTime !== mission.end) e.endTime = `任務結束時間為 ${mission.end}`;

  if (!f.district) e.district = '請選擇行政區';
  else if (mission && f.district !== mission.district) e.district = `任務指定行政區為${mission.districtLabel}`;
  if (!f.location) e.location = '請選擇路段';
  else if (mission && f.location !== mission.location) e.location = '這不是任務指定的路段';

  const people = Number(f.headcount);
  if (!Number.isInteger(people) || people < 1) e.headcount = '請填寫預估人數';

  // 糾察員：每 50 人至少 1 名
  const marshals = Number(f.marshals);
  const needMarshals = Math.max(1, Math.ceil((people || 0) / 50));
  if (!Number.isInteger(marshals) || marshals < needMarshals) e.marshals = `依預估人數，糾察員至少需 ${needMarshals} 名`;

  // 代理人
  if (f.hasAgent) {
    req('agentName', '代理人姓名');
    if (!isValidTwId(f.agentId)) e.agentId = '代理人身分證字號格式錯誤';
    else if (f.agentId.toUpperCase() === (f.idNumber || '').toUpperCase()) e.agentId = '代理人不可與申請人相同';
    if (!isValidPhone(f.agentPhone)) e.agentPhone = '代理人電話格式錯誤';
  }

  // 附件
  const files = f.files || {};
  for (const [key, label] of REQUIRED_FILES) {
    if (!files[key]) e[`file_${key}`] = `請上傳${label}`;
  }
  if (f.hasAgent && !files.agentConsent) e.file_agentConsent = '請上傳代理人同意書';

  return e;
}

export const REQUIRED_FILES = [
  ['applicationForm', '集會申請書'],
  ['venueConsent', '場地管理機關同意文件'],
  ['idCopy', '身分證影本'],
  ['marshalRoster', '糾察員名冊'],
];

/** Fixed mission: full stretch of 凱達格蘭大道, 2026-11-25 08:00 to 2026-11-27 22:00. */
export function makeMission() {
  return {
    startDate: '2026-11-25',
    start: '08:00',
    endDate: '2026-11-27',
    end: '22:00',
    district: 'zhongzheng',
    districtLabel: '中正區',
    location: 'ketagalan-full',
    locationLabel: '凱達格蘭大道（重慶南路至中山南路全段）',
  };
}

export function missionPeriodLabel(m) {
  return `${m.startDate} ${m.start} 至 ${m.endDate} ${m.end}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ---------- Fake persona (so players never type real personal data) ----------

const ID_LETTERS = Object.keys(LETTER_CODES);
const FAKE_SURNAMES = ['王', '陳', '林', '張', '李', '黃', '吳', '劉'];
const FAKE_GIVEN = ['小明', '大文', '美麗', '志明', '春嬌', '阿宏', '佳佳', '建國'];
const FAKE_STREETS = ['模擬路', '測試街', '範例大道', '虛構巷'];

/** Generate a checksum-valid but fictional Taiwan ID. `rng` returns [0, 1). */
export function generateFakeId(rng = Math.random) {
  const letter = ID_LETTERS[Math.floor(rng() * ID_LETTERS.length)];
  const code = LETTER_CODES[letter];
  const body = [rng() < 0.5 ? 1 : 2];
  for (let i = 0; i < 7; i++) body.push(Math.floor(rng() * 10));
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const partial = [Math.floor(code / 10), code % 10, ...body].reduce((acc, d, i) => acc + d * weights[i], 0);
  const check = (10 - (partial % 10)) % 10;
  return letter + body.join('') + check;
}

function digits(rng, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rng() * 10);
  return s;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function makePersona(rng = Math.random) {
  const name = pick(rng, FAKE_SURNAMES) + pick(rng, FAKE_GIVEN);
  let agentName = name;
  while (agentName === name) agentName = pick(rng, FAKE_SURNAMES) + pick(rng, FAKE_GIVEN);
  const idNumber = generateFakeId(rng);
  let agentId = idNumber;
  while (agentId === idNumber) agentId = generateFakeId(rng);
  const year = 1960 + Math.floor(rng() * 40); // always ≥ 20 years old
  const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(rng() * 28)).padStart(2, '0');
  return {
    name,
    idNumber,
    birthDate: `${year}-${month}-${day}`,
    phone: '09' + digits(rng, 8),
    address: `臺北市中正區${pick(rng, FAKE_STREETS)}${1 + Math.floor(rng() * 200)}號`,
    email: `player${digits(rng, 4)}@example.com`,
    bankCode: '000',
    bankAccount: digits(rng, 12),
    agentName,
    agentId,
    agentPhone: '09' + digits(rng, 8),
  };
}

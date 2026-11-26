import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTwId, ageOn, daysBetween, parseDate, isValidPhone, isValidBankAccount,
  validateApplication, makeMission, formatDuration,
} from '../js/validators.js';

const today = new Date(2026, 10, 26);
const mission = makeMission();

function validForm(overrides = {}) {
  return {
    name: '王小明', idNumber: 'A123456789', birthDate: '1990-01-01', address: '臺北市中正區某路 1 號',
    phone: '0912345678', email: 'test@example.com', bankCode: '700', bankAccount: '0001234567890',
    purpose: '這是一個測試用的集會目的說明', startDate: '2026-11-25', startTime: '08:00', endDate: '2026-11-27', endTime: '22:00',
    district: 'zhongzheng', location: 'ketagalan-full', headcount: '100', marshals: '2', hasAgent: false,
    files: { applicationForm: 'a.pdf', venueConsent: 'b.pdf', idCopy: 'c.jpg', marshalRoster: 'd.xlsx' },
    ...overrides,
  };
}

test('TW ID checksum', () => {
  assert.equal(isValidTwId('A123456789'), true);
  assert.equal(isValidTwId('a123456789'), true);
  assert.equal(isValidTwId('A123456788'), false);
  assert.equal(isValidTwId('A323456789'), false);
  assert.equal(isValidTwId(''), false);
});

test('age and day math', () => {
  assert.equal(ageOn(parseDate('2006-11-27'), today), 19);
  assert.equal(ageOn(parseDate('2006-11-26'), today), 20);
  assert.equal(daysBetween(today, parseDate('2026-12-02')), 6);
  assert.equal(parseDate('2026-02-30'), null);
});

test('phone and bank', () => {
  assert.ok(isValidPhone('0912-345-678'));
  assert.ok(isValidPhone('0223456789'));
  assert.ok(!isValidPhone('12345'));
  assert.ok(isValidBankAccount('700', '0001234567'));
  assert.ok(!isValidBankAccount('70', '0001234567'));
});

test('mission is the fixed 2026-11-25 08:00 – 2026-11-27 22:00 slot', () => {
  assert.deepEqual([mission.startDate, mission.start, mission.endDate, mission.end], ['2026-11-25', '08:00', '2026-11-27', '22:00']);
});

test('valid form passes', () => {
  assert.deepEqual(validateApplication(validForm(), { today, mission }), {});
});

test('mission dates/times', () => {
  const v = (o) => validateApplication(validForm(o), { today, mission });
  assert.equal(v({}).startDate, undefined); // no advance-notice rule: a slot that already started is fine
  assert.match(v({ startDate: '2026-11-26' }).startDate, /任務起日/);
  assert.match(v({ endDate: '2026-11-24' }).endDate, /迄日不可早於起日/);
  assert.match(v({ endDate: '2026-11-28' }).endDate, /任務迄日/);
  assert.match(v({ startTime: '09:00' }).startTime, /08:00/);
  assert.match(v({ endTime: '21:00' }).endTime, /22:00/);
  assert.match(v({ endDate: '2026-11-25', endTime: '07:00' }).endTime, /晚於/);
});

test('underage, marshal ratio, wrong road, missing file', () => {
  const e = validateApplication(validForm({
    birthDate: '2010-01-01', marshals: '1', location: 'ketagalan-east', files: {},
  }), { today, mission });
  assert.ok(e.birthDate && e.marshals && e.location && e.file_applicationForm);
});

test('agent required fields and consent', () => {
  const e = validateApplication(validForm({ hasAgent: true, agentId: 'A123456789' }), { today, mission });
  assert.ok(e.agentName && e.agentId && e.agentPhone && e.file_agentConsent);
});

test('formatDuration', () => {
  assert.equal(formatDuration(83456), '01:23.45');
});

import { generateFakeId, makePersona } from '../js/validators.js';

test('generated fake IDs are checksum-valid', () => {
  for (let i = 0; i < 500; i++) assert.ok(isValidTwId(generateFakeId()));
});

test('persona passes form validation', () => {
  for (let i = 0; i < 50; i++) {
    const p = makePersona();
    const e = validateApplication(validForm({ ...p, hasAgent: true,
      files: { applicationForm: 1, venueConsent: 1, idCopy: 1, marshalRoster: 1, agentConsent: 1 } }), { today, mission });
    assert.deepEqual(e, {}, JSON.stringify(p));
  }
});

test('mission district is 中正區 and enforced', () => {
  assert.equal(mission.districtLabel, '中正區');
  const e = validateApplication(validForm({ district: 'daan' }), { today, mission });
  assert.match(e.district, /中正區/);
});

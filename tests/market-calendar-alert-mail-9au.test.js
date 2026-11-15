'use strict';

// 9AU Build 3: the calendar refresh alert email. Injected fake fetch and a mocked engine only: no
// network, no real mail, no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const {SETTINGS_REGISTRY, settingValue, isEmailFormat} = require('../lib/settings-registry');
const {buildAlert, alertEmailConfig, sendCalendarAlert, BODY_LIMIT, RESEND_URL} = require('../lib/calendar-alert-mail');
const {runCalendarRefresh} = require('../lib/market-calendar-refresh-job');

const KEY = 're_test_key_8c1d2e';
const TO = 'kevin@example.test';
const FROM = 'alerts@example.test';
const ON = Object.freeze({
  CALENDAR_ALERT_EMAIL_ENABLED: 'true', CALENDAR_ALERT_EMAIL_TO: TO, CALENDAR_ALERT_EMAIL_FROM: FROM,
  RESEND_API_KEY: KEY
});
const NOW = Date.parse('2026-11-02T01:00:00Z');
const OK = Object.freeze({ok: true, status: 200});

function fakeMail(response = OK) {
  const calls = [];
  const fn = async (url, options) => { calls.push({url, options}); return response; };
  fn.calls = calls;
  return fn;
}

const rows = [];
const runtime = {
  async transaction(cb) { return cb({async query() { return {rows}; }}); }
};

function saved(market, year, extra = {}) {
  return {market, year, status: 'SAVED', source: 'OFFICIAL', saved: {inserted: 0, updated: 0, retired: 0},
    heldChanges: [], errors: [], ...extra};
}
function failed(market, year, codes) {
  return {market, year, status: 'ERROR', source: null, saved: {inserted: 0, updated: 0, retired: 0},
    heldChanges: [], errors: codes.map(code => ({code}))};
}

// A run where each market-year gets the result the given function returns.
async function run(resultFor, {env = ON, mail = fakeMail(), logs = []} = {}) {
  const out = await runCalendarRefresh({
    env, runtime, now: () => NOW, clock: () => NOW, log: line => logs.push(line), mailFetchImpl: mail,
    refreshMarketYear: async ({market, year}) => resultFor(market, year)
  });
  return {out, mail, logs};
}
const quiet = (market, year) => saved(market, year);

test('settings: three new Admin settings, switch off, addresses empty', () => {
  assert.equal(SETTINGS_REGISTRY.calendarAlertEmailEnabled.default, false);
  assert.equal(SETTINGS_REGISTRY.calendarAlertEmailEnabled.boolean, true);
  for (const name of ['calendarAlertEmailTo', 'calendarAlertEmailFrom']) {
    assert.equal(SETTINGS_REGISTRY[name].text, true, name);
    assert.equal(SETTINGS_REGISTRY[name].default, '', name);
    assert.equal(SETTINGS_REGISTRY[name].admin, 'Admin', name);
  }
  assert.equal(settingValue('calendarAlertEmailEnabled', {env: {}}), false);
  assert.equal(settingValue('calendarAlertEmailTo', {env: {}}), '');
});

test('settings: the email format check accepts good addresses and rejects bad ones', () => {
  assert.equal(isEmailFormat('a@b.co'), true);
  assert.equal(isEmailFormat('MarketBrief <a@b.co>'), true);
  for (const bad of ['', 'nope', 'a@b', 'a b@c.co', 'a@b.co, c@d.co', '<a@b.co>', 5, null]) {
    assert.equal(isEmailFormat(bad), false, String(bad));
  }
  assert.equal(settingValue('calendarAlertEmailTo', {env: {CALENDAR_ALERT_EMAIL_TO: ' me@x.co '}}), 'me@x.co');
  assert.equal(settingValue('calendarAlertEmailTo', {env: {CALENDAR_ALERT_EMAIL_TO: 'not an email'}}), '');
  assert.equal(settingValue('calendarAlertEmailFrom', {env: {CALENDAR_ALERT_EMAIL_FROM: 'x'}}), '');
});

test('no event: no email, even with everything configured', async () => {
  const {mail, logs} = await run(quiet);
  assert.equal(mail.calls.length, 0);
  assert.equal(logs.length, 1); // the normal run line only
});

test('a market-year read from no source sends one email', async () => {
  const {mail} = await run((m, y) => (m === 'HK' && y === 2027 ? failed(m, y, ['FETCH_FAILED', 'BOTH_SOURCES_FAILED']) : saved(m, y)));
  assert.equal(mail.calls.length, 1);
  const {url, options} = mail.calls[0];
  assert.equal(url, RESEND_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(options.body);
  assert.deepEqual(body.to, [TO]);
  assert.equal(body.from, FROM);
  assert.match(body.subject, /^MarketBrief calendar:/);
  assert.match(body.text, /COULD NOT READ/);
  assert.match(body.text, /HK 2027/);
});

test('a held change is listed with market, year, date, old and new value', async () => {
  const held = [{date: '2026-12-24', change: 'UPDATE',
    from: {kind: 'EARLY_CLOSE', name: 'PAGE TEXT MUST NOT APPEAR', earlyCloseTime: '13:00'},
    to: {kind: 'HOLIDAY', name: 'x', earlyCloseTime: null}}];
  const {mail} = await run((m, y) => (m === 'US' && y === 2026 ? saved(m, y, {heldChanges: held}) : saved(m, y)));
  assert.equal(mail.calls.length, 1);
  const text = JSON.parse(mail.calls[0].options.body).text;
  assert.match(text, /CHANGE HELD/);
  assert.match(text, /US 2026 2026-12-24: EARLY_CLOSE close 13:00 -> HOLIDAY/);
  assert.doesNotMatch(text, /PAGE TEXT/);
});

test('applied changes are listed with date, old and new value', async () => {
  const applied = [
    {date: '2027-05-03', change: 'UPDATE', from: {kind: 'HOLIDAY'}, to: {kind: 'EARLY_CLOSE', earlyCloseTime: '12:30'}},
    {date: '2027-08-30', change: 'RETIRE', from: {kind: 'HOLIDAY'}, to: null}
  ];
  const {mail} = await run((m, y) => (m === 'UK' && y === 2027
    ? saved(m, y, {saved: {inserted: 0, updated: 1, retired: 1}, appliedChanges: applied}) : saved(m, y)));
  const text = JSON.parse(mail.calls[0].options.body).text;
  assert.match(text, /CHANGES APPLIED/);
  assert.match(text, /UK 2027 2027-05-03: HOLIDAY -> EARLY_CLOSE close 12:30/);
  assert.match(text, /UK 2027 2027-08-30: HOLIDAY -> removed/);
});

test('applied changes without detail fall back to a count', async () => {
  const {mail} = await run((m, y) => (m === 'UK' && y === 2027
    ? saved(m, y, {saved: {inserted: 0, updated: 1, retired: 1}}) : saved(m, y)));
  assert.match(JSON.parse(mail.calls[0].options.body).text, /UK 2027: 2 date\(s\) changed or removed/);
});

test('too many changes is an email trigger and shows the count and the limit', async () => {
  const {mail} = await run((m, y) => (m === 'US' && y === 2027
    ? {...failed(m, y, []), errors: [{code: 'TOO_MANY_CHANGES', count: 7, limit: 3}]} : saved(m, y)));
  assert.equal(mail.calls.length, 1);
  const {text, subject} = JSON.parse(mail.calls[0].options.body);
  assert.match(text, /TOO MANY CHANGES[^]*US 2027: 7 changes, limit 3/);
  assert.match(subject, /too many changes/);
});

test('a cleared second-source flag is logged once per date and sends no email', async () => {
  const {mail, logs} = await run((m, y) => (m === 'US' && y === 2027
    ? saved(m, y, {clearedFlags: [{date: '2027-01-18'}]}) : saved(m, y)));
  assert.equal(mail.calls.length, 0);
  const lines = logs.filter(line => /flag cleared/.test(line.message || ''));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].market, lines[0].year, lines[0].date], ['US', 2027, '2027-01-18']);
});

test('inserted dates alone are not an event', async () => {
  const {mail} = await run((m, y) => saved(m, y, {saved: {inserted: 11, updated: 0, retired: 0}}));
  assert.equal(mail.calls.length, 0);
});

test('a year rejected by the sanity check is reported; a rolling-page partial year is not', async () => {
  const sanity = (m, y) => (m === 'US' && y === 2027 ? failed(m, y, ['HOLIDAY_COUNT_OUT_OF_RANGE', 'SANITY_CHECK_FAILED']) : saved(m, y));
  const {mail} = await run(sanity);
  assert.equal(mail.calls.length, 1);
  assert.match(JSON.parse(mail.calls[0].options.body).text, /YEAR REJECTED[^]*US 2027/);

  const partial = (m, y) => (m === 'US' && y === 2026
    ? {market: m, year: y, status: 'ERROR', errors: [{code: 'HOLIDAY_COUNT_OUT_OF_RANGE', count: 5, min: 9, max: 11}, {code: 'SANITY_CHECK_FAILED'}]}
    : saved(m, y));
  const second = await run(partial);
  assert.equal(second.mail.calls.length, 0);
});

test('write errors alone send no email (not in the approved list)', async () => {
  const {mail} = await run((m, y) => failed(m, y, ['WRITE_FAILED']));
  assert.equal(mail.calls.length, 0);
});

test('several events go in ONE email', async () => {
  const {mail} = await run((m, y) => {
    if (m === 'HK') return failed(m, y, ['BOTH_SOURCES_FAILED']);
    if (m === 'US' && y === 2026) return saved(m, y, {heldChanges: [{date: '2026-11-26', change: 'RETIRE', from: {kind: 'HOLIDAY'}, to: null}]});
    return saved(m, y);
  });
  assert.equal(mail.calls.length, 1);
  const {text, subject} = JSON.parse(mail.calls[0].options.body);
  assert.match(text, /COULD NOT READ[^]*HK 2026[^]*HK 2027/);
  assert.match(text, /HOLIDAY -> removed/);
  assert.match(subject, /could not read, change held/);
});

test('the body is capped near 2,000 characters', () => {
  const events = [];
  for (let i = 0; i < 80; i++) {
    events.push({category: 'HELD', market: 'US', year: 2026, date: '2026-11-26',
      from: {kind: 'HOLIDAY'}, to: {kind: 'EARLY_CLOSE', earlyCloseTime: '13:00'}});
  }
  const {text} = buildAlert(events);
  assert.ok(text.length <= BODY_LIMIT, String(text.length));
  assert.match(text, /more events not shown/);
});

test('the body and request never hold the database address, a secret or page text', async () => {
  const env = {...ON, DATABASE_URL: 'postgres://u:p-secret-77@db.invalid/x', CRON_SECRET: 'cron-zzz'};
  const {mail} = await run((m, y) => (m === 'SG' ? failed(m, y, ['BOTH_SOURCES_FAILED']) : saved(m, y)), {env});
  const body = mail.calls[0].options.body;
  for (const secret of [KEY, 'p-secret-77', 'cron-zzz', 'postgres://']) assert.ok(!body.includes(secret), secret);
});

test('switch off: no email and no log line about it', async () => {
  const env = {...ON, CALENDAR_ALERT_EMAIL_ENABLED: 'false'};
  const {mail, logs} = await run((m, y) => failed(m, y, ['BOTH_SOURCES_FAILED']), {env});
  assert.equal(mail.calls.length, 0);
  assert.ok(!logs.some(line => line.stage === 'calendarAlertEmail'));
});

test('switch on but To, From or the key is missing: nothing sent, one "not configured" line, job continues', async () => {
  for (const drop of ['CALENDAR_ALERT_EMAIL_TO', 'CALENDAR_ALERT_EMAIL_FROM', 'RESEND_API_KEY']) {
    const env = {...ON};
    delete env[drop];
    const {mail, logs, out} = await run((m, y) => failed(m, y, ['BOTH_SOURCES_FAILED']), {env});
    assert.equal(mail.calls.length, 0, drop);
    const lines = logs.filter(line => line.stage === 'calendarAlertEmail');
    assert.equal(lines.length, 1, drop);
    assert.equal(lines[0].message, 'alert email not configured');
    assert.equal(out.result, 'ran');
  }
});

test('a failed send never fails the job; one line, no address or key', async () => {
  for (const mail of [fakeMail({ok: false, status: 403}), async () => { throw new Error(`boom ${KEY} ${TO}`); }]) {
    const logs = [];
    const {out} = await run((m, y) => failed(m, y, ['BOTH_SOURCES_FAILED']), {mail, logs});
    assert.equal(out.result, 'ran');
    const lines = logs.filter(line => line.stage === 'calendarAlertEmail');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].message, 'alert email send failed');
    const text = JSON.stringify([lines, out]);
    for (const secret of [KEY, TO, FROM]) assert.ok(!text.includes(secret), secret);
  }
});

test('the job result never carries the addresses or the key', async () => {
  const {out} = await run((m, y) => failed(m, y, ['BOTH_SOURCES_FAILED']));
  const text = JSON.stringify(out);
  for (const secret of [KEY, TO, FROM]) assert.ok(!text.includes(secret), secret);
});

test('sendCalendarAlert direct: no events, disabled, and a thrown fetch all stay quiet', async () => {
  assert.deepEqual(await sendCalendarAlert({events: [], env: ON, fetchImpl: fakeMail()}), {sent: false, reason: 'no_events'});
  const events = [{category: 'UNREADABLE', market: 'US', year: 2026}];
  assert.equal((await sendCalendarAlert({events, env: {}, fetchImpl: fakeMail()})).reason, 'disabled');
  assert.equal((await sendCalendarAlert({events, env: ON, fetchImpl: fakeMail()})).sent, true);
  assert.equal(alertEmailConfig({}).enabled, false);
});

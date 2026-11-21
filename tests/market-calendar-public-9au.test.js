'use strict';

// 9AU Build 5A: the read-only public calendar route. Fake database only: no network, no real
// database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');
const pgRuntime = require('../lib/postgres-runtime');
const {handleHolidayCalendar, PUBLIC_CALENDAR_QUERY} = require('../lib/market-calendar-public');

const ON = Object.freeze({HOLIDAY_CALENDAR_DB_ENABLED: 'true'});
const SECRET_URL = 'postgres://main-user:main-pass-91b2@db.invalid/main';

function year(market, y, extra = {}) {
  return {market, year: y, year_source: 'OFFICIAL', year_fetched_at: new Date('2026-11-01T01:00:00Z'),
    calendar_date: null, kind: null, name: null, early_close_time: null, after_hours_end: null,
    source_url: null, needs_review: false, ...extra};
}
function day(market, y, date, kind, name, extra = {}) {
  return year(market, y, {calendar_date: date, kind, name, source_url: `https://example.invalid/${market}`, ...extra});
}
function fakeRuntime(rows, {fail} = {}) {
  const runtime = {queries: [], async query(sql) {
    runtime.queries.push(sql);
    if (fail) { const e = new Error(`down ${SECRET_URL}`); e.code = 'ECONNREFUSED'; throw e; }
    return {rows};
  }};
  return runtime;
}
function fakeRes() {
  const res = {headers: {}, statusCode: null, body: null};
  res.setHeader = (n, v) => { res.headers[n] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
const quiet = () => {};

test('switch off: available false, reason switch_off, database never read', async () => {
  const runtime = fakeRuntime([day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')]);
  const r = await handleHolidayCalendar({env: {}, runtime, log: quiet});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {available: false, reason: 'switch_off'});
  assert.equal(runtime.queries.length, 0);
});

test('database failure: 200 with database_unavailable; no error text or address leaks', async () => {
  const lines = [];
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime([], {fail: true}), log: l => lines.push(l)});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {available: false, reason: 'database_unavailable'});
  assert.ok(!JSON.stringify(r).includes('main-pass'));
  assert.ok(!JSON.stringify(lines).includes('main-pass'));
});

test('no complete year: available false, reason no_complete_year', async () => {
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime([]), log: quiet});
  assert.deepEqual(r.body, {available: false, reason: 'no_complete_year'});
  assert.equal(r.status, 200);
});

test('the query reads only COMPLETE years and live days, in one query', async () => {
  assert.match(PUBLIC_CALENDAR_QUERY, /status = 'COMPLETE'/);
  assert.match(PUBLIC_CALENDAR_QUERY, /retired_at IS NULL/);
  assert.match(PUBLIC_CALENDAR_QUERY, /^\s*SELECT/);
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(PUBLIC_CALENDAR_QUERY));
  const runtime = fakeRuntime([day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')]);
  await handleHolidayCalendar({env: ON, runtime, log: quiet});
  assert.equal(runtime.queries.length, 1);
});

test('an incomplete year (not returned by the query) is left out; a broken year is dropped whole', async () => {
  const rows = [
    day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day'),
    day('US', 2027, '2027-01-01', 'HOLIDAY', 'New Year'),
    day('US', 2027, '2027-13-45', 'HOLIDAY', 'Bad date')
  ];
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime(rows), log: quiet});
  assert.deepEqual(Object.keys(r.body.markets.US), ['2026']);
});

test('retired rows are left out (the query filters them; a stray retired row never appears)', async () => {
  assert.match(PUBLIC_CALENDAR_QUERY, /d\.retired_at IS NULL/);
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime([
    day('SG', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')]), log: quiet});
  assert.deepEqual(Object.keys(r.body.markets.SG[2026].holidays), ['2026-12-25']);
});

test('all four markets, with the documented shape', async () => {
  const rows = [
    day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day'),
    day('SG', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day'),
    day('HK', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day'),
    day('UK', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')
  ];
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime(rows), log: quiet});
  assert.equal(r.body.available, true);
  assert.deepEqual(Object.keys(r.body.markets).sort(), ['HK', 'SG', 'UK', 'US']);
  assert.deepEqual(r.body.markets.UK[2026], {
    holidays: {'2026-12-25': {name: 'Christmas Day'}},
    earlyCloses: {},
    source: 'OFFICIAL',
    sourceUrl: 'https://example.invalid/UK',
    fetchedAt: '2026-11-01T01:00:00.000Z',
    needsReview: []
  });
  assert.equal(r.cacheControl, 'public, max-age=3600');
});

test('a market with no complete year is an empty object', async () => {
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime([
    day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')]), log: quiet});
  assert.deepEqual(r.body.markets.HK, {});
});

test('half days with and without an after-hours end; halfDaysEnabled follows earlyCloseDaysEnabled', async () => {
  const rows = [
    day('US', 2026, '2026-11-27', 'EARLY_CLOSE', 'Day after Thanksgiving', {early_close_time: '13:00', after_hours_end: '17:00'}),
    day('UK', 2026, '2026-12-24', 'EARLY_CLOSE', 'Christmas Eve', {early_close_time: '12:30'})
  ];
  const on = await handleHolidayCalendar({env: {...ON, EARLY_CLOSE_DAYS_ENABLED: 'true'}, runtime: fakeRuntime(rows), log: quiet});
  assert.equal(on.body.halfDaysEnabled, true);
  assert.deepEqual(on.body.markets.US[2026].earlyCloses['2026-11-27'],
    {name: 'Day after Thanksgiving', close: '13:00', afterHoursEnd: '17:00'});
  assert.deepEqual(on.body.markets.UK[2026].earlyCloses['2026-12-24'],
    {name: 'Christmas Eve', close: '12:30', afterHoursEnd: null});
  const off = await handleHolidayCalendar({env: {...ON, EARLY_CLOSE_DAYS_ENABLED: 'false'}, runtime: fakeRuntime(rows), log: quiet});
  assert.equal(off.body.halfDaysEnabled, false);
});

test('review flags are listed by date; SECOND source is reported', async () => {
  const rows = [
    year('HK', 2027, {year_source: 'SECOND'}),
    day('HK', 2027, '2027-02-06', 'HOLIDAY', 'Lunar New Year', {year_source: 'SECOND', needs_review: true}),
    day('HK', 2027, '2027-05-01', 'HOLIDAY', 'Labour Day', {year_source: 'SECOND'})
  ];
  const r = await handleHolidayCalendar({env: ON, runtime: fakeRuntime(rows), log: quiet});
  assert.equal(r.body.markets.HK[2027].source, 'SECOND');
  assert.deepEqual(r.body.markets.HK[2027].needsReview, ['2027-02-06']);
});

test('nothing secret in the answer: no email, no database address, no settings but halfDaysEnabled', async () => {
  const saved = {...process.env};
  Object.assign(process.env, {
    DATABASE_URL: SECRET_URL, RESEND_API_KEY: 're_secret_key_1', CRON_SECRET: 'cron-secret-1',
    CALENDAR_ALERT_EMAIL_TO: 'kevin@example.invalid'
  });
  try {
    const r = await handleHolidayCalendar({env: {...process.env, ...ON}, log: quiet,
      runtime: fakeRuntime([day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')])});
    const text = JSON.stringify(r);
    for (const bad of ['main-pass', 're_secret_key_1', 'cron-secret-1', 'kevin@example.invalid', 'postgres://']) {
      assert.ok(!text.includes(bad), bad);
    }
    assert.deepEqual(Object.keys(r.body).sort(), ['available', 'halfDaysEnabled', 'markets']);
  } finally {
    for (const k of ['DATABASE_URL', 'RESEND_API_KEY', 'CRON_SECRET', 'CALENDAR_ALERT_EMAIL_TO']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// ---- the route in api/quote.js ----

async function callRoute(req, rows, envPatch = {}) {
  const handler = require('../api/quote');
  const original = pgRuntime.getPostgresRuntime;
  const saved = {};
  for (const [k, v] of Object.entries(envPatch)) { saved[k] = process.env[k]; process.env[k] = v; }
  const runtime = fakeRuntime(rows);
  pgRuntime.getPostgresRuntime = () => runtime;
  const res = fakeRes();
  try { await handler(req, res); } finally {
    pgRuntime.getPostgresRuntime = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return {res, runtime};
}

test('route: GET answers 200 with CORS and a one-hour cache; switch off is a plain 200', async () => {
  const rows = [day('US', 2026, '2026-12-25', 'HOLIDAY', 'Christmas Day')];
  const on = await callRoute({method: 'GET', query: {holidayCalendar: '1'}, headers: {}}, rows, {HOLIDAY_CALENDAR_DB_ENABLED: 'true'});
  assert.equal(on.res.statusCode, 200);
  assert.equal(on.res.body.available, true);
  assert.equal(on.res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(on.res.headers['Cache-Control'], 'public, max-age=3600');
  const off = await callRoute({method: 'GET', query: {holidayCalendar: '1'}, headers: {}}, rows, {HOLIDAY_CALENDAR_DB_ENABLED: 'false'});
  assert.equal(off.res.statusCode, 200);
  assert.deepEqual(off.res.body, {available: false, reason: 'switch_off'});
  assert.equal(off.runtime.queries.length, 0);
});

test('route: POST, PUT and DELETE are refused and never read or write', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const {res, runtime} = await callRoute({method, query: {holidayCalendar: '1'}, headers: {}, body: {x: 1}}, [],
      {HOLIDAY_CALENDAR_DB_ENABLED: 'true'});
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.Allow, 'GET, OPTIONS');
    assert.equal(runtime.queries.length, 0);
  }
});

test('route: OPTIONS is still the normal preflight; other routes are unchanged', async () => {
  const pre = await callRoute({method: 'OPTIONS', query: {holidayCalendar: '1'}, headers: {}}, []);
  assert.equal(pre.res.statusCode, 200);
  const bad = await callRoute({method: 'POST', query: {newsMateriality: '1'}, headers: {}}, []);
  assert.equal(bad.res.statusCode, 404);
  assert.deepEqual(bad.res.body, {error: 'endpoint not found'});
  const refresh = await callRoute({method: 'GET', query: {calendarRefresh: '1'}, headers: {}}, []);
  assert.equal(refresh.res.statusCode, 404);
});

test('no new setting: the registry still has 151', () => {
  assert.equal(Object.keys(SETTINGS_REGISTRY).length, 151);
});

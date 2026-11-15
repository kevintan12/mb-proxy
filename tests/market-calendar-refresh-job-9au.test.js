'use strict';

// 9AU Build 2C: the scheduled calendar refresh job and its route. Mocked fetch, a mocked engine
// and an in-memory fake of market_calendar_years. No network, no real database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {checkMarketYear, calendarLoginRuntime} = require('../lib/market-calendar-refresh');
const {getPostgresRuntime} = require('../lib/postgres-runtime');
const {
  MARKETS, RUN_BUDGET_MS, PAGE_FETCH_TIMEOUT_MS, isRollingPagePartial, runCalendarRefresh, handleCalendarRefresh
} = require('../lib/market-calendar-refresh-job');

const SECRET = 'cron-secret-for-tests-7f3a9c';
const DB_URL = 'postgres://main-user:main-pass-91b2@db.invalid/main';
const CAL_URL = 'postgres://cal-user:cal-pass-c4d5@db.invalid/calendar';
const ON = Object.freeze({CRON_SECRET: SECRET, HOLIDAY_CALENDAR_REFRESH_ENABLED: 'true'});
const AUTH = Object.freeze({authorization: `Bearer ${SECRET}`});
const DAY1 = Date.parse('2026-11-01T01:00:00Z'); // 09:00 Singapore time, 1 November
const DAY2 = Date.parse('2026-11-02T01:00:00Z');

// Fake market_calendar_years; only the job's status read goes through it.
function fakeDatabase(years = []) {
  const runtime = {
    years: years.map(row => ({...row})),
    transactions: 0,
    async query() { throw new Error('calendar code must use transactions only'); },
    async transaction(callback) {
      runtime.transactions++;
      return callback({
        async query(sql, p) {
          const tag = /-- calendar:([a-z-]+)/.exec(sql)[1];
          if (tag !== 'select-years') throw new Error(`unexpected query ${tag}`);
          return {rows: runtime.years.filter(row => p.includes(row.year)).map(row => ({...row}))};
        }
      });
    }
  };
  return runtime;
}

// A mocked engine: `fail` maps "MARKET-YEAR" to an errors list; anything else is saved and recorded
// in the fake years table like the real engine's upsert.
function fakeEngine(db, {fail = {}, onCall} = {}) {
  const calls = [];
  const impl = async ({market, year, now}) => {
    calls.push(`${market}-${year}`);
    if (onCall) onCall();
    const key = `${market}-${year}`;
    if (fail[key]) {
      return {market, year, status: 'ERROR', source: null, saved: {inserted: 0, updated: 0, retired: 0},
        heldChanges: [], errors: fail[key]};
    }
    db.years = db.years.filter(row => !(row.market === market && row.year === year));
    db.years.push({market, year, status: 'COMPLETE', source: 'OFFICIAL', fetched_at: now().toISOString(), row_count: 10});
    return {market, year, status: 'SAVED', source: 'OFFICIAL', saved: {inserted: 10, updated: 0, retired: 0},
      heldChanges: key === 'US-2026' ? [{date: '2026-11-27', change: 'UPDATE', from: {}, to: {}}] : [], errors: []};
  };
  impl.calls = calls;
  return impl;
}

function noWorkSpies() {
  const spies = {fetch: 0, engine: 0, logs: []};
  return {
    spies,
    options: {
      fetchImpl: async () => { spies.fetch++; throw new Error('no fetch expected'); },
      runtime: {async transaction() { spies.engine++; throw new Error('no database expected'); },
        async query() { spies.engine++; throw new Error('no database expected'); }},
      refreshMarketYear: async () => { spies.engine++; throw new Error('no refresh expected'); },
      log: line => spies.logs.push(line)
    }
  };
}

function allKeys() {
  return MARKETS.flatMap(market => [`${market}-2026`, `${market}-2027`]);
}

// ---------------------------------------------------------------------------------------------
// Access

test('9AU Build 2C: a missing or wrong secret answers 404 like an unknown route and does no work', async () => {
  for (const headers of [{}, undefined, {authorization: 'Bearer wrong'}, {authorization: SECRET},
    {authorization: `Bearer ${SECRET} `}, {authorization: `bearer ${SECRET}`}]) {
    const {spies, options} = noWorkSpies();
    const result = await handleCalendarRefresh({headers, env: {...ON}, ...options});
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, {error: 'endpoint not found'});
    assert.deepEqual([spies.fetch, spies.engine, spies.logs.length], [0, 0, 0]);
  }
});

test('9AU Build 2C: with CRON_SECRET unset (or blank) every request answers 404 and does no work', async () => {
  for (const env of [{HOLIDAY_CALENDAR_REFRESH_ENABLED: 'true'}, {...ON, CRON_SECRET: ''}, {...ON, CRON_SECRET: '   '}]) {
    for (const headers of [{}, {authorization: 'Bearer '}, {authorization: 'Bearer undefined'}, AUTH]) {
      const {spies, options} = noWorkSpies();
      const result = await handleCalendarRefresh({headers, env, ...options});
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, {error: 'endpoint not found'});
      assert.deepEqual([spies.fetch, spies.engine, spies.logs.length], [0, 0, 0]);
    }
  }
});

test('9AU Build 2C: with the right secret and the switch off the answer is "disabled" and nothing runs', async () => {
  for (const env of [{CRON_SECRET: SECRET}, {CRON_SECRET: SECRET, HOLIDAY_CALENDAR_REFRESH_ENABLED: 'false'}]) {
    const {spies, options} = noWorkSpies();
    const result = await handleCalendarRefresh({headers: AUTH, env, ...options});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {result: 'disabled'});
    assert.deepEqual([spies.fetch, spies.engine, spies.logs.length], [0, 0, 0]);
  }
});

test('9AU Build 2C: api/quote.js routes GET ?calendarRefresh=1 with no-store; 404 without the secret', async () => {
  const handler = require('../api/quote');
  const saved = {CRON_SECRET: process.env.CRON_SECRET,
    HOLIDAY_CALENDAR_REFRESH_ENABLED: process.env.HOLIDAY_CALENDAR_REFRESH_ENABLED};
  const fakeRes = () => {
    const res = {headers: {}, statusCode: null, body: null};
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; return res; };
    res.end = () => res;
    return res;
  };
  try {
    delete process.env.CRON_SECRET;
    delete process.env.HOLIDAY_CALENDAR_REFRESH_ENABLED;
    const unset = fakeRes();
    await handler({method: 'GET', query: {calendarRefresh: '1'}, headers: {...AUTH}}, unset);
    assert.equal(unset.statusCode, 404);
    assert.deepEqual(unset.body, {error: 'endpoint not found'});
    assert.equal(unset.headers['Cache-Control'], 'no-store');

    process.env.CRON_SECRET = SECRET;
    const wrong = fakeRes();
    await handler({method: 'GET', query: {calendarRefresh: '1'}, headers: {authorization: 'Bearer nope'}}, wrong);
    assert.equal(wrong.statusCode, 404);
    assert.deepEqual(wrong.body, {error: 'endpoint not found'});

    const off = fakeRes();
    await handler({method: 'GET', query: {calendarRefresh: '1'}, headers: {...AUTH}}, off);
    assert.equal(off.statusCode, 200);
    assert.deepEqual(off.body, {result: 'disabled'});
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------------------------------------
// What a run does

test('9AU Build 2C: a run refreshes this year and next year for US, SG, HK and UK and logs one line', async () => {
  const db = fakeDatabase();
  const engine = fakeEngine(db);
  const logs = [];
  const result = await handleCalendarRefresh({headers: AUTH, env: {...ON}, runtime: db, now: () => DAY1,
    refreshMarketYear: engine, log: line => logs.push(line)});
  assert.equal(result.status, 200);
  assert.deepEqual(engine.calls, allKeys());
  assert.equal(result.body.result, 'ran');
  assert.equal(result.body.runDate, '2026-11-01');
  assert.deepEqual(result.body.marketYears.map(entry => entry.outcome), Array(8).fill('saved'));
  const us = result.body.marketYears[0];
  assert.deepEqual(us.saved, {inserted: 10, updated: 0, retired: 0});
  assert.deepEqual(us.heldChanges, [{date: '2026-11-27', change: 'UPDATE'}]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, 'calendarRefresh');
  assert.deepEqual([logs[0].saved, logs[0].skipped, logs[0].errors, logs[0].inserted, logs[0].held],
    [8, 0, 0, 80, 1]);
});

test('9AU Build 2C: a market-year already refreshed this month is skipped; one from an earlier month is redone', async () => {
  const db = fakeDatabase(allKeys().map(key => {
    const [market, year] = key.split('-');
    const fetchedAt = key === 'SG-2027' ? '2026-05-03T01:00:00Z' : new Date(DAY1);
    return {market, year: Number(year), status: 'COMPLETE', source: 'OFFICIAL', fetched_at: fetchedAt, row_count: 10};
  }));
  const engine = fakeEngine(db);
  const logs = [];
  const result = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY2, refreshMarketYear: engine,
    log: line => logs.push(line)});
  assert.deepEqual(engine.calls, ['SG-2027']);
  assert.equal(result.marketYears.filter(entry => entry.outcome === 'skipped').length, 7);
  assert.equal(logs[0].skipped, 7);
  assert.equal(logs[0].saved, 1);
});

test('9AU Build 2C: a failed market is tried again the next day while saved markets are not redone', async () => {
  const db = fakeDatabase();
  const fail = {'HK-2026': [{code: 'FETCH_FAILED', source: 'HKEX', status: 503}, {code: 'BOTH_SOURCES_FAILED'}],
    'HK-2027': [{code: 'FETCH_FAILED', source: 'HKEX', status: 503}, {code: 'BOTH_SOURCES_FAILED'}]};
  const first = fakeEngine(db, {fail});
  const logs = [];
  const day1 = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY1, refreshMarketYear: first,
    log: line => logs.push(line)});
  assert.deepEqual(first.calls, allKeys());
  const hk = day1.marketYears.find(entry => entry.market === 'HK' && entry.year === 2026);
  assert.equal(hk.outcome, 'error');
  assert.deepEqual(hk.errors, [{code: 'FETCH_FAILED', source: 'HKEX', status: 503}, {code: 'BOTH_SOURCES_FAILED'}]);
  assert.equal(logs[0].errors, 2);
  assert.deepEqual(logs[0].errorCodes, ['HK-2026:FETCH_FAILED', 'HK-2026:BOTH_SOURCES_FAILED',
    'HK-2027:FETCH_FAILED', 'HK-2027:BOTH_SOURCES_FAILED']);

  const second = fakeEngine(db);
  const day2 = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY2, refreshMarketYear: second,
    log: line => logs.push(line)});
  assert.deepEqual(second.calls, ['HK-2026', 'HK-2027']);
  assert.equal(day2.marketYears.filter(entry => entry.outcome === 'skipped').length, 6);

  const third = fakeEngine(db);
  await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY2 + 86400000, refreshMarketYear: third,
    log: () => {}});
  assert.deepEqual(third.calls, []);
});

test('9AU Build 2C: a status-read failure stops the run before any fetch and reports every market-year not reached', async () => {
  const engine = fakeEngine(fakeDatabase());
  const logs = [];
  const result = await runCalendarRefresh({env: {...ON}, now: () => DAY1, refreshMarketYear: engine,
    runtime: {async transaction() { throw new Error(`connection to ${DB_URL} failed`); }},
    log: line => logs.push(line)});
  assert.deepEqual(engine.calls, []);
  assert.equal(result.runError, 'STATUS_READ_FAILED');
  assert.deepEqual(result.marketYears.map(entry => entry.outcome), Array(8).fill('not_reached'));
  assert.equal(logs[0].runError, 'STATUS_READ_FAILED');
  assert.ok(!JSON.stringify([result, logs]).includes('main-pass'));
});

// ---------------------------------------------------------------------------------------------
// Rolling-page partial current year

test('9AU Build 2C: a UK current year missing only past early-year dates is "partial, skipped", not an error', async () => {
  // The real engine check on the UK 2026 holidays left on a rolling page in November.
  const late = ['2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'].map(date => ({date, name: 'x'}));
  const problems = checkMarketYear({market: 'UK', year: 2026, holidays: late, earlyCloses: []});
  const errors = [...problems.map(problem => ({...problem, source: 'LSE'})), {code: 'SANITY_CHECK_FAILED'}];
  assert.ok(errors.some(error => error.code === 'ANCHOR_MISSING'));
  assert.ok(errors.some(error => error.code === 'HOLIDAY_COUNT_OUT_OF_RANGE'));
  const context = {currentYear: 2026, todayKey: '2026-11-01'};
  assert.equal(isRollingPagePartial({year: 2026, status: 'ERROR', errors}, context), true);
  // Next year with the same shape, a missing future anchor, or any other problem is an error.
  assert.equal(isRollingPagePartial({year: 2027, status: 'ERROR', errors}, context), false);
  assert.equal(isRollingPagePartial({year: 2026, status: 'ERROR', errors: [...errors,
    {code: 'ANCHOR_MISSING', date: '2026-12-25'}]}, context), false);
  assert.equal(isRollingPagePartial({year: 2026, status: 'ERROR', errors: [...errors, {code: 'WEEKEND_DATE'}]}, context), false);
  assert.equal(isRollingPagePartial({year: 2026, status: 'ERROR', errors: [{code: 'FETCH_FAILED'},
    {code: 'BOTH_SOURCES_FAILED'}]}, context), false);

  const db = fakeDatabase();
  const engine = fakeEngine(db, {fail: {'UK-2026': errors, 'UK-2027': errors}});
  const logs = [];
  const result = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY1, refreshMarketYear: engine,
    log: line => logs.push(line)});
  const uk = year => result.marketYears.find(entry => entry.market === 'UK' && entry.year === year);
  assert.equal(uk(2026).outcome, 'partial_skipped');
  assert.equal(uk(2027).outcome, 'error');
  assert.equal(logs[0].partialSkipped, 1);
  assert.equal(logs[0].errors, 1);
  assert.ok(logs[0].errorCodes.every(code => code.startsWith('UK-2027:')));
});

// ---------------------------------------------------------------------------------------------
// Limits

test('9AU Build 2C: the limits are fixed at 120 seconds per run and 10 seconds per page fetch', () => {
  assert.equal(RUN_BUDGET_MS, 120000);
  assert.equal(PAGE_FETCH_TIMEOUT_MS, 10000);
});

test('9AU Build 2C: the 120 second budget stops the run cleanly and reports what was not reached', async () => {
  const db = fakeDatabase();
  let clockMs = DAY1;
  const engine = fakeEngine(db, {onCall: () => { clockMs += 50000; }});
  const logs = [];
  const result = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY1, clock: () => clockMs,
    refreshMarketYear: engine, log: line => logs.push(line)});
  assert.deepEqual(engine.calls, ['US-2026', 'US-2027', 'SG-2026']);
  assert.equal(result.budgetReached, true);
  assert.deepEqual(result.marketYears.map(entry => entry.outcome),
    ['saved', 'saved', 'saved', 'not_reached', 'not_reached', 'not_reached', 'not_reached', 'not_reached']);
  assert.equal(logs[0].notReached, 5);
  assert.equal(logs[0].durationMs, 150000);
});

test('9AU Build 2C: a page that hangs past the budget stops the run cleanly through the real engine', async () => {
  const db = fakeDatabase();
  const fetchCalls = [];
  const result = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY1, budgetMs: 40,
    fetchImpl: url => { fetchCalls.push(url); return new Promise(() => {}); }, log: () => {}});
  assert.equal(fetchCalls.length, 1);
  assert.equal(result.budgetReached, true);
  assert.deepEqual(result.marketYears.map(entry => entry.outcome), Array(8).fill('not_reached'));
});

test('9AU Build 2C: a page that hangs past the page timeout fails that source, without retries', async () => {
  const db = fakeDatabase();
  const fetchCalls = [];
  const result = await runCalendarRefresh({env: {...ON}, runtime: db, now: () => DAY1, pageTimeoutMs: 20,
    fetchImpl: url => { fetchCalls.push(url); return new Promise(() => {}); }, log: () => {}});
  const us = result.marketYears[0];
  assert.equal(us.outcome, 'error');
  assert.deepEqual(us.errors.map(error => error.code), ['FETCH_TIMEOUT', 'FETCH_TIMEOUT', 'BOTH_SOURCES_FAILED']);
  assert.equal(new Set(fetchCalls).size, fetchCalls.length, 'no page is fetched twice in one run');
});

// ---------------------------------------------------------------------------------------------
// Secrets and login

test('9AU Build 2C: no secret or database login appears in the response or the log line', async () => {
  const env = {...ON, DATABASE_URL: DB_URL, CALENDAR_DATABASE_URL: CAL_URL};
  const db = fakeDatabase();
  const engine = fakeEngine(db, {fail: {'SG-2026': [{code: 'WRITE_FAILED', detail: CAL_URL, message: DB_URL}]}});
  const logs = [];
  const ran = await handleCalendarRefresh({headers: AUTH, env, runtime: db, now: () => DAY1,
    refreshMarketYear: engine, log: line => logs.push(line)});
  const denied = await handleCalendarRefresh({headers: {authorization: 'Bearer x'}, env, log: line => logs.push(line)});
  const text = JSON.stringify([ran, denied, logs]);
  for (const secret of [SECRET, DB_URL, CAL_URL, 'main-pass', 'cal-pass']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(ran.body.marketYears.find(entry => entry.market === 'SG' && entry.year === 2026).errors,
    [{code: 'WRITE_FAILED'}]);
});

test('9AU Build 2C: the engine database function prefers CALENDAR_DATABASE_URL when it is set', () => {
  const made = [];
  const createRuntime = options => { made.push(options); return {transaction: async () => null}; };
  calendarLoginRuntime({DATABASE_URL: DB_URL, CALENDAR_DATABASE_URL: CAL_URL}, {createRuntime});
  assert.deepEqual(made, [{environment: {DATABASE_URL: CAL_URL}}]);
  // Unset or blank: the shared DATABASE_URL runtime.
  assert.equal(calendarLoginRuntime({DATABASE_URL: DB_URL}, {createRuntime}), getPostgresRuntime());
  assert.equal(calendarLoginRuntime({DATABASE_URL: DB_URL, CALENDAR_DATABASE_URL: '  '}, {createRuntime}), getPostgresRuntime());
  assert.equal(made.length, 1);
  // Without an injected factory the calendar runtime is created once and kept (no connection yet).
  const first = calendarLoginRuntime({CALENDAR_DATABASE_URL: CAL_URL});
  assert.notEqual(first, getPostgresRuntime());
  assert.equal(calendarLoginRuntime({CALENDAR_DATABASE_URL: CAL_URL}), first);
  assert.ok(!JSON.stringify(first).includes('cal-pass'));
});

// ---------------------------------------------------------------------------------------------
// Setting and vercel.json

test('9AU Build 2C: holidayCalendarRefreshEnabled is an Admin switch, default off, with a plain description', () => {
  const row = SETTINGS_REGISTRY.holidayCalendarRefreshEnabled;
  assert.equal(row.default, false);
  assert.equal(row.admin, 'Admin');
  assert.equal(row.envVar, 'HOLIDAY_CALENDAR_REFRESH_ENABLED');
  assert.equal(settingValue('holidayCalendarRefreshEnabled', {env: {}}), false);
  assert.equal(settingValue('holidayCalendarRefreshEnabled', {env: {HOLIDAY_CALENDAR_REFRESH_ENABLED: 'true'}}), true);
  assert.ok(row.description.length <= 450);
  assert.ok(row.description.includes('When on') && row.description.includes('When off'));
  assert.equal(row.description.split(/(?<=\.)\s+/).filter(Boolean).length, 2);
  assert.ok(!/\bstep\b/i.test(row.description));
  assert.ok(!/\b[0-9a-f]{7,40}\b/.test(row.description));
});

test('9AU Build 2C: vercel.json parses and holds exactly the calendar cron, other settings unchanged', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(Object.keys(config), ['functions', 'rewrites', 'crons']);
  assert.deepEqual(config.crons, [{path: '/api/quote?calendarRefresh=1', schedule: '0 1 1-7 5,11 *'}]);
  assert.deepEqual(config.functions, {'api/quote.js': {regions: ['sin1']}});
  assert.deepEqual(config.rewrites, [{source: '/api/(.*)', destination: '/api/$1'}]);
});

'use strict';

// 9AU Build 4: UK in the backend session calendar, the calendarCoverage log line, and the November
// "next year missing" alert. Fake fetch, mocked engine and fake database only: no network, no real
// database, no paid call, no real mail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {getSessionContext, FULL_DAY_HOLIDAYS} = require('../lib/market-session-calendar');
const {MARKET_TIME_ZONES} = require('../lib/completed-session-telemetry');
const {canonicalizeAnalysisPackageRequest} = require('../lib/analysis-package-service');
const {loadCalendar, resetCalendarCache} = require('../lib/market-calendar-store');
const {calendarCoverage, coverageBand, logCalendarCoverage} = require('../lib/calendar-coverage');
const {runCalendarRefresh} = require('../lib/market-calendar-refresh-job');
const {RESEND_URL} = require('../lib/calendar-alert-mail');

const ctx = (market, exchangeDate) => getSessionContext({market, exchangeDate});
const at = (market, instant) => getSessionContext({market, instant});

// ---------------------------------------------------------------------------------------------
// Job 1: UK calendar

const UK_HOLIDAYS = {
  2026: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'],
  2027: ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']
};

test('9AU Build 4: UK built-in holidays are exactly the approved 2026 and 2027 lists', () => {
  assert.deepEqual([...FULL_DAY_HOLIDAYS.UK[2026]], UK_HOLIDAYS[2026]);
  assert.deepEqual([...FULL_DAY_HOLIDAYS.UK[2027]], UK_HOLIDAYS[2027]);
  for (const date of [...UK_HOLIDAYS[2026], ...UK_HOLIDAYS[2027]]) {
    const context = ctx('UK', date);
    assert.equal(context.dayType, 'HOLIDAY', date);
    assert.equal(context.calendarSupported, true);
    assert.equal(context.tradingDay, false);
    assert.equal(context.regularCloseTime, null);
  }
});

test('9AU Build 4: the UK holidays match the saved GOV.UK page copy (England and Wales)', () => {
  const file = path.join(__dirname, 'fixtures', 'market-calendar', 'govuk-bank-holidays.json');
  const events = JSON.parse(fs.readFileSync(file, 'utf8'))['england-and-wales'].events;
  for (const year of [2026, 2027]) {
    const saved = events.map(event => event.date).filter(date => date.startsWith(String(year)));
    assert.deepEqual([...FULL_DAY_HOLIDAYS.UK[year]], saved);
  }
});

test('9AU Build 4: UK ordinary days, weekends and years with no list', () => {
  assert.equal(ctx('UK', '2026-12-23').dayType, 'TRADING_DAY');
  assert.equal(ctx('UK', '2027-01-04').dayType, 'TRADING_DAY');
  assert.equal(ctx('UK', '2026-12-26').dayType, 'WEEKEND');
  assert.equal(ctx('UK', '2027-01-03').dayType, 'WEEKEND');
  const unsupported = ctx('UK', '2028-01-04');
  assert.deepEqual([unsupported.dayType, unsupported.calendarSupported, unsupported.tradingDay],
    ['UNSUPPORTED', false, false]);
});

test('9AU Build 4: UK regular session is 08:00 to 16:30 London time, no lunch, no pre or after hours', () => {
  const summer = ctx('UK', '2026-07-01'); // BST, UTC+1
  assert.equal(summer.exchangeTimezone, 'Europe/London');
  assert.equal(summer.regularOpenTime, '2026-07-01T07:00:00.000Z');
  assert.equal(summer.regularCloseTime, '2026-07-01T15:30:00.000Z');
  const winter = ctx('UK', '2027-01-05'); // GMT
  assert.equal(winter.regularOpenTime, '2027-01-05T08:00:00.000Z');
  assert.equal(winter.regularCloseTime, '2027-01-05T16:30:00.000Z');
  const sessionAt = time => at('UK', `2027-01-05T${time}:00Z`).session;
  assert.equal(sessionAt('07:59'), 'CLOSED');
  assert.equal(sessionAt('08:00'), 'REGULAR');
  assert.equal(sessionAt('12:30'), 'REGULAR');
  assert.equal(sessionAt('13:00'), 'REGULAR');
  assert.equal(sessionAt('16:29'), 'REGULAR');
  assert.equal(sessionAt('16:30'), 'CLOSED');
  assert.equal(sessionAt('18:00'), 'CLOSED');
  assert.equal(at('UK', '2027-01-05T16:30:00Z').regularSessionCompleted, true);
  assert.equal(at('UK', '2027-01-05T16:29:00Z').regularSessionCompleted, false);
  assert.equal(at('UK', '2026-12-25T10:00:00Z').session, 'HOLIDAY');
});

test('9AU Build 4: UK half days (24 and 31 December) close at 12:30 and are supported trading days', () => {
  for (const date of ['2026-12-24', '2026-12-31', '2027-12-24', '2027-12-31']) {
    const context = ctx('UK', date);
    assert.equal(context.dayType, 'EARLY_CLOSE', date);
    assert.equal(context.calendarSupported, true);
    assert.equal(context.tradingDay, true);
    assert.equal(context.regularCloseTime, `${date}T12:30:00.000Z`);
    assert.equal(context.regularOpenTime, `${date}T08:00:00.000Z`);
    assert.equal(at('UK', `${date}T12:29:00Z`).session, 'REGULAR');
    assert.equal(at('UK', `${date}T12:30:00Z`).session, 'CLOSED');
    assert.equal(at('UK', `${date}T12:30:00Z`).regularSessionCompleted, true);
    assert.equal(at('UK', `${date}T12:29:00Z`).regularSessionCompleted, false);
  }
});

async function withEnv(values, body) {
  const saved = {};
  for (const name of Object.keys(values)) { saved[name] = process.env[name]; process.env[name] = values[name]; }
  resetCalendarCache();
  try { return await body(); } finally {
    resetCalendarCache();
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

test('9AU Build 4: UK half days follow earlyCloseDaysEnabled (on: close 12:30; off: unsupported special session)', async () => {
  await withEnv({EARLY_CLOSE_DAYS_ENABLED: 'on'}, async () => {
    for (const date of ['2026-12-24', '2026-12-31']) assert.equal(ctx('UK', date).dayType, 'EARLY_CLOSE');
  });
  await withEnv({EARLY_CLOSE_DAYS_ENABLED: 'off'}, async () => {
    for (const date of ['2026-12-24', '2026-12-31', '2027-12-24', '2027-12-31']) {
      const context = ctx('UK', date);
      assert.deepEqual([context.dayType, context.calendarSupported, context.tradingDay, context.regularCloseTime],
        ['UNSUPPORTED_SPECIAL_SESSION', false, true, null], date);
    }
    // Ordinary UK days and holidays do not depend on the switch.
    assert.equal(ctx('UK', '2026-12-23').dayType, 'TRADING_DAY');
    assert.equal(ctx('UK', '2026-12-25').dayType, 'HOLIDAY');
    // US is gated the same way.
    assert.equal(ctx('US', '2026-12-24').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
  });
});

test('9AU Build 4: a complete UK table year wins over the built-in list; half days use the stored close time', async () => {
  const day = (date, kind = 'HOLIDAY', close = null) => ({market: 'UK', year: Number(date.slice(0, 4)), calendar_date: date,
    kind, early_close_time: close, after_hours_end: null});
  const rows = [day('2028-01-03'), day('2028-12-22', 'EARLY_CLOSE', '12:00'), day('2026-07-06')];
  for (const [early, expected] of [['on', 'EARLY_CLOSE'], ['off', 'UNSUPPORTED_SPECIAL_SESSION']]) {
    await withEnv({HOLIDAY_CALENDAR_DB_ENABLED: 'on', EARLY_CLOSE_DAYS_ENABLED: early}, async () => {
      await loadCalendar({runtime: {async query() { return {rows}; }}, log: () => {}});
      assert.equal(ctx('UK', '2028-01-03').dayType, 'HOLIDAY'); // 2028 supported only through the table
      assert.equal(ctx('UK', '2028-01-04').dayType, 'TRADING_DAY');
      assert.equal(ctx('UK', '2026-07-06').dayType, 'HOLIDAY'); // table 2026 replaces the built-in list...
      assert.equal(ctx('UK', '2026-12-25').dayType, 'TRADING_DAY'); // ...so built-in dates are not mixed in
      const half = ctx('UK', '2028-12-22');
      assert.equal(half.dayType, expected);
      if (early === 'on') assert.equal(half.regularCloseTime, '2028-12-22T12:00:00.000Z');
    });
  }
  // Switch off: the built-in list decides again.
  await withEnv({HOLIDAY_CALENDAR_DB_ENABLED: 'off'}, async () => {
    assert.equal(ctx('UK', '2028-01-03').dayType, 'UNSUPPORTED');
    assert.equal(ctx('UK', '2026-12-25').dayType, 'HOLIDAY');
  });
});

test('9AU Build 4: the early-close setting description covers UK half days within the description rules', () => {
  const text = require('../lib/settings-registry').SETTINGS_REGISTRY.earlyCloseDaysEnabled.description;
  assert.match(text, /UK/);
  assert.match(text, /When on/);
  assert.match(text, /When off/);
  assert.ok(text.length <= 450);
});

test('9AU Build 4: UK Christmas weekend and substitute days are not trading days', () => {
  assert.equal(ctx('UK', '2027-12-25').dayType, 'WEEKEND');
  assert.equal(ctx('UK', '2027-12-26').dayType, 'WEEKEND');
  assert.equal(ctx('UK', '2027-12-27').dayType, 'HOLIDAY');
  assert.equal(ctx('UK', '2027-12-28').dayType, 'HOLIDAY');
});

test('9AU Build 4: US, SG and HK results are unchanged', () => {
  assert.equal(ctx('US', '2026-12-25').dayType, 'HOLIDAY');
  assert.equal(ctx('US', '2026-12-24').dayType, 'EARLY_CLOSE'); // early-close switch is on by default
  assert.equal(ctx('US', '2027-11-26').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
  assert.equal(ctx('US', '2026-12-23').regularCloseTime, '2026-12-23T21:00:00.000Z');
  assert.equal(ctx('SG', '2026-12-24').dayType, 'TRADING_DAY');
  assert.equal(ctx('SG', '2027-02-05').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
  assert.equal(ctx('HK', '2026-12-24').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
  assert.equal(ctx('HK', '2027-12-31').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
  assert.equal(ctx('HK', '2028-01-04').dayType, 'UNSUPPORTED');
  assert.equal(at('SG', '2027-01-05T04:30:00Z').session, 'LUNCH');
  assert.equal(at('US', '2027-01-05T14:00:00Z').session, 'PRE');
  assert.throws(() => ctx('EU', '2027-01-05'), /Invalid market/);
});

test('9AU Build 4: UK stays refused by the package route', () => {
  assert.equal(MARKET_TIME_ZONES.UK, undefined);
  const request = scope => ({
    selectedScope: scope, initiatingList: 'myStocks',
    myStocks: [{market: 'UK', symbol: 'VOD.L'}], watchlist: []
  });
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('UK')));
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('ALL')));
});

test('9AU Build 4: no scope list or route in the code accepts UK for a report or package', () => {
  const {SELECTED_SCOPES} = require('../lib/claude-analysis-contract');
  assert.deepEqual([...SELECTED_SCOPES], ['US', 'SG', 'HK', 'ALL']);
  const route = fs.readFileSync(path.join(__dirname, '..', 'api', 'quote.js'), 'utf8');
  assert.doesNotMatch(route, /['"]UK['"]/);
});

// ---------------------------------------------------------------------------------------------
// Job 2: calendarCoverage

const dayMs = iso => Date.parse(`${iso}T12:00:00Z`);

test('9AU Build 4: coverage bands change at 90, 31 and 0 days left', () => {
  assert.equal(coverageBand(411), 'current');
  assert.equal(coverageBand(90), 'current');
  assert.equal(coverageBand(89), 'expiring');
  assert.equal(coverageBand(31), 'expiring');
  assert.equal(coverageBand(30), 'urgent');
  assert.equal(coverageBand(0), 'urgent');
  assert.equal(coverageBand(-1), 'expired');
  assert.equal(coverageBand(null), 'expired');
});

test('9AU Build 4: coverage reads the built-in lists for every market, one band each', () => {
  const cases = [
    ['2026-11-15', 411, 'current'],
    ['2027-10-02', 90, 'current'],
    ['2027-10-03', 89, 'expiring'],
    ['2027-11-30', 31, 'expiring'],
    ['2027-12-01', 30, 'urgent'],
    ['2027-12-31', 0, 'urgent'],
    ['2028-01-01', -1, 'expired']
  ];
  for (const [date, daysLeft, band] of cases) {
    const coverage = calendarCoverage({now: dayMs(date), env: {}});
    assert.deepEqual(Object.keys(coverage), ['US', 'SG', 'HK', 'UK']);
    for (const market of Object.keys(coverage)) {
      assert.deepEqual(coverage[market], {latestYear: 2027, daysLeft, band}, `${date} ${market}`);
    }
  }
});

test('9AU Build 4: a loaded 2028 table year extends coverage for that market only (switch on)', async () => {
  const rows = [{market: 'US', year: 2028, calendar_date: '2028-01-17', kind: 'HOLIDAY',
    early_close_time: null, after_hours_end: null}];
  const runtime = {async query() { return {rows}; }};
  resetCalendarCache();
  try {
    const env = {HOLIDAY_CALENDAR_DB_ENABLED: 'on'};
    await loadCalendar({runtime, env, log: () => {}});
    const coverage = calendarCoverage({now: dayMs('2027-11-30'), env});
    assert.deepEqual(coverage.US, {latestYear: 2028, daysLeft: 397, band: 'current'});
    assert.equal(coverage.HK.latestYear, 2027);
    assert.equal(coverage.UK.latestYear, 2027);
    resetCalendarCache();
    await loadCalendar({runtime: {async query() { return {rows: [{...rows[0], market: 'UK'}]}; }}, env, log: () => {}});
    const withUk = calendarCoverage({now: dayMs('2027-11-30'), env});
    assert.equal(withUk.UK.latestYear, 2028);
    assert.equal(withUk.US.latestYear, 2027);
    assert.equal(calendarCoverage({now: dayMs('2027-11-30'), env: {}}).US.latestYear, 2027);
  } finally {
    resetCalendarCache();
  }
});

test('9AU Build 4: the coverage line is one log call', () => {
  const lines = [];
  logCalendarCoverage({now: dayMs('2027-10-10'), env: {}, log: line => lines.push(line)});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'calendarCoverage');
  assert.equal(lines[0].markets.US.band, 'expiring');
  assert.equal(lines[0].markets.UK.latestYear, 2027);
});

test('9AU Build 4: an error inside the coverage line is swallowed and logged, never thrown', () => {
  const lines = [];
  const badEnv = new Proxy({}, {get() { throw Object.assign(new Error('boom'), {code: 'BOOM'}); }});
  assert.doesNotThrow(() => logCalendarCoverage({now: dayMs('2027-10-10'), env: badEnv, log: line => lines.push(line)}));
  assert.deepEqual(lines, [{stage: 'calendarCoverage', message: 'coverage check failed', code: 'BOOM'}]);
  assert.doesNotThrow(() => logCalendarCoverage({now: Number.NaN, env: {}, log: line => lines.push(line)}));
  assert.doesNotThrow(() => logCalendarCoverage({now: dayMs('2027-10-10'), env: {}, log: () => { throw new Error('log down'); }}));
});

test('9AU Build 4: the package runtime calls the coverage line with no switch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analysis-package-runtime.js'), 'utf8');
  assert.match(source, /logCalendarCoverage\(\{env\}\)/);
});

// ---------------------------------------------------------------------------------------------
// Job 3: November email

const TO = 'owner@example.test';
const FROM = 'MarketBrief <alerts@example.test>';
const KEY = 're_test_key_4f1c';
const MAIL_ENV = Object.freeze({
  CRON_SECRET: 'secret', HOLIDAY_CALENDAR_REFRESH_ENABLED: 'true', CALENDAR_ALERT_EMAIL_ENABLED: 'true',
  CALENDAR_ALERT_EMAIL_TO: TO, CALENDAR_ALERT_EMAIL_FROM: FROM, RESEND_API_KEY: KEY
});

function fakeRuntime(rows = []) {
  return {
    async query() { throw new Error('transactions only'); },
    async transaction(callback) {
      return callback({async query(sql, p) { return {rows: rows.filter(row => p.includes(row.year))}; }});
    }
  };
}

const quietEngine = async ({market, year}) => ({
  market, year, status: 'SAVED', source: 'OFFICIAL', saved: {inserted: 1, updated: 0, retired: 0},
  heldChanges: [], errors: []
});
const failingEngine = async ({market, year}) => ({
  market, year, status: 'ERROR', source: null, saved: {inserted: 0, updated: 0, retired: 0},
  heldChanges: [], errors: [{code: 'FETCH_FAILED'}]
});

async function runOn(isoDate, {env = MAIL_ENV, engine = quietEngine, rows = []} = {}) {
  const mail = {calls: []};
  const logs = [];
  const mailFetchImpl = async (url, options) => { mail.calls.push({url, options}); return {ok: true, status: 200}; };
  const result = await runCalendarRefresh({
    env: {...env}, runtime: fakeRuntime(rows), now: () => Date.parse(`${isoDate}T01:00:00Z`),
    fetchImpl: async () => { throw new Error('no page fetch expected'); },
    refreshMarketYear: engine, mailFetchImpl, log: line => logs.push(line)
  });
  return {mail, logs, result};
}

test('9AU Build 4: a November run with next year missing sends one email naming every missing market', async () => {
  const {mail, logs} = await runOn('2027-11-01');
  assert.equal(mail.calls.length, 1);
  const {url, options} = mail.calls[0];
  assert.equal(url, RESEND_URL);
  const body = JSON.parse(options.body);
  assert.match(body.subject, /next year missing/);
  assert.match(body.text, /NEXT YEAR MISSING/);
  for (const market of ['US', 'SG', 'HK', 'UK']) assert.match(body.text, new RegExp(`- ${market} 2028`));
  assert.doesNotMatch(body.text, /owner@example|alerts@example|re_test_key/);
  assert.doesNotMatch(JSON.stringify(logs), /owner@example|alerts@example|re_test_key/);
});

test('9AU Build 4: the missing-year trigger joins the run\'s single email with other triggers', async () => {
  const held = [{date: '2027-12-24', change: 'UPDATE', from: {kind: 'HOLIDAY'}, to: {kind: 'EARLY_CLOSE', earlyCloseTime: '13:00'}}];
  const engine = async args => (args.market === 'US' && args.year === 2027
    ? {...(await quietEngine(args)), heldChanges: held} : quietEngine(args));
  const {mail} = await runOn('2027-11-01', {engine});
  assert.equal(mail.calls.length, 1);
  const text = JSON.parse(mail.calls[0].options.body).text;
  assert.match(text, /CHANGE HELD/);
  assert.match(text, /NEXT YEAR MISSING/);
});

test('9AU Build 4: a May run sends no missing-year email even when next year is missing', async () => {
  const {mail} = await runOn('2027-05-03');
  assert.equal(mail.calls.length, 0);
});

test('9AU Build 4: a November run in 2026 sends nothing, because 2027 is on every built-in list', async () => {
  const {mail} = await runOn('2026-11-02');
  assert.equal(mail.calls.length, 0);
});

test('9AU Build 4: with the alert email switch off a November run sends nothing', async () => {
  const {mail, result} = await runOn('2027-11-01', {env: {...MAIL_ENV, CALENDAR_ALERT_EMAIL_ENABLED: 'false'}});
  assert.equal(mail.calls.length, 0);
  assert.equal(result.result, 'ran');
});

test('9AU Build 4: with the database switch on, a complete 2028 table year covers all four markets', async () => {
  const complete = market => ({market, year: 2028, status: 'COMPLETE', fetched_at: '2027-05-03T01:00:00Z'});
  const rows = ['US', 'SG', 'HK', 'UK'].map(complete);
  const on = await runOn('2027-11-01', {env: {...MAIL_ENV, HOLIDAY_CALENDAR_DB_ENABLED: 'on'}, rows, engine: failingEngine});
  assert.equal(on.mail.calls.length, 0); // nothing is missing, so no email
  const off = await runOn('2027-11-01', {env: MAIL_ENV, rows, engine: failingEngine});
  assert.match(JSON.parse(off.mail.calls[0].options.body).text, /- US 2028/);
});

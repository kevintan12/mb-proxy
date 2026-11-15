'use strict';

// 9AU Build 1: the holiday calendar read from the database, behind holidayCalendarDbEnabled
// (env HOLIDAY_CALENDAR_DB_ENABLED, default off). Made-up rows and a fake database only:
// no network, no real database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {
  CALENDAR_QUERY, loadCalendar, calendarYear, resetCalendarCache
} = require('../lib/market-calendar-store');
const {getSessionContext} = require('../lib/market-session-calendar');
const {createAnalysisPackageRuntime} = require('../lib/analysis-package-runtime');

const SWITCH_ENV = 'HOLIDAY_CALENDAR_DB_ENABLED';
const EARLY_ENV = 'EARLY_CLOSE_DAYS_ENABLED';
const MINUTE = 60 * 1000;

function fakeRuntime(rows) {
  const calls = [];
  return {
    calls,
    async query(text, parameters) {
      calls.push({text, parameters});
      if (rows instanceof Error) throw rows;
      return {rows};
    },
    async transaction() { throw new Error('not expected'); }
  };
}

function day(market, date, kind = 'HOLIDAY', earlyClose = null, afterHoursEnd = null) {
  return {
    market, year: Number(date.slice(0, 4)), calendar_date: date, kind,
    early_close_time: earlyClose, after_hours_end: afterHoursEnd
  };
}

function emptyYear(market, year) {
  return {market, year, calendar_date: null, kind: null, early_close_time: null, after_hours_end: null};
}

// Runs one test body with the given env values set, restoring env and the cache afterwards.
async function withEnv(values, body) {
  const saved = {};
  for (const name of Object.keys(values)) {
    saved[name] = process.env[name];
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  resetCalendarCache();
  try {
    return await body();
  } finally {
    resetCalendarCache();
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function status(market, exchangeDate) {
  const context = getSessionContext({market, exchangeDate});
  return {dayType: context.dayType, calendarSupported: context.calendarSupported, tradingDay: context.tradingDay};
}

// US 2026 table year: a made-up holiday on Monday 16 Nov, a made-up early close on Wednesday
// 25 Nov, and NOT Thanksgiving (26 Nov) or the built-in early close (27 Nov).
const US_2026_ROWS = [
  day('US', '2026-11-16'),
  day('US', '2026-11-25', 'EARLY_CLOSE', '13:00', '17:00')
];

test('9AU Build 1: the two settings are registered as approved', () => {
  const sw = SETTINGS_REGISTRY.holidayCalendarDbEnabled;
  assert.equal(sw.admin, 'Admin');
  assert.equal(sw.boolean, true);
  assert.equal(sw.default, false);
  assert.equal(sw.envVar, SWITCH_ENV);
  assert.equal(settingValue('holidayCalendarDbEnabled', {env: {}}), false);
  assert.equal(settingValue('holidayCalendarDbEnabled', {env: {[SWITCH_ENV]: 'on'}}), true);
  const cache = SETTINGS_REGISTRY.calendarCacheMinutes;
  assert.equal(cache.admin, 'Fixed');
  assert.equal(cache.default, 360);
  assert.equal(cache.envVar, undefined);
  assert.equal(settingValue('calendarCacheMinutes', {env: {CALENDAR_CACHE_MINUTES: '5'}}), 360);
  for (const name of ['holidayCalendarDbEnabled', 'calendarCacheMinutes']) {
    const text = SETTINGS_REGISTRY[name].description;
    assert.ok(text.length <= 450, name);
    assert.ok(!/\bStep\b/i.test(text) && !/[0-9a-f]{7,}/i.test(text) && !/\b9[A-Z]{1,2}\b/.test(text), name);
    assert.ok(text.split(/[.!?](?:\s+|$)/).filter(part => part.trim()).length <= 2, name);
  }
  assert.ok(SETTINGS_REGISTRY.holidayCalendarDbEnabled.description.includes('When on'));
  assert.ok(SETTINGS_REGISTRY.holidayCalendarDbEnabled.description.includes('When off'));
});

test('9AU Build 1: switch on, a COMPLETE table year replaces the built-in year entirely', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: undefined}, async () => {
    const runtime = fakeRuntime(US_2026_ROWS);
    const result = await loadCalendar({runtime, log: () => {}});
    assert.equal(result.status, 'LOADED');
    assert.equal(runtime.calls.length, 1);
    assert.deepEqual(status('US', '2026-11-16'), {dayType: 'HOLIDAY', calendarSupported: true, tradingDay: false});
    // Built-in Thanksgiving and the built-in 27 Nov early close are not mixed in.
    assert.equal(status('US', '2026-11-26').dayType, 'TRADING_DAY');
    assert.equal(status('US', '2026-11-27').dayType, 'TRADING_DAY');
    assert.equal(status('US', '2026-11-21').dayType, 'WEEKEND');
    const early = getSessionContext({market: 'US', exchangeDate: '2026-11-25'});
    assert.equal(early.dayType, 'EARLY_CLOSE');
    assert.equal(early.regularCloseTime, '2026-11-25T18:00:00.000Z');
    const after = getSessionContext({market: 'US', instant: '2026-11-25T21:30:00Z'});
    assert.equal(after.session, 'POST');
    assert.equal(getSessionContext({market: 'US', instant: '2026-11-25T22:30:00Z'}).session, 'CLOSED');
    // Other markets and years are untouched.
    assert.equal(status('US', '2027-11-25').dayType, 'HOLIDAY');
    assert.equal(status('SG', '2026-12-25').dayType, 'HOLIDAY');
  });
});

test('9AU Build 1: US table early closes stay behind earlyCloseDaysEnabled', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: 'off'}, async () => {
    await loadCalendar({runtime: fakeRuntime(US_2026_ROWS), log: () => {}});
    assert.deepEqual(status('US', '2026-11-25'),
      {dayType: 'UNSUPPORTED_SPECIAL_SESSION', calendarSupported: false, tradingDay: true});
  });
});

test('9AU Build 1: SG and HK table early closes stay unsupported; UK rows are ignored', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: 'on'}, async () => {
    await loadCalendar({runtime: fakeRuntime([
      day('SG', '2026-12-24', 'EARLY_CLOSE', '12:00'),
      day('HK', '2026-12-24', 'EARLY_CLOSE', '12:00'),
      day('UK', '2026-12-25'),
      emptyYear('UK', 2026)
    ]), log: () => {}});
    assert.equal(status('SG', '2026-12-24').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
    assert.equal(status('HK', '2026-12-24').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
    // SG 2026 now comes only from the table, which lists no Christmas holiday.
    assert.equal(status('SG', '2026-12-25').dayType, 'TRADING_DAY');
    assert.equal(calendarYear('UK', 2026), null);
  });
});

test('9AU Build 1: a 2028 table year makes 2028 supported; without one 2028 stays unsupported', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: undefined}, async () => {
    await loadCalendar({runtime: fakeRuntime([day('US', '2028-01-17')]), log: () => {}});
    assert.equal(status('US', '2028-01-17').dayType, 'HOLIDAY');
    assert.equal(status('US', '2028-01-18').dayType, 'TRADING_DAY');
    assert.equal(status('SG', '2028-01-18').dayType, 'UNSUPPORTED');
  });
});

test('9AU Build 1: missing, incomplete or unreadable years fall back to the built-in lists', async () => {
  // Only COMPLETE years are read; anything else never reaches the backend.
  assert.match(CALENDAR_QUERY, /y\.status = 'COMPLETE'/);
  assert.match(CALENDAR_QUERY, /d\.retired_at IS NULL/);
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: undefined}, async () => {
    const lines = [];
    await loadCalendar({runtime: fakeRuntime([
      day('US', '2027-01-01'),
      // HK 2026 has one unreadable row, so the whole year is skipped (never half table, half built-in).
      day('HK', '2026-10-19'),
      day('HK', '2026-10-20', 'EARLY_CLOSE', null)
    ]), log: line => lines.push(line)});
    // US 2026 is not in the table: built-in Thanksgiving.
    assert.equal(calendarYear('US', 2026), null);
    assert.equal(status('US', '2026-11-26').dayType, 'HOLIDAY');
    // US 2027 comes only from the table: built-in Thanksgiving 2027 is not mixed in.
    assert.equal(status('US', '2027-11-25').dayType, 'TRADING_DAY');
    // HK 2026 skipped: built-in list, including the built-in special session.
    assert.equal(calendarYear('HK', 2026), null);
    assert.equal(status('HK', '2026-10-19').dayType, 'HOLIDAY');
    assert.equal(status('HK', '2026-12-24').dayType, 'UNSUPPORTED_SPECIAL_SESSION');
    assert.deepEqual(lines, [{event: 'CALENDAR_DB_YEAR_SKIPPED', years: ['HK:2026']}]);
  });
});

test('9AU Build 1: a database failure means built-in lists, one log line, and the brief carries on', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: undefined}, async () => {
    const lines = [];
    const failure = Object.assign(new Error('secret connection detail'), {code: 'POSTGRES_OPERATION_FAILED'});
    const result = await loadCalendar({runtime: fakeRuntime(failure), log: line => lines.push(line)});
    assert.equal(result.status, 'UNAVAILABLE');
    assert.deepEqual(lines, [{event: 'CALENDAR_DB_UNAVAILABLE', code: 'POSTGRES_OPERATION_FAILED'}]);
    assert.ok(!JSON.stringify(lines).includes('secret'));
    assert.equal(status('US', '2026-11-26').dayType, 'HOLIDAY');
    assert.equal(status('US', '2026-11-27').dayType, 'EARLY_CLOSE');

    // Through the package runtime: the failure does not change what assemble does.
    const runtime = fakeRuntime(failure);
    const service = createAnalysisPackageRuntime({
      postgresRuntime: runtime,
      fetchImpl: async () => { throw new Error('not expected'); },
      now: () => new Date('2026-11-16T10:00:00Z')
    });
    assert.equal(Object.isFrozen(service), true);
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      await assert.rejects(service.assemble({}), /Invalid US analysis orchestration request/);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].text, CALENDAR_QUERY);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /CALENDAR_DB_UNAVAILABLE/);
  });
});

test('9AU Build 1: switch off never reads the table and ignores anything already loaded', async () => {
  await withEnv({[SWITCH_ENV]: undefined, [EARLY_ENV]: undefined}, async () => {
    const runtime = fakeRuntime(US_2026_ROWS);
    assert.equal((await loadCalendar({runtime})).status, 'OFF');
    const service = createAnalysisPackageRuntime({
      postgresRuntime: runtime,
      fetchImpl: async () => { throw new Error('not expected'); },
      now: () => new Date('2026-11-16T10:00:00Z')
    });
    await assert.rejects(service.assemble({}), /Invalid US analysis orchestration request/);
    assert.equal(runtime.calls.length, 0);
    assert.equal(status('US', '2026-11-16').dayType, 'TRADING_DAY');
    assert.equal(status('US', '2026-11-26').dayType, 'HOLIDAY');

    // Loaded while on, then switched off: the built-in lists are used again at once.
    process.env[SWITCH_ENV] = 'on';
    await loadCalendar({runtime, log: () => {}});
    assert.equal(status('US', '2026-11-16').dayType, 'HOLIDAY');
    process.env[SWITCH_ENV] = 'off';
    assert.equal(status('US', '2026-11-16').dayType, 'TRADING_DAY');
    assert.equal(status('US', '2026-11-26').dayType, 'HOLIDAY');
  });
});

test('9AU Build 1: the calendar is read once per 360-minute cache window', async () => {
  await withEnv({[SWITCH_ENV]: 'on', [EARLY_ENV]: undefined}, async () => {
    const runtime = fakeRuntime(US_2026_ROWS);
    let clock = 1_000_000;
    const nowMs = () => clock;
    assert.equal((await loadCalendar({runtime, nowMs, log: () => {}})).status, 'LOADED');
    clock += 359 * MINUTE;
    assert.equal((await loadCalendar({runtime, nowMs, log: () => {}})).status, 'CACHED');
    assert.equal(runtime.calls.length, 1);
    clock += 2 * MINUTE;
    assert.equal((await loadCalendar({runtime, nowMs, log: () => {}})).status, 'LOADED');
    assert.equal(runtime.calls.length, 2);
  });
});

test('9AU Build 1: a 2028 date still returns unsupported with the switch off (today\'s behaviour)', async () => {
  await withEnv({[SWITCH_ENV]: undefined}, async () => {
    for (const market of ['US', 'SG', 'HK']) {
      assert.deepEqual(status(market, '2028-01-03'),
        {dayType: 'UNSUPPORTED', calendarSupported: false, tradingDay: false}, market);
    }
  });
});

test('9AU Build 1: migration 004 creates the three tables and the change log is insert-only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '004_market_calendar.sql'), 'utf8');
  for (const table of ['market_calendar_days', 'market_calendar_years', 'market_calendar_changes']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  }
  assert.match(sql, /CHECK \(market IN \('US', 'SG', 'HK', 'UK'\)\)/);
  assert.match(sql, /CHECK \(kind IN \('HOLIDAY', 'EARLY_CLOSE'\)\)/);
  assert.match(sql, /CHECK \(source IN \('OFFICIAL', 'SECOND'\)\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON market_calendar_changes/);
  for (const column of ['source_url', 'fetched_at', 'retired_at', 'needs_review', 'early_close_time',
    'after_hours_end', 'row_count']) {
    assert.ok(sql.includes(column), column);
  }
});

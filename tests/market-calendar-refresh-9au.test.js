'use strict';

// 9AU Build 2A: the calendar refresh engine. Saved trimmed copies of the NYSE, Nasdaq, LSE and
// GOV.UK pages (tests/fixtures/market-calendar, fetched once on 15 Nov 2026), a fake fetch and an
// in-memory fake database with rollback. No network, no real database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {
  SOURCES, parseNyseHoursCalendars, parseNasdaqHolidaySchedule, parseLseBusinessDays,
  parseGovUkBankHolidays, checkMarketYear, refreshMarketYear, refreshCalendars
} = require('../lib/market-calendar-refresh');

const FIXTURES = path.join(__dirname, 'fixtures', 'market-calendar');
const PAGE = Object.freeze({
  NYSE: fs.readFileSync(path.join(FIXTURES, 'nyse-hours-calendars.html'), 'utf8'),
  NASDAQ: fs.readFileSync(path.join(FIXTURES, 'nasdaq-holiday-schedule.html'), 'utf8'),
  LSE: fs.readFileSync(path.join(FIXTURES, 'lse-business-days.html'), 'utf8'),
  GOVUK: fs.readFileSync(path.join(FIXTURES, 'govuk-bank-holidays.json'), 'utf8')
});
const NOW = () => new Date('2026-11-15T02:00:00Z');

function dates(rows) {
  return rows.map(row => row.date);
}

// A fake fetch serving the saved pages; `fail` lists source ids whose page fails (or a function).
function fakeFetch({fail = [], override = {}} = {}) {
  const calls = [];
  const byUrl = {};
  for (const market of Object.keys(SOURCES)) {
    for (const kind of ['official', 'second']) byUrl[SOURCES[market][kind].url] = SOURCES[market][kind].id;
  }
  const impl = async url => {
    const id = byUrl[url];
    calls.push(id);
    if (fail.includes(id)) return {ok: false, status: 503, text: async () => ''};
    const body = override[id] !== undefined ? override[id] : PAGE[id];
    return {ok: true, status: 200, text: async () => body};
  };
  impl.calls = calls;
  return impl;
}

// In-memory fake of the three calendar tables. Each transaction works on a copy; a throw rolls back.
function fakeDatabase({failOn} = {}) {
  const state = {days: [], years: [], changes: [], nextId: 1};
  const runtime = {
    state,
    transactions: 0,
    async query() { throw new Error('calendar engine must use transactions only'); },
    async transaction(callback) {
      runtime.transactions++;
      const work = JSON.parse(JSON.stringify(state));
      const client = {
        async query(sql, p) {
          const tag = /-- calendar:([a-z-]+)/.exec(sql)[1];
          if (failOn === tag) throw new Error('made-up database failure');
          if (tag === 'select-days') {
            return {rows: work.days.filter(d => d.market === p[0] && d.year === p[1] && !d.retired_at)
              .map(d => ({...d}))};
          }
          if (tag === 'insert-day') {
            work.days.push({id: work.nextId++, market: p[0], year: p[1], calendar_date: p[2], kind: p[3], name: p[4],
              early_close_time: p[5], after_hours_end: p[6], source: p[7], source_url: p[8], fetched_at: p[9],
              needs_review: p[10], retired_at: null});
          } else if (tag === 'update-day') {
            Object.assign(work.days.find(d => d.id === p[0]), {kind: p[1], name: p[2], early_close_time: p[3],
              after_hours_end: p[4], source: p[5], source_url: p[6], fetched_at: p[7], needs_review: true});
          } else if (tag === 'retire-day') {
            Object.assign(work.days.find(d => d.id === p[0]), {retired_at: p[1], needs_review: true});
          } else if (tag === 'flag-day') {
            work.days.find(d => d.id === p[0]).needs_review = true;
          } else if (tag === 'insert-change') {
            work.changes.push({market: p[1], year: p[2], calendar_date: p[3], change_kind: p[4], note: p[9]});
          } else if (tag === 'upsert-year') {
            work.years = work.years.filter(y => !(y.market === p[0] && y.year === p[1]));
            work.years.push({market: p[0], year: p[1], status: 'COMPLETE', source: p[2], row_count: p[4]});
          } else {
            throw new Error(`unexpected query ${tag}`);
          }
          return {rows: []};
        }
      };
      const result = await callback(client);
      Object.assign(state, work);
      return result;
    }
  };
  return runtime;
}

function liveDays(state, market, year) {
  return state.days.filter(d => d.market === market && d.year === year && !d.retired_at);
}

function yearRow(state, market, year) {
  return state.years.find(y => y.market === market && y.year === year);
}

// ---------------------------------------------------------------------------------------------
// Readers

test('9AU Build 2A: the NYSE reader finds the known 2026 and 2027 holidays and early closes', () => {
  const {years} = parseNyseHoursCalendars(PAGE.NYSE);
  assert.deepEqual(dates(years[2026].holidays), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
  assert.deepEqual(dates(years[2027].holidays), ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
    '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
  assert.deepEqual(years[2026].earlyCloses.map(r => [r.date, r.earlyCloseTime, r.afterHoursEnd]),
    [['2026-11-27', '13:00', '17:00'], ['2026-12-24', '13:00', '17:00']]);
  assert.deepEqual(years[2027].earlyCloses.map(r => [r.date, r.earlyCloseTime, r.afterHoursEnd]),
    [['2027-11-26', '13:00', '17:00']]);
  // 2028: no New Year's Day holiday (Saturday), 9 holidays, two early closes.
  assert.equal(years[2028].holidays.length, 9);
  assert.ok(!dates(years[2028].holidays).includes('2028-01-01'));
  assert.deepEqual(dates(years[2028].earlyCloses), ['2028-07-03', '2028-11-24']);
  // The same dates as today's built-in US lists.
  const {FULL_DAY_HOLIDAYS} = require('../lib/market-session-calendar');
  assert.deepEqual(dates(years[2026].holidays), [...FULL_DAY_HOLIDAYS.US[2026]]);
  assert.deepEqual(dates(years[2027].holidays), [...FULL_DAY_HOLIDAYS.US[2027]]);
});

test('9AU Build 2A: the Nasdaq reader finds the 2026 holidays and early closes (no after-hours end)', () => {
  const {years} = parseNasdaqHolidaySchedule(PAGE.NASDAQ);
  assert.deepEqual(Object.keys(years), ['2026']);
  assert.equal(years[2026].holidays.length, 10);
  assert.deepEqual(years[2026].earlyCloses.map(r => [r.date, r.earlyCloseTime, r.afterHoursEnd]),
    [['2026-11-27', '13:00', null], ['2026-12-24', '13:00', null]]);
});

test('9AU Build 2A: the LSE reader finds 2027 holidays and the 12:30 half days; 2026 is only partly on the page', () => {
  const {years} = parseLseBusinessDays(PAGE.LSE);
  assert.deepEqual(dates(years[2027].holidays), ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03',
    '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']);
  assert.deepEqual(years[2027].earlyCloses.map(r => [r.date, r.earlyCloseTime]),
    [['2027-12-24', '12:30'], ['2027-12-31', '12:30']]);
  assert.deepEqual(dates(years[2026].holidays), ['2026-08-31', '2026-12-25', '2026-12-28']);
  assert.deepEqual(dates(years[2026].earlyCloses), ['2026-12-24', '2026-12-31']);
  assert.equal(years[2028].holidays.length, 8);
});

test('9AU Build 2A: the GOV.UK reader finds the England and Wales 2026 and 2027 bank holidays', () => {
  const {years} = parseGovUkBankHolidays(PAGE.GOVUK);
  assert.deepEqual(dates(years[2026].holidays), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04',
    '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
  assert.deepEqual(dates(years[2027].holidays), ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03',
    '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']);
  assert.equal(years[2027].earlyCloses.length, 0);
});

test('9AU Build 2A: a page that changed shape is a parse failure, not a guess', () => {
  assert.throws(() => parseNyseHoursCalendars('<html>nothing here</html>'), {code: 'PARSE_FAILED'});
  assert.throws(() => parseLseBusinessDays('<table><tr><td>x</td></tr></table>'), {code: 'PARSE_FAILED'});
  assert.throws(() => parseGovUkBankHolidays('not json'), {code: 'PARSE_FAILED'});
  const wrongWeekday = PAGE.NYSE.replace('Thursday, January 1', 'Monday, January 1');
  assert.throws(() => parseNyseHoursCalendars(wrongWeekday), {code: 'PARSE_FAILED'});
});

// ---------------------------------------------------------------------------------------------
// Sanity rules

test('9AU Build 2A: each sanity rule rejects a bad case', () => {
  const good = parseNyseHoursCalendars(PAGE.NYSE).years[2027];
  const base = {market: 'US', year: 2027, holidays: good.holidays, earlyCloses: good.earlyCloses};
  assert.deepEqual(checkMarketYear(base), []);
  const codes = input => checkMarketYear({...base, ...input}).map(p => p.code);
  assert.ok(codes({holidays: [...good.holidays.slice(1), {date: '2028-01-03', name: 'x'}]}).includes('DATE_OUTSIDE_YEAR'));
  assert.ok(codes({holidays: [...good.holidays.slice(0, 9), {date: '2027-07-04', name: 'Sunday'}]}).includes('WEEKEND_DATE'));
  assert.ok(codes({holidays: [...good.holidays.slice(0, 9), good.holidays[1]]}).includes('DUPLICATE_DATE'));
  assert.ok(codes({holidays: good.holidays.slice(0, 8)}).includes('HOLIDAY_COUNT_OUT_OF_RANGE'));
  assert.ok(codes({holidays: [...good.holidays, {date: '2027-08-02', name: 'a'}, {date: '2027-08-03', name: 'b'}]})
    .includes('HOLIDAY_COUNT_OUT_OF_RANGE'));
  assert.ok(codes({holidays: [...good.holidays.slice(1), {date: '2027-08-02', name: 'x'}]}).includes('ANCHOR_MISSING'));
  assert.ok(codes({holidays: [...good.holidays.slice(0, 9), {date: '2027-08-02', name: 'x'}]}).includes('ANCHOR_MISSING'));
  assert.ok(codes({earlyCloses: [{date: '2027-11-25', name: 'x', earlyCloseTime: '13:00', afterHoursEnd: '17:00'}]})
    .includes('EARLY_CLOSE_IS_HOLIDAY'));
  // UK range 8 to 9 and UK observed days (Christmas 2027 on Saturday -> 27 December).
  const uk = parseLseBusinessDays(PAGE.LSE).years[2027];
  assert.deepEqual(checkMarketYear({market: 'UK', year: 2027, ...uk}), []);
  assert.ok(checkMarketYear({market: 'UK', year: 2027, holidays: uk.holidays.slice(0, 7), earlyCloses: []})
    .some(p => p.code === 'HOLIDAY_COUNT_OUT_OF_RANGE'));
  // US 2028: a Saturday New Year's Day has no observed day, so its absence passes.
  const us2028 = parseNyseHoursCalendars(PAGE.NYSE).years[2028];
  assert.deepEqual(checkMarketYear({market: 'US', year: 2028, ...us2028}), []);
});

// ---------------------------------------------------------------------------------------------
// Refresh

test('9AU Build 2A: official source saves the year, COMPLETE, rows OFFICIAL and not flagged', async () => {
  const db = fakeDatabase();
  const fetchImpl = fakeFetch();
  const result = await refreshMarketYear({market: 'US', year: 2027, fetchImpl, runtime: db, now: NOW});
  assert.equal(result.status, 'SAVED');
  assert.equal(result.source, 'OFFICIAL');
  assert.deepEqual(result.saved, {inserted: 11, updated: 0, retired: 0});
  assert.deepEqual(fetchImpl.calls, ['NYSE']);
  const rows = liveDays(db.state, 'US', 2027);
  assert.ok(rows.every(r => r.source === 'OFFICIAL' && r.needs_review === false));
  assert.deepEqual(yearRow(db.state, 'US', 2027), {market: 'US', year: 2027, status: 'COMPLETE', source: 'OFFICIAL', row_count: 11});
  // Running again with the same page changes nothing.
  const again = await refreshMarketYear({market: 'US', year: 2027, fetchImpl, runtime: db, now: NOW});
  assert.deepEqual(again.saved, {inserted: 0, updated: 0, retired: 0});
  assert.equal(db.state.changes.length, 0);
});

test('9AU Build 2A: the second source is used only when the official page fails, rows SECOND and flagged', async () => {
  for (const [market, year, official, second] of [['US', 2026, 'NYSE', 'NASDAQ'], ['UK', 2027, 'LSE', 'GOVUK']]) {
    const db = fakeDatabase();
    const fetchImpl = fakeFetch({fail: [official]});
    const result = await refreshMarketYear({market, year, fetchImpl, runtime: db, now: NOW});
    assert.equal(result.status, 'SAVED', market);
    assert.equal(result.source, 'SECOND', market);
    assert.deepEqual(fetchImpl.calls, [official, second], market);
    assert.ok(liveDays(db.state, market, year).every(r => r.source === 'SECOND' && r.needs_review === true), market);
    assert.equal(yearRow(db.state, market, year).source, 'SECOND');
  }
  // An official page that cannot be parsed also falls to the second source.
  const db = fakeDatabase();
  const result = await refreshMarketYear({market: 'UK', year: 2027,
    fetchImpl: fakeFetch({override: {LSE: '<html>moved</html>'}}), runtime: db, now: NOW});
  assert.equal(result.source, 'SECOND');
  assert.equal(result.errors[0].code, 'PARSE_FAILED');
});

test('9AU Build 2A: both sources failing writes nothing and returns an error', async () => {
  const db = fakeDatabase();
  const result = await refreshMarketYear({market: 'US', year: 2027,
    fetchImpl: fakeFetch({fail: ['NYSE', 'NASDAQ']}), runtime: db, now: NOW});
  assert.equal(result.status, 'ERROR');
  assert.ok(result.errors.some(e => e.code === 'BOTH_SOURCES_FAILED'));
  assert.equal(db.transactions, 0);
  assert.equal(db.state.days.length + db.state.years.length + db.state.changes.length, 0);
});

test('9AU Build 2A: a year failing the sanity check writes nothing (LSE 2026 is only partly listed)', async () => {
  const db = fakeDatabase();
  const fetchImpl = fakeFetch();
  const result = await refreshMarketYear({market: 'UK', year: 2026, fetchImpl, runtime: db, now: NOW});
  assert.equal(result.status, 'ERROR');
  assert.ok(result.errors.some(e => e.code === 'HOLIDAY_COUNT_OUT_OF_RANGE'));
  assert.deepEqual(fetchImpl.calls, ['LSE']);
  assert.equal(db.transactions, 0);
});

// Seeds US 2026 from the official page, then serves an edited page.
async function seededUs2026() {
  const db = fakeDatabase();
  await refreshMarketYear({market: 'US', year: 2026, fetchImpl: fakeFetch(), runtime: db, now: NOW});
  return db;
}

test('9AU Build 2A: a change within 30 days is held and flagged; one further away is applied; removed dates are retired, never deleted', async () => {
  const db = await seededUs2026();
  const before = db.state.days.length;
  // Edited page: Thanksgiving (26 Nov, 11 days away) moves to Monday 23 Nov (the new date is
  // inserted, the stored one is held); 24 Dec early close becomes 12:00 (39 days away: applied).
  const page = PAGE.NYSE
    .replace('Thursday, November 26***', 'Monday, November 23***')
    .replace('close early at 1:00 p.m. (1:15 p.m. for eligible options) on Thursday, December 24, 2026',
      'close early at 12:00 p.m. (1:15 p.m. for eligible options) on Thursday, December 24, 2026');
  const result = await refreshMarketYear({market: 'US', year: 2026, fetchImpl: fakeFetch({override: {NYSE: page}}),
    runtime: db, now: NOW});
  assert.equal(result.status, 'SAVED');
  assert.deepEqual(result.saved, {inserted: 1, updated: 1, retired: 0});
  assert.deepEqual(result.heldChanges.map(c => [c.date, c.change]), [['2026-11-26', 'RETIRE']]);
  const thanksgiving = db.state.days.find(d => d.calendar_date === '2026-11-26');
  assert.equal(thanksgiving.retired_at, null);
  assert.equal(thanksgiving.needs_review, true);
  const eve = db.state.days.find(d => d.calendar_date === '2026-12-24');
  assert.equal(eve.early_close_time, '12:00');
  assert.equal(eve.needs_review, true);
  assert.deepEqual(db.state.changes.map(c => [c.calendar_date, c.change_kind]),
    [['2026-12-24', 'UPDATE'], ['2026-11-26', 'HELD_RETIRE']]);
  assert.ok(db.state.changes.every(c => c.note.startsWith('flagged')));

  // A date far ahead that disappears is retired (kept, with retired_at), never deleted.
  const db2 = await seededUs2026();
  const result2 = await refreshMarketYear({market: 'US', year: 2026, runtime: db2, now: () => new Date('2026-01-02T00:00:00Z'),
    fetchImpl: fakeFetch({override: {NYSE: PAGE.NYSE.replace('Monday, September 7', 'Tuesday, September 8')}})});
  assert.deepEqual(result2.saved, {inserted: 1, updated: 0, retired: 1});
  assert.equal(db2.state.days.length, before + 1);
  const labor = db2.state.days.find(d => d.calendar_date === '2026-09-07');
  assert.ok(labor.retired_at);
  assert.equal(labor.needs_review, true);
});

test('9AU Build 2A: more stored-date changes than calendarMaxChangedDatesPerRun are rejected, nothing written', async () => {
  const db = await seededUs2026();
  const snapshot = JSON.stringify(db.state);
  const page = PAGE.NYSE
    .replace('Monday, January 19', 'Tuesday, January 20')
    .replace('Monday, February 16', 'Tuesday, February 17')
    .replace('Monday, May 25', 'Tuesday, May 26')
    .replace('Monday, September 7', 'Tuesday, September 8');
  const result = await refreshMarketYear({market: 'US', year: 2026, fetchImpl: fakeFetch({override: {NYSE: page}}),
    runtime: db, now: () => new Date('2026-01-02T00:00:00Z')});
  assert.equal(result.status, 'ERROR');
  assert.deepEqual(result.errors.at(-1), {code: 'TOO_MANY_CHANGES', count: 4, limit: 3});
  assert.equal(JSON.stringify(db.state), snapshot);
  // A higher limit lets the same refresh through.
  const allowed = await refreshMarketYear({market: 'US', year: 2026, fetchImpl: fakeFetch({override: {NYSE: page}}),
    runtime: db, now: () => new Date('2026-01-02T00:00:00Z'), env: {CALENDAR_MAX_CHANGED_DATES_PER_RUN: '4'}});
  assert.equal(allowed.status, 'SAVED');
  // 19 Jan is within 30 days of 2 Jan, so that removal is held; the other three are applied.
  assert.deepEqual(allowed.saved, {inserted: 4, updated: 0, retired: 3});
  assert.deepEqual(allowed.heldChanges.map(c => [c.date, c.change]), [['2026-01-19', 'RETIRE']]);
});

test('9AU Build 2A: a failed transaction leaves the year not COMPLETE and nothing written', async () => {
  for (const failOn of ['insert-day', 'upsert-year']) {
    const db = fakeDatabase({failOn});
    const result = await refreshMarketYear({market: 'US', year: 2027, fetchImpl: fakeFetch(), runtime: db, now: NOW});
    assert.equal(result.status, 'ERROR', failOn);
    assert.deepEqual(result.errors.at(-1), {code: 'WRITE_FAILED'});
    assert.deepEqual(result.saved, {inserted: 0, updated: 0, retired: 0});
    assert.equal(yearRow(db.state, 'US', 2027), undefined);
    assert.equal(db.state.days.length, 0);
  }
});

test('9AU Build 2A: markets are independent, and each page is fetched once per run', async () => {
  const db = fakeDatabase();
  const fetchImpl = fakeFetch({fail: ['NYSE', 'NASDAQ']});
  const results = await refreshCalendars({targets: [
    {market: 'US', year: 2027}, {market: 'UK', year: 2027}, {market: 'UK', year: 2028}, {market: 'JP', year: 2027}
  ], fetchImpl, runtime: db, now: NOW});
  assert.deepEqual(results.map(r => [r.market, r.year, r.status]),
    [['US', 2027, 'ERROR'], ['UK', 2027, 'SAVED'], ['UK', 2028, 'SAVED'], ['JP', 2027, 'ERROR']]);
  assert.equal(results[3].errors[0].code, 'UNSUPPORTED_MARKET_YEAR');
  assert.equal(fetchImpl.calls.filter(id => id === 'LSE').length, 1);
  assert.equal(yearRow(db.state, 'UK', 2028).row_count, 10);
  assert.equal(yearRow(db.state, 'US', 2027), undefined);
  const halfDay = liveDays(db.state, 'UK', 2027).find(d => d.calendar_date === '2027-12-24');
  assert.deepEqual([halfDay.kind, halfDay.early_close_time, halfDay.after_hours_end], ['EARLY_CLOSE', '12:30', null]);
});

test('9AU Build 2A: calendarMaxChangedDatesPerRun is an Admin number 0 to 20, default 3', () => {
  const entry = SETTINGS_REGISTRY.calendarMaxChangedDatesPerRun;
  assert.equal(entry.admin, 'Admin');
  assert.equal(entry.envVar, 'CALENDAR_MAX_CHANGED_DATES_PER_RUN');
  assert.deepEqual([entry.default, entry.min, entry.max], [3, 0, 20]);
  assert.equal(settingValue('calendarMaxChangedDatesPerRun', {env: {}}), 3);
  assert.equal(settingValue('calendarMaxChangedDatesPerRun', {env: {CALENDAR_MAX_CHANGED_DATES_PER_RUN: '50'}}), 20);
  assert.equal(settingValue('calendarMaxChangedDatesPerRun', {env: {CALENDAR_MAX_CHANGED_DATES_PER_RUN: '-1'}}), 0);
  const text = entry.description;
  assert.ok(text.length <= 450);
  assert.ok(!/\bStep\b/i.test(text) && !/[0-9a-f]{7,}/i.test(text) && !/\b9[A-Z]{1,2}\b/.test(text));
  assert.ok(text.split(/[.!?](?:\s+|$)/).filter(part => part.trim()).length <= 2);
});

'use strict';

// 9AU Build 2B: Hong Kong and Singapore readers, US half-day hours and the flagged change column.
// Saved trimmed copies of the HKEX calendar, the 1823 JSON file, the HK Government 2027 page and
// the MOM page (tests/fixtures/market-calendar, fetched once on 15 Nov 2026), a fake fetch and an
// in-memory fake database with rollback. No network, no real database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCES, SECOND_ONLY_SOURCES, SQL, parseHkexCalendar, parseHk1823Holidays, parseHkGovYearPage,
  parseMomPublicHolidays, singaporeHalfDays, checkMarketYear, refreshMarketYear
} = require('../lib/market-calendar-refresh');
const {FULL_DAY_HOLIDAYS} = require('../lib/market-session-calendar');

const FIXTURES = path.join(__dirname, 'fixtures', 'market-calendar');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const PAGE = Object.freeze({
  HKEX: read('hkex-calendar.html'),
  HK1823: read('hk-1823-holidays.json'),
  HKGOV: read('hk-gov-holidays-2027.html'),
  MOM: read('mom-public-holidays.html'),
  NASDAQ: read('nasdaq-holiday-schedule.html')
});
const NOW = () => new Date('2026-11-15T02:00:00Z');
const dates = rows => rows.map(row => row.date);

function urlIds() {
  const byUrl = {
    [SOURCES.HK.third.urlFor(2027)]: 'HKGOV',
    [SECOND_ONLY_SOURCES.SG.url]: 'MOM'
  };
  for (const market of Object.keys(SOURCES)) {
    for (const kind of ['official', 'second']) byUrl[SOURCES[market][kind].url] = SOURCES[market][kind].id;
  }
  return byUrl;
}

function fakeFetch({fail = [], override = {}} = {}) {
  const byUrl = urlIds();
  const calls = [];
  const impl = async url => {
    const id = byUrl[url];
    calls.push(id || url);
    if (!id || fail.includes(id)) return {ok: false, status: 503, text: async () => ''};
    const body = override[id] !== undefined ? override[id] : PAGE[id];
    return {ok: true, status: 200, text: async () => body};
  };
  impl.calls = calls;
  return impl;
}

function fakeDatabase() {
  const state = {days: [], years: [], changes: [], nextId: 1};
  const runtime = {
    state,
    transactions: 0,
    async transaction(callback) {
      runtime.transactions++;
      const work = JSON.parse(JSON.stringify(state));
      const client = {
        async query(sql, p) {
          const tag = /-- calendar:([a-z-]+)/.exec(sql)[1];
          if (tag === 'select-days') {
            return {rows: work.days.filter(d => d.market === p[0] && d.year === p[1] && !d.retired_at).map(d => ({...d}))};
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
            work.changes.push({market: p[1], year: p[2], calendar_date: p[3], change_kind: p[4], note: p[9], flagged: p[10]});
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

const live = (state, market, year) => state.days.filter(d => d.market === market && d.year === year && !d.retired_at);

// ---------------------------------------------------------------------------------------------
// Hong Kong readers

test('9AU Build 2B: the HKEX reader finds the 2026 holidays and half days; mainland events are excluded', () => {
  const {years} = parseHkexCalendar(PAGE.HKEX);
  assert.deepEqual(dates(years[2026].holidays), [...FULL_DAY_HOLIDAYS.HK[2026]]);
  assert.deepEqual(years[2026].earlyCloses.map(r => [r.date, r.earlyCloseTime]),
    [['2026-02-16', null], ['2026-12-24', null], ['2026-12-31', null]]);
  // Mainland-only days (Spring Festival 20 Feb, Labour 4-5 May, National Day 2-7 Oct) are not holidays.
  for (const date of ['2026-02-20', '2026-05-04', '2026-05-05', '2026-10-02', '2026-10-05']) {
    assert.ok(!dates(years[2026].holidays).includes(date), date);
  }
  // Weekend Hong Kong holidays (Saturday 4 Apr, 26 Sep, 26 Dec) are dropped.
  assert.ok(!dates(years[2026].holidays).some(date => ['2026-04-04', '2026-09-26', '2026-12-26'].includes(date)));
  assert.equal(years[2026].holidays.length >= 12 && years[2026].holidays.length <= 17, true);
  assert.deepEqual(checkMarketYear({market: 'HK', year: 2026, ...years[2026]}), []);
  // 2027: the page covers only up to 5 Dec 2027, so 27 Dec and the December half days are missing
  // and the year fails the Christmas check (nothing would be written).
  assert.deepEqual(dates(years[2027].holidays), FULL_DAY_HOLIDAYS.HK[2027].filter(d => d !== '2027-12-27'));
  assert.deepEqual(dates(years[2027].earlyCloses), ['2027-02-05']);
  assert.ok(checkMarketYear({market: 'HK', year: 2027, ...years[2027]}).some(p => p.code === 'ANCHOR_MISSING'));
});

test('9AU Build 2B: the 1823 and HK Government readers find the known 2026 and 2027 holidays', () => {
  const j = parseHk1823Holidays(PAGE.HK1823).years;
  assert.deepEqual(dates(j[2026].holidays), [...FULL_DAY_HOLIDAYS.HK[2026]]);
  assert.deepEqual(dates(j[2027].holidays), [...FULL_DAY_HOLIDAYS.HK[2027]]);
  assert.equal(j[2027].earlyCloses.length, 0);
  const g = parseHkGovYearPage(PAGE.HKGOV, {year: 2027}).years;
  assert.deepEqual(dates(g[2027].holidays), [...FULL_DAY_HOLIDAYS.HK[2027]]);
  assert.deepEqual(checkMarketYear({market: 'HK', year: 2027, ...g[2027]}), []);
});

test('9AU Build 2B: an HKEX page that changed shape keeps the existing dates, writes nothing and returns an error', async () => {
  assert.throws(() => parseHkexCalendar('<html>moved</html>'), {code: 'PARSE_FAILED'});
  const db = fakeDatabase();
  const seeded = await refreshMarketYear({market: 'HK', year: 2026, fetchImpl: fakeFetch(), runtime: db, now: NOW});
  assert.equal(seeded.status, 'SAVED');
  assert.equal(seeded.source, 'OFFICIAL');
  assert.deepEqual(seeded.saved, {inserted: 17, updated: 0, retired: 0});
  const snapshot = JSON.stringify(db.state);
  const fetchImpl = fakeFetch({override: {HKEX: PAGE.HKEX.replaceAll('calendarDataSource', 'calendarData')}});
  const result = await refreshMarketYear({market: 'HK', year: 2026, fetchImpl, runtime: db, now: NOW});
  assert.equal(result.status, 'ERROR');
  assert.deepEqual(result.errors.map(e => e.code), ['PARSE_FAILED', 'OFFICIAL_PAGE_CHANGED']);
  assert.deepEqual(fetchImpl.calls, ['HKEX']);
  assert.equal(JSON.stringify(db.state), snapshot);
});

test('9AU Build 2B: an HKEX page that cannot be fetched uses 1823, then the HK Government page; SECOND and needs_review', async () => {
  const db = fakeDatabase();
  const first = await refreshMarketYear({market: 'HK', year: 2027, fetchImpl: fakeFetch({fail: ['HKEX']}), runtime: db, now: NOW});
  assert.equal(first.status, 'SAVED');
  assert.equal(first.sourceId, 'HK1823');
  assert.ok(live(db.state, 'HK', 2027).every(r => r.source === 'SECOND' && r.needs_review === true));
  assert.equal(live(db.state, 'HK', 2027).length, 13);
  const db2 = fakeDatabase();
  const fetchImpl = fakeFetch({fail: ['HKEX', 'HK1823']});
  const second = await refreshMarketYear({market: 'HK', year: 2027, fetchImpl, runtime: db2, now: NOW});
  assert.equal(second.status, 'SAVED');
  assert.equal(second.sourceId, 'HKGOV');
  assert.deepEqual(fetchImpl.calls, ['HKEX', 'HK1823', 'HKGOV']);
  assert.equal(live(db2.state, 'HK', 2027)[0].source_url, 'https://www.gov.hk/en/about/abouthk/holiday/2027.htm');
  // All three failing writes nothing.
  const db3 = fakeDatabase();
  const none = await refreshMarketYear({market: 'HK', year: 2027,
    fetchImpl: fakeFetch({fail: ['HKEX', 'HK1823', 'HKGOV']}), runtime: db3, now: NOW});
  assert.equal(none.status, 'ERROR');
  assert.equal(none.errors.at(-1).code, 'BOTH_SOURCES_FAILED');
  assert.equal(db3.transactions, 0);
});

test('9AU Build 2B: Hong Kong half days are EARLY_CLOSE rows stored closing at 12:00 when the page states none', async () => {
  const db = fakeDatabase();
  await refreshMarketYear({market: 'HK', year: 2026, fetchImpl: fakeFetch(), runtime: db, now: NOW});
  const half = live(db.state, 'HK', 2026).filter(r => r.kind === 'EARLY_CLOSE');
  assert.deepEqual(half.map(r => [r.calendar_date, r.early_close_time, r.after_hours_end]),
    [['2026-02-16', '12:00', null], ['2026-12-24', '12:00', null], ['2026-12-31', '12:00', null]]);
  // A stated time is stored.
  const stated = PAGE.HKEX.replace('"description":"","startdate":"2026-12-24"',
    '"description":"Trading ends at 12:00 noon","startdate":"2026-12-24"');
  const {years} = parseHkexCalendar(stated);
  assert.equal(years[2026].earlyCloses.find(r => r.date === '2026-12-24').earlyCloseTime, '12:00');
});

// ---------------------------------------------------------------------------------------------
// Singapore

test('9AU Build 2B: the MOM reader finds the known 2026 and 2027 holidays with Monday substitutes for Sunday holidays only', () => {
  const {years, chineseNewYear} = parseMomPublicHolidays(PAGE.MOM);
  assert.deepEqual(dates(years[2026].holidays), [...FULL_DAY_HOLIDAYS.SG[2026]]);
  assert.deepEqual(dates(years[2027].holidays), [...FULL_DAY_HOLIDAYS.SG[2027]]);
  // Sunday 31 May, 9 Aug, 8 Nov 2026 -> Monday; Saturday 21 Mar 2026 has none.
  for (const date of ['2026-06-01', '2026-08-10', '2026-11-09']) assert.ok(dates(years[2026].holidays).includes(date));
  assert.ok(!dates(years[2026].holidays).some(d => d === '2026-03-21' || d === '2026-03-23'));
  // Chinese New Year 2027 is Saturday 6 and Sunday 7 Feb: only Monday 8 Feb.
  assert.ok(dates(years[2027].holidays).includes('2027-02-08'));
  assert.deepEqual([chineseNewYear[2026], chineseNewYear[2027]], ['2026-02-17', '2027-02-06']);
  assert.deepEqual(checkMarketYear({market: 'SG', year: 2026, holidays: years[2026].holidays, earlyCloses: []}), []);
  assert.deepEqual(checkMarketYear({market: 'SG', year: 2027, holidays: years[2027].holidays, earlyCloses: []}), []);
  assert.throws(() => parseMomPublicHolidays('<html>moved</html>'), {code: 'PARSE_FAILED'});
});

test('9AU Build 2B: Singapore half-day rule (Chinese New Year eve, 24 and 31 Dec; weekday and not a holiday)', () => {
  const parsed = parseMomPublicHolidays(PAGE.MOM);
  const half = year => singaporeHalfDays(year, parsed.years[year].holidays, parsed);
  // Eve on Monday 16 Feb 2026 and Friday 5 Feb 2027 (the first day is a Saturday); 24 and 31 Dec on weekdays.
  assert.deepEqual(dates(half(2026)), ['2026-02-16', '2026-12-24', '2026-12-31']);
  assert.deepEqual(dates(half(2027)), ['2027-02-05', '2027-12-24', '2027-12-31']);
  assert.ok(half(2027).every(r => r.earlyCloseTime === null));
  // Weekend: 2028 has 24 and 31 Dec on Sundays, so neither is a half day.
  const none = {years: {}, chineseNewYear: {2028: '2028-01-26'}};
  assert.deepEqual(dates(singaporeHalfDays(2028, [], none)), ['2028-01-25']);
  // Holiday: a 24 Dec or eve that is itself a holiday is not a half day.
  const holiday = singaporeHalfDays(2026, [{date: '2026-12-24'}, {date: '2026-02-16'}], parsed);
  assert.deepEqual(dates(holiday), ['2026-12-31']);
});

test('9AU Build 2B: Singapore saves MOM holidays and rule half days as SECOND and needs_review', async () => {
  const db = fakeDatabase();
  const fetchImpl = fakeFetch();
  const result = await refreshMarketYear({market: 'SG', year: 2027, fetchImpl, runtime: db, now: NOW});
  assert.equal(result.status, 'SAVED');
  assert.equal(result.source, 'SECOND');
  assert.equal(result.sourceId, 'MOM');
  assert.deepEqual(fetchImpl.calls, ['MOM']);
  const rows = live(db.state, 'SG', 2027);
  assert.equal(rows.length, 11);
  assert.ok(rows.every(r => r.source === 'SECOND' && r.needs_review === true));
  assert.deepEqual(rows.filter(r => r.kind === 'EARLY_CLOSE').map(r => r.calendar_date), ['2027-02-05', '2027-12-24', '2027-12-31']);
  assert.equal(db.state.years[0].source, 'SECOND');
  // MOM unreadable: nothing written.
  const db2 = fakeDatabase();
  const failed = await refreshMarketYear({market: 'SG', year: 2027, fetchImpl: fakeFetch({fail: ['MOM']}), runtime: db2, now: NOW});
  assert.equal(failed.status, 'ERROR');
  assert.equal(db2.transactions, 0);
});

// ---------------------------------------------------------------------------------------------
// US half-day hours and the flagged column

test('9AU Build 2B: a Nasdaq-sourced US half day is stored complete (close 13:00, after-hours 17:00)', async () => {
  const db = fakeDatabase();
  const result = await refreshMarketYear({market: 'US', year: 2026, fetchImpl: fakeFetch({fail: ['NYSE']}), runtime: db, now: NOW});
  assert.equal(result.sourceId, 'NASDAQ');
  const half = live(db.state, 'US', 2026).filter(r => r.kind === 'EARLY_CLOSE');
  assert.deepEqual(half.map(r => [r.calendar_date, r.early_close_time, r.after_hours_end]),
    [['2026-11-27', '13:00', '17:00'], ['2026-12-24', '13:00', '17:00']]);
});

test('9AU Build 2B: change-log rows carry flagged = TRUE in their own column; the note text is kept', async () => {
  assert.match(SQL.insertChange, /note, flagged\)/);
  assert.match(SQL.insertChange, /\$11\)/);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '004_market_calendar.sql'), 'utf8');
  const changes = /CREATE TABLE IF NOT EXISTS market_calendar_changes \(([\s\S]*?)\n\);/.exec(sql)[1];
  assert.match(changes, /flagged BOOLEAN NOT NULL DEFAULT FALSE/);
  const db = fakeDatabase();
  await refreshMarketYear({market: 'HK', year: 2026, fetchImpl: fakeFetch(), runtime: db, now: NOW});
  // The 31 Dec half day (46 days away, so applied) moves to 30 Dec on the page.
  const page = PAGE.HKEX.replace('"startdate":"2026-12-31","enddate":"2026-12-31"', '"startdate":"2026-12-30","enddate":"2026-12-30"');
  const result = await refreshMarketYear({market: 'HK', year: 2026, fetchImpl: fakeFetch({override: {HKEX: page}}), runtime: db, now: NOW});
  assert.equal(result.status, 'SAVED');
  assert.deepEqual(result.saved, {inserted: 1, updated: 0, retired: 1});
  assert.deepEqual(db.state.changes.map(c => [c.calendar_date, c.change_kind, c.flagged, c.note]),
    [['2026-12-31', 'RETIRE', true, 'flagged; applied']]);
});

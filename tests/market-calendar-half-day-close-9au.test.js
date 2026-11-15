'use strict';

// 9AU Build 2B (decision 2): Hong Kong and Singapore half days are stored closing at 12:00 with
// needs_review; every engine-written row satisfies migration 004's own early-close rules; and a
// year with those half days is read by the Build 1 reader. Saved fixtures, fake fetch, in-memory
// fake database. No network, no real database, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SOURCES, SECOND_ONLY_SOURCES, refreshMarketYear} = require('../lib/market-calendar-refresh');
const {loadCalendar, calendarYear, resetCalendarCache} = require('../lib/market-calendar-store');

const FIXTURES = path.join(__dirname, 'fixtures', 'market-calendar');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const PAGE = Object.freeze({
  NYSE: read('nyse-hours-calendars.html'),
  NASDAQ: read('nasdaq-holiday-schedule.html'),
  LSE: read('lse-business-days.html'),
  GOVUK: read('govuk-bank-holidays.json'),
  HKEX: read('hkex-calendar.html'),
  HK1823: read('hk-1823-holidays.json'),
  MOM: read('mom-public-holidays.html')
});
const NOW = () => new Date('2026-11-15T02:00:00Z');
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '004_market_calendar.sql'), 'utf8');

function fakeFetch({fail = []} = {}) {
  const byUrl = {[SECOND_ONLY_SOURCES.SG.url]: 'MOM'};
  for (const market of Object.keys(SOURCES)) {
    for (const kind of ['official', 'second']) byUrl[SOURCES[market][kind].url] = SOURCES[market][kind].id;
  }
  return async url => {
    const id = byUrl[url];
    if (!id || fail.includes(id)) return {ok: false, status: 503, text: async () => ''};
    return {ok: true, status: 200, text: async () => PAGE[id]};
  };
}

// Records the days the engine inserts (the only writes these refreshes make to the days table).
function fakeDatabase() {
  const days = [];
  return {
    days,
    async transaction(callback) {
      return callback({
        async query(sql, p) {
          const tag = /-- calendar:([a-z-]+)/.exec(sql)[1];
          if (tag === 'insert-day') {
            days.push({market: p[0], year: p[1], calendar_date: p[2], kind: p[3], name: p[4], early_close_time: p[5],
              after_hours_end: p[6], source: p[7], needs_review: p[10]});
          }
          return {rows: []};
        }
      });
    }
  };
}

async function engineRows(market, year, options = {}) {
  const db = fakeDatabase();
  const result = await refreshMarketYear({market, year, fetchImpl: fakeFetch(options), runtime: db, now: NOW});
  assert.equal(result.status, 'SAVED', `${market} ${year}`);
  return db.days;
}

// Turns the market_calendar_days CHECK constraints that mention early_close_time or
// after_hours_end into JavaScript tests, read from the migration file (not hard-coded).
function earlyCloseRules() {
  const table = /CREATE TABLE IF NOT EXISTS market_calendar_days \(([\s\S]*?)\n\);/.exec(MIGRATION)[1];
  const checks = [];
  const re = /CONSTRAINT (\w+)\s+CHECK \(/g;
  let match;
  while ((match = re.exec(table))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth && i < table.length) {
      if (table[i] === '(') depth++;
      else if (table[i] === ')') depth--;
      i++;
    }
    const body = table.slice(re.lastIndex, i - 1);
    if (/early_close_time|after_hours_end/.test(body)) checks.push({name: match[1], body});
  }
  return checks.map(({name, body}) => {
    const js = body
      .replace(/(\w+) ~ '([^']*)'/g, (all, column, pattern) => `new RegExp(${JSON.stringify(pattern)}).test(row.${column})`)
      .replace(/(\w+) IS NOT NULL/g, 'row.$1 != null')
      .replace(/(\w+) IS NULL/g, 'row.$1 == null')
      .replace(/(\w+) = '([^']*)'/g, "row.$1 === '$2'")
      .replace(/\bAND\b/g, '&&')
      .replace(/\bOR\b/g, '||');
    return {name, test: new Function('row', `return Boolean(${js});`)};
  });
}

test('9AU Build 2B: HK and SG half days are stored closing at 12:00 and marked needs_review', async () => {
  const hk = (await engineRows('HK', 2026)).filter(r => r.kind === 'EARLY_CLOSE');
  assert.deepEqual(hk.map(r => [r.calendar_date, r.early_close_time, r.after_hours_end, r.source, r.needs_review]),
    [['2026-02-16', '12:00', null, 'OFFICIAL', true], ['2026-12-24', '12:00', null, 'OFFICIAL', true],
      ['2026-12-31', '12:00', null, 'OFFICIAL', true]]);
  const sg = (await engineRows('SG', 2027)).filter(r => r.kind === 'EARLY_CLOSE');
  assert.deepEqual(sg.map(r => [r.calendar_date, r.early_close_time, r.needs_review]),
    [['2027-02-05', '12:00', true], ['2027-12-24', '12:00', true], ['2027-12-31', '12:00', true]]);
  // HK official holidays are not marked; only the half days are.
  const hkHolidays = (await engineRows('HK', 2026)).filter(r => r.kind === 'HOLIDAY');
  assert.ok(hkHolidays.length && hkHolidays.every(r => r.needs_review === false));
});

test('9AU Build 2B: every row the engine writes satisfies the migration 004 early-close rules', async () => {
  const rules = earlyCloseRules();
  // The migration has the time-format rules and the kind/fields rule.
  assert.deepEqual(rules.map(r => r.name).sort(), ['market_calendar_days_after_hours_end_check',
    'market_calendar_days_early_close_fields_check', 'market_calendar_days_early_close_time_check']);
  // The rules catch a blank half-day close (what the engine used to write for HK and SG).
  const fields = rules.find(r => r.name === 'market_calendar_days_early_close_fields_check');
  assert.equal(fields.test({kind: 'EARLY_CLOSE', early_close_time: null, after_hours_end: null}), false);
  assert.equal(fields.test({kind: 'HOLIDAY', early_close_time: null, after_hours_end: null}), true);
  const runs = [['US', 2026], ['US', 2027], ['UK', 2027], ['UK', 2028], ['HK', 2026], ['SG', 2026], ['SG', 2027]];
  const rows = [];
  for (const [market, year] of runs) rows.push(...await engineRows(market, year));
  rows.push(...await engineRows('US', 2026, {fail: ['NYSE']}));
  rows.push(...await engineRows('HK', 2027, {fail: ['HKEX']}));
  assert.ok(rows.some(r => r.kind === 'EARLY_CLOSE' && r.market === 'HK'));
  assert.ok(rows.some(r => r.kind === 'EARLY_CLOSE' && r.market === 'SG'));
  for (const row of rows) {
    for (const rule of rules) assert.ok(rule.test(row), `${rule.name}: ${row.market} ${row.calendar_date}`);
  }
});

test('9AU Build 2B: a year with HK or SG half days is no longer skipped by the Build 1 reader', async () => {
  const saved = process.env.HOLIDAY_CALENDAR_DB_ENABLED;
  process.env.HOLIDAY_CALENDAR_DB_ENABLED = 'on';
  resetCalendarCache();
  try {
    const rows = [...await engineRows('HK', 2026), ...await engineRows('SG', 2027)];
    const runtime = {
      async query() { return {rows: rows.map(r => ({...r}))}; },
      async transaction() { throw new Error('not expected'); }
    };
    const lines = [];
    await loadCalendar({runtime, log: line => lines.push(line)});
    assert.ok(!lines.some(line => line.event === 'CALENDAR_DB_YEAR_SKIPPED'), JSON.stringify(lines));
    const hk = calendarYear('HK', 2026);
    const sg = calendarYear('SG', 2027);
    assert.ok(hk && sg);
    assert.deepEqual([...hk.earlyCloses.keys()], ['2026-02-16', '2026-12-24', '2026-12-31']);
    assert.deepEqual(hk.earlyCloses.get('2026-12-24'), {regularClose: '12:00'});
    assert.deepEqual([...sg.earlyCloses.keys()], ['2027-02-05', '2027-12-24', '2027-12-31']);
    assert.equal(hk.holidays.size, 14);
    assert.equal(sg.holidays.size, 8);
  } finally {
    if (saved === undefined) delete process.env.HOLIDAY_CALENDAR_DB_ENABLED;
    else process.env.HOLIDAY_CALENDAR_DB_ENABLED = saved;
    resetCalendarCache();
  }
});

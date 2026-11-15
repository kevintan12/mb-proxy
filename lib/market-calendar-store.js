'use strict';

// Holiday calendar read from the database (db/migrations/004_market_calendar.sql), behind the
// Admin switch holidayCalendarDbEnabled (off by default). loadCalendar() reads every COMPLETE
// year in one query and keeps the result in memory for calendarCacheMinutes. dateStatus() in
// lib/market-session-calendar.js asks calendarYear() synchronously; a year that is not loaded
// stays on the built-in lists. A database failure is one log line and the built-in lists: the
// table can never fail a brief.
//
// This module must not require lib/market-session-calendar.js (that module requires this one).

const {settingValue} = require('./settings-registry');

const SUPPORTED_MARKETS = Object.freeze(['US', 'SG', 'HK']);
const DATE_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const CALENDAR_QUERY = `
SELECT y.market, y.year, d.calendar_date, d.kind, d.early_close_time, d.after_hours_end
FROM market_calendar_years y
LEFT JOIN market_calendar_days d
  ON d.market = y.market AND d.year = y.year AND d.retired_at IS NULL
WHERE y.status = 'COMPLETE' AND y.market IN ('US', 'SG', 'HK')
ORDER BY y.market, y.year, d.calendar_date`;

let cachedCalendar = null; // {loadedAtMs, years: {US: {2028: yearEntry}}}

function defaultLog(line) {
  console.warn('[market-calendar]', JSON.stringify(line));
}

function enabled(env) {
  return settingValue('holidayCalendarDbEnabled', {env}) === true;
}

// Builds {US: {2028: {holidays, earlyCloses}}} from the query rows. A year with any row that
// cannot be read is dropped as a whole (it stays on the built-in lists), so one year is never a
// mix of table rows and built-in rows.
function buildYears(rows) {
  const years = {};
  const broken = new Set();
  for (const row of rows) {
    const market = row && row.market;
    const year = Number(row && row.year);
    if (!SUPPORTED_MARKETS.includes(market) || !Number.isInteger(year)) continue;
    const key = `${market}:${year}`;
    if (!years[market]) years[market] = {};
    if (!years[market][year]) years[market][year] = {holidays: new Set(), earlyCloses: new Map()};
    if (row.calendar_date === null || row.calendar_date === undefined) continue; // a year with no rows
    const entry = years[market][year];
    const match = DATE_KEY.exec(row.calendar_date);
    if (!match || Number(match[1]) !== year) { broken.add(key); continue; }
    if (row.kind === 'HOLIDAY') {
      entry.holidays.add(row.calendar_date);
    } else if (row.kind === 'EARLY_CLOSE') {
      const regularClose = row.early_close_time;
      const postEnd = row.after_hours_end;
      if (!WALL_TIME.test(regularClose || '')) { broken.add(key); continue; }
      if (market === 'US' && !WALL_TIME.test(postEnd || '')) { broken.add(key); continue; }
      entry.earlyCloses.set(row.calendar_date, Object.freeze(
        postEnd ? {regularClose, postEnd} : {regularClose}
      ));
    } else {
      broken.add(key);
    }
  }
  for (const key of broken) {
    const [market, year] = key.split(':');
    delete years[market][year];
  }
  for (const market of Object.keys(years)) {
    for (const year of Object.keys(years[market])) {
      const entry = years[market][year];
      Object.freeze(entry.holidays);
      Object.freeze(entry.earlyCloses);
      Object.freeze(entry);
    }
    Object.freeze(years[market]);
  }
  return {years: Object.freeze(years), brokenYears: [...broken].sort()};
}

// Reads the calendar once per cache window. Never throws. Returns a short summary for logs/tests.
async function loadCalendar({
  runtime,
  env = process.env,
  nowMs = Date.now,
  log = defaultLog
} = {}) {
  if (!enabled(env)) return Object.freeze({status: 'OFF'});
  const cacheMs = settingValue('calendarCacheMinutes', {env}) * 60 * 1000;
  const current = nowMs();
  if (cachedCalendar && current - cachedCalendar.loadedAtMs < cacheMs) {
    return Object.freeze({status: 'CACHED'});
  }
  try {
    const source = runtime || require('./postgres-runtime').getPostgresRuntime();
    const result = await source.query(CALENDAR_QUERY);
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    const {years, brokenYears} = buildYears(rows);
    cachedCalendar = {loadedAtMs: current, years};
    if (brokenYears.length) {
      log({event: 'CALENDAR_DB_YEAR_SKIPPED', years: brokenYears});
    }
    return Object.freeze({status: 'LOADED', brokenYears: Object.freeze(brokenYears)});
  } catch (error) {
    cachedCalendar = null;
    log({event: 'CALENDAR_DB_UNAVAILABLE', code: (error && error.code) || 'UNKNOWN'});
    return Object.freeze({status: 'UNAVAILABLE'});
  }
}

// The loaded COMPLETE year for this market, or null (use the built-in lists). Null whenever the
// switch is off or nothing is loaded. Expiry is handled by the next loadCalendar() (start of the
// next package), so a year never flips between table and built-in in the middle of one package.
function calendarYear(market, year, {env = process.env} = {}) {
  if (!enabled(env) || !cachedCalendar) return null;
  const marketYears = cachedCalendar.years[market];
  return (marketYears && marketYears[year]) || null;
}

// Tests only: forget the loaded calendar.
function resetCalendarCache() {
  cachedCalendar = null;
}

module.exports = {
  CALENDAR_QUERY,
  loadCalendar,
  calendarYear,
  resetCalendarCache
};

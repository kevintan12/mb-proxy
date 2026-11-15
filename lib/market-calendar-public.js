'use strict';

// 9AU Build 5A: read-only public calendar answer for the page (GET /api/quote?holidayCalendar=1).
//
// Follows the existing holidayCalendarDbEnabled switch (no new setting). Never writes, needs no
// secret. One SELECT reads every COMPLETE year with its live (not retired) days. Any problem
// (switch off, database unreadable, no complete year) is a normal answer {available: false,
// reason}, never an error page. The answer holds public calendar data only: no secret, no email
// address, no database address and no setting other than halfDaysEnabled.

const {settingValue} = require('./settings-registry');
const {SUPPORTED_MARKETS} = require('./market-calendar-store');

const DATE_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const PUBLIC_CALENDAR_QUERY = `
SELECT y.market, y.year, y.source AS year_source, y.fetched_at AS year_fetched_at,
       d.calendar_date, d.kind, d.name, d.early_close_time, d.after_hours_end,
       d.source_url, d.needs_review
FROM market_calendar_years y
LEFT JOIN market_calendar_days d
  ON d.market = y.market AND d.year = y.year AND d.retired_at IS NULL
WHERE y.status = 'COMPLETE' AND y.market IN ('US', 'SG', 'HK', 'UK')
ORDER BY y.market, y.year, d.calendar_date`;

function unavailable(reason) {
  return {available: false, reason};
}

function isoTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function buildMarkets(rows) {
  const markets = {};
  for (const market of SUPPORTED_MARKETS) markets[market] = {};
  const broken = new Set();
  for (const row of rows) {
    const market = row && row.market;
    const year = Number(row && row.year);
    if (!SUPPORTED_MARKETS.includes(market) || !Number.isInteger(year)) continue;
    const bucket = markets[market];
    if (!bucket[year]) {
      bucket[year] = {
        holidays: {},
        earlyCloses: {},
        source: row.year_source === 'OFFICIAL' ? 'OFFICIAL' : 'SECOND',
        sourceUrl: null,
        fetchedAt: isoTime(row.year_fetched_at),
        needsReview: []
      };
    }
    if (row.calendar_date === null || row.calendar_date === undefined) continue; // a year with no days
    const entry = bucket[year];
    const match = DATE_KEY.exec(row.calendar_date);
    if (!match || Number(match[1]) !== year || typeof row.name !== 'string' || !row.name.trim()) {
      broken.add(`${market}:${year}`);
      continue;
    }
    if (row.kind === 'HOLIDAY') {
      entry.holidays[row.calendar_date] = {name: row.name};
    } else if (row.kind === 'EARLY_CLOSE' && WALL_TIME.test(row.early_close_time || '')) {
      entry.earlyCloses[row.calendar_date] = {
        name: row.name,
        close: row.early_close_time,
        afterHoursEnd: WALL_TIME.test(row.after_hours_end || '') ? row.after_hours_end : null
      };
    } else {
      broken.add(`${market}:${year}`);
      continue;
    }
    if (row.needs_review === true) entry.needsReview.push(row.calendar_date);
    if (!entry.sourceUrl && typeof row.source_url === 'string' && /^https?:\/\//i.test(row.source_url)) {
      entry.sourceUrl = row.source_url;
    }
  }
  // A year with any unreadable row is left out whole, as the backend store does.
  for (const key of broken) {
    const [market, year] = key.split(':');
    delete markets[market][year];
  }
  return markets;
}

// Returns {status, body, cacheControl}. Never throws.
async function handleHolidayCalendar({env = process.env, runtime, log = line => console.warn('[holidayCalendar]', JSON.stringify(line))} = {}) {
  const noStore = 'no-store';
  try {
    if (settingValue('holidayCalendarDbEnabled', {env}) !== true) {
      return {status: 200, body: unavailable('switch_off'), cacheControl: noStore};
    }
    let rows;
    try {
      const source = runtime || require('./postgres-runtime').getPostgresRuntime();
      const result = await source.query(PUBLIC_CALENDAR_QUERY);
      rows = result && Array.isArray(result.rows) ? result.rows : [];
    } catch (error) {
      log({event: 'HOLIDAY_CALENDAR_DB_UNAVAILABLE', code: (error && error.code) || 'UNKNOWN'});
      return {status: 200, body: unavailable('database_unavailable'), cacheControl: noStore};
    }
    const markets = buildMarkets(rows);
    if (!SUPPORTED_MARKETS.some(market => Object.keys(markets[market]).length)) {
      return {status: 200, body: unavailable('no_complete_year'), cacheControl: noStore};
    }
    return {
      status: 200,
      body: {
        available: true,
        halfDaysEnabled: settingValue('earlyCloseDaysEnabled', {env}) === true,
        markets
      },
      cacheControl: 'public, max-age=3600'
    };
  } catch (error) {
    return {status: 200, body: unavailable('unexpected_error'), cacheControl: noStore};
  }
}

module.exports = {PUBLIC_CALENDAR_QUERY, handleHolidayCalendar, buildMarkets};

'use strict';

// Holiday calendar refresh engine (library only; nothing calls it yet). For one market-year it
// fetches the official exchange page, reads it with a fixed parser (no AI), checks the result and
// writes it to the calendar tables of db/migrations/004_market_calendar.sql in one transaction.
// The second source is used only when the official page cannot be fetched or has no data for the
// year; its rows are marked SECOND and needs_review. If both fail, nothing is written.
//
// Writes go only to market_calendar_days, market_calendar_years and market_calendar_changes, and
// every database call goes through calendarTransaction() so a calendar-only login can be plugged
// in later.

const {settingValue} = require('./settings-registry');

const SOURCES = Object.freeze({
  US: Object.freeze({
    official: Object.freeze({id: 'NYSE', url: 'https://www.nyse.com/markets/hours-calendars', parse: parseNyseHoursCalendars}),
    second: Object.freeze({id: 'NASDAQ', url: 'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule', parse: parseNasdaqHolidaySchedule})
  }),
  UK: Object.freeze({
    official: Object.freeze({id: 'LSE', url: 'https://www.londonstockexchange.com/equities-trading/business-days', parse: parseLseBusinessDays}),
    second: Object.freeze({id: 'GOVUK', url: 'https://www.gov.uk/bank-holidays.json', parse: parseGovUkBankHolidays})
  })
});

const HOLIDAY_COUNT_RANGE = Object.freeze({US: Object.freeze([9, 11]), UK: Object.freeze([8, 9])});
const HOLD_WINDOW_DAYS = 30;
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; calendar-refresh/1.0)';
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
});
const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

class CalendarParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalendarParseError';
    this.code = 'PARSE_FAILED';
  }
}

// ---------------------------------------------------------------------------------------------
// Small text helpers

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cellText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ').trim();
}

function tableRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cellText(cell[1])));
}

function dateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CalendarParseError(`Not a real date: ${year}-${month}-${day}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekdayOf(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

function checkWeekdayName(key, name) {
  if (name && WEEKDAYS.indexOf(name.toLowerCase()) !== weekdayOf(key)) {
    throw new CalendarParseError(`Weekday name ${name} does not match ${key}`);
  }
}

// "1:00 p.m." / "12:30" (24-hour) -> "13:00" / "12:30"
function wallTime(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (meridiem) {
    const pm = /^p/i.test(meridiem);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new CalendarParseError(`Not a real time: ${hourText}:${minuteText}`);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function emptyYears() {
  return {};
}

function yearBucket(years, year) {
  if (!years[year]) years[year] = {holidays: [], earlyCloses: []};
  return years[year];
}

// ---------------------------------------------------------------------------------------------
// Readers. Each returns {years: {2026: {holidays: [{date, name}], earlyCloses: [{date, name,
// earlyCloseTime, afterHoursEnd}]}}} or throws CalendarParseError.

// NYSE holidays and hours page: one table with a Holiday column and one column per year
// ("Thursday, January 1"; "—" for none), early closes in the footnotes ("close early at 1:00 p.m.
// ... on Friday, November 27, 2026, ..."; "late trading sessions will close at 5:00 p.m.").
function parseNyseHoursCalendars(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map(match => tableRows(match[0]));
  const table = tables.find(rows => rows.length > 1 && /^holiday$/i.test((rows[0] || [])[0] || '')
    && rows[0].slice(1).every(cell => /^\d{4}$/.test(cell)));
  if (!table) throw new CalendarParseError('NYSE holiday table not found');
  const columnYears = table[0].slice(1).map(Number);
  const years = emptyYears();
  for (const year of columnYears) yearBucket(years, year);
  for (const row of table.slice(1)) {
    const name = row[0];
    if (!name) continue;
    columnYears.forEach((year, index) => {
      const cell = (row[index + 1] || '').trim();
      if (!cell || /^[—–-]/.test(cell)) return;
      const match = /^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})\b/.exec(cell);
      const month = match && MONTHS[match[2].toLowerCase()];
      if (!month) throw new CalendarParseError(`NYSE cell not understood: ${cell}`);
      const key = dateKey(year, month, Number(match[3]));
      checkWeekdayName(key, match[1]);
      yearBucket(years, year).holidays.push({date: key, name});
    });
  }
  const notes = String(html).split(/<\/p>|\\u003c\/p>|<\\\/p>/i).map(cellText);
  const seen = new Set();
  for (const note of notes) {
    const close = /close early at (\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(note);
    if (!close) continue;
    const earlyCloseTime = wallTime(close[1], close[2], close[3]);
    const late = /late trading sessions will close at (\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(note);
    const afterHoursEnd = late ? wallTime(late[1], late[2], late[3]) : null;
    for (const date of note.matchAll(/([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/g)) {
      const month = MONTHS[date[2].toLowerCase()];
      if (!month) continue;
      const key = dateKey(Number(date[4]), month, Number(date[3]));
      checkWeekdayName(key, date[1]);
      if (seen.has(key)) continue;
      seen.add(key);
      yearBucket(years, Number(date[4])).earlyCloses.push({date: key, name: 'Early close', earlyCloseTime, afterHoursEnd});
    }
  }
  return {years};
}

// Nasdaq holiday schedule: Holiday | Date ("January 1, 2026") | Market Status ("Closed" or an
// early close time such as "1:00 p.m."). After-hours end is not given.
function parseNasdaqHolidaySchedule(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map(match => tableRows(match[0]));
  const table = tables.find(rows => rows.length > 1 && /^holiday$/i.test((rows[0] || [])[0] || '')
    && /^date$/i.test(rows[0][1] || ''));
  if (!table) throw new CalendarParseError('Nasdaq holiday table not found');
  const years = emptyYears();
  for (const [name, dateText, statusText] of table.slice(1)) {
    if (!name || !dateText) continue;
    const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(dateText);
    const month = match && MONTHS[match[1].toLowerCase()];
    if (!month) throw new CalendarParseError(`Nasdaq date not understood: ${dateText}`);
    const year = Number(match[3]);
    const key = dateKey(year, month, Number(match[2]));
    const status = statusText || '';
    const time = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(status);
    if (/^closed$/i.test(status)) yearBucket(years, year).holidays.push({date: key, name});
    else if (time) {
      yearBucket(years, year).earlyCloses.push({
        date: key, name, earlyCloseTime: wallTime(time[1], time[2], time[3]), afterHoursEnd: null
      });
    } else throw new CalendarParseError(`Nasdaq status not understood: ${status}`);
  }
  return {years};
}

// London Stock Exchange business days: "Monday 31 August 2026" | name | "NON-trading day." or
// "Markets closing process commences from 12:30 London time." (a half day).
function parseLseBusinessDays(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map(match => tableRows(match[0]));
  const table = tables.find(rows => rows.some(row => /NON-trading day/i.test(row.join(' '))));
  if (!table) throw new CalendarParseError('LSE business days table not found');
  const years = emptyYears();
  for (const row of table) {
    const match = /^([A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(row[0] || '');
    if (!match) continue;
    const month = MONTHS[match[3].toLowerCase()];
    if (!month) throw new CalendarParseError(`LSE date not understood: ${row[0]}`);
    const year = Number(match[4]);
    const key = dateKey(year, month, Number(match[2]));
    checkWeekdayName(key, match[1]);
    const name = row[1] || '';
    const status = row[2] || '';
    const half = /closing process commences from (\d{1,2}):(\d{2})/i.exec(status);
    if (/NON-trading day/i.test(status)) yearBucket(years, year).holidays.push({date: key, name});
    else if (half) {
      yearBucket(years, year).earlyCloses.push({
        date: key, name, earlyCloseTime: wallTime(half[1], half[2]), afterHoursEnd: null
      });
    } else throw new CalendarParseError(`LSE status not understood: ${status}`);
  }
  if (!Object.keys(years).length) throw new CalendarParseError('LSE table has no dates');
  return {years};
}

// GOV.UK bank holidays JSON, England and Wales division. Holidays only (no half days).
function parseGovUkBankHolidays(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (error) {
    throw new CalendarParseError('GOV.UK JSON not readable');
  }
  const events = data && data['england-and-wales'] && data['england-and-wales'].events;
  if (!Array.isArray(events)) throw new CalendarParseError('GOV.UK England and Wales events missing');
  const years = emptyYears();
  for (const event of events) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((event && event.date) || '');
    if (!match) throw new CalendarParseError('GOV.UK date not understood');
    const year = Number(match[1]);
    const key = dateKey(year, Number(match[2]), Number(match[3]));
    yearBucket(years, year).holidays.push({date: key, name: String(event.title || '').trim() || 'Bank holiday'});
  }
  return {years};
}

// ---------------------------------------------------------------------------------------------
// Sanity check (per market-year). Returns a list of problems; empty means it passes.

function shiftDays(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// New Year's Day and Christmas Day, or the day the market observes instead. US: a Saturday New
// Year's Day has no observed day (the NYSE does not close on the Friday before, as for 2028);
// Saturday Christmas is observed Friday, Sunday holidays Monday. UK: a weekend holiday moves to
// the next free weekday (Christmas on Saturday or Sunday -> 27 December).
function anchorDates(market, year) {
  const newYear = `${year}-01-01`;
  const christmas = `${year}-12-25`;
  const anchors = [];
  const newYearDay = weekdayOf(newYear);
  const christmasDay = weekdayOf(christmas);
  if (market === 'US') {
    if (newYearDay === 0) anchors.push({name: "New Year's Day", date: shiftDays(newYear, 1)});
    else if (newYearDay !== 6) anchors.push({name: "New Year's Day", date: newYear});
    if (christmasDay === 6) anchors.push({name: 'Christmas Day', date: shiftDays(christmas, -1)});
    else if (christmasDay === 0) anchors.push({name: 'Christmas Day', date: shiftDays(christmas, 1)});
    else anchors.push({name: 'Christmas Day', date: christmas});
  } else {
    if (newYearDay === 6) anchors.push({name: "New Year's Day", date: shiftDays(newYear, 2)});
    else if (newYearDay === 0) anchors.push({name: "New Year's Day", date: shiftDays(newYear, 1)});
    else anchors.push({name: "New Year's Day", date: newYear});
    if (christmasDay === 6 || christmasDay === 0) anchors.push({name: 'Christmas Day', date: `${year}-12-27`});
    else anchors.push({name: 'Christmas Day', date: christmas});
  }
  return anchors;
}

function checkMarketYear({market, year, holidays, earlyCloses}) {
  const problems = [];
  const all = [...holidays.map(row => ({...row, kind: 'HOLIDAY'})), ...earlyCloses.map(row => ({...row, kind: 'EARLY_CLOSE'}))];
  const seen = new Map();
  for (const row of all) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date.slice(0, 4) !== String(year)) {
      problems.push({code: 'DATE_OUTSIDE_YEAR', date: row.date});
    }
    const weekday = weekdayOf(row.date);
    if (weekday === 0 || weekday === 6) problems.push({code: 'WEEKEND_DATE', date: row.date});
    if (seen.has(row.date)) {
      problems.push({code: seen.get(row.date) === row.kind ? 'DUPLICATE_DATE' : 'EARLY_CLOSE_IS_HOLIDAY', date: row.date});
    } else {
      seen.set(row.date, row.kind);
    }
  }
  const [min, max] = HOLIDAY_COUNT_RANGE[market];
  if (holidays.length < min || holidays.length > max) {
    problems.push({code: 'HOLIDAY_COUNT_OUT_OF_RANGE', count: holidays.length, min, max});
  }
  const holidayDates = new Set(holidays.map(row => row.date));
  for (const anchor of anchorDates(market, year)) {
    if (!holidayDates.has(anchor.date)) problems.push({code: 'ANCHOR_MISSING', name: anchor.name, date: anchor.date});
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Fetch and read one source.

async function fetchPage(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {'user-agent': USER_AGENT, accept: 'text/html,application/json'},
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
  });
  if (!response || !response.ok) {
    const error = new Error('Calendar page fetch failed');
    error.code = 'FETCH_FAILED';
    error.status = response ? response.status : null;
    throw error;
  }
  const text = await response.text();
  if (typeof text !== 'string' || !text.length || text.length > MAX_PAGE_BYTES) {
    const error = new Error('Calendar page empty or too large');
    error.code = 'FETCH_FAILED';
    throw error;
  }
  return text;
}

// Reads one source for one year: {ok: true, holidays, earlyCloses} or {ok: false, error}.
async function readSource(source, year, {fetchImpl, pageCache}) {
  try {
    let text = pageCache && pageCache.get(source.url);
    if (text === undefined) {
      text = await fetchPage(fetchImpl, source.url);
      if (pageCache) pageCache.set(source.url, text);
    }
    const parsed = source.parse(text);
    const bucket = parsed.years[year];
    if (!bucket || (!bucket.holidays.length && !bucket.earlyCloses.length)) {
      return {ok: false, error: {code: 'YEAR_NOT_ON_PAGE', source: source.id}};
    }
    return {ok: true, holidays: bucket.holidays, earlyCloses: bucket.earlyCloses};
  } catch (error) {
    return {ok: false, error: {code: (error && error.code) || 'FETCH_FAILED', source: source.id,
      ...(error && error.status ? {status: error.status} : {})}};
  }
}

// ---------------------------------------------------------------------------------------------
// Database: the one function every query goes through.

function calendarTransaction(runtime, callback) {
  const source = runtime || require('./postgres-runtime').getPostgresRuntime();
  return source.transaction(callback);
}

const SQL = Object.freeze({
  selectDays: `-- calendar:select-days
SELECT id, calendar_date, kind, name, early_close_time, after_hours_end, source, needs_review
FROM market_calendar_days
WHERE market = $1 AND year = $2 AND retired_at IS NULL
ORDER BY calendar_date
FOR UPDATE`,
  insertDay: `-- calendar:insert-day
INSERT INTO market_calendar_days
  (market, year, calendar_date, kind, name, early_close_time, after_hours_end, source, source_url,
   fetched_at, needs_review)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  updateDay: `-- calendar:update-day
UPDATE market_calendar_days
SET kind = $2, name = $3, early_close_time = $4, after_hours_end = $5, source = $6, source_url = $7,
    fetched_at = $8, needs_review = TRUE
WHERE id = $1`,
  retireDay: `-- calendar:retire-day
UPDATE market_calendar_days SET retired_at = $2, needs_review = TRUE WHERE id = $1`,
  flagDay: `-- calendar:flag-day
UPDATE market_calendar_days SET needs_review = TRUE WHERE id = $1`,
  insertChange: `-- calendar:insert-change
INSERT INTO market_calendar_changes
  (changed_at, market, year, calendar_date, change_kind, old_value, new_value, source, source_url, note)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  upsertYear: `-- calendar:upsert-year
INSERT INTO market_calendar_years (market, year, status, source, fetched_at, row_count)
VALUES ($1, $2, 'COMPLETE', $3, $4, $5)
ON CONFLICT (market, year) DO UPDATE
SET status = 'COMPLETE', source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at,
    row_count = EXCLUDED.row_count`
});

function dayValue(row) {
  return {
    kind: row.kind,
    name: row.name,
    earlyCloseTime: row.early_close_time !== undefined ? row.early_close_time : row.earlyCloseTime,
    afterHoursEnd: row.after_hours_end !== undefined ? row.after_hours_end : row.afterHoursEnd
  };
}

function sameDay(stored, incoming) {
  const a = dayValue(stored);
  const b = dayValue(incoming);
  return a.kind === b.kind && (a.earlyCloseTime || null) === (b.earlyCloseTime || null)
    && (a.afterHoursEnd || null) === (b.afterHoursEnd || null);
}

// Compares stored live rows with the new rows. Only kind and times count as a change; a different
// name or source alone is left as stored.
function planChanges(storedRows, incomingRows, todayKey) {
  const stored = new Map(storedRows.map(row => [row.calendar_date, row]));
  const incoming = new Map(incomingRows.map(row => [row.date, row]));
  const holdUntil = shiftDays(todayKey, HOLD_WINDOW_DAYS);
  const inserts = [];
  const changes = [];
  for (const [date, row] of incoming) {
    if (!stored.has(date)) inserts.push(row);
    else if (!sameDay(stored.get(date), row)) changes.push({type: 'UPDATE', date, stored: stored.get(date), incoming: row});
  }
  for (const [date, row] of stored) {
    if (!incoming.has(date)) changes.push({type: 'RETIRE', date, stored: row});
  }
  for (const change of changes) change.held = change.date <= holdUntil;
  return {inserts, changes};
}

function exchangeToday(now) {
  return new Date(now()).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// One market-year: fetch, read, check, write. Never throws; returns a plain result.

async function refreshMarketYear({
  market,
  year,
  fetchImpl = global.fetch,
  runtime,
  now = () => new Date(),
  env = process.env,
  pageCache = new Map()
} = {}) {
  const result = {market, year, status: 'ERROR', source: null, sourceId: null,
    saved: {inserted: 0, updated: 0, retired: 0}, heldChanges: [], errors: []};
  const sources = SOURCES[market];
  if (!sources || !Number.isInteger(year)) {
    result.errors.push({code: 'UNSUPPORTED_MARKET_YEAR'});
    return result;
  }
  let read = await readSource(sources.official, year, {fetchImpl, pageCache});
  let source = sources.official;
  let sourceKind = 'OFFICIAL';
  if (!read.ok) {
    result.errors.push(read.error);
    read = await readSource(sources.second, year, {fetchImpl, pageCache});
    source = sources.second;
    sourceKind = 'SECOND';
    if (!read.ok) {
      result.errors.push(read.error, {code: 'BOTH_SOURCES_FAILED'});
      return result;
    }
  }
  result.source = sourceKind;
  result.sourceId = source.id;
  const problems = checkMarketYear({market, year, holidays: read.holidays, earlyCloses: read.earlyCloses});
  if (problems.length) {
    result.errors.push(...problems.map(problem => ({...problem, source: source.id})), {code: 'SANITY_CHECK_FAILED'});
    return result;
  }
  const fetchedAt = new Date(now()).toISOString();
  const needsReview = sourceKind === 'SECOND';
  const incoming = [
    ...read.holidays.map(row => ({...row, kind: 'HOLIDAY', earlyCloseTime: null, afterHoursEnd: null})),
    ...read.earlyCloses.map(row => ({...row, kind: 'EARLY_CLOSE'}))
  ].sort((a, b) => a.date.localeCompare(b.date));
  const limit = settingValue('calendarMaxChangedDatesPerRun', {env});
  try {
    await calendarTransaction(runtime, async client => {
      const storedRows = (await client.query(SQL.selectDays, [market, year])).rows || [];
      const plan = planChanges(storedRows, incoming, exchangeToday(now));
      if (plan.changes.length > limit) {
        const error = new Error('Too many changes to stored dates');
        error.code = 'TOO_MANY_CHANGES';
        error.count = plan.changes.length;
        throw error;
      }
      for (const row of plan.inserts) {
        await client.query(SQL.insertDay, [market, year, row.date, row.kind, row.name, row.earlyCloseTime || null,
          row.afterHoursEnd || null, sourceKind, source.url, fetchedAt, needsReview]);
        result.saved.inserted++;
      }
      for (const change of plan.changes) {
        const oldValue = dayValue(change.stored);
        const newValue = change.type === 'UPDATE' ? dayValue(change.incoming) : null;
        if (change.held) {
          await client.query(SQL.flagDay, [change.stored.id]);
          result.heldChanges.push({date: change.date, change: change.type, from: oldValue, to: newValue});
        } else if (change.type === 'UPDATE') {
          await client.query(SQL.updateDay, [change.stored.id, change.incoming.kind, change.incoming.name,
            change.incoming.earlyCloseTime || null, change.incoming.afterHoursEnd || null, sourceKind, source.url, fetchedAt]);
          result.saved.updated++;
        } else {
          await client.query(SQL.retireDay, [change.stored.id, fetchedAt]);
          result.saved.retired++;
        }
        await client.query(SQL.insertChange, [fetchedAt, market, year, change.date,
          `${change.held ? 'HELD_' : ''}${change.type === 'UPDATE' ? 'UPDATE' : 'RETIRE'}`,
          JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue), sourceKind, source.url,
          change.held ? `flagged; held: within ${HOLD_WINDOW_DAYS} days` : 'flagged; applied']);
      }
      const liveCount = storedRows.length + result.saved.inserted - result.saved.retired;
      await client.query(SQL.upsertYear, [market, year, sourceKind, fetchedAt, liveCount]);
    });
    result.status = 'SAVED';
  } catch (error) {
    result.saved = {inserted: 0, updated: 0, retired: 0};
    result.heldChanges = [];
    result.errors.push({code: (error && error.code === 'TOO_MANY_CHANGES') ? 'TOO_MANY_CHANGES' : 'WRITE_FAILED',
      ...(error && error.count !== undefined ? {count: error.count, limit} : {})});
  }
  return result;
}

// Several market-years; each is independent (one failing never blocks another). A page is
// fetched at most once per call.
async function refreshCalendars({targets, ...options} = {}) {
  const pageCache = new Map();
  const results = [];
  for (const target of targets || []) {
    try {
      results.push(await refreshMarketYear({...options, ...target, pageCache}));
    } catch (error) {
      results.push({market: target && target.market, year: target && target.year, status: 'ERROR', source: null,
        sourceId: null, saved: {inserted: 0, updated: 0, retired: 0}, heldChanges: [], errors: [{code: 'UNEXPECTED'}]});
    }
  }
  return results;
}

module.exports = {
  SOURCES,
  SQL,
  HOLIDAY_COUNT_RANGE,
  CalendarParseError,
  parseNyseHoursCalendars,
  parseNasdaqHolidaySchedule,
  parseLseBusinessDays,
  parseGovUkBankHolidays,
  anchorDates,
  checkMarketYear,
  planChanges,
  calendarTransaction,
  refreshMarketYear,
  refreshCalendars
};

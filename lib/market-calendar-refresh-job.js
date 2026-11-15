'use strict';

// 9AU Build 2C: the scheduled holiday calendar refresh (GET /api/quote?calendarRefresh=1, called
// by the Vercel cron in vercel.json on days 1 to 7 of May and November at 09:00 Singapore time).
//
// - Answers "not found" unless the request carries "Authorization: Bearer <CRON_SECRET>" and
//   CRON_SECRET is set. With holidayCalendarRefreshEnabled off it answers "disabled" and does nothing.
// - Refreshes this year and next year for US, SG, HK and UK through the engine in
//   lib/market-calendar-refresh.js (the only writer). A market-year already refreshed this month is
//   skipped; a failed one is simply tried again by the next day's run (no retries inside a run).
// - Fixed limits: 120 seconds for the whole run, 10 seconds for each page fetch.
// - Returns and logs counts and error codes only: never a secret, a database login or page text.

const crypto = require('node:crypto');
const {settingValue} = require('./settings-registry');
const engine = require('./market-calendar-refresh');
const {sendCalendarAlert} = require('./calendar-alert-mail');

const NOT_FOUND = Object.freeze({status: 404, body: Object.freeze({error: 'endpoint not found'})});
const MARKETS = Object.freeze(['US', 'SG', 'HK', 'UK']);
const RUN_BUDGET_MS = 120000;
const PAGE_FETCH_TIMEOUT_MS = 10000;
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000; // Singapore has no daylight saving.

const SQL = Object.freeze({
  selectYears: `-- calendar:select-years
SELECT market, year, status, fetched_at
FROM market_calendar_years
WHERE year = $1 OR year = $2`
});

function defaultLog(line) {
  console.info('[calendarRefresh]', JSON.stringify(line));
}

function codedError(code) {
  const error = new Error('Calendar refresh stopped');
  error.code = code;
  return error;
}

// Equal-length digests so the comparison takes the same time whatever the header holds.
function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(headers, env) {
  const secret = env && typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET : '';
  if (!secret.trim()) return false;
  const header = headers && (headers.authorization !== undefined ? headers.authorization : headers.Authorization);
  if (typeof header !== 'string' || !header) return false;
  return sameSecret(header, `Bearer ${secret}`);
}

// Singapore calendar date parts for an epoch-millisecond time.
function singaporeParts(epochMs) {
  const iso = new Date(epochMs + SINGAPORE_OFFSET_MS).toISOString();
  return {year: Number(iso.slice(0, 4)), month: iso.slice(0, 7), date: iso.slice(0, 10)};
}

function fetchedMonth(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? singaporeParts(ms).month : null;
}

// A fetch that gives up after 10 seconds (or when the run budget runs out, if sooner), covering the
// page body as well as the response headers. The engine only uses ok, status and text(). A page
// that failed once in this run is not fetched again in the same run (no retries inside a run; the
// engine already keeps pages that loaded).
function boundedFetch(fetchImpl, {deadlineAt, clock, pageTimeoutMs}) {
  const failed = new Map();
  let exhausted = false;
  const remember = (url, code) => {
    if (code === 'RUN_BUDGET_EXHAUSTED') exhausted = true;
    else failed.set(url, code);
  };
  return async (url, options = {}) => {
    if (failed.has(url)) throw codedError(failed.get(url));
    const remaining = deadlineAt - clock();
    if (exhausted || remaining <= 0) throw codedError('RUN_BUDGET_EXHAUSTED');
    const limit = Math.min(pageTimeoutMs, remaining);
    const code = limit < pageTimeoutMs ? 'RUN_BUDGET_EXHAUSTED' : 'FETCH_TIMEOUT';
    const controller = new AbortController();
    let timer = null;
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(codedError(code));
      }, limit);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    expired.catch(() => {});
    const done = () => clearTimeout(timer);
    try {
      const response = await Promise.race([fetchImpl(url, {...options, signal: controller.signal}), expired]);
      if (!response || !response.ok) {
        done();
        remember(url, 'FETCH_FAILED');
        return response;
      }
      return {
        ok: response.ok,
        status: response.status,
        text: async () => {
          try {
            return await Promise.race([response.text(), expired]);
          } catch (error) {
            remember(url, (error && error.code) || 'FETCH_FAILED');
            throw error;
          } finally {
            done();
          }
        }
      };
    } catch (error) {
      done();
      remember(url, (error && error.code) || 'FETCH_FAILED');
      throw error;
    }
  };
}

function plainErrors(errors) {
  return (errors || []).map(error => {
    const entry = {code: String((error && error.code) || 'UNKNOWN')};
    if (error && typeof error.source === 'string') entry.source = error.source;
    if (error && Number.isInteger(error.status)) entry.status = error.status;
    return entry;
  });
}

// A current-year result that failed only because dates already past have dropped off a rolling page:
// the sanity check failed, and every problem is either too few holidays or a missing anchor date
// that is already behind us.
function isRollingPagePartial(result, {currentYear, todayKey}) {
  if (!result || result.year !== currentYear || result.status !== 'ERROR') return false;
  const errors = result.errors || [];
  if (!errors.some(error => error && error.code === 'SANITY_CHECK_FAILED')) return false;
  const problems = errors.filter(error => !error || error.code !== 'SANITY_CHECK_FAILED');
  if (!problems.length) return false;
  return problems.every(error => {
    if (!error) return false;
    if (error.code === 'HOLIDAY_COUNT_OUT_OF_RANGE') return Number.isFinite(error.count) && error.count < error.min;
    if (error.code === 'ANCHOR_MISSING') return typeof error.date === 'string' && error.date < todayKey;
    return false;
  });
}

function summaryEntry(market, year, outcome, result) {
  const saved = result && result.saved ? result.saved : {inserted: 0, updated: 0, retired: 0};
  return {
    market,
    year,
    outcome,
    source: (result && result.source) || null,
    saved: {inserted: saved.inserted || 0, updated: saved.updated || 0, retired: saved.retired || 0},
    heldChanges: ((result && result.heldChanges) || []).map(change => ({date: change.date, change: change.change})),
    errors: outcome === 'saved' || outcome === 'skipped' ? [] : plainErrors(result && result.errors)
  };
}

function logLine(summary, durationMs, runError) {
  const count = outcome => summary.filter(entry => entry.outcome === outcome).length;
  const totals = {inserted: 0, updated: 0, retired: 0, held: 0};
  const errorCodes = [];
  for (const entry of summary) {
    totals.inserted += entry.saved.inserted;
    totals.updated += entry.saved.updated;
    totals.retired += entry.saved.retired;
    totals.held += entry.heldChanges.length;
    if (entry.outcome !== 'error') continue;
    for (const error of entry.errors) errorCodes.push(`${entry.market}-${entry.year}:${error.code}`);
  }
  return {
    stage: 'calendarRefresh',
    saved: count('saved'),
    skipped: count('skipped'),
    partialSkipped: count('partial_skipped'),
    errors: count('error'),
    notReached: count('not_reached'),
    ...totals,
    durationMs,
    ...(runError ? {runError} : {}),
    errorCodes
  };
}

// 9AU Build 3: what the alert email may report. A market-year that could not be read from any
// source, or that failed its sanity check, is an event; so is each held change and each saved
// year that changed or removed stored dates. Nothing else (a skipped or partial year, a write
// error, the run budget) sends mail.
function errorAlertCategory(errors) {
  const codes = new Set((errors || []).map(error => error && error.code));
  if (codes.has('TOO_MANY_CHANGES')) return 'TOO_MANY';
  if (codes.has('SANITY_CHECK_FAILED')) return 'REJECTED';
  if (codes.has('BOTH_SOURCES_FAILED') || codes.has('OFFICIAL_PAGE_CHANGED')) return 'UNREADABLE';
  return null;
}

function savedAlerts(market, year, result) {
  const events = (result.heldChanges || []).map(change => ({
    category: 'HELD', market, year, date: change.date, from: change.from, to: change.to
  }));
  const applied = result.appliedChanges || [];
  for (const change of applied) {
    events.push({category: 'APPLIED', market, year, date: change.date, from: change.from, to: change.to});
  }
  const saved = result.saved || {};
  const count = (saved.updated || 0) + (saved.retired || 0);
  if (!applied.length && count > 0) events.push({category: 'APPLIED', market, year, count});
  return events;
}

// Sends the one email for the run, if there is anything to say. Never throws, never fails the run.
// Logs one line per outcome that needs one: no address, key or message text.
async function sendAlertEmail({alerts, env, fetchImpl, log, sendAlert}) {
  if (!alerts.length) return;
  let outcome;
  try {
    outcome = await sendAlert({events: alerts, env, fetchImpl});
  } catch (error) {
    outcome = {sent: false, reason: 'send_failed', code: 'SEND_ERROR'};
  }
  let line = null;
  if (outcome && outcome.reason === 'not_configured') {
    line = {stage: 'calendarAlertEmail', message: 'alert email not configured'};
  } else if (outcome && outcome.reason === 'send_failed') {
    line = {stage: 'calendarAlertEmail', message: 'alert email send failed',
      ...(typeof outcome.code === 'string' ? {code: outcome.code} : {})};
  }
  if (!line) return;
  try {
    log(line);
  } catch (error) {
    // Logging must never fail the run.
  }
}

async function runCalendarRefresh({
  env = process.env,
  fetchImpl = global.fetch,
  runtime,
  now = () => Date.now(),
  clock = now,
  log = defaultLog,
  refreshMarketYear = engine.refreshMarketYear,
  pageTimeoutMs = PAGE_FETCH_TIMEOUT_MS,
  budgetMs = RUN_BUDGET_MS,
  mailFetchImpl = global.fetch,
  sendAlert = sendCalendarAlert
} = {}) {
  const startedAt = clock();
  const deadlineAt = startedAt + budgetMs;
  const today = singaporeParts(now());
  const years = [today.year, today.year + 1];
  const targets = [];
  for (const market of MARKETS) for (const year of years) targets.push({market, year});

  let refreshedThisMonth = new Set();
  let runError = null;
  try {
    const rows = await engine.calendarTransaction(runtime,
      async client => (await client.query(SQL.selectYears, years)).rows || [], {env});
    refreshedThisMonth = new Set(rows
      .filter(row => row && row.status === 'COMPLETE' && fetchedMonth(row.fetched_at) === today.month)
      .map(row => `${row.market}-${Number(row.year)}`));
  } catch (error) {
    runError = 'STATUS_READ_FAILED';
  }

  const summary = [];
  const alerts = [];
  const pageCache = new Map();
  const fetchForRun = boundedFetch(fetchImpl, {deadlineAt, clock, pageTimeoutMs});
  let stopped = runError !== null;
  for (const {market, year} of targets) {
    if (stopped || clock() >= deadlineAt) {
      stopped = true;
      summary.push(summaryEntry(market, year, 'not_reached', null));
      continue;
    }
    if (refreshedThisMonth.has(`${market}-${year}`)) {
      summary.push(summaryEntry(market, year, 'skipped', null));
      continue;
    }
    let result;
    try {
      result = await refreshMarketYear({market, year, fetchImpl: fetchForRun, runtime, env,
        now: () => new Date(now()), pageCache});
    } catch (error) {
      result = {market, year, status: 'ERROR', errors: [{code: 'UNEXPECTED'}]};
    }
    const errors = (result && result.errors) || [];
    if (result && result.status === 'SAVED') {
      summary.push(summaryEntry(market, year, 'saved', result));
      alerts.push(...savedAlerts(market, year, result));
      for (const cleared of result.clearedFlags || []) {
        try {
          log({stage: 'calendarRefresh', message: 'second-source flag cleared by official page', market, year,
            date: cleared.date});
        } catch (error) {
          // Logging must never fail the run.
        }
      }
    } else if (errors.some(error => error && error.code === 'RUN_BUDGET_EXHAUSTED')) {
      stopped = true;
      summary.push(summaryEntry(market, year, 'not_reached', null));
    } else if (isRollingPagePartial(result, {currentYear: today.year, todayKey: today.date})) {
      summary.push(summaryEntry(market, year, 'partial_skipped', result));
    } else {
      summary.push(summaryEntry(market, year, 'error', result));
      const category = errorAlertCategory(errors);
      if (category) {
        const detail = errors.find(error => error && error.code === 'TOO_MANY_CHANGES') || {};
        alerts.push({category, market, year,
          ...(category === 'TOO_MANY' ? {count: detail.count, limit: detail.limit} : {})});
      }
    }
  }

  const durationMs = Math.max(0, clock() - startedAt);
  try {
    log(logLine(summary, durationMs, runError));
  } catch (error) {
    // Logging must never fail the run.
  }
  await sendAlertEmail({alerts, env, fetchImpl: mailFetchImpl, log, sendAlert});
  return {
    result: 'ran',
    runDate: today.date,
    ...(runError ? {runError} : {}),
    budgetReached: summary.some(entry => entry.outcome === 'not_reached') && runError === null,
    marketYears: summary
  };
}

// The route. Never throws; never reveals the route without the right secret.
async function handleCalendarRefresh({headers, env = process.env, ...options} = {}) {
  if (!authorized(headers, env)) return NOT_FOUND;
  if (settingValue('holidayCalendarRefreshEnabled', {env}) !== true) {
    return {status: 200, body: {result: 'disabled'}};
  }
  try {
    return {status: 200, body: await runCalendarRefresh({env, ...options})};
  } catch (error) {
    return {status: 200, body: {result: 'ran', runError: 'UNEXPECTED', marketYears: []}};
  }
}

module.exports = {
  NOT_FOUND,
  MARKETS,
  RUN_BUDGET_MS,
  PAGE_FETCH_TIMEOUT_MS,
  SQL,
  isRollingPagePartial,
  runCalendarRefresh,
  handleCalendarRefresh
};

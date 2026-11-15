'use strict';

// 9AU Build 4: one log line per analysis package saying how far holiday coverage reaches for each
// market, so a missing year is noticed before any brief fails. Reads only what is already in
// memory (the built-in lists and the loaded table years): no database, no network, no switch.
// It changes no report output and any error inside it is swallowed (one fallback log line).

const {FULL_DAY_HOLIDAYS} = require('./market-session-calendar');
const {loadedCalendarYears} = require('./market-calendar-store');

const COVERAGE_MARKETS = Object.freeze(['US', 'SG', 'HK', 'UK']);
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_DAYS = 90;
const URGENT_DAYS = 31;

function defaultLog(line) {
  console.info('[calendarCoverage]', JSON.stringify(line));
}

// current: 90 days or more left; expiring: under 90; urgent: under 31; expired: the last covered
// year has ended.
function coverageBand(daysLeft) {
  if (daysLeft === null || daysLeft < 0) return 'expired';
  if (daysLeft < URGENT_DAYS) return 'urgent';
  if (daysLeft < EXPIRING_DAYS) return 'expiring';
  return 'current';
}

// Latest covered year per market, from whichever calendar is in use: the loaded table years when
// the database switch is on and a complete year is loaded, otherwise the built-in lists.
function latestCoveredYear(market, env) {
  const years = [...Object.keys(FULL_DAY_HOLIDAYS[market] || {}).map(Number), ...loadedCalendarYears(market, {env})];
  return years.length ? Math.max(...years) : null;
}

function calendarCoverage({now = Date.now(), env = process.env} = {}) {
  const today = Date.UTC(...(iso => [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))])(
    new Date(now).toISOString()));
  const markets = {};
  for (const market of COVERAGE_MARKETS) {
    const year = latestCoveredYear(market, env);
    const daysLeft = year === null ? null : Math.round((Date.UTC(year, 11, 31) - today) / DAY_MS);
    markets[market] = {latestYear: year, daysLeft, band: coverageBand(daysLeft)};
  }
  return markets;
}

// Never throws, never awaits, never touches report output.
function logCalendarCoverage({now, env, log = defaultLog} = {}) {
  try {
    log({stage: 'calendarCoverage', markets: calendarCoverage({now, env})});
  } catch (error) {
    try {
      log({stage: 'calendarCoverage', message: 'coverage check failed', code: (error && error.code) || 'UNKNOWN'});
    } catch (loggingError) {
      // Logging must never fail a package.
    }
  }
}

module.exports = {COVERAGE_MARKETS, coverageBand, calendarCoverage, logCalendarCoverage};

// Step 9F.1a: the reading window and its adjustable settings. Not connected to
// the live pipeline yet; nothing else requires this file.
//
// The window ends at the trigger instant and starts `extensionHours` before the
// latest regular close at or before the trigger, in the market's own calendar.
'use strict';

const {getSessionContext} = require('./market-session-calendar');
const {marketSettings} = require('./section-rules');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLOSE_LOOKBACK_DAYS = 14;
// Fixed on purpose: not adjustable through settings or environment variables.
const DOWNLOAD_ATTEMPTS = 3;

// Pulls a setting back to the nearest safe limit. A missing value, a non-number,
// a non-finite number, or a string that cannot be read as a number gets the default.
function clampSetting(value, {default: fallback, min, max}) {
  let number = value;
  if (typeof value === 'string') number = value.trim() === '' ? NaN : Number(value);
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// Environment variables only override the table defaults, and are always clamped.
function readingSettings({market = 'US', env = process.env} = {}) {
  const row = marketSettings(market);
  const extension = row.readingExtensionHours;
  const article = row.articleKb;
  if (!extension || !article) throw new TypeError('No reading settings for market');
  return Object.freeze({
    readingExtensionHours: clampSetting(env.READING_EXTENSION_HOURS, extension),
    articleKb: clampSetting(env.ARTICLE_KB, article),
    downloadAttempts: DOWNLOAD_ATTEMPTS
  });
}

function previousCalendarDate(exchangeDate) {
  const [year, month, day] = exchangeDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString().slice(0, 10);
}

// The latest regular close at or before `triggerAt` (ISO string), or null.
// Walks back from the market's own local date, so a close later today that has
// not happened yet is skipped. Weekends, holidays, and days with no supported
// close time (half days) are skipped. The Singapore/Hong Kong lunch break is
// not a close: only the regular close time counts.
function latestCloseAtOrBefore(market, triggerAt) {
  const trigger = triggerAt.getTime();
  let date = getSessionContext({market, instant: triggerAt}).exchangeDate;
  for (let i = 0; i <= CLOSE_LOOKBACK_DAYS; i++) {
    const context = getSessionContext({market, exchangeDate: date});
    if (context.calendarSupported && context.tradingDay && context.regularCloseTime
        && Date.parse(context.regularCloseTime) <= trigger) {
      return context.regularCloseTime;
    }
    date = previousCalendarDate(date);
  }
  return null;
}

function readingWindow({market, triggerAt, extensionHours} = {}) {
  const trigger = new Date(triggerAt);
  if (!Number.isFinite(trigger.getTime())) throw new TypeError('Invalid trigger instant');
  const row = marketSettings(typeof market === 'string' ? market.trim().toUpperCase() : market);
  if (!row.readingExtensionHours) throw new TypeError('Invalid market');
  const normalizedMarket = market.trim().toUpperCase();
  const hours = extensionHours === undefined
    ? readingSettings({market: normalizedMarket}).readingExtensionHours
    : clampSetting(extensionHours, row.readingExtensionHours);
  const lastClose = latestCloseAtOrBefore(normalizedMarket, trigger);
  if (!lastClose) return null;
  return Object.freeze({
    market: normalizedMarket,
    lastClose,
    extensionHours: hours,
    startsAt: new Date(Date.parse(lastClose) - hours * HOUR_MS).toISOString(),
    endsAt: trigger.toISOString()
  });
}

module.exports = {
  DOWNLOAD_ATTEMPTS,
  clampSetting,
  readingSettings,
  latestCloseAtOrBefore,
  readingWindow
};

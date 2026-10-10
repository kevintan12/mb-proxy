// Step 9F.1a: the reading window and its adjustable settings.
// Step 9F.1d: also the shared download retry helper and reading budget.
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
    downloadAttempts: DOWNLOAD_ATTEMPTS,
    readingBudgetSeconds: row.readingBudgetSeconds
  });
}

// Step 9F.1f: article text sizes, shared by the Yahoo news and Yahoo recap readers,
// the classifier and the writer budget. The read size comes from `articleKb`
// (adjustable through ARTICLE_KB, clamped); the classifier size is fixed in code.
const CLASSIFIER_ARTICLE_BYTES = 8 * 1024;
// The stored result (headline, publisher, link, times and text) may use this much
// on top of the article text, as the 8 KB text / 12 KB result caps did before.
const ARTICLE_RESULT_HEADROOM_BYTES = 4 * 1024;
// Step 9F.1f (temporary until Step 9F.2): no Yahoo article is trimmed below this
// to fit the writer request.
const WRITER_ARTICLE_FLOOR_BYTES = 4 * 1024;

function yahooArticleBounds({market = 'US', env = process.env} = {}) {
  const maxArticleTextBytes = Math.floor(readingSettings({market, env}).articleKb * 1024);
  return Object.freeze({
    maxArticleTextBytes,
    maxResultBytes: maxArticleTextBytes + ARTICLE_RESULT_HEADROOM_BYTES
  });
}

// The first `maxBytes` bytes of `text`, cut back to a whole character and with
// trailing spaces removed, so the result is always a prefix of the text. Text
// that already fits is returned unchanged.
function firstBytes(text, maxBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8').trimEnd();
}

// What the classifier and the subject repair read of an article: its first 8 KB.
function classifierArticleText(text) {
  return firstBytes(text, CLASSIFIER_ARTICLE_BYTES);
}

// Step 9F.1f (temporary until Step 9F.2): fits a request under `capBytes` by
// trimming article texts, longest first. `articles` are {key, text, minBytes};
// each is never cut below max(floorBytes, minBytes), and never dropped.
// `measure(textsByKey)` returns the request size for those texts. The search
// finds the highest common length that fits: every article longer than it is cut
// to it (or to its own minimum). When even the minimums do not fit, the texts are
// returned at their minimums and `fits` is false.
function fitArticlesToBudget({articles, measure, capBytes, floorBytes = WRITER_ARTICLE_FLOOR_BYTES}) {
  const lengths = new Map(articles.map(article =>
    [article.key, Buffer.byteLength(article.text, 'utf8')]));
  const minimums = new Map(articles.map(article => [article.key,
    Math.min(lengths.get(article.key), Math.max(floorBytes, article.minBytes || 0))]));
  const textsAt = level => new Map(articles.map(article => [article.key,
    firstBytes(article.text, Math.max(minimums.get(article.key), level))]));
  const before = measure(new Map(articles.map(article => [article.key, article.text])));
  const result = (texts, after, level, fits) => Object.freeze({
    fits,
    levelBytes: level,
    requestBytesBefore: before,
    requestBytesAfter: after,
    texts,
    trimmed: Object.freeze(articles.flatMap(article => {
      const toBytes = Buffer.byteLength(texts.get(article.key), 'utf8');
      return toBytes < lengths.get(article.key)
        ? [Object.freeze({key: article.key, fromBytes: lengths.get(article.key), toBytes})] : [];
    }))
  });
  if (before <= capBytes) {
    return result(new Map(articles.map(article => [article.key, article.text])), before, null, true);
  }
  const floorTexts = textsAt(0);
  const floorSize = measure(floorTexts);
  if (floorSize > capBytes) return result(floorTexts, floorSize, 0, false);
  let low = 0;
  let high = Math.max(0, ...lengths.values());
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(textsAt(middle)) <= capBytes) low = middle;
    else high = middle - 1;
  }
  const texts = textsAt(low);
  return result(texts, measure(texts), low, true);
}

// Step 9F.1d: retries for one article download, shared by every Yahoo article
// reader. Only temporary failures are retried: a timeout, a failed retrieval, a
// failed read of the response, or a 429/5xx reply. Anything else (404, an
// unreadable page, a wrong page identity, ...) is final after one attempt.
const DOWNLOAD_RETRY_PAUSES_MS = Object.freeze([250, 750]);
const TEMPORARY_FAILURE_TYPES = new Set(['TIMEOUT', 'RETRIEVAL_FAILURE', 'RESPONSE_READ_FAILURE']);

function isTemporaryDownloadFailure(result) {
  if (!result || result.ok === true) return false;
  if (TEMPORARY_FAILURE_TYPES.has(result.type)) return true;
  if (result.type !== 'HTTP_FAILURE') return false;
  const status = result.httpStatus;
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function realSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One budget for a whole reading stage. `now` is a millisecond clock.
function createReadingBudget({budgetMs, now}) {
  const started = now();
  return Object.freeze({
    remainingMs: () => budgetMs - (now() - started),
    spent: () => budgetMs - (now() - started) <= 0
  });
}

// Runs `download` up to DOWNLOAD_ATTEMPTS times. A retry (with its pause) only
// starts while the budget still has more than the pause left; a download that
// is already running is never cut short here (the fetcher's own timeout bounds
// it). A thrown error is returned, not retried.
async function downloadWithRetries(download, {budget = null, sleep = realSleep} = {}) {
  let attempts = 0;
  for (;;) {
    attempts++;
    let result;
    try {
      result = await download();
    } catch (error) {
      return {result: null, error, attempts, budgetStopped: false};
    }
    if (!isTemporaryDownloadFailure(result) || attempts >= DOWNLOAD_ATTEMPTS) {
      return {result, error: null, attempts, budgetStopped: false};
    }
    const pause = DOWNLOAD_RETRY_PAUSES_MS[attempts - 1];
    if (budget && budget.remainingMs() <= pause) {
      return {result, error: null, attempts, budgetStopped: true};
    }
    await sleep(pause);
  }
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
  DOWNLOAD_RETRY_PAUSES_MS,
  CLASSIFIER_ARTICLE_BYTES,
  ARTICLE_RESULT_HEADROOM_BYTES,
  WRITER_ARTICLE_FLOOR_BYTES,
  yahooArticleBounds,
  firstBytes,
  classifierArticleText,
  fitArticlesToBudget,
  clampSetting,
  isTemporaryDownloadFailure,
  createReadingBudget,
  downloadWithRetries,
  readingSettings,
  latestCloseAtOrBefore,
  readingWindow
};

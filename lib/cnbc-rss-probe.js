// Step 9F.6b: a read-only diagnostic (GET ?cnbcRssProbe=1) that shows what the
// CNBC RSS lists return from where it runs (Vercel Preview), without connecting
// the finder to any report. It reads only the fixed CNBC lists in the settings
// table -- never an address taken from the request -- and, with &pages=N (at
// most 3), downloads the first N kept candidates' pages to show each page's own
// publish time next to its list updated time. It makes no paid call and does
// not touch Neon. It answers "not found" in Production always (a Fixed rule,
// not a setting) and everywhere else while cnbcRssProbeEnabled is off.
'use strict';

const {SETTINGS_REGISTRY, clampSetting, settingValue} = require('./settings-registry');
const {readingWindow} = require('./reading-window');
const {
  cnbcRssSettings,
  readCnbcRssLists,
  selectCnbcRssCandidates,
  moversMatch,
  isPossibleMoversMiss,
  readBoundedBody
} = require('./sources/cnbc-rss');

const NOT_FOUND = Object.freeze({status: 404, body: Object.freeze({error: 'endpoint not found'})});
const PAGE_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml',
  'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
});
const MAX_POSSIBLE_MISSES_PER_LIST = 10;

function isProduction(env) {
  return env.VERCEL_ENV === 'production';
}

// The page option from the request, clamped to 0..3 (the Fixed row's range).
function probePageCount(value) {
  const row = SETTINGS_REGISTRY.cnbcRssProbePages;
  return Math.floor(clampSetting(value === undefined ? row.default : value, row));
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch (error) {
    return null;
  }
}

// "2026-10-18T05:00:01+0000" (CNBC's form, no colon) or any ISO form -> ISO, or null.
function pageTime(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3'));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function listSummary(list) {
  const times = list.items.map(item => item.listedAt).filter(Boolean).map(Date.parse);
  const movers = {addressOnly: 0, titleOnly: 0, both: 0};
  const possibleMisses = [];
  for (const item of list.items) {
    const match = moversMatch(item);
    if (match.address && match.title) movers.both++;
    else if (match.address) movers.addressOnly++;
    else if (match.title) movers.titleOnly++;
    if (isPossibleMoversMiss(item) && possibleMisses.length < MAX_POSSIBLE_MISSES_PER_LIST) {
      possibleMisses.push({title: item.title, path: pathOf(item.url)});
    }
  }
  return {
    listId: list.listId,
    outcome: list.outcome,
    httpStatus: list.httpStatus,
    durationMs: list.durationMs,
    bytes: list.bytes,
    itemCount: list.items.length,
    newestListTime: times.length ? new Date(Math.max(...times)).toISOString() : null,
    oldestListTime: times.length ? new Date(Math.min(...times)).toISOString() : null,
    unparsableListTimeCount: list.items.filter(item => !item.listedAt).length,
    movers,
    possibleMisses
  };
}

// One page: its HTTP status and its own publish/modified times, nothing else.
async function probePage(candidate, {fetchImpl, now}) {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settingValue('cnbcPageTimeoutMs'));
  const result = {path: pathOf(candidate.url), listUpdatedTime: candidate.listedAt, outcome: 'OK',
    httpStatus: null, durationMs: 0, pagePublishedRaw: null, pagePublishedAt: null,
    pageModifiedRaw: null, pageModifiedAt: null};
  try {
    const response = await fetchImpl(candidate.url, {method: 'GET', headers: PAGE_HEADERS, signal: controller.signal});
    result.httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (!response || !response.ok) {
      result.outcome = 'HTTP_FAILURE';
    } else {
      const html = await readBoundedBody(response, settingValue('cnbcMaxResponseBytes'));
      result.pagePublishedRaw = (/"datePublished"\s*:\s*"([^"]{1,40})"/.exec(html) || [])[1] || null;
      result.pageModifiedRaw = (/"dateModified"\s*:\s*"([^"]{1,40})"/.exec(html) || [])[1] || null;
      result.pagePublishedAt = pageTime(result.pagePublishedRaw);
      result.pageModifiedAt = pageTime(result.pageModifiedRaw);
      if (!result.pagePublishedAt) result.outcome = 'NO_PAGE_PUBLISH_TIME';
    }
  } catch (error) {
    result.outcome = controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT'
      : (error?.outcome || 'FETCH_FAILED');
  } finally {
    clearTimeout(timeout);
    result.durationMs = Math.max(0, Math.round(now() - startedAt));
  }
  return result;
}

// Returns {status, body}; api/quote.js sends it with Cache-Control: no-store.
async function handleCnbcRssProbe({query = {}, env = process.env, fetchImpl = global.fetch, now = Date.now} = {}) {
  if (isProduction(env)) return NOT_FOUND;
  if (!settingValue('cnbcRssProbeEnabled', {env})) return NOT_FOUND;
  try {
    return await runProbe({query, env, fetchImpl, now});
  } catch (error) {
    return {status: 502, body: {probe: 'cnbc-rss', outcome: 'PROBE_FAILED'}};
  }
}

async function runProbe({query, env, fetchImpl, now}) {
  const settings = cnbcRssSettings({env});
  const generatedAt = new Date(now()).toISOString();
  const base = {
    probe: 'cnbc-rss',
    generatedAt,
    note: 'List time is the list updated time: a hint for order and the pre-download window check only; '
      + 'it never admits anything (admission uses each page\'s own publish time).',
    finderEnabled: settings.enabled
  };
  if (!settings.enabled) return {status: 200, body: {...base, outcome: 'DISABLED'}};
  const lists = await readCnbcRssLists({fetchImpl, env, now});
  let window = null;
  try {
    window = readingWindow({market: 'US', triggerAt: generatedAt});
  } catch (error) {
    window = null;
  }
  const {candidates, counts} = selectCnbcRssCandidates(lists, {window, maxCandidates: settings.maxCandidates});
  const pageCount = probePageCount(query.pages);
  const pages = [];
  for (const candidate of candidates.slice(0, pageCount)) {
    pages.push(await probePage(candidate, {fetchImpl, now}));
  }
  return {
    status: 200,
    body: {
      ...base,
      outcome: lists.some(list => list.outcome === 'OK') ? 'OK' : 'ALL_LISTS_FAILED',
      readingWindow: window ? {startsAt: window.startsAt, endsAt: window.endsAt} : null,
      limits: {timeoutMs: settings.timeoutMs, maxResponseBytes: settings.maxResponseBytes,
        maxCandidates: settings.maxCandidates, pagesRequested: pageCount},
      lists: lists.map(listSummary),
      counts,
      candidates: candidates.map(candidate => ({
        headline: candidate.headline,
        path: pathOf(candidate.url),
        listId: candidate.listId,
        listUpdatedTime: candidate.listedAt,
        contentType: candidate.contentType
      })),
      pages
    }
  };
}

module.exports = {handleCnbcRssProbe, probePageCount, pageTime};

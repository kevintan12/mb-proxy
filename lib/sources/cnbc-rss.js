// Step 9F.6b: the CNBC candidate finder for the shared source reader
// (lib/source-reader.js), reading CNBC's free RSS lists. It supplies only how
// CNBC candidates are found; the page reader comes with Step 9F.6d. Nothing
// calls this finder yet (Steps 9F.6c/9F.6d connect it; 9F.6f retires the paid
// CNBC search), so reports are unchanged whether cnbcRssFinderEnabled is on or off.
//
// The list time (each item's <pubDate>) is the "list updated time": CNBC writes
// the page's last-updated time there, not its first-published time. It is used
// only as a hint -- to order the candidates (newest first) and to drop, before
// any download, an item whose list time is before the reading window start
// (a page's publish time is never later than its last update, so nothing in the
// window is lost). The list time never admits anything: admission is decided by
// the shared reader from each page's own publish time.
'use strict';

const {XMLParser, XMLValidator} = require('fast-xml-parser');
const {settingValue} = require('../settings-registry');

const CNBC_RSS_SOURCE_ID = 'us.cnbc';
const CNBC_RSS_LIST_URL_PREFIX =
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=';
const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
  'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
});
const KB = 1024;

// Kevin, 18 Oct 2026 (decision 2): address families that are never candidates
// (shopping guides, videos, subscriber-only Investing Club and Pro, lifestyle).
const EXCLUDED_PATH_PREFIXES = Object.freeze(['/select/', '/video/', '/investingclub/', '/pro/', '/make-it/']);
const VIDEO_CONTENT_TYPE = 'cnbcvideo';

// The biggest-movers rule: a page is a movers page when its address OR its
// title matches (the patterns are the Fixed registry row cnbcRssMoversPatterns).
const MOVERS_PATTERNS = Object.freeze({
  address: Object.freeze(settingValue('cnbcRssMoversPatterns').address.map(source => new RegExp(source, 'i'))),
  title: Object.freeze(settingValue('cnbcRssMoversPatterns').title.map(source => new RegExp(source, 'i')))
});
// A deliberately loose net, used only by the probe to list possible misses.
const LOOSE_MOVERS_PATTERN = /\bmov(?:ers?|es|ing)\b/i;

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch (error) {
    return '';
  }
}

// Which parts of the movers rule a page matches: {address, title, movers}.
function moversMatch({url, title} = {}) {
  const path = pathOf(url);
  const address = MOVERS_PATTERNS.address.some(pattern => pattern.test(path));
  const titleMatch = typeof title === 'string' && MOVERS_PATTERNS.title.some(pattern => pattern.test(title.trim()));
  return Object.freeze({address, title: titleMatch, movers: address || titleMatch});
}

function isBiggestMoversPage(page) {
  return moversMatch(page).movers;
}

// True when the loose net catches a page the strict rule did not.
function isPossibleMoversMiss({url, title} = {}) {
  if (isBiggestMoversPage({url, title})) return false;
  return LOOSE_MOVERS_PATTERN.test(typeof title === 'string' ? title : '')
    || LOOSE_MOVERS_PATTERN.test(pathOf(url).replace(/[-/]/g, ' '));
}

function isExcludedFamily({url, contentType}) {
  if (contentType === VIDEO_CONTENT_TYPE) return true;
  const path = pathOf(url).toLowerCase();
  return EXCLUDED_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
}

// The list time: "Sun, 18 Oct 2026 06:13:05 GMT", or without seconds
// ("Fri, 16 Oct 2026 18:10 GMT"), in GMT/UTC or with a +hhmm/-hhmm offset.
// Returns an ISO string or null. A list updated time only (see the top note).
const MONTHS = Object.freeze(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const LIST_TIME_PATTERN = new RegExp('^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s+)?(\\d{1,2})\\s+'
  + '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+(\\d{4})\\s+(\\d{2}):(\\d{2})(?::(\\d{2}))?'
  + '\\s+(GMT|UTC|Z|([+-])(\\d{2})(\\d{2}))$', 'i');

function listUpdatedTime(value) {
  if (typeof value !== 'string') return null;
  const match = LIST_TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  const day = Number(match[2]);
  const month = MONTHS.indexOf(match[3].toLowerCase());
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = match[7] === undefined ? 0 : Number(match[7]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59) return null;
  const local = Date.UTC(year, month, day, hour, minute, second);
  const calendar = new Date(local);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day) {
    return null;
  }
  if (match[1] && WEEKDAYS[calendar.getUTCDay()] !== match[1].toLowerCase()) return null;
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60 * 1000;
  return new Date(local + (match[9] === '-' ? offsetMs : -offsetMs)).toISOString();
}

function decodeHtmlEntities(value) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
    const hexadecimal = entity[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try {
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint) : match;
    } catch (error) {
      return match;
    }
  });
}

// Plain text from an RSS field: CDATA arrives undecoded, so tags are removed and
// HTML entities decoded here as well.
function plainText(value) {
  const raw = value && typeof value === 'object' ? value['#text'] : value;
  if (typeof raw !== 'string') return null;
  const text = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text || null;
}

// An https cnbc.com address, without query or fragment; null otherwise.
function canonicalCnbcUrl(value) {
  const raw = plainText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(hostname === 'cnbc.com' || hostname.endsWith('.cnbc.com'))) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

// The finder's settings, read once per call.
function cnbcRssSettings({env = process.env} = {}) {
  return Object.freeze({
    enabled: settingValue('cnbcRssFinderEnabled', {env}),
    listIds: settingValue('cnbcRssLists', {env}),
    timeoutMs: settingValue('cnbcRssTimeoutMs', {env}),
    maxResponseBytes: settingValue('cnbcRssMaxResponseKb', {env}) * KB,
    maxCandidates: settingValue('cnbcRssMaxCandidates', {env})
  });
}

class ListReadError extends Error {
  constructor(outcome) {
    super(outcome);
    this.outcome = outcome;
  }
}

async function readBoundedBody(response, maxResponseBytes) {
  const declared = Number(response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxResponseBytes) throw new ListReadError('RESPONSE_TOO_LARGE');
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ListReadError('INVALID_FEED');
      total += value.byteLength;
      if (total > maxResponseBytes) {
        if (typeof reader.cancel === 'function') await reader.cancel().catch(() => {});
        throw new ListReadError('RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  }
  if (typeof response.text !== 'function') throw new ListReadError('INVALID_FEED');
  const text = await response.text();
  if (typeof text !== 'string') throw new ListReadError('INVALID_FEED');
  if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw new ListReadError('RESPONSE_TOO_LARGE');
  return text;
}

function parseListItems(xml) {
  if (XMLValidator.validate(xml) !== true) throw new ListReadError('INVALID_FEED');
  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false, parseTagValue: false, processEntities: true, htmlEntities: true, trimValues: false
    }).parse(xml);
  } catch (error) {
    throw new ListReadError('INVALID_FEED');
  }
  const channel = parsed && parsed.rss && parsed.rss.channel;
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) throw new ListReadError('INVALID_FEED');
  if (channel.item === undefined) return [];
  return (Array.isArray(channel.item) ? channel.item : [channel.item]).map(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return Object.freeze({
      url: canonicalCnbcUrl(entry.link),
      title: plainText(entry.title),
      listTimeText: plainText(entry.pubDate),
      listedAt: listUpdatedTime(plainText(entry.pubDate)),
      cnbcId: plainText(entry['metadata:id']) || plainText(entry.guid),
      contentType: plainText(entry['metadata:type']),
      sponsored: plainText(entry['metadata:sponsored']) === 'true'
    });
  });
}

// Reads one list. Never throws: a failure is an outcome, so one failing list
// never blanks the others.
async function readList(listId, {fetchImpl, settings, now}) {
  const url = `${CNBC_RSS_LIST_URL_PREFIX}${listId}`;
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  const result = {listId, outcome: 'OK', httpStatus: null, bytes: 0, durationMs: 0, items: []};
  try {
    let response;
    try {
      response = await fetchImpl(url, {method: 'GET', headers: REQUEST_HEADERS, signal: controller.signal});
    } catch (error) {
      throw new ListReadError(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_FAILURE');
    }
    result.httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (!response || !response.ok) throw new ListReadError('HTTP_FAILURE');
    let xml;
    try {
      xml = await readBoundedBody(response, settings.maxResponseBytes);
    } catch (error) {
      if (error instanceof ListReadError) throw error;
      throw new ListReadError(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'INVALID_FEED');
    }
    result.bytes = Buffer.byteLength(xml, 'utf8');
    result.items = parseListItems(xml);
  } catch (error) {
    result.outcome = error instanceof ListReadError ? error.outcome : 'INVALID_FEED';
    result.items = [];
  } finally {
    clearTimeout(timeout);
    result.durationMs = Math.max(0, Math.round(now() - startedAt));
  }
  return Object.freeze({...result, items: Object.freeze(result.items)});
}

// Reads every configured list in parallel.
async function readCnbcRssLists({fetchImpl = global.fetch, env = process.env, now = Date.now} = {}) {
  const settings = cnbcRssSettings({env});
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return Object.freeze(await Promise.all(settings.listIds.map(listId => readList(listId, {fetchImpl, settings, now}))));
}

// From the lists read, the candidates in the shared reader's shape, plus counts.
// Order of checks per item: usable (address and headline), excluded family,
// movers, duplicate (address or CNBC id), list time before the window start.
// Then newest list time first (items with no readable list time last, in list
// order) and the cap.
function selectCnbcRssCandidates(lists, {window = null, maxCandidates} = {}) {
  const windowStart = window && typeof window.startsAt === 'string' ? Date.parse(window.startsAt) : NaN;
  const counts = {
    itemCount: 0, unusableCount: 0, excludedFamilyCount: 0, moversDroppedCount: 0,
    moversByAddressOnlyCount: 0, moversByTitleOnlyCount: 0, moversByBothCount: 0,
    duplicateCount: 0, unparsableListTimeCount: 0, beforeWindowDroppedCount: 0, sponsoredCount: 0
  };
  const seenUrls = new Set();
  const seenIds = new Set();
  const kept = [];
  for (const list of lists) {
    for (const item of list.items) {
      counts.itemCount++;
      if (item.sponsored) counts.sponsoredCount++;
      if (!item.url || !item.title) {
        counts.unusableCount++;
        continue;
      }
      if (isExcludedFamily(item)) {
        counts.excludedFamilyCount++;
        continue;
      }
      const movers = moversMatch(item);
      if (movers.movers) {
        counts.moversDroppedCount++;
        if (movers.address && movers.title) counts.moversByBothCount++;
        else if (movers.address) counts.moversByAddressOnlyCount++;
        else counts.moversByTitleOnlyCount++;
        continue;
      }
      if (seenUrls.has(item.url) || (item.cnbcId && seenIds.has(item.cnbcId))) {
        counts.duplicateCount++;
        continue;
      }
      seenUrls.add(item.url);
      if (item.cnbcId) seenIds.add(item.cnbcId);
      if (!item.listedAt) counts.unparsableListTimeCount++;
      else if (Number.isFinite(windowStart) && Date.parse(item.listedAt) < windowStart) {
        counts.beforeWindowDroppedCount++;
        continue;
      }
      kept.push({item, listId: list.listId, position: kept.length});
    }
  }
  kept.sort((left, right) => {
    const leftTime = left.item.listedAt ? Date.parse(left.item.listedAt) : -Infinity;
    const rightTime = right.item.listedAt ? Date.parse(right.item.listedAt) : -Infinity;
    return rightTime - leftTime || left.position - right.position;
  });
  const capped = kept.slice(0, maxCandidates);
  const candidates = capped.map(({item, listId}) => Object.freeze({
    headline: item.title,
    url: item.url,
    publisher: 'CNBC',
    listedAt: item.listedAt,
    listId,
    cnbcId: item.cnbcId,
    contentType: item.contentType
  }));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    counts: Object.freeze({...counts, keptBeforeCapCount: kept.length, candidateCount: candidates.length})
  });
}

function listStats(list) {
  return Object.freeze({listId: list.listId, outcome: list.outcome, httpStatus: list.httpStatus,
    itemCount: list.items.length});
}

// The source, shaped like lib/sources/yahoo-news.js: findCandidates only.
function createCnbcRssSource({fetchImpl = global.fetch, env = process.env, now = Date.now} = {}) {
  return Object.freeze({
    sourceId: CNBC_RSS_SOURCE_ID,
    async findCandidates({window = null} = {}) {
      const settings = cnbcRssSettings({env});
      if (!settings.enabled) {
        return {ok: false, candidates: [], discoveryStats: Object.freeze({outcome: 'DISABLED', lists: []})};
      }
      let lists;
      try {
        lists = await readCnbcRssLists({fetchImpl, env, now});
      } catch (error) {
        return {ok: false, candidates: [], discoveryStats: Object.freeze({outcome: 'FAILED', lists: []})};
      }
      const {candidates, counts} = selectCnbcRssCandidates(lists, {window, maxCandidates: settings.maxCandidates});
      const anyListRead = lists.some(list => list.outcome === 'OK');
      return {
        ok: anyListRead,
        candidates: anyListRead ? candidates : [],
        discoveryStats: Object.freeze({
          outcome: anyListRead ? 'OK' : 'ALL_LISTS_FAILED',
          lists: Object.freeze(lists.map(listStats)),
          ...counts
        })
      };
    }
  });
}

module.exports = {
  CNBC_RSS_SOURCE_ID,
  CNBC_RSS_LIST_URL_PREFIX,
  EXCLUDED_PATH_PREFIXES,
  cnbcRssSettings,
  listUpdatedTime,
  moversMatch,
  isBiggestMoversPage,
  isPossibleMoversMiss,
  isExcludedFamily,
  readCnbcRssLists,
  selectCnbcRssCandidates,
  readBoundedBody,
  createCnbcRssSource
};

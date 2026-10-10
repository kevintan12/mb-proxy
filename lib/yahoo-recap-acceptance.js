// Step 9F.1g: what makes a Yahoo page the completed-session recap, in one place.
//
// A page is accepted by what it says, not by its address: https on
// finance.yahoo.com only (any path), an Article/NewsArticle/LiveBlogPosting,
// published on the target session date in the exchange's own time zone, with a
// body that reports how the major indexes moved. The update time never decides.
// The old address style is kept only to try those candidates first.
'use strict';

const YAHOO_RECAP_HOSTNAME = 'finance.yahoo.com';
const YAHOO_RECAP_EXCHANGE_TIMEZONE = 'America/New_York';
const OLD_RECAP_PATH_PATTERN = /^\/(?:markets|news)\/live\/stock-market-today-[^/]+\/?$/;
const RECAP_ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'LiveBlogPosting']);
// Candidates checked per run, old address style first.
const YAHOO_RECAP_MAX_CANDIDATES = 3;
// The body must report a move for at least this many of the three major indexes.
const RECAP_MIN_INDEXES_REPORTED = 2;
const RECAP_INDEXES = Object.freeze([
  Object.freeze({name: 'S&P 500', pattern: /\bS\s?&\s?P\s?500\b/}),
  Object.freeze({name: 'Dow', pattern: /\bDow\b/}),
  Object.freeze({name: 'Nasdaq', pattern: /\bNasdaq\b/i})
]);
const RECAP_MOVE_WORDS = new RegExp('\\b(?:' + [
  'clos(?:e|ed|es|ing)', 'end(?:ed|s)?', 'finish(?:ed|es)?', 'settl(?:e|ed|es)',
  'r(?:ise|ises|ose|isen)', 'gain(?:ed|s)?', 'climb(?:ed|s)?', 'jump(?:ed|s)?',
  'surg(?:e|ed|es)', 'rall(?:y|ied|ies)', 'advanc(?:e|ed|es)', 'add(?:ed|s)?',
  'edg(?:e|ed|es)', 'tick(?:ed|s)?', 'notch(?:ed|es)?', 'rebound(?:ed|s)?',
  'f(?:all|ell|alls|allen)', 'drop(?:s|ped)?', 'declin(?:e|ed|es)', 'sl(?:id|ide|ides)',
  'slip(?:s|ped)?', 's(?:ank|ink|inks)', 'tumbl(?:e|ed|es)', 'plung(?:e|ed|es)',
  'los(?:e|es|t)', 'shed(?:s)?', 'dip(?:s|ped)?', 'retreat(?:ed|s)?', 'slump(?:ed|s)?',
  'flat', 'unchanged'
].join('|') + ')\\b', 'i');
const RECAP_MOVE_SIZE = /\d+(?:\.\d+)?\s?%|\bpercent\b|\d[\d,]*(?:\.\d+)?\s+points?\b/i;

// Rejection reasons recorded in the audit.
const RECAP_REJECTION_REASONS = Object.freeze({
  WRONG_HOST: 'WRONG_HOST',
  PAGE_ADDRESS_MISMATCH: 'PAGE_ADDRESS_MISMATCH',
  NO_STRUCTURED_DATA: 'NO_STRUCTURED_DATA',
  NOT_ARTICLE_TYPE: 'NOT_ARTICLE_TYPE',
  WRONG_PUBLISH_DATE: 'WRONG_PUBLISH_DATE',
  FAILED_CLOSE_CHECK: 'FAILED_CLOSE_CHECK'
});

// The recap address with query, fragment and default port removed, or null.
// Any path is allowed; only https on finance.yahoo.com, with no credentials.
function canonicalYahooRecapUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== YAHOO_RECAP_HOSTNAME
        || url.username || url.password || (url.port && url.port !== '443')) return null;
    url.hostname = YAHOO_RECAP_HOSTNAME;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

// WRONG_HOST when the value is a URL on another host, else null (a malformed
// value is not a host question).
function yahooRecapHostReason(value) {
  try {
    return new URL(String(value).trim()).hostname.toLowerCase() === YAHOO_RECAP_HOSTNAME
      ? null : RECAP_REJECTION_REASONS.WRONG_HOST;
  } catch (error) {
    return null;
  }
}

function isOldStyleRecapAddress(value) {
  try {
    return OLD_RECAP_PATH_PATTERN.test(new URL(value).pathname);
  } catch (error) {
    return false;
  }
}

// Old-style addresses first, each group in its original order, then the first
// YAHOO_RECAP_MAX_CANDIDATES. With three or more old-style candidates this is
// exactly the old choice.
function orderRecapCandidates(candidates) {
  const oldStyle = candidates.filter(candidate => isOldStyleRecapAddress(candidate.discovery.url));
  const other = candidates.filter(candidate => !isOldStyleRecapAddress(candidate.discovery.url));
  return oldStyle.concat(other).slice(0, YAHOO_RECAP_MAX_CANDIDATES);
}

function isRecapArticleType(node) {
  const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
  return types.some(type => RECAP_ARTICLE_TYPES.has(type));
}

function exchangeDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: YAHOO_RECAP_EXCHANGE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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

// Moved unchanged from the recap reader (Step 9F.1g) so the page check reads the
// body exactly as the reader stores it.
function normalizePlainText(value) {
  if (typeof value !== 'string') return null;
  const text = decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return text || null;
}

// The close check: the body reports a move for at least two of the S&P 500, the
// Dow and the Nasdaq, each named in a sentence that also has a move word and a
// size (a percentage or points). Raw body text in; it is normalized here.
function reportsIndexClose(body) {
  const text = normalizePlainText(body);
  if (!text) return false;
  const reported = new Set();
  for (const sentence of text.split(/(?<=[.!?])\s*(?=[A-Z"“(])|;\s*/)) {
    if (!RECAP_MOVE_WORDS.test(sentence) || !RECAP_MOVE_SIZE.test(sentence)) continue;
    for (const index of RECAP_INDEXES) {
      if (index.pattern.test(sentence)) reported.add(index.name);
    }
    if (reported.size >= RECAP_MIN_INDEXES_REPORTED) return true;
  }
  return false;
}

module.exports = {
  YAHOO_RECAP_HOSTNAME,
  YAHOO_RECAP_EXCHANGE_TIMEZONE,
  YAHOO_RECAP_MAX_CANDIDATES,
  RECAP_MIN_INDEXES_REPORTED,
  RECAP_REJECTION_REASONS,
  canonicalYahooRecapUrl,
  yahooRecapHostReason,
  isOldStyleRecapAddress,
  orderRecapCandidates,
  isRecapArticleType,
  exchangeDate,
  normalizePlainText,
  reportsIndexClose
};

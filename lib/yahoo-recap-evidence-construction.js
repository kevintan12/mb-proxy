const {createEvidenceItem, validateEvidenceItem} = require('./evidence-items');
const {NEWS_EVIDENCE_HORIZONS} = require('./news-evidence-candidates');
const {
  YAHOO_RECAP_ARTICLE_CONTENT_KEYS
} = require('./yahoo-recap-article-content-acquisition');

const YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS = Object.freeze([
  'maxHeadlineBytes',
  'maxPublisherNameBytes',
  'maxEvidenceTextBytes',
  'maxResultBytes'
]);
const YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS = Object.freeze([
  'targetSessionDate',
  'updatedAt',
  'horizon',
  'evidenceItem'
]);
const YAHOO_RECAP_HORIZON_KEYS = Object.freeze([
  'classification',
  'startsAtExclusive',
  'endsAtInclusive'
]);
const YAHOO_RECAP_EVIDENCE_RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'INPUT_FAILURE',
  'EVIDENCE_TOO_LARGE',
  'EVIDENCE_CONTRACT_FAILURE'
]);
const YAHOO_RECAP_SOURCE_ID = 'us.yahoo-finance';
const YAHOO_RECAP_MARKET = 'US';
const YAHOO_RECAP_CATEGORY = 'news';
const YAHOO_RECAP_HOSTNAME = 'finance.yahoo.com';
const YAHOO_RECAP_PATH_PATTERN = /^\/(?:markets|news)\/live\/stock-market-today-[^/]+\/?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function newYorkDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalYahooRecapUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== YAHOO_RECAP_HOSTNAME
        || url.username || url.password || (url.port && url.port !== '443')
        || !YAHOO_RECAP_PATH_PATTERN.test(url.pathname)
        || url.search || url.hash) return null;
    url.hostname = YAHOO_RECAP_HOSTNAME;
    url.port = '';
    return url.href === value ? value : null;
  } catch (error) {
    return null;
  }
}

function canonicalBounds(bounds) {
  if (!hasExactKeys(bounds, YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS)) return null;
  const canonical = {};
  for (const key of YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) return null;
    canonical[key] = bounds[key];
  }
  return deepFreeze(canonical);
}

function canonicalHorizon(horizon, publishedAt, updatedAt) {
  if (!hasExactKeys(horizon, YAHOO_RECAP_HORIZON_KEYS)
      || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)) return null;
  const startsAtExclusive = canonicalTimestamp(horizon.startsAtExclusive);
  const endsAtInclusive = canonicalTimestamp(horizon.endsAtInclusive);
  if (!startsAtExclusive || !endsAtInclusive
      || Date.parse(startsAtExclusive) >= Date.parse(endsAtInclusive)) return null;
  const timestamps = updatedAt === null ? [publishedAt] : [publishedAt, updatedAt];
  if (timestamps.some(timestamp => Date.parse(timestamp) <= Date.parse(startsAtExclusive)
      || Date.parse(timestamp) > Date.parse(endsAtInclusive))) return null;
  return deepFreeze({classification: horizon.classification, startsAtExclusive, endsAtInclusive});
}

function canonicalArticleContent(articleContent, bounds) {
  if (!hasExactKeys(articleContent, YAHOO_RECAP_ARTICLE_CONTENT_KEYS)
      || articleContent.sourceId !== YAHOO_RECAP_SOURCE_ID
      || !hasExactKeys(articleContent.publisher, ['name'])) return null;
  const publisherName = typeof articleContent.publisher.name === 'string'
    ? articleContent.publisher.name : '';
  const headline = typeof articleContent.headline === 'string' ? articleContent.headline : '';
  const articleText = typeof articleContent.articleText === 'string' ? articleContent.articleText : '';
  const publishedAt = canonicalTimestamp(articleContent.publishedAt);
  const updatedAt = articleContent.updatedAt === null
    ? null : canonicalTimestamp(articleContent.updatedAt);
  const targetSessionDate = canonicalDate(articleContent.targetSessionDate);
  if (!publisherName || publisherName !== publisherName.trim()
      || !headline || headline !== headline.trim()
      || !articleText || articleText !== articleText.trim()
      || !canonicalYahooRecapUrl(articleContent.canonicalUrl)
      || !publishedAt || !targetSessionDate || newYorkDate(publishedAt) !== targetSessionDate
      || (articleContent.updatedAt !== null && !updatedAt)
      || (updatedAt !== null && Date.parse(updatedAt) < Date.parse(publishedAt))) return null;
  if (Buffer.byteLength(headline, 'utf8') > bounds.maxHeadlineBytes
      || Buffer.byteLength(publisherName, 'utf8') > bounds.maxPublisherNameBytes
      || Buffer.byteLength(articleText, 'utf8') > bounds.maxEvidenceTextBytes) {
    return {tooLarge: true};
  }
  return deepFreeze({
    sourceId: articleContent.sourceId,
    publisher: {name: publisherName},
    canonicalUrl: articleContent.canonicalUrl,
    headline,
    publishedAt,
    updatedAt,
    targetSessionDate,
    articleText
  });
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message});
}

function createYahooRecapEvidenceConstructionService({evidenceConstructionBounds} = {}) {
  const bounds = canonicalBounds(evidenceConstructionBounds);
  if (!bounds) throw new TypeError('Invalid Yahoo recap evidence construction bounds');

  return Object.freeze({
    constructEvidence({articleContent, horizon} = {}) {
      const canonicalArticle = canonicalArticleContent(articleContent, bounds);
      if (canonicalArticle?.tooLarge) {
        return failure('EVIDENCE_TOO_LARGE', 'Yahoo recap evidence exceeds configured bounds');
      }
      if (!canonicalArticle) {
        return failure('INPUT_FAILURE', 'Invalid Yahoo recap article content');
      }
      const canonicalEvidenceHorizon = canonicalHorizon(
        horizon,
        canonicalArticle.publishedAt,
        canonicalArticle.updatedAt
      );
      if (!canonicalEvidenceHorizon) {
        return failure('INPUT_FAILURE', 'Invalid Yahoo recap evidence horizon');
      }

      let evidenceItem;
      try {
        evidenceItem = createEvidenceItem({
          sourceId: canonicalArticle.sourceId,
          market: YAHOO_RECAP_MARKET,
          evidenceCategory: YAHOO_RECAP_CATEGORY,
          title: canonicalArticle.headline,
          summary: canonicalArticle.articleText,
          canonicalUrl: canonicalArticle.canonicalUrl,
          publishedAt: canonicalArticle.publishedAt,
          symbols: [],
          publisher: canonicalArticle.publisher.name
        });
      } catch (error) {
        return failure(
          'EVIDENCE_CONTRACT_FAILURE',
          'Yahoo recap evidence construction failed canonical validation'
        );
      }
      if (!validateEvidenceItem(evidenceItem).valid) {
        return failure(
          'EVIDENCE_CONTRACT_FAILURE',
          'Yahoo recap evidence construction failed canonical validation'
        );
      }

      const constructedEvidence = {
        targetSessionDate: canonicalArticle.targetSessionDate,
        updatedAt: canonicalArticle.updatedAt,
        horizon: canonicalEvidenceHorizon,
        evidenceItem
      };
      if (!hasExactKeys(constructedEvidence, YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS)
          || Buffer.byteLength(JSON.stringify(constructedEvidence), 'utf8') > bounds.maxResultBytes) {
        return failure('EVIDENCE_TOO_LARGE', 'Yahoo recap evidence exceeds configured bounds');
      }
      return deepFreeze({ok: true, type: 'SUCCESS', constructedEvidence});
    }
  });
}

module.exports = {
  YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS,
  YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS,
  YAHOO_RECAP_HORIZON_KEYS,
  YAHOO_RECAP_EVIDENCE_RESULT_TYPES,
  createYahooRecapEvidenceConstructionService
};

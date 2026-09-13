const {createEvidenceItem, validateEvidenceItem} = require('./evidence-items');
const {NEWS_EVIDENCE_HORIZONS} = require('./news-evidence-candidates');
const {
  CNBC_RECAP_ARTICLE_CONTENT_RESULT_KEYS
} = require('./cnbc-article-content-acquisition');

const CNBC_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS = Object.freeze([
  'maxEvidenceTextBytes', 'maxTitleBytes', 'maxResultBytes'
]);
const CNBC_RECAP_CONSTRUCTED_EVIDENCE_KEYS = Object.freeze([
  'targetSessionDate', 'updatedAt', 'horizon', 'evidenceItem'
]);
const HORIZON_KEYS = Object.freeze(['classification', 'startsAtExclusive', 'endsAtInclusive']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]) ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function canonicalCnbcRecapUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(hostname === 'cnbc.com' || hostname.endsWith('.cnbc.com'))
        || url.username || url.password || (url.port && url.port !== '443')
        || !/^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates\.html\/?$/.test(url.pathname)
        || url.search || url.hash) return null;
    return url.href === value ? value : null;
  } catch (error) {
    return null;
  }
}

function newYorkDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalBounds(bounds) {
  if (!hasExactKeys(bounds, CNBC_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS)) return null;
  const result = {};
  for (const key of CNBC_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) return null;
    result[key] = bounds[key];
  }
  return deepFreeze(result);
}

function canonicalHorizon(horizon, publishedAt, updatedAt) {
  if (!hasExactKeys(horizon, HORIZON_KEYS)
      || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)) return null;
  const start = canonicalTimestamp(horizon.startsAtExclusive);
  const end = canonicalTimestamp(horizon.endsAtInclusive);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) return null;
  const timestamps = updatedAt === null ? [publishedAt] : [publishedAt, updatedAt];
  if (timestamps.some(value => Date.parse(value) <= Date.parse(start)
      || Date.parse(value) > Date.parse(end))) return null;
  return deepFreeze({classification: horizon.classification, startsAtExclusive: start, endsAtInclusive: end});
}

function canonicalArticle(article, bounds) {
  if (!hasExactKeys(article, CNBC_RECAP_ARTICLE_CONTENT_RESULT_KEYS)
      || article.sourceId !== 'us.cnbc'
      || !hasExactKeys(article.provenance, [
        'publisher', 'authority', 'homepage', 'applicableMarket', 'sourceJurisdiction', 'locator'
      ])
      || article.provenance.publisher !== 'CNBC'
      || article.provenance.authority !== 'secondary'
      || article.provenance.homepage !== 'https://www.cnbc.com/'
      || article.provenance.applicableMarket !== 'US'
      || article.provenance.sourceJurisdiction !== 'GLOBAL'
      || article.provenance.locator !== 'source-homepage'
      || !canonicalCnbcRecapUrl(article.canonicalUrl)
      || typeof article.title !== 'string' || !article.title || article.title !== article.title.trim()
      || typeof article.articleText !== 'string' || !article.articleText
      || article.articleText !== article.articleText.trim()
      || !canonicalTimestamp(article.publishedAt)
      || (article.updatedAt !== null && !canonicalTimestamp(article.updatedAt))
      || !canonicalDate(article.targetSessionDate)
      || newYorkDate(article.publishedAt) !== article.targetSessionDate
      || !['Article', 'NewsArticle', 'ReportageNewsArticle', 'BlogPosting'].includes(article.selectedArticleType)
      || (article.updatedAt !== null && Date.parse(article.updatedAt) < Date.parse(article.publishedAt))) {
    return null;
  }
  if (Buffer.byteLength(article.title, 'utf8') > bounds.maxTitleBytes
      || Buffer.byteLength(article.articleText, 'utf8') > bounds.maxEvidenceTextBytes) {
    return {tooLarge: true};
  }
  return article;
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message});
}

function createCnbcRecapEvidenceConstructionService({evidenceConstructionBounds} = {}) {
  const bounds = canonicalBounds(evidenceConstructionBounds);
  if (!bounds) throw new TypeError('Invalid CNBC recap evidence construction bounds');
  return Object.freeze({
    constructEvidence({articleContent, horizon} = {}) {
      const article = canonicalArticle(articleContent, bounds);
      if (article?.tooLarge) return failure('EVIDENCE_TOO_LARGE', 'CNBC recap evidence exceeds configured bounds');
      if (!article) return failure('INPUT_FAILURE', 'Invalid CNBC recap article content');
      const canonicalEvidenceHorizon = canonicalHorizon(horizon, article.publishedAt, article.updatedAt);
      if (!canonicalEvidenceHorizon) return failure('INPUT_FAILURE', 'Invalid CNBC recap evidence horizon');
      let evidenceItem;
      try {
        evidenceItem = createEvidenceItem({
          sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: article.title,
          summary: article.articleText, canonicalUrl: article.canonicalUrl,
          publishedAt: article.publishedAt, symbols: []
        });
      } catch (error) {
        return failure('EVIDENCE_CONTRACT_FAILURE', 'CNBC recap evidence construction failed canonical validation');
      }
      if (!validateEvidenceItem(evidenceItem).valid) {
        return failure('EVIDENCE_CONTRACT_FAILURE', 'CNBC recap evidence construction failed canonical validation');
      }
      const constructedEvidence = {
        targetSessionDate: article.targetSessionDate,
        updatedAt: article.updatedAt,
        horizon: canonicalEvidenceHorizon,
        evidenceItem
      };
      if (Buffer.byteLength(JSON.stringify(constructedEvidence), 'utf8') > bounds.maxResultBytes) {
        return failure('EVIDENCE_TOO_LARGE', 'CNBC recap evidence exceeds configured bounds');
      }
      return deepFreeze({ok: true, type: 'SUCCESS', constructedEvidence});
    }
  });
}

module.exports = {
  CNBC_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS,
  CNBC_RECAP_CONSTRUCTED_EVIDENCE_KEYS,
  createCnbcRecapEvidenceConstructionService
};

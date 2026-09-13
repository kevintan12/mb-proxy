const {validateNewsEvidenceCandidate} = require('./news-evidence-candidates');
const {getSourceById} = require('./evidence-sources');

const RETRIEVAL_BOUND_KEYS = Object.freeze([
  'timeoutMs',
  'maxResponseBytes',
  'maxArticleTextBytes',
  'maxTitleBytes',
  'maxResultBytes'
]);
const RESULT_KEYS = Object.freeze([
  'reference',
  'sourceId',
  'canonicalUrl',
  'publishedAt',
  'updatedAt',
  'title',
  'articleText',
  'provenance'
]);
const RECAP_DISCOVERY_KEYS = Object.freeze(['title', 'url', 'discoveredVia', 'targetSessionDate']);
const RECAP_RESULT_KEYS = Object.freeze([
  'sourceId',
  'canonicalUrl',
  'publishedAt',
  'updatedAt',
  'title',
  'articleText',
  'provenance',
  'targetSessionDate',
  'selectedArticleType'
]);
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'ReportageNewsArticle']);
const LIVE_BLOG_TYPE = 'LiveBlogPosting';
const BLOG_POST_TYPE = 'BlogPosting';
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CNBC_RECAP_PATH_PATTERN = /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates\.html\/?$/;
const CNBC_RECAP_DISCOVERED_VIA = 'ANTHROPIC_WEB_SEARCH';
const CNBC_RECAP_TIMEZONE = 'America/New_York';

class CnbcArticleContentAcquisitionError extends Error {
  constructor(code, message, sizeFailureType) {
    super(message);
    this.name = 'CnbcArticleContentAcquisitionError';
    this.code = code;
    if (sizeFailureType !== undefined) this.sizeFailureType = sizeFailureType;
  }
}

function fail(code, message, sizeFailureType) {
  return new CnbcArticleContentAcquisitionError(code, message, sizeFailureType);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalCnbcUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:'
        || !(hostname === 'cnbc.com' || hostname.endsWith('.cnbc.com'))
        || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (calendarDate.getUTCFullYear() !== year
      || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
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

function exchangeDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CNBC_RECAP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateCnbcRecapDiscovery(discovery) {
  if (!Object.isFrozen(discovery) || !hasExactKeys(discovery, RECAP_DISCOVERY_KEYS)
      || typeof discovery.title !== 'string' || !discovery.title
      || discovery.title !== discovery.title.trim()
      || discovery.discoveredVia !== CNBC_RECAP_DISCOVERED_VIA
      || !canonicalDate(discovery.targetSessionDate)) {
    throw fail('INVALID_INPUT', 'A canonical CNBC recap discovery result is required');
  }
  const canonicalUrl = canonicalCnbcUrl(discovery.url);
  if (!canonicalUrl || canonicalUrl !== discovery.url) {
    throw fail('INVALID_INPUT', 'A canonical CNBC recap discovery result is required');
  }
  const parsed = new URL(canonicalUrl);
  if ((parsed.port && parsed.port !== '443') || !CNBC_RECAP_PATH_PATTERN.test(parsed.pathname)
      || parsed.search || parsed.hash) {
    throw fail('INVALID_INPUT', 'A canonical CNBC recap discovery result is required');
  }
  return canonicalUrl;
}

function canonicalBounds(bounds) {
  if (!hasExactKeys(bounds, RETRIEVAL_BOUND_KEYS)) {
    throw fail('INVALID_INPUT', 'Invalid CNBC article retrieval bounds');
  }
  const normalized = {};
  for (const key of RETRIEVAL_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) {
      throw fail('INVALID_INPUT', 'Invalid CNBC article retrieval bounds');
    }
    normalized[key] = bounds[key];
  }
  return deepFreeze(normalized);
}

function candidateValidationBounds(candidate) {
  const bytes = value => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
  return {
    maxCandidates: 1,
    maxTitleBytes: Math.max(1, bytes(candidate && candidate.title)),
    maxSummaryBytes: Math.max(1, bytes(candidate && candidate.summary)),
    maxExtractBytes: Math.max(1, bytes(candidate && candidate.extract)),
    maxCollectionBytes: Math.max(1, bytes(JSON.stringify({market: candidate && candidate.market, candidates: [candidate]})))
  };
}

function validateCnbcCandidate(candidate) {
  let valid = false;
  try {
    valid = validateNewsEvidenceCandidate(candidate, {
      bounds: candidateValidationBounds(candidate)
    }).valid;
  } catch (error) {}
  const canonicalUrl = canonicalCnbcUrl(candidate && candidate.canonicalUrl);
  if (!valid || candidate.sourceId !== 'us.cnbc' || candidate.market !== 'US'
      || candidate.evidenceCategory !== 'news' || !canonicalUrl
      || canonicalUrl !== candidate.canonicalUrl) {
    throw fail('INVALID_INPUT', 'A canonical US CNBC news candidate is required');
  }
  return canonicalUrl;
}

function isAbort(error, signal) {
  return signal.aborted || (error && error.name === 'AbortError');
}

async function readBoundedBody(response, signal, maxResponseBytes) {
  const contentLengthValue = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length') : null;
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw fail(
        'CONTENT_TOO_LARGE',
        'CNBC article response exceeds configured bounds',
        'RESPONSE_TOO_LARGE'
      );
    }
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let html = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fail('INVALID_PAGE', 'CNBC article body is malformed');
      total += value.byteLength;
      if (total > maxResponseBytes) {
        if (typeof reader.cancel === 'function') await reader.cancel();
        throw fail(
          'CONTENT_TOO_LARGE',
          'CNBC article response exceeds configured bounds',
          'RESPONSE_TOO_LARGE'
        );
      }
      html += decoder.decode(value, {stream: true});
    }
    return html + decoder.decode();
  }
  if (typeof response.text !== 'function') throw fail('INVALID_PAGE', 'CNBC article body is unavailable');
  const html = await response.text();
  if (typeof html !== 'string') throw fail('INVALID_PAGE', 'CNBC article body is malformed');
  if (Buffer.byteLength(html, 'utf8') > maxResponseBytes) {
    throw fail(
      'CONTENT_TOO_LARGE',
      'CNBC article response exceeds configured bounds',
      'RESPONSE_TOO_LARGE'
    );
  }
  return html;
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

function jsonLdValues(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach(item => jsonLdValues(item, output));
    return output;
  }
  output.push(value);
  Object.entries(value).forEach(([key, item]) => {
    if (key === 'liveBlogUpdate' && hasType(value, LIVE_BLOG_TYPE)) return;
    if (item && typeof item === 'object') jsonLdValues(item, output);
  });
  return output;
}

function isArticleNode(node) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some(type => ARTICLE_TYPES.has(type));
}

function hasType(node, expectedType) {
  const types = Array.isArray(node && node['@type']) ? node['@type'] : [node && node['@type']];
  return types.includes(expectedType);
}

function firstLiveBlogUpdate(nodes) {
  for (const node of nodes) {
    if (!hasType(node, LIVE_BLOG_TYPE) || !Array.isArray(node.liveBlogUpdate)) continue;
    for (const update of node.liveBlogUpdate) {
      if (hasType(update, BLOG_POST_TYPE) && normalizePlainText(update.articleBody)) return update;
    }
  }
  return null;
}

function extractArticle(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) scripts.push(match[1]);
  if (scripts.length === 0) throw fail('INVALID_PAGE', 'CNBC page lacks structured article metadata');

  const nodes = [];
  for (const script of scripts) {
    try {
      jsonLdValues(JSON.parse(script.trim()), nodes);
    } catch (error) {}
  }
  const articles = nodes.filter(isArticleNode);
  const liveBlogs = nodes.filter(node => hasType(node, LIVE_BLOG_TYPE));
  if (articles.length === 0 && liveBlogs.length === 0) throw fail('INVALID_PAGE', 'CNBC page is not an article');
  const article = articles.find(node => normalizePlainText(node.articleBody))
    || firstLiveBlogUpdate(liveBlogs)
    || articles[0];
  if (!article) throw fail('EXTRACTION_FAILURE', 'CNBC article content or timestamps could not be extracted');
  const articleText = normalizePlainText(article.articleBody);
  const publishedAt = canonicalTimestamp(article.datePublished);
  const updatedAt = article.dateModified === undefined || article.dateModified === null
    ? null : canonicalTimestamp(article.dateModified);
  if (!articleText || !publishedAt || (article.dateModified !== undefined && article.dateModified !== null && !updatedAt)) {
    throw fail('EXTRACTION_FAILURE', 'CNBC article content or timestamps could not be extracted');
  }
  const selectedArticleType = hasType(article, BLOG_POST_TYPE)
    ? BLOG_POST_TYPE
    : [...ARTICLE_TYPES].find(type => hasType(article, type));
  return {articleText, publishedAt, updatedAt, selectedArticleType};
}

function withinHorizon(timestamp, horizon) {
  const value = Date.parse(timestamp);
  return value > Date.parse(horizon.startsAtExclusive) && value <= Date.parse(horizon.endsAtInclusive);
}

async function fetchArticleHtml(fetchImpl, canonicalUrl, limits) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(canonicalUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html, application/xhtml+xml;q=0.9',
          'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
        },
        signal: controller.signal
      });
    } catch (error) {
      if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'CNBC article request timed out');
      throw fail('NETWORK_FAILURE', 'CNBC article request failed');
    }
    if (!response || !response.ok) throw fail('HTTP_FAILURE', 'CNBC article request was unsuccessful');
    const responseUrl = response.url ? canonicalCnbcUrl(response.url) : canonicalUrl;
    if (!responseUrl || responseUrl !== canonicalUrl) {
      throw fail('INVALID_PAGE', 'CNBC article response URL is invalid');
    }
    const contentType = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type') : null;
    if (typeof contentType !== 'string'
        || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType.trim())) {
      throw fail('INVALID_PAGE', 'CNBC article response is not HTML');
    }
    try {
      return await readBoundedBody(response, controller.signal, limits.maxResponseBytes);
    } catch (error) {
      if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'CNBC article request timed out');
      if (error instanceof CnbcArticleContentAcquisitionError) throw error;
      throw fail('NETWORK_FAILURE', 'CNBC article response body could not be read');
    }
  } finally {
    clearTimeout(timeout);
  }
}

function createCnbcArticleContentAcquisitionService({fetchImpl = global.fetch} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return Object.freeze({
    async acquireArticleContent({candidate, bounds} = {}) {
      const limits = canonicalBounds(bounds);
      const canonicalUrl = validateCnbcCandidate(candidate);
      if (Buffer.byteLength(candidate.title, 'utf8') > limits.maxTitleBytes) {
        throw fail(
          'CONTENT_TOO_LARGE',
          'CNBC article title exceeds configured bounds',
          'TITLE_TOO_LARGE'
        );
      }

      const html = await fetchArticleHtml(fetchImpl, canonicalUrl, limits);

      const extracted = extractArticle(html);
      if (!withinHorizon(extracted.publishedAt, candidate.horizon)
          || (extracted.updatedAt !== null && !withinHorizon(extracted.updatedAt, candidate.horizon))
          || (extracted.updatedAt !== null
            && Date.parse(extracted.updatedAt) < Date.parse(extracted.publishedAt))) {
        throw fail('HORIZON_MISMATCH', 'CNBC article timestamps do not match the candidate horizon');
      }
      if (Buffer.byteLength(extracted.articleText, 'utf8') > limits.maxArticleTextBytes) {
        throw fail(
          'CONTENT_TOO_LARGE',
          'CNBC article text exceeds configured bounds',
          'ARTICLE_TEXT_TOO_LARGE'
        );
      }
      const result = {
        reference: candidate.reference,
        sourceId: candidate.sourceId,
        canonicalUrl: candidate.canonicalUrl,
        publishedAt: extracted.publishedAt,
        updatedAt: extracted.updatedAt,
        title: candidate.title,
        articleText: extracted.articleText,
        provenance: {...candidate.provenance}
      };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxResultBytes) {
        throw fail(
          'CONTENT_TOO_LARGE',
          'CNBC normalized article result exceeds configured bounds',
          'RESULT_TOO_LARGE'
        );
      }
      return deepFreeze(result);
    },

    async acquireRecapArticleContent({discovery, bounds} = {}) {
      const limits = canonicalBounds(bounds);
      const canonicalUrl = validateCnbcRecapDiscovery(discovery);
      if (Buffer.byteLength(discovery.title, 'utf8') > limits.maxTitleBytes) {
        throw fail('CONTENT_TOO_LARGE', 'CNBC article title exceeds configured bounds', 'TITLE_TOO_LARGE');
      }
      const html = await fetchArticleHtml(fetchImpl, canonicalUrl, limits);
      const extracted = extractArticle(html);
      if (exchangeDate(extracted.publishedAt) !== discovery.targetSessionDate) {
        throw fail('SESSION_MISMATCH', 'CNBC recap publication date does not match the target session');
      }
      if (extracted.updatedAt !== null
          && Date.parse(extracted.updatedAt) < Date.parse(extracted.publishedAt)) {
        throw fail('EXTRACTION_FAILURE', 'CNBC article content or timestamps could not be extracted');
      }
      if (Buffer.byteLength(extracted.articleText, 'utf8') > limits.maxArticleTextBytes) {
        throw fail('CONTENT_TOO_LARGE', 'CNBC article text exceeds configured bounds', 'ARTICLE_TEXT_TOO_LARGE');
      }
      const result = {
        sourceId: 'us.cnbc',
        canonicalUrl,
        publishedAt: extracted.publishedAt,
        updatedAt: extracted.updatedAt,
        title: discovery.title,
        articleText: extracted.articleText,
        provenance: {...getSourceById('us.cnbc').provenance},
        targetSessionDate: discovery.targetSessionDate,
        selectedArticleType: extracted.selectedArticleType
      };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxResultBytes) {
        throw fail('CONTENT_TOO_LARGE', 'CNBC normalized article result exceeds configured bounds', 'RESULT_TOO_LARGE');
      }
      return deepFreeze(result);
    }
  });
}

module.exports = {
  CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS: RETRIEVAL_BOUND_KEYS,
  CNBC_ARTICLE_CONTENT_RESULT_KEYS: RESULT_KEYS,
  CNBC_RECAP_DISCOVERY_KEYS: RECAP_DISCOVERY_KEYS,
  CNBC_RECAP_ARTICLE_CONTENT_RESULT_KEYS: RECAP_RESULT_KEYS,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
};

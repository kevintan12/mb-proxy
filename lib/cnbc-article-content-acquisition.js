const {validateNewsEvidenceCandidate} = require('./news-evidence-candidates');

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
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'ReportageNewsArticle']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

class CnbcArticleContentAcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CnbcArticleContentAcquisitionError';
    this.code = code;
  }
}

function fail(code, message) {
  return new CnbcArticleContentAcquisitionError(code, message);
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
      throw fail('CONTENT_TOO_LARGE', 'CNBC article response exceeds configured bounds');
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
        throw fail('CONTENT_TOO_LARGE', 'CNBC article response exceeds configured bounds');
      }
      html += decoder.decode(value, {stream: true});
    }
    return html + decoder.decode();
  }
  if (typeof response.text !== 'function') throw fail('INVALID_PAGE', 'CNBC article body is unavailable');
  const html = await response.text();
  if (typeof html !== 'string') throw fail('INVALID_PAGE', 'CNBC article body is malformed');
  if (Buffer.byteLength(html, 'utf8') > maxResponseBytes) {
    throw fail('CONTENT_TOO_LARGE', 'CNBC article response exceeds configured bounds');
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
  Object.values(value).forEach(item => {
    if (item && typeof item === 'object') jsonLdValues(item, output);
  });
  return output;
}

function isArticleNode(node) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some(type => ARTICLE_TYPES.has(type));
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
  if (articles.length === 0) throw fail('INVALID_PAGE', 'CNBC page is not an article');
  const article = articles.find(node => typeof node.articleBody === 'string') || articles[0];
  const articleText = normalizePlainText(article.articleBody);
  const publishedAt = canonicalTimestamp(article.datePublished);
  const updatedAt = article.dateModified === undefined || article.dateModified === null
    ? null : canonicalTimestamp(article.dateModified);
  if (!articleText || !publishedAt || (article.dateModified !== undefined && article.dateModified !== null && !updatedAt)) {
    throw fail('EXTRACTION_FAILURE', 'CNBC article content or timestamps could not be extracted');
  }
  return {articleText, publishedAt, updatedAt};
}

function withinHorizon(timestamp, horizon) {
  const value = Date.parse(timestamp);
  return value > Date.parse(horizon.startsAtExclusive) && value <= Date.parse(horizon.endsAtInclusive);
}

function createCnbcArticleContentAcquisitionService({fetchImpl = global.fetch} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return Object.freeze({
    async acquireArticleContent({candidate, bounds} = {}) {
      const limits = canonicalBounds(bounds);
      const canonicalUrl = validateCnbcCandidate(candidate);
      if (Buffer.byteLength(candidate.title, 'utf8') > limits.maxTitleBytes) {
        throw fail('CONTENT_TOO_LARGE', 'CNBC article title exceeds configured bounds');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
      let html;
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
          html = await readBoundedBody(response, controller.signal, limits.maxResponseBytes);
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'CNBC article request timed out');
          if (error instanceof CnbcArticleContentAcquisitionError) throw error;
          throw fail('NETWORK_FAILURE', 'CNBC article response body could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }

      const extracted = extractArticle(html);
      if (!withinHorizon(extracted.publishedAt, candidate.horizon)
          || (extracted.updatedAt !== null && !withinHorizon(extracted.updatedAt, candidate.horizon))
          || (extracted.updatedAt !== null
            && Date.parse(extracted.updatedAt) < Date.parse(extracted.publishedAt))) {
        throw fail('HORIZON_MISMATCH', 'CNBC article timestamps do not match the candidate horizon');
      }
      if (Buffer.byteLength(extracted.articleText, 'utf8') > limits.maxArticleTextBytes) {
        throw fail('CONTENT_TOO_LARGE', 'CNBC article text exceeds configured bounds');
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
        throw fail('CONTENT_TOO_LARGE', 'CNBC normalized article result exceeds configured bounds');
      }
      return deepFreeze(result);
    }
  });
}

module.exports = {
  CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS: RETRIEVAL_BOUND_KEYS,
  CNBC_ARTICLE_CONTENT_RESULT_KEYS: RESULT_KEYS,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
};

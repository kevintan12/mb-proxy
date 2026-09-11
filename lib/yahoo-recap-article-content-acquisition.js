const YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS = Object.freeze([
  'timeoutMs',
  'maxResponseBytes',
  'maxHeadlineBytes',
  'maxArticleTextBytes',
  'maxResultBytes'
]);
const YAHOO_RECAP_DISCOVERY_KEYS = Object.freeze([
  'title',
  'url',
  'discoveredVia',
  'targetSessionDate'
]);
const YAHOO_RECAP_VALIDATION_KEYS = Object.freeze([
  'headline',
  'url',
  'datePublished',
  'dateModified',
  'targetSessionDate'
]);
const YAHOO_RECAP_ARTICLE_CONTENT_KEYS = Object.freeze([
  'sourceId',
  'canonicalUrl',
  'headline',
  'publishedAt',
  'updatedAt',
  'targetSessionDate',
  'articleText'
]);
const YAHOO_RECAP_HOSTNAME = 'finance.yahoo.com';
const YAHOO_RECAP_SOURCE_ID = 'us.yahoo-finance';
const YAHOO_RECAP_DISCOVERED_VIA = 'ANTHROPIC_WEB_SEARCH';
const YAHOO_RECAP_PATH_PATTERN = /^\/(?:markets|news)\/live\/stock-market-today-[^/]+\/?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'LiveBlogPosting']);

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
    && expectedKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
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
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function newYorkDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalYahooRecapUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== YAHOO_RECAP_HOSTNAME
        || url.username || url.password || (url.port && url.port !== '443')
        || !YAHOO_RECAP_PATH_PATTERN.test(url.pathname)) return null;
    url.protocol = 'https:';
    url.hostname = YAHOO_RECAP_HOSTNAME;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function canonicalBounds(bounds) {
  if (!hasExactKeys(bounds, YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS)) return null;
  const result = {};
  for (const key of YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) return null;
    result[key] = bounds[key];
  }
  return deepFreeze(result);
}

function canonicalInput(input) {
  if (!hasExactKeys(input, ['discovery', 'validation', 'bounds'])) return null;
  const {discovery, validation} = input;
  if (!Object.isFrozen(discovery) || !Object.isFrozen(validation)
      || !hasExactKeys(discovery, YAHOO_RECAP_DISCOVERY_KEYS)
      || !hasExactKeys(validation, YAHOO_RECAP_VALIDATION_KEYS)) return null;
  const targetSessionDate = canonicalDate(discovery.targetSessionDate);
  const discoveryUrl = canonicalYahooRecapUrl(discovery.url);
  const validationUrl = canonicalYahooRecapUrl(validation.url);
  const publishedAt = canonicalTimestamp(validation.datePublished);
  const updatedAt = validation.dateModified === null
    ? null : canonicalTimestamp(validation.dateModified);
  const bounds = canonicalBounds(input.bounds);
  if (discovery.discoveredVia !== YAHOO_RECAP_DISCOVERED_VIA
      || typeof discovery.title !== 'string' || !discovery.title.trim()
      || discovery.title !== discovery.title.trim()
      || !targetSessionDate || validation.targetSessionDate !== targetSessionDate
      || !discoveryUrl || discoveryUrl !== discovery.url
      || !validationUrl || validationUrl !== validation.url || discoveryUrl !== validationUrl
      || !publishedAt || publishedAt !== validation.datePublished
      || newYorkDate(publishedAt) !== targetSessionDate
      || (validation.dateModified !== null && (!updatedAt || updatedAt !== validation.dateModified))
      || (updatedAt !== null && Date.parse(updatedAt) < Date.parse(publishedAt))
      || (validation.headline !== null
        && (typeof validation.headline !== 'string' || !validation.headline.trim()
          || validation.headline !== validation.headline.trim()))
      || !bounds) return null;
  return deepFreeze({discovery, validation, bounds, canonicalUrl: discoveryUrl});
}

function result(ok, type, articleContent = null, message = null) {
  const value = {ok, type, articleContent};
  if (message !== null) value.message = message;
  return deepFreeze(value);
}

function isAbort(error, signal) {
  return signal.aborted || error?.name === 'AbortError';
}

async function readBoundedBody(response, signal, maxBytes) {
  const declared = response.headers && typeof response.headers.get === 'function'
    ? Number(response.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) return {tooLarge: true, html: null};
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Invalid response chunk');
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch (error) {}
        return {tooLarge: true, html: null};
      }
      chunks.push(Buffer.from(value));
    }
    return {tooLarge: false, html: Buffer.concat(chunks).toString('utf8')};
  }
  if (typeof response.text !== 'function') throw new TypeError('Response body unavailable');
  const html = await response.text();
  if (typeof html !== 'string') throw new TypeError('Invalid response body');
  const tooLarge = Buffer.byteLength(html, 'utf8') > maxBytes;
  return {tooLarge, html: tooLarge ? null : html};
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

function jsonLdNodes(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach(item => jsonLdNodes(item, output));
    return output;
  }
  output.push(value);
  Object.values(value).forEach(item => {
    if (item && typeof item === 'object') jsonLdNodes(item, output);
  });
  return output;
}

function isArticle(node) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some(type => ARTICLE_TYPES.has(type));
}

function metadataUrl(node) {
  const value = typeof node.url === 'string' ? node.url
    : typeof node.mainEntityOfPage === 'string' ? node.mainEntityOfPage
      : typeof node.mainEntityOfPage?.['@id'] === 'string' ? node.mainEntityOfPage['@id'] : null;
  return value === null ? null : canonicalYahooRecapUrl(value);
}

function canonicalLink(html) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (!rel.split(/\s+/).some(value => value.toLowerCase() === 'canonical')) continue;
    return /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || null;
  }
  return null;
}

function extractArticle(html, canonical) {
  const pageCanonical = canonicalLink(html);
  if (pageCanonical !== null && canonicalYahooRecapUrl(pageCanonical) !== canonical.canonicalUrl) {
    return {failureType: 'IDENTITY_MISMATCH'};
  }
  const scripts = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) scripts.push(match[1]);
  if (scripts.length === 0) return {failureType: 'INVALID_METADATA'};
  const nodes = [];
  for (const script of scripts) {
    try { jsonLdNodes(JSON.parse(script.trim()), nodes); } catch (error) {}
  }
  const articles = nodes.filter(isArticle);
  if (articles.length === 0) return {failureType: 'INVALID_METADATA'};

  let missingBody = false;
  let identityMismatch = false;
  for (const article of articles) {
    const hasMetadataUrl = typeof article.url === 'string'
      || typeof article.mainEntityOfPage === 'string'
      || typeof article.mainEntityOfPage?.['@id'] === 'string';
    if (!hasMetadataUrl) continue;
    const articleUrl = metadataUrl(article);
    if (!articleUrl || articleUrl !== canonical.canonicalUrl) {
      identityMismatch = true;
      continue;
    }
    const publishedAt = canonicalTimestamp(article.datePublished);
    if (!publishedAt || publishedAt !== canonical.validation.datePublished) continue;
    const updatedAt = article.dateModified === undefined || article.dateModified === null
      ? null : canonicalTimestamp(article.dateModified);
    if ((article.dateModified !== undefined && article.dateModified !== null && !updatedAt)
        || updatedAt !== canonical.validation.dateModified) continue;
    const headline = typeof article.headline === 'string' ? article.headline.trim() : '';
    if (!headline) return {failureType: 'INVALID_METADATA'};
    if (canonical.validation.headline !== null && headline !== canonical.validation.headline) {
      return {failureType: 'IDENTITY_MISMATCH'};
    }
    const articleText = normalizePlainText(article.articleBody);
    if (!articleText) {
      missingBody = true;
      continue;
    }
    return {headline, publishedAt, updatedAt, articleText};
  }
  if (missingBody) return {failureType: 'ARTICLE_BODY_MISSING'};
  return {failureType: identityMismatch ? 'IDENTITY_MISMATCH' : 'INVALID_METADATA'};
}

function responseContentType(response) {
  const value = response?.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type') : null;
  return typeof value === 'string'
    && /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(value.trim());
}

function createYahooRecapArticleContentAcquisitionService({fetchImpl = global.fetch} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return deepFreeze({
    async acquireArticleContent(input) {
      const canonical = canonicalInput(input);
      if (!canonical) return result(false, 'INVALID_INPUT', null, 'Invalid Yahoo recap article request');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), canonical.bounds.timeoutMs);
      let response;
      let body;
      try {
        try {
          response = await fetchImpl(canonical.canonicalUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              Accept: 'text/html, application/xhtml+xml;q=0.9',
              'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
            },
            signal: controller.signal
          });
        } catch (error) {
          const type = isAbort(error, controller.signal) ? 'TIMEOUT' : 'RETRIEVAL_FAILURE';
          return result(false, type, null, 'Yahoo recap article could not be retrieved');
        }
        if (!response?.ok) {
          return result(false, 'HTTP_FAILURE', null, 'Yahoo recap article request was unsuccessful');
        }
        const responseUrl = response.url
          ? canonicalYahooRecapUrl(response.url) : canonical.canonicalUrl;
        if (!responseUrl || responseUrl !== canonical.canonicalUrl) {
          return result(false, 'IDENTITY_MISMATCH', null, 'Yahoo recap article identity does not match');
        }
        if (!responseContentType(response)) {
          return result(false, 'INVALID_CONTENT_TYPE', null, 'Yahoo recap article response is not HTML');
        }
        try {
          body = await readBoundedBody(response, controller.signal, canonical.bounds.maxResponseBytes);
        } catch (error) {
          const type = isAbort(error, controller.signal) ? 'TIMEOUT' : 'RETRIEVAL_FAILURE';
          return result(false, type, null, 'Yahoo recap article response could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }
      if (body.tooLarge) {
        return result(false, 'RESPONSE_TOO_LARGE', null, 'Yahoo recap article response exceeds configured bounds');
      }

      const extracted = extractArticle(body.html, canonical);
      if (extracted.failureType) {
        const messages = {
          IDENTITY_MISMATCH: 'Yahoo recap article identity does not match',
          INVALID_METADATA: 'Yahoo recap article structured metadata is invalid',
          ARTICLE_BODY_MISSING: 'Yahoo recap article body is unavailable'
        };
        return result(false, extracted.failureType, null, messages[extracted.failureType]);
      }
      if (Buffer.byteLength(extracted.headline, 'utf8') > canonical.bounds.maxHeadlineBytes) {
        return result(false, 'INVALID_METADATA', null, 'Yahoo recap article structured metadata is invalid');
      }
      if (Buffer.byteLength(extracted.articleText, 'utf8') > canonical.bounds.maxArticleTextBytes) {
        return result(false, 'ARTICLE_TEXT_TOO_LARGE', null, 'Yahoo recap article text exceeds configured bounds');
      }
      const articleContent = {
        sourceId: YAHOO_RECAP_SOURCE_ID,
        canonicalUrl: canonical.canonicalUrl,
        headline: extracted.headline,
        publishedAt: extracted.publishedAt,
        updatedAt: extracted.updatedAt,
        targetSessionDate: canonical.discovery.targetSessionDate,
        articleText: extracted.articleText
      };
      if (!hasExactKeys(articleContent, YAHOO_RECAP_ARTICLE_CONTENT_KEYS)
          || Buffer.byteLength(JSON.stringify(articleContent), 'utf8') > canonical.bounds.maxResultBytes) {
        return result(false, 'RESULT_TOO_LARGE', null, 'Yahoo recap article result exceeds configured bounds');
      }
      return result(true, 'SUCCESS', articleContent);
    }
  });
}

module.exports = {
  YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS,
  YAHOO_RECAP_ARTICLE_CONTENT_KEYS,
  createYahooRecapArticleContentAcquisitionService
};

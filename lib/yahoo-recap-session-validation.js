const {performance} = require('node:perf_hooks');

const YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS = Object.freeze([
  'timeoutMs',
  'maxResponseBytes',
  'maxHeadlineBytes'
]);
const YAHOO_RECAP_DISCOVERY_KEYS = Object.freeze([
  'title',
  'url',
  'discoveredVia',
  'targetSessionDate'
]);
const YAHOO_RECAP_VALIDATION_INPUT_KEYS = Object.freeze([
  'discovery',
  'targetSessionDate',
  'bounds'
]);
const YAHOO_RECAP_HOSTNAME = 'finance.yahoo.com';
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

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
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
  if (!hasExactKeys(bounds, YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS)) return null;
  const result = {};
  for (const key of YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) return null;
    result[key] = bounds[key];
  }
  return deepFreeze(result);
}

function canonicalInput(input) {
  if (!hasExactKeys(input, YAHOO_RECAP_VALIDATION_INPUT_KEYS)) return null;
  const {discovery} = input;
  const targetSessionDate = canonicalDate(input.targetSessionDate);
  const bounds = canonicalBounds(input.bounds);
  if (!Object.isFrozen(discovery) || !hasExactKeys(discovery, YAHOO_RECAP_DISCOVERY_KEYS)
      || typeof discovery.title !== 'string' || !discovery.title.trim()
      || discovery.discoveredVia !== YAHOO_RECAP_DISCOVERED_VIA
      || discovery.targetSessionDate !== targetSessionDate || !bounds) return null;
  const url = canonicalYahooRecapUrl(discovery.url);
  if (!url || url !== discovery.url) return null;
  return deepFreeze({discovery, targetSessionDate, bounds, url});
}

function result(ok, type, validation = null, message = null) {
  const value = {ok, type, validation};
  if (message !== null) value.message = message;
  return deepFreeze(value);
}

function elapsed(start, end) {
  const value = end - start;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function emitDiagnostics(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try {
    onDiagnostics(deepFreeze(value));
  } catch (error) {}
}

function responseContentType(response) {
  const value = response?.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type') : null;
  return typeof value === 'string' && /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(value.trim())
    ? 'HTML' : 'UNSUPPORTED';
}

async function readBoundedBody(response, signal, maxBytes) {
  const declared = response.headers && typeof response.headers.get === 'function'
    ? Number(response.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {tooLarge: true, html: null, bytes: 0};
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch (error) {}
        return {tooLarge: true, html: null, bytes};
      }
      chunks.push(Buffer.from(value));
    }
    return {tooLarge: false, html: Buffer.concat(chunks).toString('utf8'), bytes};
  }
  const html = await response.text();
  const bytes = Buffer.byteLength(html, 'utf8');
  return {tooLarge: bytes > maxBytes, html: bytes > maxBytes ? null : html, bytes};
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

function extractMetadata(html, expectedUrl, targetSessionDate, maxHeadlineBytes) {
  const canonical = canonicalLink(html);
  if (canonical !== null && canonicalYahooRecapUrl(canonical) !== expectedUrl) return null;
  const scripts = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) scripts.push(match[1]);
  const nodes = [];
  for (const script of scripts) {
    try { jsonLdNodes(JSON.parse(script.trim()), nodes); } catch (error) {}
  }
  for (const article of nodes.filter(isArticle)) {
    const datePublished = canonicalTimestamp(article.datePublished);
    if (!datePublished || newYorkDate(datePublished) !== targetSessionDate) continue;
    const dateModified = article.dateModified === undefined || article.dateModified === null
      ? null : canonicalTimestamp(article.dateModified);
    if (article.dateModified !== undefined && article.dateModified !== null && !dateModified) continue;
    const articleUrl = metadataUrl(article);
    if ((article.url !== undefined || article.mainEntityOfPage !== undefined)
        && articleUrl !== expectedUrl) continue;
    const headline = typeof article.headline === 'string' && article.headline.trim()
      && Buffer.byteLength(article.headline.trim(), 'utf8') <= maxHeadlineBytes
      ? article.headline.trim() : null;
    return {headline, datePublished, dateModified};
  }
  return null;
}

function createYahooRecapSessionValidationService({
  fetchImpl = global.fetch,
  onDiagnostics,
  monotonicNow = () => performance.now()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return deepFreeze({
    async validateYahooRecapSession(input) {
      const started = monotonicNow();
      const canonical = canonicalInput(input);
      if (!canonical) return result(false, 'INVALID_INPUT', null, 'Invalid Yahoo recap validation input');
      let fetchCount = 0;
      let responseBytes = 0;
      let httpStatus = null;
      let contentType = null;
      const finish = (outcomeType) => emitDiagnostics(onDiagnostics, {
        stage: 'yahooRecapSessionValidation',
        elapsedMs: elapsed(started, monotonicNow()),
        responseBytes,
        fetchCount,
        httpStatus,
        contentType,
        outcomeType
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), canonical.bounds.timeoutMs);
      let response;
      let body;
      try {
        try {
          fetchCount++;
          response = await fetchImpl(canonical.url, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              Accept: 'text/html, application/xhtml+xml;q=0.9',
              'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
            },
            signal: controller.signal
          });
        } catch (error) {
          const type = controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE';
          finish(type);
          return result(false, type, null, 'Yahoo recap page could not be retrieved');
        }
        httpStatus = Number.isInteger(response?.status) ? response.status : null;
        if (!response?.ok) {
          finish('HTTP_FAILURE');
          return result(false, 'HTTP_FAILURE', null, 'Yahoo recap page request was unsuccessful');
        }
        const responseUrl = response.url ? canonicalYahooRecapUrl(response.url) : canonical.url;
        if (!responseUrl || responseUrl !== canonical.url) {
          finish('INVALID_RESPONSE');
          return result(false, 'INVALID_RESPONSE', null, 'Yahoo recap response URL is invalid');
        }
        contentType = responseContentType(response);
        if (contentType !== 'HTML') {
          finish('INVALID_RESPONSE');
          return result(false, 'INVALID_RESPONSE', null, 'Yahoo recap response is not HTML');
        }
        try {
          body = await readBoundedBody(response, controller.signal, canonical.bounds.maxResponseBytes);
        } catch (error) {
          const type = controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE';
          finish(type);
          return result(false, type, null, 'Yahoo recap response body could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }
      responseBytes = body.bytes;
      if (body.tooLarge) {
        finish('RESPONSE_TOO_LARGE');
        return result(false, 'RESPONSE_TOO_LARGE', null, 'Yahoo recap response exceeds configured bounds');
      }
      const metadata = extractMetadata(
        body.html, canonical.url, canonical.targetSessionDate, canonical.bounds.maxHeadlineBytes
      );
      if (!metadata) {
        finish('NOT_VALIDATED');
        return result(true, 'NOT_VALIDATED');
      }
      const validation = deepFreeze({
        headline: metadata.headline,
        url: canonical.url,
        datePublished: metadata.datePublished,
        dateModified: metadata.dateModified,
        targetSessionDate: canonical.targetSessionDate
      });
      finish('VALIDATED');
      return result(true, 'VALIDATED', validation);
    }
  });
}

module.exports = {
  YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS,
  createYahooRecapSessionValidationService
};

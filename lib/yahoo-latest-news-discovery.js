const YAHOO_LATEST_NEWS_URL = 'https://sg.finance.yahoo.com/topic/latestnews/';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 30;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message, candidates: []});
}

function decode(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)));
}

function plainText(value) {
  return decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function bounded(value, bytes) {
  const text = plainText(value);
  return text && Buffer.byteLength(text, 'utf8') <= bytes ? text : null;
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match ? decode(match[2]) : null;
}

function canonicalArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(decode(value).trim());
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !['finance.yahoo.com', 'sg.finance.yahoo.com'].includes(url.hostname.toLowerCase())
        || !/^\/news\/[^/]+\.html\/?$/i.test(url.pathname)) return null;
    url.hostname = 'finance.yahoo.com';
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function parseAnalytics(section) {
  const tag = section.match(/<[^>]+\bdata-yga\s*=\s*(["'])[\s\S]*?\1/i)?.[0];
  if (!tag) return null;
  const raw = attribute(tag, 'data-yga');
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    return null;
  }
}

function extractCandidates(html) {
  const candidates = [];
  const seen = new Set();
  const sections = html.match(/<section\b[^>]*\bstory-item\b[^>]*>[\s\S]*?<\/section\s*>/gi) || [];
  for (const section of sections) {
    const analytics = parseAnalytics(section);
    if (!analytics || analytics.yContentType !== 'story' || analytics.yModuleName !== 'topic-stream') continue;
    const searchable = `${section} ${JSON.stringify(analytics)}`;
    if (/\b(?:sponsored|native[- ]?ad|advertisement|promoted)\b/i.test(searchable)) continue;
    const anchors = section.match(/<a\b[^>]*>/gi) || [];
    let url = null;
    for (const anchor of anchors) {
      url = canonicalArticleUrl(attribute(anchor, 'href'));
      if (url) break;
    }
    if (!url || seen.has(url)) continue;
    const headline = bounded(section.match(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i)?.[1], 512)
      || bounded(analytics.yLinkText, 512);
    if (!headline) continue;
    const uuid = typeof analytics.yDestinationContentUUID === 'string'
      && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(analytics.yDestinationContentUUID.trim())
      ? analytics.yDestinationContentUUID.trim().toLowerCase() : null;
    const publisher = bounded(analytics.yDestinationContentPartner || analytics.yContentPartner, 256);
    seen.add(url);
    candidates.push(deepFreeze({headline, url, uuid, publisher}));
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return deepFreeze(candidates);
}

async function responseText(response, maximum) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) return {tooLarge: true, text: ''};
  const text = await response.text();
  return Buffer.byteLength(text, 'utf8') > maximum ? {tooLarge: true, text: ''} : {tooLarge: false, text};
}

function createYahooLatestNewsDiscoveryService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('Invalid Yahoo Latest News discovery bounds');
  }
  return deepFreeze({
    async discoverLatestNews() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let body;
      try {
        try {
          response = await fetchImpl(YAHOO_LATEST_NEWS_URL, {
            headers: {'User-Agent': 'MarketBrief/1.0 active-session-acquisition', Accept: 'text/html'},
            signal: controller.signal
          });
        } catch (error) {
          return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE', 'Yahoo Latest News could not be retrieved');
        }
        if (!response?.ok) return failure('HTTP_FAILURE', 'Yahoo Latest News request was unsuccessful');
        const contentType = response.headers?.get?.('content-type');
        if (typeof contentType === 'string' && !/^text\/html(?:\s*;|$)/i.test(contentType.trim())) {
          return failure('INVALID_CONTENT_TYPE', 'Yahoo Latest News response is not HTML');
        }
        try { body = await responseText(response, maxResponseBytes); } catch (error) {
          return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RESPONSE_READ_FAILURE', 'Yahoo Latest News response could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }
      if (body.tooLarge) return failure('RESPONSE_TOO_LARGE', 'Yahoo Latest News response exceeds configured bounds');
      const candidates = extractCandidates(body.text);
      return deepFreeze({ok: true, type: candidates.length ? 'SUCCESS' : 'NOT_FOUND', candidates});
    }
  });
}

module.exports = {
  YAHOO_LATEST_NEWS_URL,
  YAHOO_LATEST_NEWS_DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  YAHOO_LATEST_NEWS_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  YAHOO_LATEST_NEWS_MAX_CANDIDATES: MAX_CANDIDATES,
  canonicalYahooCurrentNewsCandidateUrl: canonicalArticleUrl,
  createYahooLatestNewsDiscoveryService
};

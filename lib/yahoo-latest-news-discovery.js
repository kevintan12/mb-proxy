const YAHOO_LATEST_NEWS_URL = 'https://sg.finance.yahoo.com/topic/latestnews/';
const YAHOO_US_MARKET_NEWS_URL = 'https://finance.yahoo.com/topic/stock-market-news/';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 30;
// Step 8K.3: the US page is ~1.3 MB, so it gets its own, larger bounds.
const US_DEFAULT_TIMEOUT_MS = 6000;
const US_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const US_MAX_CANDIDATES = 60;
const MERGED_MAX_CANDIDATES = 90;

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

// Step 8K.3: the US edition links articles under /<section>/articles/<slug>.html
// (Step 8K.5: and the singular /<section>/article/<slug>.html; /live/ stays out).
// Accepts exactly the path shapes the article fetcher accepts, on finance.yahoo.com only.
function canonicalUsArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(decode(value).trim());
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || url.hostname.toLowerCase() !== 'finance.yahoo.com'
        || !/^\/(?:news\/[^/]+|(?:[a-z0-9-]+\/){1,3}articles?\/[^/]+)\.html\/?$/i.test(url.pathname)) return null;
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

// `moduleName` restricts the Singapore page to its topic-stream module. The US
// parser passes null: it must not depend on module names (Step 8K.3).
function extractCandidatesWithCount(html, {
  moduleName = 'topic-stream', canonicalUrl = canonicalArticleUrl, maxCandidates = MAX_CANDIDATES
} = {}) {
  const candidates = [];
  const seen = new Set();
  const sections = html.match(/<section\b[^>]*\bstory-item\b[^>]*>[\s\S]*?<\/section\s*>/gi) || [];
  for (const section of sections) {
    const analytics = parseAnalytics(section);
    if (!analytics || analytics.yContentType !== 'story'
        || (moduleName !== null && analytics.yModuleName !== moduleName)) continue;
    const searchable = `${section} ${JSON.stringify(analytics)}`;
    if (/\b(?:sponsored|native[- ]?ad|advertisement|promoted)\b/i.test(searchable)) continue;
    const anchors = section.match(/<a\b[^>]*>/gi) || [];
    let url = null;
    for (const anchor of anchors) {
      url = canonicalUrl(attribute(anchor, 'href'));
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
    // Step 8K.5: the page's relative label ("58m ago"), kept verbatim as an age hint
    // only; absent when the page has none.
    const ageLabel = bounded(section.match(/<span\b[^>]*\bpublished-date\b[^>]*>([\s\S]*?)<\/span\s*>/i)?.[1], 32);
    candidates.push(deepFreeze(ageLabel ? {headline, url, uuid, publisher, ageLabel}
      : {headline, url, uuid, publisher}));
    if (candidates.length === maxCandidates) break;
  }
  return {candidates: deepFreeze(candidates), sectionCount: sections.length};
}

async function responseText(response, maximum) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) return {tooLarge: true, text: ''};
  const text = await response.text();
  return Buffer.byteLength(text, 'utf8') > maximum ? {tooLarge: true, text: ''} : {tooLarge: false, text};
}

function validBounds(timeoutMs, maxResponseBytes) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('Invalid Yahoo Latest News discovery bounds');
  }
}

// One bounded GET of an HTML page. Returns {failure} or {text}; never throws.
async function fetchPageText({fetchImpl, url, timeoutMs, maxResponseBytes, label}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body;
  try {
    try {
      response = await fetchImpl(url, {
        headers: {'User-Agent': 'MarketBrief/1.0 active-session-acquisition', Accept: 'text/html'},
        signal: controller.signal
      });
    } catch (error) {
      return {failure: failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE', `${label} could not be retrieved`)};
    }
    if (!response?.ok) return {failure: failure('HTTP_FAILURE', `${label} request was unsuccessful`)};
    const contentType = response.headers?.get?.('content-type');
    if (typeof contentType === 'string' && !/^text\/html(?:\s*;|$)/i.test(contentType.trim())) {
      return {failure: failure('INVALID_CONTENT_TYPE', `${label} response is not HTML`)};
    }
    try { body = await responseText(response, maxResponseBytes); } catch (error) {
      return {failure: failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RESPONSE_READ_FAILURE', `${label} response could not be read`)};
    }
  } finally {
    clearTimeout(timeout);
  }
  if (body.tooLarge) return {failure: failure('RESPONSE_TOO_LARGE', `${label} response exceeds configured bounds`)};
  return {text: body.text};
}

function createYahooLatestNewsDiscoveryService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  validBounds(timeoutMs, maxResponseBytes);
  return deepFreeze({
    async discoverLatestNews() {
      const page = await fetchPageText({
        fetchImpl, url: YAHOO_LATEST_NEWS_URL, timeoutMs, maxResponseBytes, label: 'Yahoo Latest News'
      });
      if (page.failure) return page.failure;
      const {candidates} = extractCandidatesWithCount(page.text);
      return deepFreeze({ok: true, type: candidates.length ? 'SUCCESS' : 'NOT_FOUND', candidates});
    }
  });
}

// Step 8K.3: US stock-market-news page. Module-agnostic: any story-type section
// whose link passes the article fetcher's path shapes is a candidate.
function createYahooUsMarketNewsDiscoveryService({
  fetchImpl = global.fetch,
  timeoutMs = US_DEFAULT_TIMEOUT_MS,
  maxResponseBytes = US_MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  validBounds(timeoutMs, maxResponseBytes);
  return deepFreeze({
    async discoverUsMarketNews() {
      const page = await fetchPageText({
        fetchImpl, url: YAHOO_US_MARKET_NEWS_URL, timeoutMs, maxResponseBytes, label: 'Yahoo US Market News'
      });
      if (page.failure) return deepFreeze({...page.failure, sectionCount: 0});
      const {candidates, sectionCount} = extractCandidatesWithCount(page.text, {
        moduleName: null, canonicalUrl: canonicalUsArticleUrl, maxCandidates: US_MAX_CANDIDATES
      });
      // A 200 page with no accepted story means the page shape changed.
      return deepFreeze({
        ok: candidates.length > 0,
        type: candidates.length ? 'SUCCESS' : 'SHAPE_CHANGED',
        candidates, sectionCount
      });
    }
  });
}

function normalizedHeadline(headline) {
  return String(headline || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function trailingNumericId(url) {
  return /-(\d{6,})\.html\/?$/i.exec(url)?.[1] || null;
}

function candidateKeys(candidate) {
  const headline = normalizedHeadline(candidate.headline);
  const numericId = trailingNumericId(candidate.url);
  return [
    `url:${candidate.url}`,
    candidate.uuid ? `uuid:${candidate.uuid}` : null,
    numericId ? `id:${numericId}` : null,
    headline.length >= 12 ? `headline:${headline}` : null
  ].filter(Boolean);
}

// Step 8K.3: fetches both editions in parallel and merges them, US first. A
// Singapore entry that matches a US entry (canonical URL, UUID, trailing numeric
// id or normalized headline) is dropped so the US entry is kept. If the US page
// fails or yields nothing, the result is the Singapore-only result.
function createYahooMultiEditionNewsDiscoveryService({
  fetchImpl = global.fetch,
  singaporeService = createYahooLatestNewsDiscoveryService({fetchImpl}),
  usService = createYahooUsMarketNewsDiscoveryService({fetchImpl}),
  maxMergedCandidates = MERGED_MAX_CANDIDATES
} = {}) {
  if (!Number.isSafeInteger(maxMergedCandidates) || maxMergedCandidates <= 0) {
    throw new TypeError('Invalid Yahoo news discovery merged cap');
  }
  return deepFreeze({
    async discoverLatestNews() {
      const [sgSettled, usSettled] = await Promise.allSettled([
        singaporeService.discoverLatestNews(),
        usService.discoverUsMarketNews()
      ]);
      const sg = sgSettled.status === 'fulfilled' && sgSettled.value
        ? sgSettled.value : failure('RETRIEVAL_FAILURE', 'Yahoo Latest News could not be retrieved');
      const us = usSettled.status === 'fulfilled' && usSettled.value
        ? usSettled.value : {ok: false, type: 'RETRIEVAL_FAILURE', candidates: [], sectionCount: 0};
      const usCandidates = us.ok === true && Array.isArray(us.candidates) ? us.candidates : [];
      const sgCandidates = sg.ok === true && Array.isArray(sg.candidates) ? sg.candidates : [];
      const meta = {
        usOutcome: usCandidates.length ? 'SUCCESS' : String(us.type || 'RETRIEVAL_FAILURE'),
        usSectionCount: Number.isSafeInteger(us.sectionCount) ? us.sectionCount : 0,
        usCandidateCount: usCandidates.length,
        singaporeCandidateCount: sgCandidates.length,
        crossEditionDuplicateCount: 0
      };
      if (usCandidates.length === 0) {
        return deepFreeze({
          ok: sg.ok === true, type: sg.type, ...meta,
          candidates: sgCandidates.map(candidate => ({...candidate, edition: 'SG'}))
        });
      }
      const usKeys = new Set(usCandidates.flatMap(candidateKeys));
      const merged = usCandidates.map(candidate => ({...candidate, edition: 'US'}));
      for (const candidate of sgCandidates) {
        if (candidateKeys(candidate).some(key => usKeys.has(key))) {
          meta.crossEditionDuplicateCount++;
        } else {
          merged.push({...candidate, edition: 'SG'});
        }
      }
      return deepFreeze({
        ok: true, type: 'SUCCESS', ...meta, candidates: merged.slice(0, maxMergedCandidates)
      });
    }
  });
}

module.exports = {
  YAHOO_LATEST_NEWS_URL,
  YAHOO_US_MARKET_NEWS_URL,
  YAHOO_LATEST_NEWS_DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  YAHOO_LATEST_NEWS_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  YAHOO_LATEST_NEWS_MAX_CANDIDATES: MAX_CANDIDATES,
  YAHOO_US_MARKET_NEWS_DEFAULT_TIMEOUT_MS: US_DEFAULT_TIMEOUT_MS,
  YAHOO_US_MARKET_NEWS_MAX_RESPONSE_BYTES: US_MAX_RESPONSE_BYTES,
  YAHOO_US_MARKET_NEWS_MAX_CANDIDATES: US_MAX_CANDIDATES,
  YAHOO_MERGED_NEWS_MAX_CANDIDATES: MERGED_MAX_CANDIDATES,
  canonicalYahooCurrentNewsCandidateUrl: canonicalArticleUrl,
  createYahooLatestNewsDiscoveryService,
  createYahooUsMarketNewsDiscoveryService,
  createYahooMultiEditionNewsDiscoveryService
};

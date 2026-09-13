const {performance} = require('node:perf_hooks');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 768;
const MAX_USES = 1;
const MAX_RESULTS_INSPECTED = 10;
const MAX_DISCOVERIES = 5;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TITLE_BYTES = 512;
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ALLOWED_DOMAIN = 'cnbc.com';
const DISCOVERED_VIA = 'ANTHROPIC_WEB_SEARCH';
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATED_ARTICLE_PATH = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.html$/;
const RECAP_SLUG = 'stock-market-today-live-updates.html';
const UNSUPPORTED_SLUG = /^stocks-making-the-biggest-moves-(?:midday|premarket|after-hours)-/;
const MONTHS = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]);
const SYSTEM_PROMPT = [
  'Use the supplied web search tool only to locate materially relevant CNBC reporting about the supplied completed US trading session.',
  'Prioritize broad-market leadership and laggards, sectors, notable movers, market breadth or rotation, and major session-specific company developments.',
  'Use only cnbc.com results. Do not invent URLs, retrieve article bodies, provide market analysis, or treat search snippets as evidence.'
].join(' ');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? value : null;
}

function canonicalCnbcMarketNewsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const slug = url.pathname.split('/').pop();
    if (url.protocol !== 'https:'
        || !(hostname === ALLOWED_DOMAIN || hostname.endsWith(`.${ALLOWED_DOMAIN}`))
        || url.username || url.password || (url.port && url.port !== '443')
        || !DATED_ARTICLE_PATH.test(url.pathname)
        || slug === RECAP_SLUG || UNSUPPORTED_SLUG.test(slug)) return null;
    url.hostname = hostname;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function buildClaudeBoundedCnbcMarketNewsDiscoveryRequest({targetSessionDate} = {}) {
  const canonical = canonicalDate(targetSessionDate);
  if (!canonical || Reflect.ownKeys(arguments[0] || {}).length !== 1) {
    throw new TypeError('Invalid CNBC market-news discovery context');
  }
  const [year, month, day] = canonical.split('-').map(Number);
  return deepFreeze({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{role: 'user', content: `CNBC US stock market sectors leadership laggards notable movers ${MONTHS[month - 1]} ${day} ${year}`}],
    tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: MAX_USES, allowed_domains: [ALLOWED_DOMAIN]}]
  });
}

function searchResults(envelope) {
  if (!envelope || !Array.isArray(envelope.content)) return {valid: false, error: false, results: []};
  let valid = false;
  let error = false;
  const results = [];
  for (const block of envelope.content) {
    if (!block || block.type !== 'web_search_tool_result') continue;
    valid = true;
    for (const item of (Array.isArray(block.content) ? block.content : [block.content])) {
      if (item?.type === 'web_search_tool_result_error') error = true;
      else if (item?.type === 'web_search_result') results.push(item);
    }
  }
  return {valid, error, results};
}

function discoveries(results, targetSessionDate) {
  const seen = new Set();
  const output = [];
  for (const [index, result] of results.slice(0, MAX_RESULTS_INSPECTED).entries()) {
    const url = canonicalCnbcMarketNewsUrl(result?.url);
    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!url || !title || Buffer.byteLength(title, 'utf8') > MAX_TITLE_BYTES || seen.has(url)) continue;
    seen.add(url);
    output.push(deepFreeze({rank: index + 1, title, url, discoveredVia: DISCOVERED_VIA, targetSessionDate}));
    if (output.length === MAX_DISCOVERIES) break;
  }
  return deepFreeze(output);
}

function emit(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(deepFreeze(value)); } catch (error) { /* diagnostics cannot alter discovery */ }
}

function failure(type, message, upstreamStatus = null) {
  return deepFreeze({ok: false, type, message, upstreamStatus});
}

function createClaudeBoundedCnbcMarketNewsDiscoveryService({apiKey, fetchImpl = global.fetch, onDiagnostics, monotonicNow = () => performance.now()} = {}) {
  return Object.freeze({
    async discoverCnbcMarketNews(input) {
      let request;
      try { request = buildClaudeBoundedCnbcMarketNewsDiscoveryRequest(input); } catch (error) {
        return failure('INPUT_FAILURE', 'Invalid CNBC market-news discovery request');
      }
      const body = JSON.stringify(request);
      const completeRequestBodyBytes = Buffer.byteLength(body, 'utf8');
      if (completeRequestBodyBytes > MAX_REQUEST_BYTES) {
        emit(onDiagnostics, {stage: 'cnbcMarketNewsDiscovery', model: MODEL, completeRequestBodyBytes, limitBytes: MAX_REQUEST_BYTES, providerInvocationSkipped: true, fetchCount: 0});
        return failure('REQUEST_TOO_LARGE', 'Claude bounded CNBC market-news discovery request exceeds provisional size limit');
      }
      if (typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') {
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery transport unavailable');
      }
      const started = monotonicNow();
      let upstream;
      try {
        upstream = await fetchImpl(MESSAGES_URL, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}, body});
      } catch (error) {
        emit(onDiagnostics, {stage: 'cnbcMarketNewsDiscovery', model: MODEL, completeRequestBodyBytes, elapsedMs: Math.max(0, monotonicNow() - started), fetchCount: 1});
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery network request failed');
      }
      if (!upstream?.ok) return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery upstream request failed', Number.isInteger(upstream?.status) ? upstream.status : null);
      let envelope;
      try { envelope = await upstream.json(); } catch (error) {
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery response could not be read', upstream.status ?? null);
      }
      const parsed = searchResults(envelope);
      if (!parsed.valid) return failure('CONTRACT_FAILURE', 'Claude bounded CNBC market-news discovery returned no search result block', upstream.status ?? null);
      if (parsed.error) return failure('SEARCH_TOOL_FAILURE', 'Claude web search tool failed', upstream.status ?? null);
      const output = discoveries(parsed.results, input.targetSessionDate);
      emit(onDiagnostics, {
        stage: 'cnbcMarketNewsDiscovery', model: MODEL,
        resultCount: parsed.results.length,
        inspectedResultCount: Math.min(parsed.results.length, MAX_RESULTS_INSPECTED),
        retainedResultCount: output.length,
        elapsedMs: Math.max(0, monotonicNow() - started),
        searchRequestCount: typeof envelope?.usage?.server_tool_use?.web_search_requests === 'number'
          ? envelope.usage.server_tool_use.web_search_requests : null,
        fetchCount: 1
      });
      return deepFreeze({ok: true, type: output.length ? 'SUCCESS' : 'NOT_FOUND', discoveries: output});
    }
  });
}

module.exports = {
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MODEL: MODEL,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES: MAX_USES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED: MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES: MAX_DISCOVERIES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
  CNBC_MARKET_NEWS_DISCOVERY_SYSTEM_PROMPT: SYSTEM_PROMPT,
  canonicalCnbcMarketNewsUrl,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequest,
  createClaudeBoundedCnbcMarketNewsDiscoveryService
};

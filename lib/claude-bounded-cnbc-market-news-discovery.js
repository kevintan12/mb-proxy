const {performance} = require('node:perf_hooks');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 768;
const MAX_USES = 1;
const MAX_SEARCH_INVOCATIONS = 2;
const MAX_RESULTS_INSPECTED_PER_SEARCH = 10;
const MAX_RESULTS_INSPECTED = MAX_SEARCH_INVOCATIONS * MAX_RESULTS_INSPECTED_PER_SEARCH;
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
const SEARCH_INTENTS = Object.freeze([
  'CNBC US stock market completed session leadership laggards sectors breadth rotation',
  'CNBC US stocks notable movers company developments earnings major announcements'
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

function validatedCnbcMarketNewsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {url: null, rejectionReason: 'INVALID_URL'};
  }
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const slug = url.pathname.split('/').pop();
    if (url.protocol !== 'https:'
        || !(hostname === ALLOWED_DOMAIN || hostname.endsWith(`.${ALLOWED_DOMAIN}`))
        || url.username || url.password || (url.port && url.port !== '443')) {
      return {url: null, rejectionReason: 'INVALID_URL'};
    }
    if (!DATED_ARTICLE_PATH.test(url.pathname)
        || slug === RECAP_SLUG || UNSUPPORTED_SLUG.test(slug)) {
      return {url: null, rejectionReason: 'PATH_MISMATCH'};
    }
    url.hostname = hostname;
    url.port = '';
    url.search = '';
    url.hash = '';
    return {url: url.href, rejectionReason: null};
  } catch (error) {
    return {url: null, rejectionReason: 'INVALID_URL'};
  }
}

function canonicalCnbcMarketNewsUrl(value) {
  return validatedCnbcMarketNewsUrl(value).url;
}

function buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate} = {}) {
  const canonical = canonicalDate(targetSessionDate);
  if (!canonical || Reflect.ownKeys(arguments[0] || {}).length !== 1) {
    throw new TypeError('Invalid CNBC market-news discovery context');
  }
  const [year, month, day] = canonical.split('-').map(Number);
  const date = `${MONTHS[month - 1]} ${day} ${year}`;
  return deepFreeze(SEARCH_INTENTS.map(intent => ({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{role: 'user', content: `${intent} ${date}`}],
    tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: MAX_USES, allowed_domains: [ALLOWED_DOMAIN]}]
  })));
}

function buildClaudeBoundedCnbcMarketNewsDiscoveryRequest(input) {
  return buildClaudeBoundedCnbcMarketNewsDiscoveryRequests(input)[0];
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

function discoveries(resultSets, targetSessionDate) {
  const seen = new Set();
  const eligibleBySearch = resultSets.map(() => []);
  const rejectionCounts = {
    INVALID_URL: 0,
    PATH_MISMATCH: 0,
    INVALID_TITLE: 0,
    DUPLICATE: 0,
    RETAINED_LIMIT: 0
  };
  for (const [searchIndex, results] of resultSets.entries()) {
    for (const [resultIndex, result] of results.entries()) {
      const validatedUrl = validatedCnbcMarketNewsUrl(result?.url);
      const title = typeof result?.title === 'string' ? result.title.trim() : '';
      if (!validatedUrl.url) {
        rejectionCounts[validatedUrl.rejectionReason]++;
        continue;
      }
      if (!title || Buffer.byteLength(title, 'utf8') > MAX_TITLE_BYTES) {
        rejectionCounts.INVALID_TITLE++;
        continue;
      }
      if (seen.has(validatedUrl.url)) {
        rejectionCounts.DUPLICATE++;
        continue;
      }
      seen.add(validatedUrl.url);
      eligibleBySearch[searchIndex].push(deepFreeze({
        rank: searchIndex * MAX_RESULTS_INSPECTED_PER_SEARCH + resultIndex + 1,
        title,
        url: validatedUrl.url,
        discoveredVia: DISCOVERED_VIA,
        targetSessionDate
      }));
    }
  }
  const output = [];
  const minimumPerSearch = Math.floor(MAX_DISCOVERIES / resultSets.length);
  const firstSearchAllowance = minimumPerSearch + (MAX_DISCOVERIES % resultSets.length);
  for (const [searchIndex, eligible] of eligibleBySearch.entries()) {
    const allowance = searchIndex === 0 ? firstSearchAllowance : minimumPerSearch;
    output.push(...eligible.slice(0, allowance));
  }
  for (const eligible of eligibleBySearch) {
    for (const candidate of eligible) {
      if (output.length === MAX_DISCOVERIES) break;
      if (!output.includes(candidate)) output.push(candidate);
    }
  }
  rejectionCounts.RETAINED_LIMIT = eligibleBySearch.reduce((sum, eligible) => sum + eligible.length, 0)
    - output.length;
  return deepFreeze({output, rejectionCounts});
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
      let requests;
      try { requests = buildClaudeBoundedCnbcMarketNewsDiscoveryRequests(input); } catch (error) {
        return failure('INPUT_FAILURE', 'Invalid CNBC market-news discovery request');
      }
      const bodies = requests.map(request => JSON.stringify(request));
      const requestBytes = bodies.map(body => Buffer.byteLength(body, 'utf8'));
      const completeRequestBodyBytes = requestBytes.reduce((sum, value) => sum + value, 0);
      if (requestBytes.some(value => value > MAX_REQUEST_BYTES)) {
        emit(onDiagnostics, {stage: 'cnbcMarketNewsDiscovery', model: MODEL, searchInvocationCount: 0, completeRequestBodyBytes, perRequestLimitBytes: MAX_REQUEST_BYTES, providerInvocationSkipped: true, fetchCount: 0});
        return failure('REQUEST_TOO_LARGE', 'Claude bounded CNBC market-news discovery request exceeds provisional size limit');
      }
      if (typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') {
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery transport unavailable');
      }
      const started = monotonicNow();
      let fetchCount = 0;
      let searchRequestCount = 0;
      let hasSearchRequestCount = false;
      let completedSearchCount = 0;
      const inspectedResultSets = bodies.map(() => []);
      let firstFailure = null;
      let rawResultCount = 0;
      for (const [searchIndex, body] of bodies.entries()) {
        fetchCount++;
        let upstream;
        try {
          upstream = await fetchImpl(MESSAGES_URL, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}, body});
        } catch (error) {
          firstFailure ||= failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery network request failed');
          continue;
        }
        if (!upstream?.ok) {
          firstFailure ||= failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery upstream request failed', Number.isInteger(upstream?.status) ? upstream.status : null);
          continue;
        }
        let envelope;
        try { envelope = await upstream.json(); } catch (error) {
          firstFailure ||= failure('UPSTREAM_FAILURE', 'Claude bounded CNBC market-news discovery response could not be read', upstream.status ?? null);
          continue;
        }
        const parsed = searchResults(envelope);
        if (!parsed.valid) {
          firstFailure ||= failure('CONTRACT_FAILURE', 'Claude bounded CNBC market-news discovery returned no search result block', upstream.status ?? null);
          continue;
        }
        if (parsed.error) {
          firstFailure ||= failure('SEARCH_TOOL_FAILURE', 'Claude web search tool failed', upstream.status ?? null);
          continue;
        }
        completedSearchCount++;
        rawResultCount += parsed.results.length;
        inspectedResultSets[searchIndex] = parsed.results.slice(0, MAX_RESULTS_INSPECTED_PER_SEARCH);
        if (typeof envelope?.usage?.server_tool_use?.web_search_requests === 'number') {
          hasSearchRequestCount = true;
          searchRequestCount += envelope.usage.server_tool_use.web_search_requests;
        }
      }
      const inspectedResultCount = inspectedResultSets.reduce((sum, results) => sum + results.length, 0);
      const selected = discoveries(inspectedResultSets, input.targetSessionDate);
      const outcome = selected.output.length ? (firstFailure ? 'PARTIAL_SUCCESS' : 'SUCCESS')
        : rawResultCount === 0 && !firstFailure ? 'ZERO_RESULTS'
          : inspectedResultCount > 0 && !firstFailure ? 'ALL_RESULTS_REJECTED'
            : firstFailure ? 'SEARCH_FAILURE' : 'NOT_FOUND';
      emit(onDiagnostics, {
        stage: 'cnbcMarketNewsDiscovery', model: MODEL,
        outcome,
        configuredSearchInvocationCount: MAX_SEARCH_INVOCATIONS,
        searchInvocationCount: fetchCount,
        completedSearchCount,
        failedSearchCount: fetchCount - completedSearchCount,
        resultCount: rawResultCount,
        inspectedResultCount,
        retainedResultCount: selected.output.length,
        retainedResults: selected.output.map(item => Object.freeze({
          rank: item.rank,
          searchIndex: Math.floor((item.rank - 1) / MAX_RESULTS_INSPECTED_PER_SEARCH) + 1,
          path: new URL(item.url).pathname,
          outcome: 'RETAINED'
        })),
        rejectionCounts: selected.rejectionCounts,
        elapsedMs: Math.max(0, monotonicNow() - started),
        searchRequestCount: hasSearchRequestCount ? searchRequestCount : null,
        fetchCount
      });
      if (!selected.output.length && firstFailure) return firstFailure;
      return deepFreeze({
        ok: true,
        type: selected.output.length ? 'SUCCESS' : 'NOT_FOUND',
        discoveries: selected.output
      });
    }
  });
}

module.exports = {
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MODEL: MODEL,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES: MAX_USES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_SEARCH_INVOCATIONS: MAX_SEARCH_INVOCATIONS,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED_PER_SEARCH: MAX_RESULTS_INSPECTED_PER_SEARCH,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED: MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES: MAX_DISCOVERIES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
  CNBC_MARKET_NEWS_DISCOVERY_SYSTEM_PROMPT: SYSTEM_PROMPT,
  canonicalCnbcMarketNewsUrl,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequest,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequests,
  createClaudeBoundedCnbcMarketNewsDiscoveryService
};

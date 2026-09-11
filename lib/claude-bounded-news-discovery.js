const {performance} = require('node:perf_hooks');

const CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_TOKENS = 512;
const CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_USES = 1;
const CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED = 10;
// TO VALIDATE: this fixed metadata-only request is normally well below 2 KiB.
const CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES = 16 * 1024;
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const YAHOO_FINANCE_ALLOWED_DOMAIN = 'finance.yahoo.com';
const DISCOVERED_VIA = 'ANTHROPIC_WEB_SEARCH';
const SYSTEM_PROMPT = [
  'Use the supplied web search tool only to locate one Yahoo Finance-authored daily US stock-market recap.',
  'Use only search results from finance.yahoo.com and do not invent or construct a URL.',
  'The desired result must be a Stock market today recap for the supplied completed US trading-session date.',
  'Do not retrieve article bodies and do not provide market analysis.'
].join(' ');
const RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'NOT_FOUND',
  'INPUT_FAILURE',
  'REQUEST_TOO_LARGE',
  'UPSTREAM_FAILURE',
  'SEARCH_TOOL_FAILURE',
  'CONTRACT_FAILURE'
]);
const CONTEXT_KEYS = Object.freeze(['targetSessionDate']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RECAP_PATH_PATTERN = /^\/(?:markets|news)\/live\/stock-market-today-[^/]+\/?$/;
const MAX_TITLE_BYTES = 512;

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

function canonicalSessionDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : null;
}

function canonicalContext(input) {
  if (!hasExactKeys(input, CONTEXT_KEYS)) throw new TypeError('Invalid Yahoo recap discovery context');
  const targetSessionDate = canonicalSessionDate(input.targetSessionDate);
  if (!targetSessionDate) throw new TypeError('Invalid Yahoo recap target session date');
  return deepFreeze({targetSessionDate});
}

function buildClaudeBoundedNewsDiscoveryRequest(context) {
  const canonical = canonicalContext(context);
  const searchIntent = `us stock market today yahoo finance ${canonical.targetSessionDate}`;
  return deepFreeze({
    model: CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL,
    max_tokens: CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Find the Yahoo Finance daily US market recap for completed trading session ${canonical.targetSessionDate}. Search intent: "${searchIntent}".`
    }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_USES,
      allowed_domains: [YAHOO_FINANCE_ALLOWED_DOMAIN]
    }]
  });
}

function assertRequestWithinLimit(serializedRequestBody) {
  if (typeof serializedRequestBody !== 'string') throw new TypeError('Serialized request body required');
  const completeRequestBodyBytes = Buffer.byteLength(serializedRequestBody, 'utf8');
  if (completeRequestBodyBytes > CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES) {
    const error = new RangeError('Claude bounded news discovery request exceeds provisional size limit');
    error.completeRequestBodyBytes = completeRequestBodyBytes;
    throw error;
  }
  return completeRequestBodyBytes;
}

function canonicalYahooRecapUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== YAHOO_FINANCE_ALLOWED_DOMAIN
        || url.username || url.password || (url.port && url.port !== '443')
        || !RECAP_PATH_PATTERN.test(url.pathname)) return null;
    url.protocol = 'https:';
    url.hostname = YAHOO_FINANCE_ALLOWED_DOMAIN;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function inspectYahooResultUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {url: null, path: null, rejectionReason: 'INVALID_URL'};
  }
  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== YAHOO_FINANCE_ALLOWED_DOMAIN) {
      return {url: null, path: null, rejectionReason: 'HOST_MISMATCH'};
    }
    if (url.protocol !== 'https:' || url.username || url.password
        || (url.port && url.port !== '443')) {
      return {url: null, path: null, rejectionReason: 'INVALID_URL'};
    }
    url.protocol = 'https:';
    url.hostname = YAHOO_FINANCE_ALLOWED_DOMAIN;
    url.port = '';
    url.search = '';
    url.hash = '';
    return {
      url: url.href,
      path: url.pathname,
      rejectionReason: RECAP_PATH_PATTERN.test(url.pathname) ? null : 'PATH_MISMATCH'
    };
  } catch (error) {
    return {url: null, path: null, rejectionReason: 'INVALID_URL'};
  }
}

function canonicalTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && Buffer.byteLength(title, 'utf8') <= MAX_TITLE_BYTES ? title : null;
}

function parseSearchToolResults(envelope) {
  if (!envelope || !Array.isArray(envelope.content)) {
    return {validEnvelope: false, toolError: false, results: []};
  }
  let sawToolResult = false;
  let toolError = false;
  const results = [];
  for (const block of envelope.content) {
    if (!block || block.type !== 'web_search_tool_result') continue;
    sawToolResult = true;
    const content = Array.isArray(block.content) ? block.content : [block.content];
    for (const item of content) {
      if (item && item.type === 'web_search_tool_result_error') {
        toolError = true;
      } else if (item && item.type === 'web_search_result') {
        results.push(item);
      }
    }
  }
  return {validEnvelope: sawToolResult, toolError, results};
}

function inspectDiscoveryResults(searchResults, targetSessionDate) {
  const seen = new Set();
  const inspected = searchResults.slice(0, CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED);
  let discovery = null;
  const results = inspected.map((result, index) => {
    const inspectedUrl = inspectYahooResultUrl(result?.url);
    const title = canonicalTitle(result.title);
    let rejectionReason = inspectedUrl.rejectionReason;
    if (!rejectionReason && !title) rejectionReason = 'INVALID_TITLE';
    if (!rejectionReason && seen.has(inspectedUrl.url)) rejectionReason = 'DUPLICATE';
    if (!rejectionReason) seen.add(inspectedUrl.url);
    if (!rejectionReason && discovery) rejectionReason = 'NOT_SELECTED';
    if (!rejectionReason) {
      discovery = deepFreeze({
        title,
        url: inspectedUrl.url,
        discoveredVia: DISCOVERED_VIA,
        targetSessionDate
      });
    }
    return deepFreeze({
      rank: index + 1,
      title,
      normalizedYahooUrl: inspectedUrl.url,
      path: inspectedUrl.path,
      outcome: rejectionReason ? 'REJECTED' : 'ACCEPTED',
      rejectionReason
    });
  });
  return deepFreeze({
    discovery,
    diagnostics: deepFreeze({
      stage: 'yahooRecapDiscoveryResults',
      resultCount: searchResults.length,
      inspectedResultCount: inspected.length,
      results: deepFreeze(results)
    })
  });
}

function sanitizedUsage(usage) {
  const result = {};
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    for (const [name, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[name] = value;
    }
  }
  return deepFreeze(result);
}

function sanitizedSearchRequestCount(usage) {
  const value = usage?.server_tool_use?.web_search_requests;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizedRequestId(upstream) {
  const value = upstream?.headers && typeof upstream.headers.get === 'function'
    ? upstream.headers.get('request-id')
    : null;
  if (typeof value !== 'string') return null;
  const canonical = value.trim();
  return canonical && canonical.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(canonical)
    ? canonical
    : null;
}

function elapsedMilliseconds(start, end) {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function emitDiagnostics(onDiagnostics, diagnostics) {
  if (typeof onDiagnostics !== 'function') return;
  try {
    onDiagnostics(deepFreeze(diagnostics));
  } catch (error) {
    // Observability must not alter discovery behavior.
  }
}

function failure(type, message, upstreamStatus = null) {
  return deepFreeze({ok: false, type, message, upstreamStatus});
}

function createClaudeBoundedNewsDiscoveryService({
  apiKey,
  fetchImpl = global.fetch,
  onDiagnostics,
  monotonicNow = () => performance.now()
} = {}) {
  return deepFreeze({
    async discoverYahooCompletedSessionRecap(context) {
      const invocationStarted = monotonicNow();
      let canonical;
      let request;
      try {
        canonical = canonicalContext(context);
        request = buildClaudeBoundedNewsDiscoveryRequest(canonical);
      } catch (error) {
        return failure('INPUT_FAILURE', 'Invalid Yahoo recap discovery request');
      }

      const serializedRequestBody = JSON.stringify(request);
      let completeRequestBodyBytes;
      try {
        completeRequestBodyBytes = assertRequestWithinLimit(serializedRequestBody);
      } catch (error) {
        emitDiagnostics(onDiagnostics, {
          model: CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL,
          completeRequestBodyBytes: error.completeRequestBodyBytes,
          limitBytes: CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES,
          providerInvocationSkipped: true,
          fetchCount: 0
        });
        return failure('REQUEST_TOO_LARGE', 'Claude bounded news discovery request exceeds provisional size limit');
      }
      if (typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') {
        return failure('UPSTREAM_FAILURE', 'Claude bounded news discovery transport unavailable');
      }

      const requestSize = deepFreeze({
        systemPromptBytes: Buffer.byteLength(request.system, 'utf8'),
        userPromptBytes: Buffer.byteLength(request.messages[0].content, 'utf8'),
        completeRequestBodyBytes
      });
      const timing = {
        anthropicFetchMs: 0,
        responseBodyReadParseMs: 0,
        marketBriefValidationMs: 0,
        invocationTotalMs: 0
      };
      let fetchCount = 0;
      function finishDiagnostics(requestId, usage) {
        timing.invocationTotalMs = elapsedMilliseconds(invocationStarted, monotonicNow());
        emitDiagnostics(onDiagnostics, {
          model: CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL,
          requestId,
          requestSize,
          timing: deepFreeze({...timing}),
          usage: sanitizedUsage(usage),
          searchRequestCount: sanitizedSearchRequestCount(usage),
          fetchCount
        });
      }

      let upstream;
      const fetchStarted = monotonicNow();
      try {
        fetchCount++;
        upstream = await fetchImpl(CLAUDE_MESSAGES_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: serializedRequestBody
        });
      } catch (error) {
        timing.anthropicFetchMs = elapsedMilliseconds(fetchStarted, monotonicNow());
        finishDiagnostics(null, null);
        return failure('UPSTREAM_FAILURE', 'Claude bounded news discovery network request failed');
      }
      timing.anthropicFetchMs = elapsedMilliseconds(fetchStarted, monotonicNow());
      const requestId = sanitizedRequestId(upstream);
      if (!upstream || !upstream.ok) {
        finishDiagnostics(requestId, null);
        return failure(
          'UPSTREAM_FAILURE',
          'Claude bounded news discovery upstream request failed',
          Number.isInteger(upstream?.status) ? upstream.status : null
        );
      }

      let envelope;
      const responseStarted = monotonicNow();
      try {
        envelope = await upstream.json();
      } catch (error) {
        timing.responseBodyReadParseMs = elapsedMilliseconds(responseStarted, monotonicNow());
        finishDiagnostics(requestId, null);
        return failure('UPSTREAM_FAILURE', 'Claude bounded news discovery response could not be read', upstream.status ?? null);
      }
      timing.responseBodyReadParseMs = elapsedMilliseconds(responseStarted, monotonicNow());

      const validationStarted = monotonicNow();
      const parsed = parseSearchToolResults(envelope);
      timing.marketBriefValidationMs = elapsedMilliseconds(validationStarted, monotonicNow());
      if (!parsed.validEnvelope) {
        finishDiagnostics(requestId, envelope?.usage);
        return failure('CONTRACT_FAILURE', 'Claude bounded news discovery returned no search result block', upstream.status ?? null);
      }
      if (parsed.toolError) {
        finishDiagnostics(requestId, envelope?.usage);
        return failure('SEARCH_TOOL_FAILURE', 'Claude web search tool failed', upstream.status ?? null);
      }

      const inspected = inspectDiscoveryResults(parsed.results, canonical.targetSessionDate);
      emitDiagnostics(onDiagnostics, inspected.diagnostics);
      const discovery = inspected.discovery;
      finishDiagnostics(requestId, envelope?.usage);
      return discovery
        ? deepFreeze({ok: true, type: 'SUCCESS', discovery})
        : deepFreeze({ok: true, type: 'NOT_FOUND', discovery: null});
    }
  });
}

module.exports = {
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_TOKENS,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_USES,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  YAHOO_FINANCE_ALLOWED_DOMAIN,
  SYSTEM_PROMPT,
  RESULT_TYPES,
  buildClaudeBoundedNewsDiscoveryRequest,
  assertRequestWithinLimit,
  createClaudeBoundedNewsDiscoveryService
};

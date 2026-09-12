const {performance} = require('node:perf_hooks');

const CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_TOKENS = 512;
const CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_USES = 1;
const CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_RESULTS_INSPECTED = 10;
const CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES = 16 * 1024;
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CNBC_ALLOWED_DOMAIN = 'cnbc.com';
const DISCOVERED_VIA = 'ANTHROPIC_WEB_SEARCH';
const SYSTEM_PROMPT = [
  'Use the supplied web search tool only to locate one CNBC daily US stock-market recap.',
  'Use only search results from cnbc.com and do not invent or construct a URL.',
  'The desired result must use the CNBC Stock Market Today live-updates URL family and concern the supplied completed US trading-session date.',
  'The URL date is not proof of the completed session date. Do not retrieve article bodies and do not provide market analysis.'
].join(' ');
const CONTEXT_KEYS = Object.freeze(['targetSessionDate']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RECAP_PATH_PATTERN = /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates\.html\/?$/;
const MAX_TITLE_BYTES = 512;
const ENGLISH_MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]);

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
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value : null;
}

function canonicalContext(input) {
  if (!hasExactKeys(input, CONTEXT_KEYS)) throw new TypeError('Invalid CNBC recap discovery context');
  const targetSessionDate = canonicalSessionDate(input.targetSessionDate);
  if (!targetSessionDate) throw new TypeError('Invalid CNBC recap target session date');
  return deepFreeze({targetSessionDate});
}

function buildClaudeBoundedCnbcRecapDiscoveryRequest(context) {
  const canonical = canonicalContext(context);
  const [year, month, day] = canonical.targetSessionDate.split('-').map(Number);
  return deepFreeze({
    model: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL,
    max_tokens: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{role: 'user', content: `CNBC stock market today ${ENGLISH_MONTH_NAMES[month - 1]} ${day} ${year}`}],
    tools: [{
      type: 'web_search_20250305', name: 'web_search',
      max_uses: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_USES,
      allowed_domains: [CNBC_ALLOWED_DOMAIN]
    }]
  });
}

function assertRequestWithinLimit(body) {
  if (typeof body !== 'string') throw new TypeError('Serialized request body required');
  const completeRequestBodyBytes = Buffer.byteLength(body, 'utf8');
  if (completeRequestBodyBytes > CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES) {
    const error = new RangeError('Claude bounded CNBC recap discovery request exceeds provisional size limit');
    error.completeRequestBodyBytes = completeRequestBodyBytes;
    throw error;
  }
  return completeRequestBodyBytes;
}

function isCnbcHost(hostname) {
  return hostname === CNBC_ALLOWED_DOMAIN || hostname.endsWith(`.${CNBC_ALLOWED_DOMAIN}`);
}

function canonicalCnbcRecapUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !isCnbcHost(hostname) || url.username || url.password
        || (url.port && url.port !== '443') || !RECAP_PATH_PATTERN.test(url.pathname)) return null;
    url.protocol = 'https:';
    url.hostname = hostname;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function canonicalTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && Buffer.byteLength(title, 'utf8') <= MAX_TITLE_BYTES ? title : null;
}

function parseSearchToolResults(envelope) {
  if (!envelope || !Array.isArray(envelope.content)) return {validEnvelope: false, toolError: false, results: []};
  let sawToolResult = false;
  let toolError = false;
  const results = [];
  for (const block of envelope.content) {
    if (!block || block.type !== 'web_search_tool_result') continue;
    sawToolResult = true;
    for (const item of (Array.isArray(block.content) ? block.content : [block.content])) {
      if (item && item.type === 'web_search_tool_result_error') toolError = true;
      else if (item && item.type === 'web_search_result') results.push(item);
    }
  }
  return {validEnvelope: sawToolResult, toolError, results};
}

function inspectDiscoveryResults(searchResults, targetSessionDate) {
  const seen = new Set();
  const candidates = [];
  for (const [index, result] of searchResults.slice(0, CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_RESULTS_INSPECTED).entries()) {
    const url = canonicalCnbcRecapUrl(result?.url);
    const title = canonicalTitle(result?.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    candidates.push(deepFreeze({rank: index + 1, discovery: deepFreeze({
      title, url, discoveredVia: DISCOVERED_VIA, targetSessionDate
    })}));
  }
  return deepFreeze(candidates);
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
  const value = upstream?.headers && typeof upstream.headers.get === 'function' ? upstream.headers.get('request-id') : null;
  if (typeof value !== 'string') return null;
  const canonical = value.trim();
  return canonical && canonical.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(canonical) ? canonical : null;
}

function emitDiagnostics(onDiagnostics, diagnostics) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(deepFreeze(diagnostics)); } catch (error) { /* diagnostics cannot alter discovery */ }
}

function failure(type, message, upstreamStatus = null) {
  return deepFreeze({ok: false, type, message, upstreamStatus});
}

function createClaudeBoundedCnbcRecapDiscoveryService({apiKey, fetchImpl = global.fetch, onDiagnostics, monotonicNow = () => performance.now()} = {}) {
  return deepFreeze({
    async discoverCnbcCompletedSessionRecap(context) {
      const started = monotonicNow();
      let request;
      let canonical;
      try { canonical = canonicalContext(context); request = buildClaudeBoundedCnbcRecapDiscoveryRequest(canonical); } catch (error) {
        return failure('INPUT_FAILURE', 'Invalid CNBC recap discovery request');
      }
      const serializedRequestBody = JSON.stringify(request);
      let completeRequestBodyBytes;
      try { completeRequestBodyBytes = assertRequestWithinLimit(serializedRequestBody); } catch (error) {
        emitDiagnostics(onDiagnostics, {model: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL, completeRequestBodyBytes: error.completeRequestBodyBytes, limitBytes: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES, providerInvocationSkipped: true, fetchCount: 0});
        return failure('REQUEST_TOO_LARGE', 'Claude bounded CNBC recap discovery request exceeds provisional size limit');
      }
      if (typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC recap discovery transport unavailable');
      const requestSize = deepFreeze({systemPromptBytes: Buffer.byteLength(request.system, 'utf8'), userPromptBytes: Buffer.byteLength(request.messages[0].content, 'utf8'), completeRequestBodyBytes});
      const timing = {anthropicFetchMs: 0, responseBodyReadParseMs: 0, marketBriefValidationMs: 0, invocationTotalMs: 0};
      let fetchCount = 0;
      const finish = (requestId, usage) => {
        timing.invocationTotalMs = Math.max(0, monotonicNow() - started);
        emitDiagnostics(onDiagnostics, {model: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL, requestId, requestSize, timing: deepFreeze({...timing}), usage: sanitizedUsage(usage), searchRequestCount: sanitizedSearchRequestCount(usage), fetchCount});
      };
      let upstream;
      const fetchStarted = monotonicNow();
      try {
        fetchCount++;
        upstream = await fetchImpl(CLAUDE_MESSAGES_URL, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}, body: serializedRequestBody});
      } catch (error) {
        timing.anthropicFetchMs = Math.max(0, monotonicNow() - fetchStarted); finish(null, null);
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC recap discovery network request failed');
      }
      timing.anthropicFetchMs = Math.max(0, monotonicNow() - fetchStarted);
      const requestId = sanitizedRequestId(upstream);
      if (!upstream || !upstream.ok) { finish(requestId, null); return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC recap discovery upstream request failed', Number.isInteger(upstream?.status) ? upstream.status : null); }
      let envelope;
      const parseStarted = monotonicNow();
      try { envelope = await upstream.json(); } catch (error) {
        timing.responseBodyReadParseMs = Math.max(0, monotonicNow() - parseStarted); finish(requestId, null);
        return failure('UPSTREAM_FAILURE', 'Claude bounded CNBC recap discovery response could not be read', upstream.status ?? null);
      }
      timing.responseBodyReadParseMs = Math.max(0, monotonicNow() - parseStarted);
      const validationStarted = monotonicNow();
      const parsed = parseSearchToolResults(envelope);
      timing.marketBriefValidationMs = Math.max(0, monotonicNow() - validationStarted);
      if (!parsed.validEnvelope) { finish(requestId, envelope?.usage); return failure('CONTRACT_FAILURE', 'Claude bounded CNBC recap discovery returned no search result block', upstream.status ?? null); }
      if (parsed.toolError) { finish(requestId, envelope?.usage); return failure('SEARCH_TOOL_FAILURE', 'Claude web search tool failed', upstream.status ?? null); }
      const candidates = inspectDiscoveryResults(parsed.results, canonical.targetSessionDate);
      finish(requestId, envelope?.usage);
      return deepFreeze({ok: true, type: candidates.length ? 'SUCCESS' : 'NOT_FOUND', candidates});
    }
  });
}

module.exports = {
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_USES,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  CNBC_ALLOWED_DOMAIN,
  SYSTEM_PROMPT,
  buildClaudeBoundedCnbcRecapDiscoveryRequest,
  assertRequestWithinLimit,
  createClaudeBoundedCnbcRecapDiscoveryService
};

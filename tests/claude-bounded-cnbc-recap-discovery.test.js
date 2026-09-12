const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_USES,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  SYSTEM_PROMPT,
  buildClaudeBoundedCnbcRecapDiscoveryRequest,
  assertRequestWithinLimit,
  createClaudeBoundedCnbcRecapDiscoveryService
} = require('../lib/claude-bounded-cnbc-recap-discovery');

const context = Object.freeze({targetSessionDate: '2026-09-09'});
const recapPath = '/2026/09/10/stock-market-today-live-updates.html';

function searchResult(url, title = 'Stock market today: Stocks close after the session') {
  return {type: 'web_search_result', url, title, encrypted_content: 'never returned'};
}

function response(results, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: name => name === 'request-id' ? 'req_cnbc_search_123' : null},
    async json() {
      return {
        content: [{type: 'web_search_tool_result', content: results}],
        usage: {input_tokens: 100, output_tokens: 20, server_tool_use: {web_search_requests: 1}}
      };
    },
    ...overrides
  };
}

function service(fetchImpl, options = {}) {
  return createClaudeBoundedCnbcRecapDiscoveryService({apiKey: 'secret', fetchImpl, ...options});
}

test('builds the fixed CNBC completed-session discovery profile', () => {
  const request = buildClaudeBoundedCnbcRecapDiscoveryRequest(context);
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.model, CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MODEL);
  assert.equal(request.system, SYSTEM_PROMPT);
  assert.equal(request.messages[0].content, 'CNBC stock market today September 9 2026');
  assert.deepEqual(request.tools, [{type: 'web_search_20250305', name: 'web_search', max_uses: 1, allowed_domains: ['cnbc.com']}]);
  assert.equal(CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_USES, 1);
  assert.equal(Object.isFrozen(request.tools[0].allowed_domains), true);
});

test('rejects non-canonical caller input and caller-owned search overrides before fetch', async () => {
  let calls = 0;
  const discovery = service(async () => { calls++; });
  for (const invalid of [
    {}, {targetSessionDate: '2026-02-30'},
    {targetSessionDate: '2026-09-09', model: 'caller'},
    {targetSessionDate: '2026-09-09', tools: []},
    {targetSessionDate: '2026-09-09', allowedDomains: ['example.com']},
    {targetSessionDate: '2026-09-09', maxUses: 9},
    {targetSessionDate: '2026-09-09', prompt: 'caller'},
    {targetSessionDate: '2026-09-09', url: 'https://www.cnbc.com/'}
  ]) assert.equal((await discovery.discoverCnbcCompletedSessionRecap(invalid)).type, 'INPUT_FAILURE');
  assert.equal(calls, 0);
});

test('accepts a canonical CNBC recap URL even when its path date differs from target session date', async () => {
  let calls = 0;
  const result = await service(async (url, options) => {
    calls++;
    assert.equal(url, CLAUDE_MESSAGES_URL);
    assert.equal(options.method, 'POST');
    return response([searchResult(`https://www.cnbc.com${recapPath}?tracking=1#fragment`)]);
  }).discoverCnbcCompletedSessionRecap(context);
  assert.equal(calls, 1);
  assert.deepEqual(result, {ok: true, type: 'SUCCESS', candidates: [{rank: 1, discovery: {
    title: 'Stock market today: Stocks close after the session',
    url: `https://www.cnbc.com${recapPath}`,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate: '2026-09-09'
  }}]});
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates[0].discovery), true);
});

test('rejects unrelated, unsafe, malformed, and lookalike URLs as optional absence', async () => {
  const urls = [
    'https://www.cnbc.com/2026/09/10/unrelated.html',
    'https://example.com/2026/09/10/stock-market-today-live-updates.html',
    'https://www.cnbc.com.evil.test/2026/09/10/stock-market-today-live-updates.html',
    'http://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html',
    'not a URL',
    'https://user@www.cnbc.com/2026/09/10/stock-market-today-live-updates.html',
    'https://www.cnbc.com:444/2026/09/10/stock-market-today-live-updates.html'
  ];
  const result = await service(async () => response(urls.map(searchResult))).discoverCnbcCompletedSessionRecap(context);
  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', candidates: []});
});

test('deduplicates canonical URLs and preserves first search-rank order deterministically', async () => {
  const first = `https://www.cnbc.com${recapPath}`;
  const second = 'https://www.cnbc.com/2026/09/11/stock-market-today-live-updates.html';
  const result = await service(async () => response([
    searchResult(`${first}?one=1`, 'First'), searchResult(`${first}#two`, 'Duplicate'), searchResult(second, 'Second')
  ])).discoverCnbcCompletedSessionRecap(context);
  assert.deepEqual(result.candidates.map(item => [item.rank, item.discovery.url]), [[1, first], [3, second]]);
});

test('applies the fixed result ceiling before candidate selection', async () => {
  const results = Array.from({length: CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_MAX_RESULTS_INSPECTED}, (_, index) =>
    searchResult(`https://www.cnbc.com/2026/09/10/other-${index}.html`));
  results.push(searchResult(`https://www.cnbc.com${recapPath}`));
  const result = await service(async () => response(results)).discoverCnbcCompletedSessionRecap(context);
  assert.equal(result.type, 'NOT_FOUND');
});

test('handles search tool failures and malformed tool envelopes without treating either as discovery', async () => {
  const toolFailure = await service(async () => response({type: 'web_search_tool_result_error'}))
    .discoverCnbcCompletedSessionRecap(context);
  assert.equal(toolFailure.type, 'SEARCH_TOOL_FAILURE');
  const malformed = await service(async () => response([], {async json() { return {content: [{type: 'text'}]}; }}))
    .discoverCnbcCompletedSessionRecap(context);
  assert.equal(malformed.type, 'CONTRACT_FAILURE');
});

test('uses exactly one Anthropic fetch with no retry on network and upstream failures', async () => {
  for (const failingFetch of [async () => { throw new Error('private'); }, async () => ({ok: false, status: 429, headers: {get: () => null}})]) {
    let calls = 0;
    const result = await service(async (...args) => { calls++; return failingFetch(...args); })
      .discoverCnbcCompletedSessionRecap(context);
    assert.equal(result.type, 'UPSTREAM_FAILURE');
    assert.equal(calls, 1);
  }
});

test('enforces the fixed UTF-8 request bound before provider work', () => {
  assert.equal(CLAUDE_BOUNDED_CNBC_RECAP_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES, 16 * 1024);
  assert.equal(assertRequestWithinLimit('x'.repeat(16 * 1024)), 16 * 1024);
  assert.throws(() => assertRequestWithinLimit('x'.repeat((16 * 1024) + 1)), /exceeds provisional size limit/);
});

test('emits only safe invocation diagnostics and has no article/package side effects', async () => {
  const diagnostics = [];
  const result = await service(async () => response([searchResult(`https://www.cnbc.com${recapPath}`)]), {
    onDiagnostics: event => diagnostics.push(event)
  }).discoverCnbcCompletedSessionRecap(context);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]), ['model', 'requestId', 'requestSize', 'timing', 'usage', 'searchRequestCount', 'fetchCount']);
  const serialized = JSON.stringify(diagnostics[0]);
  for (const forbidden of ['secret', 'stock-market-today', 'cnbc.com', 'encrypted_content', '2026-09-09']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(result.candidates[0].discovery.articleText, undefined);
  assert.equal(result.candidates[0].discovery.evidenceRef, undefined);
});

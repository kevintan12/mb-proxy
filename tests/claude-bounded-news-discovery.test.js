const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_USES,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  SYSTEM_PROMPT,
  buildClaudeBoundedNewsDiscoveryRequest,
  assertRequestWithinLimit,
  createClaudeBoundedNewsDiscoveryService
} = require('../lib/claude-bounded-news-discovery');

const context = Object.freeze({targetSessionDate: '2026-09-09'});

function searchResult(url, title = 'Stock market today: US stocks close after the session') {
  return {type: 'web_search_result', url, title, encrypted_content: 'not returned by MarketBrief'};
}

function response(results, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: name => name === 'request-id' ? 'req_search_123' : null},
    async json() {
      return {
        content: [{
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: results
        }, {type: 'text', text: 'Search completed.'}],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          server_tool_use: {web_search_requests: 1},
          service_tier: 'standard'
        }
      };
    },
    ...overrides
  };
}

function service(fetchImpl, options = {}) {
  return createClaudeBoundedNewsDiscoveryService({apiKey: 'secret', fetchImpl, ...options});
}

test('builds the exact fixed Yahoo completed-session discovery profile', () => {
  const request = buildClaudeBoundedNewsDiscoveryRequest(context);
  assert.equal(request.model, CLAUDE_BOUNDED_NEWS_DISCOVERY_MODEL);
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.system, SYSTEM_PROMPT);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].content, 'Yahoo US stock market today September 9 2026');
  assert.deepEqual(request.tools, [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 1,
    allowed_domains: ['finance.yahoo.com']
  }]);
  assert.equal(CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_USES, 1);
  assert.equal(CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED, 10);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.tools[0].allowed_domains), true);
});

test('formats canonical dates with full English month names and unpadded days', () => {
  assert.equal(
    buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-01-01'})
      .messages[0].content,
    'Yahoo US stock market today January 1 2026'
  );
  assert.equal(
    buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-12-31'})
      .messages[0].content,
    'Yahoo US stock market today December 31 2026'
  );
});

test('rejects non-canonical context and caller-owned overrides', async () => {
  let calls = 0;
  const discovery = service(async () => { calls++; });
  for (const invalid of [
    {},
    {targetSessionDate: '2026-02-30'},
    {targetSessionDate: '2026-09-09', model: 'caller-model'},
    {targetSessionDate: '2026-09-09', tools: []},
    {targetSessionDate: '2026-09-09', allowedDomains: ['example.com']},
    {targetSessionDate: '2026-09-09', maxUses: 99},
    {targetSessionDate: '2026-09-09', prompt: 'caller prompt'},
    {targetSessionDate: '2026-09-09', url: 'https://finance.yahoo.com/' }
  ]) {
    const result = await discovery.discoverYahooCompletedSessionRecap(invalid);
    assert.equal(result.type, 'INPUT_FAILURE');
  }
  assert.equal(calls, 0);
});

test('accepts current and legacy Yahoo recap URL families and canonicalizes tracking data', async () => {
  for (const path of [
    '/markets/live/stock-market-today-dow-sp-500-nasdaq-live-200000001.html',
    '/news/live/stock-market-today-dow-sp-500-nasdaq-live-200000002.html'
  ]) {
    let calls = 0;
    const result = await service(async (url, options) => {
      calls++;
      assert.equal(url, CLAUDE_MESSAGES_URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-api-key'], 'secret');
      return response([searchResult(`https://finance.yahoo.com${path}?guccounter=1#fragment`)]);
    }).discoverYahooCompletedSessionRecap(context);
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.type, 'SUCCESS');
    assert.deepEqual(result.candidates, [{
      rank: 1,
      discovery: {
        title: 'Stock market today: US stocks close after the session',
        url: `https://finance.yahoo.com${path}`,
        discoveredVia: 'ANTHROPIC_WEB_SEARCH',
        targetSessionDate: '2026-09-09'
      }
    }]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.candidates), true);
    assert.equal(Object.isFrozen(result.candidates[0].discovery), true);
  }
});

test('rejects non-Yahoo, non-HTTPS, malformed, and unrelated Yahoo results as normal not found', async () => {
  const results = [
    searchResult('https://example.com/markets/live/stock-market-today-example.html'),
    searchResult('http://finance.yahoo.com/markets/live/stock-market-today-http.html'),
    searchResult('not a URL'),
    searchResult('https://finance.yahoo.com/topic/stock-market-news/'),
    searchResult('https://news.yahoo.com/markets/live/stock-market-today-wrong-host.html'),
    searchResult('https://finance.yahoo.com:444/markets/live/stock-market-today-wrong-port.html')
  ];
  const result = await service(async () => response(results))
    .discoverYahooCompletedSessionRecap(context);
  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', candidates: []});
});

test('deduplicates results and returns every valid canonical recap in search rank order', async () => {
  const first = 'https://finance.yahoo.com/markets/live/stock-market-today-first.html';
  const second = 'https://finance.yahoo.com/markets/live/stock-market-today-second.html';
  const result = await service(async () => response([
    searchResult(`${first}?tracking=one`, 'First recap'),
    searchResult(`${first}#duplicate`, 'Duplicate recap'),
    searchResult(second, 'Second recap')
  ])).discoverYahooCompletedSessionRecap(context);
  assert.deepEqual(result.candidates.map(candidate => candidate.discovery.url), [first, second]);
  assert.deepEqual(result.candidates.map(candidate => candidate.rank), [1, 3]);
  assert.equal(result.candidates[0].discovery.title, 'First recap');
});

test('bounds inspected search results deterministically', async () => {
  const unrelated = Array.from({length: CLAUDE_BOUNDED_NEWS_DISCOVERY_MAX_RESULTS_INSPECTED}, (_, index) =>
    searchResult(`https://finance.yahoo.com/news/unrelated-${index}.html`));
  const result = await service(async () => response([
    ...unrelated,
    searchResult('https://finance.yahoo.com/markets/live/stock-market-today-too-late.html')
  ])).discoverYahooCompletedSessionRecap(context);
  assert.equal(result.type, 'NOT_FOUND');
});

test('treats an HTTP 200 search tool error as a distinct failure', async () => {
  const result = await service(async () => response({
    type: 'web_search_tool_result_error',
    error_code: 'unavailable'
  })).discoverYahooCompletedSessionRecap(context);
  assert.deepEqual(result, {
    ok: false,
    type: 'SEARCH_TOOL_FAILURE',
    message: 'Claude web search tool failed',
    upstreamStatus: 200
  });
});

test('rejects malformed successful envelopes without fabricating discovery', async () => {
  const result = await service(async () => response([], {
    async json() { return {content: [{type: 'text', text: 'No result'}], usage: {input_tokens: 1}}; }
  })).discoverYahooCompletedSessionRecap(context);
  assert.equal(result.type, 'CONTRACT_FAILURE');
});

test('makes one request with no retry for network and provider failures', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private network detail'); },
    async () => ({ok: false, status: 429, headers: {get: () => null}})
  ]) {
    let calls = 0;
    const result = await service(async (...args) => {
      calls++;
      return fetchImpl(...args);
    }).discoverYahooCompletedSessionRecap(context);
    assert.equal(result.type, 'UPSTREAM_FAILURE');
    assert.equal(calls, 1);
  }
});

test('enforces a fixed provisional UTF-8 request-size ceiling', () => {
  assert.equal(CLAUDE_BOUNDED_NEWS_DISCOVERY_PROVISIONAL_MAX_REQUEST_BYTES, 16 * 1024);
  assert.equal(assertRequestWithinLimit('x'.repeat(16 * 1024)), 16 * 1024);
  assert.throws(
    () => assertRequestWithinLimit('x'.repeat((16 * 1024) + 1)),
    /exceeds provisional size limit/
  );
});

test('captures only sanitized size, request-id, timing, usage, search-count, and fetch-count diagnostics', async () => {
  const diagnostics = [];
  let tick = 0;
  const result = await service(
    async () => response([searchResult('https://finance.yahoo.com/markets/live/stock-market-today-valid.html')]),
    {monotonicNow: () => tick++, onDiagnostics: value => diagnostics.push(value)}
  ).discoverYahooCompletedSessionRecap(context);
  assert.equal(result.ok, true);
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(Object.keys(diagnostics[1]), [
    'model', 'requestId', 'requestSize', 'timing', 'usage', 'searchRequestCount', 'fetchCount'
  ]);
  assert.equal(diagnostics[1].requestId, 'req_search_123');
  assert.equal(diagnostics[1].fetchCount, 1);
  assert.equal(diagnostics[1].searchRequestCount, 1);
  assert.deepEqual(diagnostics[1].usage, {input_tokens: 100, output_tokens: 20});
  for (const value of Object.values(diagnostics[1].requestSize)) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0);
  }
  for (const value of Object.values(diagnostics[1].timing)) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0);
  }
  const serialized = JSON.stringify(diagnostics[1]);
  for (const forbidden of [
    'stock-market-today-valid', 'Search completed', 'encrypted_content', 'finance.yahoo.com',
    'secret', '2026-09-09'
  ]) assert.equal(serialized.includes(forbidden), false);
});

test('emits bounded sanitized Yahoo result selection diagnostics without changing discovery', async () => {
  const diagnostics = [];
  const accepted = 'https://finance.yahoo.com/markets/live/stock-market-today-valid.html';
  const results = [
    searchResult('https://example.com/private?secret=one', 'External result'),
    searchResult('https://finance.yahoo.com/markets/stocks/articles/other.html?tracking=yes#fragment', 'Other Yahoo page'),
    searchResult(`${accepted}?guccounter=1#fragment`, ' Accepted recap '),
    searchResult(`${accepted}?duplicate=yes`, 'Duplicate recap'),
    searchResult('https://finance.yahoo.com/news/live/stock-market-today-second.html', 'Second valid recap'),
    searchResult('https://finance.yahoo.com/news/live/stock-market-today-invalid-title.html', 'x'.repeat(513))
  ];
  const result = await service(async () => response(results), {
    onDiagnostics: value => diagnostics.push(value)
  }).discoverYahooCompletedSessionRecap(context);

  assert.deepEqual(result, {
    ok: true,
    type: 'SUCCESS',
    candidates: [{rank: 3, discovery: {
      title: 'Accepted recap',
      url: accepted,
      discoveredVia: 'ANTHROPIC_WEB_SEARCH',
      targetSessionDate: '2026-09-09'
    }}, {rank: 5, discovery: {
      title: 'Second valid recap',
      url: 'https://finance.yahoo.com/news/live/stock-market-today-second.html',
      discoveredVia: 'ANTHROPIC_WEB_SEARCH',
      targetSessionDate: '2026-09-09'
    }}]
  });
  assert.deepEqual(diagnostics[0], {
    stage: 'yahooRecapDiscoveryResults',
    resultCount: 6,
    inspectedResultCount: 6,
    results: [
      {rank: 1, title: 'External result', normalizedYahooUrl: null, path: null,
        outcome: 'REJECTED', rejectionReason: 'HOST_MISMATCH'},
      {rank: 2, title: 'Other Yahoo page',
        normalizedYahooUrl: 'https://finance.yahoo.com/markets/stocks/articles/other.html',
        path: '/markets/stocks/articles/other.html', outcome: 'REJECTED', rejectionReason: 'PATH_MISMATCH'},
      {rank: 3, title: 'Accepted recap', normalizedYahooUrl: accepted,
        path: '/markets/live/stock-market-today-valid.html', outcome: 'ACCEPTED', rejectionReason: null},
      {rank: 4, title: 'Duplicate recap', normalizedYahooUrl: accepted,
        path: '/markets/live/stock-market-today-valid.html', outcome: 'REJECTED', rejectionReason: 'DUPLICATE'},
      {rank: 5, title: 'Second valid recap',
        normalizedYahooUrl: 'https://finance.yahoo.com/news/live/stock-market-today-second.html',
        path: '/news/live/stock-market-today-second.html', outcome: 'ACCEPTED', rejectionReason: null},
      {rank: 6, title: null,
        normalizedYahooUrl: 'https://finance.yahoo.com/news/live/stock-market-today-invalid-title.html',
        path: '/news/live/stock-market-today-invalid-title.html',
        outcome: 'REJECTED', rejectionReason: 'INVALID_TITLE'}
    ]
  });
  assert.equal(Object.isFrozen(diagnostics[0]), true);
  assert.equal(Object.isFrozen(diagnostics[0].results), true);
  assert.equal(Object.isFrozen(diagnostics[0].results[0]), true);
  const serialized = JSON.stringify(diagnostics[0]);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('tracking'), false);
  assert.equal(serialized.includes('fragment'), false);
  assert.equal(serialized.includes('encrypted_content'), false);
});

test('caps result diagnostics at ten in deterministic rank order while reporting the full count', async () => {
  const diagnostics = [];
  const results = Array.from({length: 12}, (_, index) => searchResult(
    `https://finance.yahoo.com/news/unrelated-${index}.html`,
    `Result ${index + 1}`
  ));
  const result = await service(async () => response(results), {
    onDiagnostics: value => diagnostics.push(value)
  }).discoverYahooCompletedSessionRecap(context);

  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', candidates: []});
  assert.equal(diagnostics[0].resultCount, 12);
  assert.equal(diagnostics[0].inspectedResultCount, 10);
  assert.equal(diagnostics[0].results.length, 10);
  assert.deepEqual(diagnostics[0].results.map(item => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(JSON.stringify(diagnostics[0]).includes('unrelated-10'), false);
});

test('does not retrieve articles or integrate with package or final synthesis', async () => {
  let fetches = 0;
  const result = await service(async url => {
    fetches++;
    assert.equal(url, CLAUDE_MESSAGES_URL);
    return response([searchResult('https://finance.yahoo.com/markets/live/stock-market-today-only.html')]);
  }).discoverYahooCompletedSessionRecap(context);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(fetches, 1);
  assert.deepEqual(Object.keys(result), ['ok', 'type', 'candidates']);
  assert.deepEqual(Object.keys(result.candidates[0]), ['rank', 'discovery']);
  assert.deepEqual(Object.keys(result.candidates[0].discovery), [
    'title', 'url', 'discoveredVia', 'targetSessionDate'
  ]);
  assert.equal(Object.hasOwn(result.candidates[0].discovery, 'publishedAt'), false);
  assert.equal(Object.hasOwn(result.candidates[0].discovery, 'articleText'), false);
  assert.equal(Object.hasOwn(result.candidates[0].discovery, 'evidenceRef'), false);
});

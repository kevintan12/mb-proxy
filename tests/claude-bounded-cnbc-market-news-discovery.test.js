const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_SEARCH_INVOCATIONS,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED_PER_SEARCH,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequest,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequests,
  createClaudeBoundedCnbcMarketNewsDiscoveryService
} = require('../lib/claude-bounded-cnbc-market-news-discovery');

function result(url, title = 'CNBC market article') {
  return {type: 'web_search_result', url, title, page_age: 'ignored', encrypted_content: 'ignored'};
}
function response(results, overrides = {}) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() {
      return {
        content: [{type: 'web_search_tool_result', content: results}],
        usage: {server_tool_use: {web_search_requests: 1}},
        ...overrides
      };
    }
  };
}

test('builds two fixed complementary full-date CNBC search requests', () => {
  const requests = buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate: '2026-09-11'});
  assert.deepEqual(requests.map(request => request.messages[0].content), [
    'CNBC US stock market completed session leadership laggards sectors breadth rotation September 11 2026',
    'CNBC US stocks notable movers company developments earnings major announcements September 11 2026'
  ]);
  for (const request of requests) {
    assert.deepEqual(request.tools, [{
      type: 'web_search_20250305', name: 'web_search', max_uses: 1,
      allowed_domains: ['cnbc.com']
    }]);
  }
  assert.equal(buildClaudeBoundedCnbcMarketNewsDiscoveryRequest({
    targetSessionDate: '2026-09-11'
  }).messages[0].content, requests[0].messages[0].content);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES, 1);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_SEARCH_INVOCATIONS, 2);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED_PER_SEARCH, 10);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED, 20);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES, 5);
  assert.throws(() => buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({
    targetSessionDate: '2026-09-11', query: 'override'
  }));
});

test('normalizes CNBC dated article URLs and preserves first search rank with deduplication', async () => {
  const calls = [];
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'server-key',
    fetchImpl: async (...args) => {
      calls.push(args);
      return response([
        result('https://www.cnbc.com/2026/09/11/market-leaders.html?x=1#top', 'Leaders'),
        result('https://www.cnbc.com/2026/09/11/market-leaders.html', 'Duplicate'),
        result('https://www.cnbc.com/2026/09/11/sector-rotation.html', 'Rotation')
      ]);
    }
  });
  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  assert.equal(calls.length, 2);
  assert.deepEqual(output.discoveries.map(item => [item.rank, item.title, item.url]), [
    [1, 'Leaders', 'https://www.cnbc.com/2026/09/11/market-leaders.html'],
    [3, 'Rotation', 'https://www.cnbc.com/2026/09/11/sector-rotation.html']
  ]);
  assert.equal(Object.isFrozen(output.discoveries[0]), true);
});

test('rejects unsafe, malformed, recap, and all unsupported biggest-moves families', async () => {
  const urls = [
    'http://www.cnbc.com/2026/09/11/article.html',
    'https://user@www.cnbc.com/2026/09/11/article.html',
    'https://www.cnbc.com:444/2026/09/11/article.html',
    'https://cnbc.com.example.test/2026/09/11/article.html',
    'https://www.cnbc.com/not-dated/article.html',
    'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html',
    'https://www.cnbc.com/2026/09/11/stocks-making-the-biggest-moves-midday-x.html',
    'https://www.cnbc.com/2026/09/11/stocks-making-the-biggest-moves-premarket-x.html',
    'https://www.cnbc.com/2026/09/11/stocks-making-the-biggest-moves-after-hours-x.html',
    'not a url'
  ];
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', fetchImpl: async () => response(urls.map(url => result(url)))
  });
  assert.deepEqual(await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'}), {
    ok: true, type: 'NOT_FOUND', discoveries: []
  });
});

test('inspects ten per intent and balances both intents within the global five-URL budget', async () => {
  const firstIntent = Array.from({length: 10}, (_, index) => index < 8
    ? result(`https://example.test/rejected-${index + 1}.html`, `Rejected ${index + 1}`)
    : result('https://www.cnbc.com/2026/09/11/shared.html', `Shared ${index + 1}`));
  const secondIntent = [
    result('https://www.cnbc.com/2026/09/11/shared.html', 'Cross-intent duplicate'),
    ...Array.from({length: 9}, (_, index) =>
      result(`https://www.cnbc.com/2026/09/11/later-${index + 1}.html`, `Later ${index + 1}`))
  ];
  let call = 0;
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', fetchImpl: async () => response(call++ === 0 ? firstIntent : secondIntent)
  });
  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  assert.equal(output.discoveries.length, 5);
  assert.deepEqual(output.discoveries.map(item => item.rank), [9, 12, 13, 14, 15]);
  assert.equal(call, 2);
});

test('a full first-intent result set cannot starve company and sector discoveries', async () => {
  const firstIntent = Array.from({length: 10}, (_, index) =>
    result(`https://www.cnbc.com/2026/09/11/session-${index + 1}.html`, `Session ${index + 1}`));
  const secondIntent = [
    result('https://www.cnbc.com/2026/09/11/non-portfolio-company.html', 'Company'),
    result('https://www.cnbc.com/2026/09/11/constructive-sector.html', 'Sector')
  ];
  let call = 0;
  const diagnostics = [];
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => response(call++ === 0 ? firstIntent : secondIntent)
  });

  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});

  assert.deepEqual(output.discoveries.map(item => [item.rank, item.title]), [
    [1, 'Session 1'],
    [2, 'Session 2'],
    [3, 'Session 3'],
    [11, 'Company'],
    [12, 'Sector']
  ]);
  assert.deepEqual(diagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery').retainedResults.map(item => [
    item.rank, item.searchIndex, item.path, item.outcome
  ]), [
    [1, 1, '/2026/09/11/session-1.html', 'RETAINED'],
    [2, 1, '/2026/09/11/session-2.html', 'RETAINED'],
    [3, 1, '/2026/09/11/session-3.html', 'RETAINED'],
    [11, 2, '/2026/09/11/non-portfolio-company.html', 'RETAINED'],
    [12, 2, '/2026/09/11/constructive-sector.html', 'RETAINED']
  ]);
});

test('returns optional absence and deterministic provider failures with no retry', async () => {
  let calls = 0;
  const empty = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', fetchImpl: async () => { calls++; return response([]); }
  });
  assert.equal((await empty.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'})).type, 'NOT_FOUND');
  const failed = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', fetchImpl: async () => { calls++; throw new Error('private'); }
  });
  assert.equal((await failed.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'})).type, 'UPSTREAM_FAILURE');
  assert.equal(calls, 4);
});

test('emits bounded structural diagnostics without snippets or raw payloads', async () => {
  const diagnostics = [];
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => response([result('https://www.cnbc.com/2026/09/11/article.html')])
  });
  await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  const aggregate = diagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery');
  assert.equal(aggregate.outcome, 'SUCCESS');
  assert.deepEqual(aggregate.resultCount, 2);
  assert.equal(aggregate.inspectedResultCount, 2);
  assert.equal(aggregate.retainedResultCount, 1);
  assert.deepEqual(aggregate.retainedResults, [{
    rank: 1,
    searchIndex: 1,
    path: '/2026/09/11/article.html',
    outcome: 'RETAINED'
  }]);
  assert.deepEqual(aggregate.rejectionCounts, {
    INVALID_URL: 0,
    PATH_MISMATCH: 0,
    INVALID_TITLE: 0,
    DUPLICATE: 1,
    RETAINED_LIMIT: 0
  });
  assert.equal(aggregate.fetchCount, 2);
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of ['CNBC market article', 'encrypted_content', 'server-key']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('diagnostics distinguish zero results, validation rejection, and bounded partial search success', async () => {
  for (const [responses, expected] of [
    [[response([]), response([])], {
      outcome: 'ZERO_RESULTS', type: 'NOT_FOUND', invalidUrls: 0, failedSearchCount: 0
    }],
    [[
      response([result('https://example.test/not-cnbc.html')]),
      response([result('https://www.cnbc.com/not-dated/article.html')])
    ], {
      outcome: 'ALL_RESULTS_REJECTED', type: 'NOT_FOUND', invalidUrls: 1,
      pathMismatches: 1, failedSearchCount: 0
    }]
  ]) {
    const diagnostics = [];
    let call = 0;
    const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
      apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
      fetchImpl: async () => responses[call++]
    });
    const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
    const aggregate = diagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery');
    assert.equal(output.type, expected.type);
    assert.equal(aggregate.outcome, expected.outcome);
    assert.equal(aggregate.rejectionCounts.INVALID_URL, expected.invalidUrls);
    assert.equal(aggregate.rejectionCounts.PATH_MISMATCH, expected.pathMismatches || 0);
    assert.equal(aggregate.failedSearchCount, expected.failedSearchCount);
  }

  const diagnostics = [];
  let call = 0;
  const partial = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => {
      if (call++ === 0) throw new Error('private');
      return response([result('https://www.cnbc.com/2026/09/11/valid-company-news.html')]);
    }
  });
  const partialOutput = await partial.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  const aggregate = diagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery');
  assert.equal(partialOutput.type, 'SUCCESS');
  assert.deepEqual(partialOutput.discoveries.map(item => item.rank), [11]);
  assert.equal(aggregate.outcome, 'PARTIAL_SUCCESS');
  assert.equal(aggregate.failedSearchCount, 1);
  assert.equal(aggregate.fetchCount, 2);
  assert.deepEqual(diagnostics.filter(item => item.stage === 'cnbcMarketNewsSearchInvocation').map(item => item.outcome),
    ['NETWORK_FAILURE', 'SUCCESS']);
});

test('attributes request size, provider usage, request ID, timing and tool counts to each search without changing discoveries', async () => {
  const diagnostics = [];
  const bodies = [];
  let call = 0;
  let clock = 0;
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'secret-key', onDiagnostics: value => diagnostics.push(value),
    monotonicNow: () => clock++,
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      const index = ++call;
      return {
        ...response([result(`https://www.cnbc.com/2026/09/11/story-${index}.html`, `Story ${index}`)], {
          usage: {input_tokens: index * 100, output_tokens: index * 10,
            server_tool_use: {web_search_requests: index}}
        }),
        headers: {get: name => name === 'request-id' ? `req_test_${index}` : null}
      };
    }
  });
  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  assert.deepEqual(output.discoveries.map(item => item.rank), [1, 11]);
  assert.equal(bodies.length, 2);
  const invocations = diagnostics.filter(item => item.stage === 'cnbcMarketNewsSearchInvocation');
  assert.equal(invocations.length, 2);
  for (const [index, invocation] of invocations.entries()) {
    assert.deepEqual(Object.keys(invocation).sort(), [
      'elapsedMs', 'httpStatus', 'model', 'outcome', 'requestId', 'requestSize',
      'searchIndex', 'searchRequestCount', 'stage', 'usage'
    ].sort());
    assert.equal(invocation.searchIndex, index + 1);
    assert.equal(invocation.outcome, 'SUCCESS');
    assert.equal(invocation.requestId, `req_test_${index + 1}`);
    assert.equal(invocation.httpStatus, 200);
    assert.equal(invocation.requestSize.completeRequestBodyBytes, Buffer.byteLength(bodies[index], 'utf8'));
    assert.equal(invocation.requestSize.systemPromptBytes > 0, true);
    assert.equal(invocation.requestSize.userPromptBytes > 0, true);
    assert.deepEqual(invocation.usage, {input_tokens: (index + 1) * 100, output_tokens: (index + 1) * 10});
    assert.equal(invocation.searchRequestCount, index + 1);
    assert.equal(invocation.elapsedMs >= 0, true);
    assert.equal(Object.isFrozen(invocation), true);
  }
  const aggregate = diagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery');
  assert.equal(aggregate.searchRequestCount, 3);
  assert.equal(aggregate.fetchCount, 2);
  const logged = JSON.stringify(diagnostics);
  for (const forbidden of ['secret-key', 'Story 1', 'Story 2', 'encrypted_content', 'CNBC US stock market']) {
    assert.equal(logged.includes(forbidden), false);
  }
});

test('omits absent or invalid provider metadata and unexpected numeric usage fields', async () => {
  const diagnostics = [];
  let call = 0;
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => {
      call++;
      if (call === 1) {
        return response([], {usage: undefined});
      }
      return {
        ...response([], {usage: {
          input_tokens: 101,
          output_tokens: Number.NaN,
          unexpected_numeric_field: 999,
          server_tool_use: {web_search_requests: 'invalid'}
        }}),
        headers: {get: () => 'invalid request id with spaces'}
      };
    }
  });

  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});

  assert.deepEqual(output, {ok: true, type: 'NOT_FOUND', discoveries: []});
  const invocations = diagnostics.filter(item => item.stage === 'cnbcMarketNewsSearchInvocation');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].requestId, null);
  assert.deepEqual(invocations[0].usage, {});
  assert.equal(invocations[0].searchRequestCount, null);
  assert.equal(invocations[1].requestId, null);
  assert.deepEqual(invocations[1].usage, {input_tokens: 101});
  assert.equal(invocations[1].searchRequestCount, null);
  assert.equal('unexpected_numeric_field' in invocations[1].usage, false);
});

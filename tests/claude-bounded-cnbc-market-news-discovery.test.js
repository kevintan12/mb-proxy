const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED,
  CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES,
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequest,
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

test('builds one fixed full-date Section 4-oriented CNBC search request', () => {
  const request = buildClaudeBoundedCnbcMarketNewsDiscoveryRequest({targetSessionDate: '2026-09-11'});
  assert.equal(request.messages[0].content,
    'CNBC US stock market sectors leadership laggards notable movers September 11 2026');
  assert.deepEqual(request.tools, [{
    type: 'web_search_20250305', name: 'web_search', max_uses: 1,
    allowed_domains: ['cnbc.com']
  }]);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_USES, 1);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_RESULTS_INSPECTED, 10);
  assert.equal(CLAUDE_BOUNDED_CNBC_MARKET_NEWS_MAX_DISCOVERIES, 5);
  assert.throws(() => buildClaudeBoundedCnbcMarketNewsDiscoveryRequest({
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
  assert.equal(calls.length, 1);
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

test('inspects ten and retains five results deterministically', async () => {
  const results = Array.from({length: 12}, (_, index) =>
    result(`https://www.cnbc.com/2026/09/11/article-${index + 1}.html`, `Article ${index + 1}`));
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', fetchImpl: async () => response(results)
  });
  const output = await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  assert.equal(output.discoveries.length, 5);
  assert.deepEqual(output.discoveries.map(item => item.rank), [1, 2, 3, 4, 5]);
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
  assert.equal(calls, 2);
});

test('emits bounded structural diagnostics without snippets or raw payloads', async () => {
  const diagnostics = [];
  const service = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => response([result('https://www.cnbc.com/2026/09/11/article.html')])
  });
  await service.discoverCnbcMarketNews({targetSessionDate: '2026-09-11'});
  assert.deepEqual(diagnostics[0].resultCount, 1);
  assert.equal(diagnostics[0].retainedResultCount, 1);
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of ['article.html', 'CNBC market article', 'encrypted_content', 'server-key']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

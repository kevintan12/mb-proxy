const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NEWS_MATERIALITY_REQUEST_KEYS,
  validateNewsMaterialityRequest,
  createNewsMaterialityRuntime
} = require('../lib/news-materiality-runtime');

const request = Object.freeze({
  market: 'US',
  horizons: Object.freeze([{
    classification: 'SUBSEQUENT_DEVELOPMENT',
    startsAtExclusive: '2026-09-07T20:00:00Z',
    endsAtInclusive: '2026-09-08T20:00:00Z'
  }]),
  bounds: Object.freeze({
    maxCandidates: 10,
    maxTitleBytes: 200,
    maxSummaryBytes: 500,
    maxExtractBytes: 500,
    maxCollectionBytes: 20000
  })
});

function rss() {
  return '<?xml version="1.0"?><rss><channel><item>'
    + '<title>Market update</title><description>Bounded market summary.</description>'
    + '<link>https://www.cnbc.com/market-update.html</link>'
    + '<pubDate>Tue, 08 Sep 2026 09:00:00 -0400</pubDate>'
    + '</item></channel></rss>';
}

test('validates the exact US horizon-and-bounds request shape', () => {
  assert.deepEqual(NEWS_MATERIALITY_REQUEST_KEYS, ['market', 'horizons', 'bounds']);
  assert.equal(validateNewsMaterialityRequest(request), true);
  for (const invalid of [
    {...request, market: 'SG'},
    {...request, providerUrl: 'https://example.com/'},
    {...request, apiKey: 'caller-key'},
    {...request, horizons: []},
    {...request, bounds: {...request.bounds, maxCandidates: 0}},
    {...request, horizons: [{...request.horizons[0], endsAtInclusive: 'not-a-date'}]}
  ]) assert.equal(validateNewsMaterialityRequest(invalid), false);
});

test('composes one CNBC acquisition and one Anthropic materiality call with server-owned key', async () => {
  const calls = [];
  const diagnostics = [];
  const runtime = createNewsMaterialityRuntime({
    apiKey: 'server-secret',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.includes('search.cnbc.com')) {
        return {
          ok: true, status: 200, headers: {get: () => null},
          async text() { return rss(); }
        };
      }
      return {
        ok: true, status: 200, headers: {get: () => 'req_runtime_1'},
        async json() {
          return {
            content: [{type: 'text', text: JSON.stringify({selections: [{
              reference: 'c1', decision: 'USE', category: 'news', materiality: 'HIGH',
              reason: 'Material broad-market development.'
            }]})}],
            usage: {input_tokens: 100, output_tokens: 20}
          };
        }
      };
    }
  });
  const result = await runtime.measure(request);
  assert.deepEqual(result, {
    ok: true,
    type: 'SUCCESS',
    candidateCount: 1,
    useCount: 1,
    skipCount: 0,
    materialityCounts: {HIGH: 1, MEDIUM: 0, LOW: 0}
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.url === 'https://api.anthropic.com/v1/messages').length, 1);
  assert.equal(calls[1].options.headers['x-api-key'], 'server-secret');
  assert.equal(JSON.stringify(request).includes('server-secret'), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].fetchCount, 1);
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 100, output_tokens: 20});
});

test('returns only aggregate success data without candidate content', async () => {
  const runtime = createNewsMaterialityRuntime({
    apiKey: 'server-secret',
    fetchImpl: async url => url.includes('search.cnbc.com') ? {
      ok: true, status: 200, headers: {get: () => null}, async text() { return rss(); }
    } : {
      ok: true, status: 200, headers: {get: () => null}, async json() {
        return {content: [{type: 'text', text: JSON.stringify({selections: [{
          reference: 'c1', decision: 'SKIP', category: 'news', materiality: 'LOW', reason: 'Not material.'
        }]})}]};
      }
    }
  });
  const result = await runtime.measure(request);
  assert.deepEqual(Object.keys(result), [
    'ok', 'type', 'candidateCount', 'useCount', 'skipCount', 'materialityCounts'
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['title', 'summary', 'reason', 'canonicalUrl', 'provenance', 'cnbc.com', 'server-secret']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

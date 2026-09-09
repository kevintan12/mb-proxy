const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcNewsResearchRuntime
} = require('../lib/cnbc-news-research-runtime');

const horizons = [{
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-03T20:00:00.000Z',
  endsAtInclusive: '2026-09-04T20:00:00.000Z'
}];

function rss() {
  return '<?xml version="1.0"?><rss><channel><item>'
    + '<title>Market update</title><description>Bounded market summary.</description>'
    + '<link>https://www.cnbc.com/2026/09/04/market-update.html</link>'
    + '<pubDate>Fri, 04 Sep 2026 12:00:00 -0400</pubDate>'
    + '</item></channel></rss>';
}

test('defines one deeply immutable production bounds bundle', () => {
  const bounds = CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS;
  assert.deepEqual(bounds, {
    candidateBounds: {
      maxCandidates: 20, maxTitleBytes: 512, maxSummaryBytes: 2048,
      maxExtractBytes: 2048, maxCollectionBytes: 32768
    },
    articleRetrievalBounds: {
      timeoutMs: 4000, maxResponseBytes: 524288, maxArticleTextBytes: 8192,
      maxTitleBytes: 512, maxResultBytes: 12288
    },
    evidenceConstructionBounds: {
      maxEvidenceTextBytes: 8192, maxTitleBytes: 512, maxCollectionBytes: 65536
    }
  });
  assert.equal(Object.isFrozen(bounds), true);
  assert.equal(Object.values(bounds).every(Object.isFrozen), true);
});

test('composes one CNBC acquisition and one guarded materiality invocation with shared bounds', async () => {
  const calls = [];
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key',
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.includes('search.cnbc.com')) {
        return {
          ok: true, status: 200, headers: {get: () => null},
          async text() { return rss(); }
        };
      }
      return {
        ok: true, status: 200, headers: {get: () => null},
        async json() {
          return {content: [{type: 'text', text: JSON.stringify({selections: [{
            reference: 'c1', decision: 'SKIP', category: 'news', materiality: 'LOW',
            reason: 'Not material for this research window.'
          }]})}]};
        }
      };
    }
  });
  const result = await service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.equal(result.constructedEvidence.length, 0);
  assert.equal(calls.filter(call => call.url === 'https://api.anthropic.com/v1/messages').length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['x-api-key'], 'server-key');
});

test('uses the one bounds bundle at every composed stage and does not invoke final synthesis', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-news-research-runtime.js'), 'utf8');
  for (const field of ['candidateBounds', 'articleRetrievalBounds', 'evidenceConstructionBounds']) {
    assert.ok(source.split(`bounds.${field}`).length >= 3);
  }
  assert.doesNotMatch(source, /invokeClaudeAnalysis|claude-analysis-invocation|analysis-package-service/);
});

test('forwards sanitized selected-article failure diagnostics through production composition', async () => {
  const diagnostics = [];
  const calls = [];
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.includes('search.cnbc.com')) {
        return {
          ok: true, status: 200, headers: {get: () => null},
          async text() { return rss(); }
        };
      }
      if (url === 'https://api.anthropic.com/v1/messages') {
        return {
          ok: true, status: 200, headers: {get: () => null},
          async json() {
            return {content: [{type: 'text', text: JSON.stringify({selections: [{
              reference: 'c1', decision: 'USE', category: 'news', materiality: 'HIGH',
              reason: 'Material market development.'
            }]})}]};
          }
        };
      }
      return {ok: false, status: 403, headers: {get: () => 'text/html'}};
    }
  });
  const result = await service.researchNews({horizons});
  assert.equal(result.type, 'ARTICLE_RETRIEVAL_FAILURE');
  assert.equal(calls.length, 3);
  assert.deepEqual(diagnostics.find(item => item.stage === 'cnbcSelectedArticleRetrieval'), {
    stage: 'cnbcSelectedArticleRetrieval',
    failedCandidateReference: 'c1',
    failureType: 'HTTP_FAILURE'
  });
});

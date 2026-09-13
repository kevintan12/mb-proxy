const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CnbcArticleContentAcquisitionError
} = require('../lib/cnbc-article-content-acquisition');
const {
  CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcRecapResearchRuntime
} = require('../lib/cnbc-recap-research-runtime');

const targetSessionDate = '2026-09-11';
const recapUrl = 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html';
const horizons = Object.freeze([Object.freeze({
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-10T20:00:00.000Z',
  endsAtInclusive: '2026-09-11T20:00:00.000Z'
}), Object.freeze({
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-11T20:00:00.000Z',
  endsAtInclusive: '2026-09-11T22:00:00.000Z'
})]);

function discovery() {
  return Object.freeze({
    title: 'Stock market news for Sept. 11, 2026', url: recapUrl,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate
  });
}

function article(overrides = {}) {
  return Object.freeze({
    sourceId: 'us.cnbc', canonicalUrl: recapUrl,
    publishedAt: '2026-09-11T20:15:23.000Z', updatedAt: '2026-09-11T20:20:00.000Z',
    title: 'Stock market news for Sept. 11, 2026', articleText: 'Stocks closed higher.',
    provenance: Object.freeze({
      publisher: 'CNBC', authority: 'secondary', homepage: 'https://www.cnbc.com/',
      applicableMarket: 'US', sourceJurisdiction: 'GLOBAL', locator: 'source-homepage'
    }),
    targetSessionDate, selectedArticleType: 'BlogPosting', ...overrides
  });
}

function constructed(articleContent, horizon) {
  return Object.freeze({
    targetSessionDate: articleContent.targetSessionDate,
    updatedAt: articleContent.updatedAt,
    horizon: Object.freeze({...horizon}),
    evidenceItem: Object.freeze({sourceId: 'us.cnbc'})
  });
}

function runtime(overrides = {}) {
  const calls = {discovery: [], acquisition: [], construction: []};
  const services = {
    discoveryService: {
      async discoverCnbcCompletedSessionRecap(input) {
        calls.discovery.push(input);
        return Object.freeze({
          ok: true, type: 'SUCCESS',
          candidates: Object.freeze([Object.freeze({rank: 1, discovery: discovery()})])
        });
      }
    },
    articleContentAcquisition: {
      async acquireRecapArticleContent(input) { calls.acquisition.push(input); return article(); }
    },
    evidenceConstruction: {
      constructEvidence(input) {
        calls.construction.push(input);
        return Object.freeze({
          ok: true, type: 'SUCCESS',
          constructedEvidence: constructed(input.articleContent, input.horizon)
        });
      }
    },
    ...overrides
  };
  return {
    calls,
    service: createCnbcRecapResearchRuntime({fetchImpl: async () => {}, ...services})
  };
}

test('owns exact deeply immutable recap production bounds', () => {
  assert.deepEqual(CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS, {
    articleRetrievalBounds: {
      timeoutMs: 4000, maxResponseBytes: 1310720, maxArticleTextBytes: 8192,
      maxTitleBytes: 512, maxResultBytes: 12288
    },
    evidenceConstructionBounds: {
      maxEvidenceTextBytes: 8192, maxTitleBytes: 512, maxResultBytes: 12288
    }
  });
  assert.equal(Object.isFrozen(CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS), true);
  assert.equal(Object.isFrozen(CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds), true);
});

test('discovers once, acquires once, and constructs a subsequent recap without references', async () => {
  const {service, calls} = runtime();
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.deepEqual(calls.discovery, [{targetSessionDate}]);
  assert.equal(calls.acquisition.length, 1);
  assert.equal(calls.acquisition[0].discovery.url, recapUrl);
  assert.deepEqual(calls.acquisition[0].bounds, CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds);
  assert.equal(calls.construction.length, 1);
  assert.equal(calls.construction[0].horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.targetSessionDate, targetSessionDate);
  assert.equal(result.constructedEvidence.horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
  assert.equal(JSON.stringify(result).includes('evidenceRef'), false);
  assert.equal(JSON.stringify(result).includes('candidateReference'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('composes one bounded discovery request and one CNBC page fetch end to end', async () => {
  const calls = [];
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting',
    datePublished: '2026-09-10T22:00:00Z',
    liveBlogUpdate: [{
      '@type': 'BlogPosting', datePublished: '2026-09-11T20:15:23Z',
      dateModified: '2026-09-11T20:20:00Z', articleBody: 'Stocks closed higher.'
    }]
  })}</script>`;
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (url === 'https://api.anthropic.com/v1/messages') {
      return {
        ok: true, status: 200, headers: {get: () => null},
        async json() {
          return {
            content: [{type: 'web_search_tool_result', content: [{
              type: 'web_search_result', title: 'Stock market news for Sept. 11, 2026', url: recapUrl
            }]}],
            usage: {server_tool_use: {web_search_requests: 1}}
          };
        }
      };
    }
    return {
      ok: true, status: 200, url: recapUrl,
      headers: {get: name => name === 'content-type' ? 'text/html' : null},
      async text() { return html; }
    };
  };
  const service = createCnbcRecapResearchRuntime({apiKey: 'server-key', fetchImpl});
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
  assert.equal(result.constructedEvidence.targetSessionDate, targetSessionDate);
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.anthropic.com/v1/messages', recapUrl
  ]);
  assert.equal(JSON.parse(calls[0].options.body).messages[0].content,
    'CNBC stock market today September 11 2026');
  assert.equal(calls[1].options.method, 'GET');
});

test('NOT_FOUND is optional and skips acquisition and construction', async () => {
  const {service, calls} = runtime({
    discoveryService: {
      async discoverCnbcCompletedSessionRecap(input) {
        calls.discovery.push(input);
        return Object.freeze({ok: true, type: 'NOT_FOUND', candidates: Object.freeze([])});
      }
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', constructedEvidence: null});
  assert.equal(calls.discovery.length, 1);
  assert.equal(calls.acquisition.length, 0);
  assert.equal(calls.construction.length, 0);
});

test('wrong provider publication date is optional NOT_VALIDATED with no stale fallback', async () => {
  const {service, calls} = runtime({
    articleContentAcquisition: {
      async acquireRecapArticleContent(input) {
        calls.acquisition.push(input);
        throw new CnbcArticleContentAcquisitionError(
          'SESSION_MISMATCH', 'CNBC recap publication date does not match the target session'
        );
      }
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.deepEqual(result, {ok: true, type: 'NOT_VALIDATED', constructedEvidence: null});
  assert.equal(calls.discovery.length, 1);
  assert.equal(calls.acquisition.length, 1);
  assert.equal(calls.construction.length, 0);
});

test('horizon mismatch is optional and never relabels a post-close recap', async () => {
  const outside = article({publishedAt: '2026-09-11T22:00:00.001Z', updatedAt: null});
  const {service, calls} = runtime({
    articleContentAcquisition: {
      async acquireRecapArticleContent(input) { calls.acquisition.push(input); return outside; }
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.deepEqual(result, {ok: true, type: 'NOT_VALIDATED', constructedEvidence: null});
  assert.equal(calls.construction.length, 0);
});

test('stage failures are sanitized and non-blocking with no retry', async () => {
  for (const [overrides, expected] of [
    [{discoveryService: {async discoverCnbcCompletedSessionRecap() {
      return {ok: false, type: 'UPSTREAM_FAILURE', message: 'private'};
    }}}, 'DISCOVERY_FAILURE'],
    [{articleContentAcquisition: {async acquireRecapArticleContent() {
      throw new CnbcArticleContentAcquisitionError('HTTP_FAILURE', 'private');
    }}}, 'ARTICLE_ACQUISITION_FAILURE'],
    [{evidenceConstruction: {constructEvidence() {
      return {ok: false, type: 'EVIDENCE_CONTRACT_FAILURE', message: 'private'};
    }}}, 'EVIDENCE_CONSTRUCTION_FAILURE']
  ]) {
    const {service} = runtime(overrides);
    const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
    assert.equal(result.ok, false);
    assert.equal(result.type, expected);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('preserves an allowlisted extraction reason in dedicated recap diagnostics', async () => {
  const diagnostics = [];
  const {service} = runtime({
    onDiagnostics(value) { diagnostics.push(value); },
    articleContentAcquisition: {async acquireRecapArticleContent() {
      throw new CnbcArticleContentAcquisitionError(
        'EXTRACTION_FAILURE', 'private page content', undefined, 'INVALID_DATE_MODIFIED'
      );
    }}
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'ARTICLE_ACQUISITION_FAILURE');
  assert.deepEqual(diagnostics, [{
    stage: 'cnbcRecapResearch',
    outcome: 'FAILURE',
    failureType: 'EXTRACTION_FAILURE',
    extractionFailureType: 'INVALID_DATE_MODIFIED'
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private page content/);
});

test('rejects caller overrides and malformed horizons before discovery', async () => {
  const {service, calls} = runtime();
  for (const input of [
    {targetSessionDate},
    {targetSessionDate, horizons, url: recapUrl},
    {targetSessionDate: '2026-02-30', horizons},
    {targetSessionDate, horizons: [horizons[1], horizons[0]]},
    {targetSessionDate: '2026-09-10', horizons}
  ]) {
    assert.equal((await service.researchCompletedSessionRecap(input)).type, 'INPUT_FAILURE');
  }
  assert.equal(calls.discovery.length, 0);
});

test('contains no RSS, materiality, package, eN, or session-association integration', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-recap-research-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /\bRSS\b|materiality|analysis-package|sessionAssociations|createPostClose|\be[1-9]/i);
});

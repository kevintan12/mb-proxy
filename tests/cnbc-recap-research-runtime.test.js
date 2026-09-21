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
const {
  createCompletedSessionRecapDiscoveryCache
} = require('../lib/completed-session-recap-discovery-cache');

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
    horizon: horizon ? Object.freeze({...horizon}) : null,
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

test('discovers once, acquires once, and constructs a recap without a timestamp horizon', async () => {
  const {service, calls} = runtime();
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.deepEqual(calls.discovery, [{targetSessionDate}]);
  assert.equal(calls.acquisition.length, 1);
  assert.equal(calls.acquisition[0].discovery.url, recapUrl);
  assert.deepEqual(calls.acquisition[0].bounds, CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds);
  assert.equal(calls.construction.length, 1);
  assert.deepEqual(calls.construction[0], {
    articleContent: article(), observedAt: '2026-09-11T22:00:00.000Z'
  });
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.targetSessionDate, targetSessionDate);
  assert.equal(result.constructedEvidence.horizon, null);
  assert.equal(JSON.stringify(result).includes('evidenceRef'), false);
  assert.equal(JSON.stringify(result).includes('candidateReference'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('caches only a fully constructed recap and revalidates it without another discovery call', async () => {
  const diagnostics = [];
  const cache = createCompletedSessionRecapDiscoveryCache();
  const {service, calls} = runtime({
    completedSessionRecapDiscoveryCache: cache,
    onDiagnostics(value) { diagnostics.push(value); }
  });

  const cold = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  const warm = await service.researchCompletedSessionRecap({targetSessionDate, horizons});

  assert.deepEqual(warm, cold);
  assert.equal(calls.discovery.length, 1);
  assert.equal(calls.acquisition.length, 2);
  assert.equal(calls.construction.length, 2);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate}).url, recapUrl);
  assert.deepEqual(diagnostics.filter(value =>
    value.stage === 'completedSessionRecapDiscoveryCache'), [
    {stage: 'completedSessionRecapDiscoveryCache', provider: 'CNBC', outcome: 'MISS'},
    {stage: 'completedSessionRecapDiscoveryCache', provider: 'CNBC', outcome: 'FALLBACK_DISCOVERY'},
    {stage: 'completedSessionRecapDiscoveryCache', provider: 'CNBC', outcome: 'VALIDATED_HIT'}
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /cnbc\.com|Stock market news|Stocks closed/);
});

test('predicted daily recap reaches subsequent evidence despite editorial session mismatch', async () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting',
    headline: 'Stock market news for Sept. 12, 2026',
    datePublished: '2026-09-11T20:05:00Z',
    liveBlogUpdate: [{
      '@type': 'BlogPosting',
      headline: 'Overnight market developments',
      datePublished: '2026-09-11T20:15:00Z',
      dateModified: '2026-09-11T20:20:00Z',
      articleBody: 'Stocks finished Friday after a volatile session.'
    }]
  })}</script>`;
  const calls = [];
  const service = createCnbcRecapResearchRuntime({
    fetchImpl: async requestUrl => {
      calls.push(requestUrl);
      return {
            ok: true, status: 200, url: recapUrl,
            headers: {get: name => name === 'content-type' ? 'text/html' : null},
            async text() { return html; }
          };
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.horizon, null);
  assert.equal(result.constructedEvidence.targetSessionDate, targetSessionDate);
  assert.equal(result.constructedEvidence.evidenceItem.title,
    'Stock market news for Sept. 12, 2026');
  assert.equal(result.constructedEvidence.evidenceItem.canonicalUrl, recapUrl);
  assert.deepEqual(calls, [recapUrl]);
});

test('evicts a failed cached identity and replaces it only after successful fallback construction', async () => {
  const cache = createCompletedSessionRecapDiscoveryCache();
  cache.set({
    provider: 'CNBC', targetSessionDate,
    discovery: {
      ...discovery(),
      url: 'https://www.cnbc.com/2026/09/09/stock-market-today-live-updates.html'
    }
  });
  const diagnostics = [];
  let acquisitions = 0;
  const {service, calls} = runtime({
    completedSessionRecapDiscoveryCache: cache,
    onDiagnostics(value) { diagnostics.push(value); },
    articleContentAcquisition: {
      async acquireRecapArticleContent(input) {
        calls.acquisition.push(input);
        acquisitions += 1;
        if (acquisitions === 1) {
          throw new CnbcArticleContentAcquisitionError(
            'SESSION_MISMATCH', 'cached identity no longer validates'
          );
        }
        return article();
      }
    }
  });

  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'SUCCESS');
  assert.equal(calls.discovery.length, 1);
  assert.equal(calls.acquisition.length, 2);
  assert.equal(calls.construction.length, 1);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate}).url, recapUrl);
  assert.deepEqual(diagnostics.filter(value =>
    value.stage === 'completedSessionRecapDiscoveryCache'), [
    {stage: 'completedSessionRecapDiscoveryCache', provider: 'CNBC',
      outcome: 'EVICTED_AFTER_VALIDATION_FAILURE'},
    {stage: 'completedSessionRecapDiscoveryCache', provider: 'CNBC', outcome: 'FALLBACK_DISCOVERY'}
  ]);
});

test('does not cache absence, acquisition failure, session mismatch, or construction failure', async () => {
  const scenarios = [
    {
      discoveryService: {async discoverCnbcCompletedSessionRecap() {
        return Object.freeze({ok: false, type: 'SEARCH_TOOL_FAILURE'});
      }}
    },
    {
      discoveryService: {async discoverCnbcCompletedSessionRecap() {
        return Object.freeze({ok: true, type: 'SUCCESS', candidates: Object.freeze([])});
      }}
    },
    {
      discoveryService: {async discoverCnbcCompletedSessionRecap() {
        return Object.freeze({ok: true, type: 'NOT_FOUND', candidates: Object.freeze([])});
      }}
    },
    {
      articleContentAcquisition: {async acquireRecapArticleContent() {
        throw new CnbcArticleContentAcquisitionError('HTTP_FAILURE', 'private');
      }}
    },
    {
      articleContentAcquisition: {async acquireRecapArticleContent() {
        throw new CnbcArticleContentAcquisitionError('SESSION_MISMATCH', 'private');
      }}
    },
    {
      evidenceConstruction: {constructEvidence() {
        return {ok: false, type: 'EVIDENCE_CONTRACT_FAILURE'};
      }}
    }
  ];
  for (const overrides of scenarios) {
    const cache = createCompletedSessionRecapDiscoveryCache();
    const {service} = runtime({...overrides, completedSessionRecapDiscoveryCache: cache});
    await service.researchCompletedSessionRecap({targetSessionDate, horizons});
    assert.equal(cache.get({provider: 'CNBC', targetSessionDate}), null);
  }
});

test('known September 15 URL validates September 16 session with September 17 release', async () => {
  const calls = [];
  const target = '2026-09-16';
  const url = 'https://www.cnbc.com/2026/09/15/stock-market-today-live-updates.html';
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting',
    headline: 'Stock market news for Sep. 16, 2026',
    datePublished: '2026-09-17T12:00:00Z',
    liveBlogUpdate: [{
      '@type': 'BlogPosting', datePublished: '2026-09-17T12:05:00Z',
      dateModified: '2026-09-17T12:10:00Z', articleBody: 'US stocks closed higher Wednesday.'
    }]
  })}</script>`;
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return {
      ok: true, status: 200, url,
      headers: {get: name => name === 'content-type' ? 'text/html' : null},
      async text() { return html; }
    };
  };
  const service = createCnbcRecapResearchRuntime({fetchImpl});
  const targetHorizons = [
    {classification: 'COMPLETED_SESSION', startsAtExclusive: '2026-09-15T20:00:00.000Z',
      endsAtInclusive: '2026-09-16T20:00:00.000Z'},
    {classification: 'SUBSEQUENT_DEVELOPMENT', startsAtExclusive: '2026-09-16T20:00:00.000Z',
      endsAtInclusive: '2026-09-17T20:00:00.000Z'}
  ];
  const result = await service.researchCompletedSessionRecap({targetSessionDate: target, horizons: targetHorizons});
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.horizon, null);
  assert.equal(result.constructedEvidence.targetSessionDate, target);
  assert.deepEqual(calls.map(call => call.url), [url]);
  assert.equal(calls[0].options.method, 'GET');
});

test('missing deterministic CNBC page is optional and never invokes Claude fallback', async () => {
  const requests = [];
  const service = createCnbcRecapResearchRuntime({
    fetchImpl: async requestUrl => {
      requests.push(requestUrl);
      return {ok: false, status: 404, url: requestUrl,
        headers: {get: () => null}};
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'ARTICLE_ACQUISITION_FAILURE');
  assert.equal(result.failureType, 'HTTP_FAILURE');
  assert.deepEqual(requests, [recapUrl]);
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

test('session mismatch diagnostics expose only the allowlisted subtype', async () => {
  const diagnostics = [];
  const {discoveryService, articleContentAcquisition} = runtime();
  const service = createCnbcRecapResearchRuntime({
    discoveryService,
    articleContentAcquisition: {
      async acquireRecapArticleContent() {
        throw Object.assign(new CnbcArticleContentAcquisitionError(
          'SESSION_MISMATCH', 'private'
        ), {sessionMismatchType: 'PUBLICATION_OR_EDITORIAL_SESSION_MISMATCH'});
      }
    },
    onDiagnostics: value => diagnostics.push(value)
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'NOT_VALIDATED');
  assert.deepEqual(diagnostics, [{
    stage: 'cnbcRecapResearch', outcome: 'NOT_VALIDATED',
    failureType: 'SESSION_MISMATCH', sessionMismatchType: 'PUBLICATION_OR_EDITORIAL_SESSION_MISMATCH'
  }]);
});

test('out-of-horizon recap metadata cannot prevent evidence construction', async () => {
  const outside = article({publishedAt: '2026-09-11T22:00:00.001Z', updatedAt: null});
  const {service, calls} = runtime({
    articleContentAcquisition: {
      async acquireRecapArticleContent(input) { calls.acquisition.push(input); return outside; }
    }
  });
  const result = await service.researchCompletedSessionRecap({targetSessionDate, horizons});
  assert.equal(result.type, 'SUCCESS');
  assert.equal(calls.construction.length, 1);
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

test('rejects invalid target dates and caller overrides but ignores recap horizon metadata', async () => {
  const {service, calls} = runtime();
  for (const input of [
    {targetSessionDate, horizons, url: recapUrl},
    {targetSessionDate: '2026-02-30', horizons}
  ]) {
    assert.equal((await service.researchCompletedSessionRecap(input)).type, 'INPUT_FAILURE');
  }
  assert.equal(calls.discovery.length, 0);
  assert.equal((await service.researchCompletedSessionRecap({targetSessionDate})).type, 'SUCCESS');
  assert.equal((await service.researchCompletedSessionRecap({
    targetSessionDate, horizons: [horizons[1], horizons[0]]
  })).type, 'SUCCESS');
});

test('contains no RSS, materiality, package, eN, or session-association integration', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-recap-research-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /\bRSS\b|materiality|analysis-package|sessionAssociations|createPostClose|\be[1-9]/i);
  assert.doesNotMatch(source, /claude-bounded-cnbc-recap-discovery|api\.anthropic\.com|web_search/);
});

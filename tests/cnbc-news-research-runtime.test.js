const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcNewsResearchRuntime
} = require('../lib/cnbc-news-research-runtime');
const {createCnbcMarketNewsDiscoveryCache}
  = require('../lib/cnbc-market-news-discovery-cache');
const {createClaudeBoundedCnbcMarketNewsDiscoveryService}
  = require('../lib/claude-bounded-cnbc-market-news-discovery');
const {createCnbcArticleContentAcquisitionService}
  = require('../lib/cnbc-article-content-acquisition');
const {createCnbcSearchNewsCandidateAcquisitionService}
  = require('../lib/cnbc-search-news-candidate-acquisition');
const {createCnbcRetrievedArticleEvidenceConstructionService}
  = require('../lib/cnbc-retrieved-article-evidence-construction');
const {createCnbcUsNewsResearchOrchestrationService}
  = require('../lib/cnbc-us-news-research-orchestration');

const targetSessionDate = '2026-09-11';
const horizons = [{
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-10T20:00:00.000Z',
  endsAtInclusive: '2026-09-11T20:00:00.000Z'
}, {
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-11T20:00:00.000Z',
  endsAtInclusive: '2026-09-12T20:00:00.000Z'
}];
const urls = [
  'https://www.cnbc.com/2026/09/11/sector-leaders.html',
  'https://www.cnbc.com/2026/09/11/notable-movers.html'
];

function searchResponse() {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() {
      return {content: [{type: 'web_search_tool_result', content: urls.map((url, index) => ({
        type: 'web_search_result', title: `Search result ${index + 1}`, url,
        encrypted_content: 'never evidence'
      }))}], usage: {server_tool_use: {web_search_requests: 1}}};
    }
  };
}
function articleResponse(url, index) {
  const article = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: `Provider headline ${index + 1}`,
    datePublished: index === 0 ? '2026-09-11T19:00:00+0000' : '2026-09-11T20:30:00+0000',
    dateModified: index === 0 ? null : '2026-09-11T21:00:00+0000',
    articleBody: `Provider-owned market article ${index + 1}.`
  };
  const html = `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
  return {ok: true, status: 200, url, headers: {get: name => name === 'content-type' ? 'text/html' : null}, async text() { return html; }};
}

test('owns the unchanged deeply immutable production bounds', () => {
  assert.deepEqual(CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS, {
    candidateBounds: {maxCandidates: 20, maxTitleBytes: 512, maxSummaryBytes: 2048, maxExtractBytes: 2048, maxCollectionBytes: 32768},
    articleRetrievalBounds: {timeoutMs: 4000, maxResponseBytes: 1310720, maxArticleTextBytes: 8192, maxTitleBytes: 512, maxResultBytes: 12288},
    evidenceConstructionBounds: {maxEvidenceTextBytes: 8192, maxTitleBytes: 512, maxCollectionBytes: 65536}
  });
  assert.equal(Object.values(CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS).every(Object.isFrozen), true);
});

test('composes two bounded searches, one fetch per retained page, and no standalone materiality call', async () => {
  const calls = [];
  let anthropicCalls = 0;
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key',
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url === 'https://api.anthropic.com/v1/messages') {
        anthropicCalls++;
        return searchResponse();
      }
      return articleResponse(url, urls.indexOf(url));
    }
  });
  const result = await service.researchNews({targetSessionDate, horizons});
  assert.equal(result.ok, true);
  assert.equal(anthropicCalls, 2);
  assert.deepEqual(urls.map(url => calls.filter(value => value === url).length), [1, 1]);
  assert.deepEqual(result.candidateCollection.candidates.map(item => [item.reference, item.title]), [
    ['c1', 'Provider headline 1'], ['c2', 'Provider headline 2']
  ]);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c1', 'c2']);
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), ['c1', 'c2']);
  assert.deepEqual(result.constructedEvidence.map(item => item.evidenceItem.summary), [
    'Provider-owned market article 1.', 'Provider-owned market article 2.'
  ]);
});

test('caches both validated intents independently and warm hits skip only Claude search', async () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const diagnostics = [];
  const intentUrls = [
    'https://www.cnbc.com/2026/09/11/breadth-and-sector-rotation.html',
    'https://www.cnbc.com/2026/09/11/company-mover.html'
  ];
  const searchCalls = [0, 0];
  const pageCalls = new Map();
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key', cnbcMarketNewsDiscoveryCache: cache,
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      if (url === 'https://api.anthropic.com/v1/messages') {
        const body = JSON.parse(options.body);
        const searchIndex = body.messages[0].content.includes('leadership laggards') ? 0 : 1;
        searchCalls[searchIndex]++;
        return {
          ok: true, status: 200, headers: {get: () => null},
          async json() {
            return {content: [{type: 'web_search_tool_result', content: [{
              type: 'web_search_result', title: `Intent ${searchIndex + 1}`,
              url: intentUrls[searchIndex]
            }]}], usage: {server_tool_use: {web_search_requests: 1}}};
          }
        };
      }
      pageCalls.set(url, (pageCalls.get(url) || 0) + 1);
      return articleResponse(url, intentUrls.indexOf(url));
    }
  });

  const cold = await service.researchNews({targetSessionDate, horizons});
  const warm = await service.researchNews({targetSessionDate, horizons});

  assert.deepEqual(warm, cold);
  assert.deepEqual(searchCalls, [1, 1]);
  assert.deepEqual(intentUrls.map(url => pageCalls.get(url)), [2, 2]);
  assert.deepEqual([1, 2].map(searchIndex => cache.get({
    provider: 'CNBC', targetSessionDate, searchIndex
  })[0].title), ['Provider headline 1', 'Provider headline 2']);
  assert.deepEqual(diagnostics.filter(item => item.stage === 'cnbcMarketNewsDiscoveryCache')
    .map(item => [item.searchIndex, item.outcome]), [
    [1, 'MISS'], [1, 'FALLBACK_DISCOVERY'],
    [2, 'MISS'], [2, 'FALLBACK_DISCOVERY'],
    [1, 'VALIDATED_HIT'], [2, 'VALIDATED_HIT']
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics.filter(item =>
    item.stage === 'cnbcMarketNewsDiscoveryCache')), /cnbc\.com|Intent|article/);
});

test('failed cached extraction evicts only that intent and cold-falls back once', async () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const intentOneInitial = 'https://www.cnbc.com/2026/09/11/initial-sector-story.html';
  const intentOneReplacement = 'https://www.cnbc.com/2026/09/11/replacement-sector-story.html';
  const intentTwo = 'https://www.cnbc.com/2026/09/11/company-story.html';
  const searchCalls = [0, 0];
  let failCachedIntentOne = false;
  const diagnostics = [];
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key', cnbcMarketNewsDiscoveryCache: cache,
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      if (url === 'https://api.anthropic.com/v1/messages') {
        const body = JSON.parse(options.body);
        const index = body.messages[0].content.includes('leadership laggards') ? 0 : 1;
        searchCalls[index]++;
        const resultUrl = index === 0 && searchCalls[index] > 1
          ? intentOneReplacement : index === 0 ? intentOneInitial : intentTwo;
        return {
          ok: true, status: 200, headers: {get: () => null},
          async json() {
            return {content: [{type: 'web_search_tool_result', content: [{
              type: 'web_search_result', title: `Intent ${index + 1}`, url: resultUrl
            }]}], usage: {server_tool_use: {web_search_requests: 1}}};
          }
        };
      }
      if (url === intentOneInitial && failCachedIntentOne) {
        return {
          ok: true, status: 200, url,
          headers: {get: name => name === 'content-type' ? 'text/html' : null},
          async text() { return '<html>no structured article</html>'; }
        };
      }
      const index = url === intentTwo ? 1 : 0;
      return articleResponse(url, index);
    }
  });

  const cold = await service.researchNews({targetSessionDate, horizons});
  assert.equal(cold.type, 'SUCCESS');
  failCachedIntentOne = true;
  const fallback = await service.researchNews({targetSessionDate, horizons});
  failCachedIntentOne = false;
  const replacedWarm = await service.researchNews({targetSessionDate, horizons});

  assert.equal(fallback.type, 'SUCCESS');
  assert.deepEqual(replacedWarm, fallback);
  assert.deepEqual(searchCalls, [2, 1]);
  assert.equal(fallback.candidateCollection.candidates.some(candidate =>
    candidate.canonicalUrl === intentOneReplacement), true);
  assert.deepEqual(diagnostics.filter(item => item.stage === 'cnbcMarketNewsDiscoveryCache'
      && ['EVICTED_AFTER_VALIDATION_FAILURE', 'FALLBACK_DISCOVERY'].includes(item.outcome))
    .map(item => [item.searchIndex, item.outcome]).slice(-2), [
    [1, 'EVICTED_AFTER_VALIDATION_FAILURE'], [1, 'FALLBACK_DISCOVERY']
  ]);
});

test('cached construction failure performs a real cold search only for the affected intent', async () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const intentUrls = [
    'https://www.cnbc.com/2026/09/11/sector-rotation-cache.html',
    'https://www.cnbc.com/2026/09/11/company-mover-cache.html'
  ];
  const searchCalls = [0, 0];
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(options.body);
      const index = body.messages[0].content.includes('leadership laggards') ? 0 : 1;
      searchCalls[index]++;
      return {
        ok: true, status: 200, headers: {get: () => null},
        async json() {
          return {content: [{type: 'web_search_tool_result', content: [{
            type: 'web_search_result', title: `Intent ${index + 1}`, url: intentUrls[index]
          }]}], usage: {server_tool_use: {web_search_requests: 1}}};
        }
      };
    }
    return articleResponse(url, intentUrls.indexOf(url));
  };
  const coldService = createCnbcNewsResearchRuntime({
    apiKey: 'server-key', fetchImpl, cnbcMarketNewsDiscoveryCache: cache
  });
  const cold = await coldService.researchNews({targetSessionDate, horizons});
  assert.equal(cold.type, 'SUCCESS');

  const discovery = createClaudeBoundedCnbcMarketNewsDiscoveryService({
    apiKey: 'server-key', fetchImpl, cnbcMarketNewsDiscoveryCache: cache
  });
  const candidateAcquisition = createCnbcSearchNewsCandidateAcquisitionService({
    discovery,
    articleContentAcquisition: createCnbcArticleContentAcquisitionService({fetchImpl})
  });
  const canonicalConstruction = createCnbcRetrievedArticleEvidenceConstructionService({
    candidateBounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds,
    evidenceConstructionBounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.evidenceConstructionBounds
  });
  let constructionCalls = 0;
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition,
    evidenceConstruction: {
      constructProvisionalEvidence(input) {
        constructionCalls++;
        return constructionCalls === 1 ? {
          ok: false, type: 'EVIDENCE_CONTRACT_FAILURE', message: 'sanitized',
          failedCandidateReferences: ['c1']
        } : canonicalConstruction.constructProvisionalEvidence(input);
      }
    },
    candidateBounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds,
    articleRetrievalBounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds,
    evidenceConstructionBounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.evidenceConstructionBounds
  });

  const result = await service.researchNews({targetSessionDate, horizons});

  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(searchCalls, [2, 1]);
  assert.deepEqual(result.constructedEvidence.map(item => item.evidenceItem.canonicalUrl), intentUrls);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate, searchIndex: 1}) !== null, true);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate, searchIndex: 2}) !== null, true);
});

test('search failure and empty results never create positive cache entries', async () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key', cnbcMarketNewsDiscoveryCache: cache,
    fetchImpl: async () => ({
      ok: true, status: 200, headers: {get: () => null},
      async json() {
        return {content: [{type: 'web_search_tool_result', content: [{
          type: 'web_search_tool_result_error', error_code: 'unavailable'
        }]}]};
      }
    })
  });
  const result = await service.researchNews({targetSessionDate, horizons});
  assert.equal(result.type, 'DISCOVERY_PROVIDER_FAILURE');
  for (const searchIndex of [1, 2]) {
    assert.equal(cache.get({provider: 'CNBC', targetSessionDate, searchIndex}), null);
  }
});

test('contains no RSS or duplicate selected-article retrieval production dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-news-research-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /cnbc-us-market-news-candidate-acquisition|selected-article-retrieval|Market Insider|RSS/i);
  assert.match(source, /claude-bounded-cnbc-market-news-discovery/);
  assert.match(source, /cnbc-search-news-candidate-acquisition/);
  assert.doesNotMatch(source, /claude-news-materiality-selection|invokeClaudeNewsMaterialitySelection/);
});

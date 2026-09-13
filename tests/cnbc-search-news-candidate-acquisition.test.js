const test = require('node:test');
const assert = require('node:assert/strict');
const {getSourceById} = require('../lib/evidence-sources');
const {
  createCnbcSearchNewsCandidateAcquisitionService
} = require('../lib/cnbc-search-news-candidate-acquisition');

const bounds = Object.freeze({
  maxCandidates: 5, maxTitleBytes: 512, maxSummaryBytes: 2048,
  maxExtractBytes: 64, maxCollectionBytes: 32768
});
const articleBounds = Object.freeze({
  timeoutMs: 4000, maxResponseBytes: 1310720, maxArticleTextBytes: 8192,
  maxTitleBytes: 512, maxResultBytes: 12288
});
const horizons = Object.freeze([{
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-10T20:00:00.000Z',
  endsAtInclusive: '2026-09-11T20:00:00.000Z'
}, {
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-11T20:00:00.000Z',
  endsAtInclusive: '2026-09-12T20:00:00.000Z'
}]);

function discovery(rank) {
  return Object.freeze({
    rank, title: `Search title ${rank}`,
    url: `https://www.cnbc.com/2026/09/11/article-${rank}.html`,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate: '2026-09-11'
  });
}
function article(item, overrides = {}) {
  return Object.freeze({
    discoveryRank: item.rank, sourceId: 'us.cnbc', canonicalUrl: item.url,
    publishedAt: '2026-09-11T19:00:00.000Z', updatedAt: null,
    title: `Provider headline ${item.rank}`,
    articleText: `Provider-owned article text for rank ${item.rank}. `.repeat(5),
    provenance: Object.freeze({...getSourceById('us.cnbc').provenance}),
    targetSessionDate: item.targetSessionDate, selectedArticleType: 'NewsArticle',
    ...overrides
  });
}

test('fetches each discovery once, skips failures, and assigns cN after validation in rank order', async () => {
  const discoveries = [discovery(1), discovery(3), discovery(5)];
  const calls = [];
  const diagnostics = [];
  const service = createCnbcSearchNewsCandidateAcquisitionService({
    discovery: {discoverCnbcMarketNews: async input => {
      assert.deepEqual(input, {targetSessionDate: '2026-09-11'});
      return {ok: true, type: 'SUCCESS', discoveries};
    }},
    articleContentAcquisition: {acquireDiscoveredArticleContent: async ({discovery: item}) => {
      calls.push(item.rank);
      if (item.rank === 1) {
        const error = new Error('private');
        error.code = 'EXTRACTION_FAILURE';
        error.extractionFailureType = 'NO_USABLE_BODY';
        throw error;
      }
      return article(item, item.rank === 5 ? {
        publishedAt: '2026-09-11T20:30:00.000Z', updatedAt: '2026-09-11T21:00:00.000Z'
      } : {});
    }},
    onDiagnostics: value => diagnostics.push(value)
  });
  const result = await service.acquireCandidates({
    targetSessionDate: '2026-09-11', horizons, bounds, articleRetrievalBounds: articleBounds
  });
  assert.deepEqual(calls, [1, 3, 5]);
  assert.deepEqual(result.candidateCollection.candidates.map(item => [
    item.reference, item.title, item.horizon.classification
  ]), [
    ['c1', 'Provider headline 3', 'COMPLETED_SESSION'],
    ['c2', 'Provider headline 5', 'SUBSEQUENT_DEVELOPMENT']
  ]);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c1', 'c2']);
  assert.equal(result.candidateCollection.candidates[0].extract.length > 0, true);
  assert.equal(result.candidateCollection.candidates[0].extract.includes('Search title'), false);
  assert.deepEqual(diagnostics[0], {
    stage: 'cnbcDiscoveredArticleAcquisition', rank: 1,
    failureType: 'EXTRACTION_FAILURE', extractionFailureType: 'NO_USABLE_BODY'
  });
});

test('uses provider timestamps only and skips horizon mismatches without fabricating URL dates', async () => {
  const item = discovery(1);
  let material = article(item, {publishedAt: '2026-09-13T12:00:00.000Z'});
  const service = createCnbcSearchNewsCandidateAcquisitionService({
    discovery: {discoverCnbcMarketNews: async () => ({ok: true, type: 'SUCCESS', discoveries: [item]})},
    articleContentAcquisition: {acquireDiscoveredArticleContent: async () => material}
  });
  const result = await service.acquireCandidates({
    targetSessionDate: '2026-09-11', horizons, bounds, articleRetrievalBounds: articleBounds
  });
  assert.deepEqual(result.candidateCollection.candidates, []);
  assert.deepEqual(result.retrievedArticles, []);
});

test('zero search results returns optional empty acquisition and transport failure remains distinct', async () => {
  let articleCalls = 0;
  const empty = createCnbcSearchNewsCandidateAcquisitionService({
    discovery: {discoverCnbcMarketNews: async () => ({ok: true, type: 'NOT_FOUND', discoveries: []})},
    articleContentAcquisition: {acquireDiscoveredArticleContent: async () => { articleCalls++; }}
  });
  const result = await empty.acquireCandidates({
    targetSessionDate: '2026-09-11', horizons, bounds, articleRetrievalBounds: articleBounds
  });
  assert.deepEqual(result.candidateCollection.candidates, []);
  assert.equal(articleCalls, 0);

  const failed = createCnbcSearchNewsCandidateAcquisitionService({
    discovery: {discoverCnbcMarketNews: async () => ({ok: false, type: 'UPSTREAM_FAILURE'})},
    articleContentAcquisition: {acquireDiscoveredArticleContent: async () => {}}
  });
  await assert.rejects(failed.acquireCandidates({
    targetSessionDate: '2026-09-11', horizons, bounds, articleRetrievalBounds: articleBounds
  }), error => error.code === 'DISCOVERY_PROVIDER_FAILURE');
});

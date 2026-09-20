const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createNewsEvidenceCandidate, createNewsEvidenceCandidateCollection}
  = require('../lib/news-evidence-candidates');
const {createCnbcRetrievedArticleEvidenceConstructionService}
  = require('../lib/cnbc-retrieved-article-evidence-construction');
const {
  CNBC_US_NEWS_RESEARCH_RESULT_KEYS,
  createCnbcUsNewsResearchOrchestrationService
} = require('../lib/cnbc-us-news-research-orchestration');

const candidateBounds = Object.freeze({
  maxCandidates: 10, maxTitleBytes: 200, maxSummaryBytes: 500,
  maxExtractBytes: 500, maxCollectionBytes: 20000
});
const articleRetrievalBounds = Object.freeze({
  timeoutMs: 100, maxResponseBytes: 10000, maxArticleTextBytes: 1000,
  maxTitleBytes: 200, maxResultBytes: 3000
});
const evidenceConstructionBounds = Object.freeze({
  maxEvidenceTextBytes: 1000, maxTitleBytes: 200, maxCollectionBytes: 10000
});
const horizons = Object.freeze([Object.freeze({
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-08T10:00:00Z', endsAtInclusive: '2026-09-08T22:00:00Z'
})]);

function candidate(reference) {
  return createNewsEvidenceCandidate({
    reference, horizon: horizons[0], sourceId: 'us.cnbc', market: 'US',
    evidenceCategory: 'news', title: `Canonical title ${reference}`,
    summary: `Canonical summary ${reference}.`, extract: `Compact extract ${reference}.`,
    canonicalUrl: `https://www.cnbc.com/2026/09/08/${reference}.html`,
    publishedAt: '2026-09-08T12:00:00Z', symbols: []
  }, {bounds: candidateBounds});
}

function collection() {
  return createNewsEvidenceCandidateCollection({
    market: 'US', candidates: [candidate('c1'), candidate('c2'), candidate('c3')]
  }, {bounds: candidateBounds});
}

function articleFor(item) {
  return {
    reference: item.reference, sourceId: item.sourceId, canonicalUrl: item.canonicalUrl,
    publishedAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T13:00:00.000Z',
    title: item.title, articleText: `Full bounded article text for ${item.reference}.`,
    provenance: {...item.provenance}
  };
}

function composedService(overrides = {}) {
  const candidates = collection();
  const evidenceConstruction = createCnbcRetrievedArticleEvidenceConstructionService({
    candidateBounds, evidenceConstructionBounds
  });
  return createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => ({
      candidateCollection: candidates, retrievedArticles: candidates.candidates.map(articleFor)
    })},
    evidenceConstruction, candidateBounds, articleRetrievalBounds, evidenceConstructionBounds,
    ...overrides
  });
}

test('returns every validated page as compact provisional evidence in provider order without materiality', async () => {
  const result = await composedService().researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result), CNBC_US_NEWS_RESEARCH_RESULT_KEYS);
  assert.deepEqual(result.selections, []);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c1', 'c2', 'c3']);
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), ['c1', 'c2', 'c3']);
  assert.deepEqual(result.constructedEvidence.map(item => item.evidenceItem.summary), [
    'Compact extract c1.', 'Compact extract c2.', 'Compact extract c3.'
  ]);
});

test('forwards unchanged acquisition and construction bounds with no semantic invocation', async () => {
  const candidates = collection();
  const calls = {};
  const records = candidates.candidates.map(candidateItem => ({
    candidateReference: candidateItem.reference, horizon: candidateItem.horizon,
    evidenceItem: createEvidenceItem({
      sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: candidateItem.title,
      summary: candidateItem.extract, canonicalUrl: candidateItem.canonicalUrl,
      publishedAt: candidateItem.publishedAt, symbols: []
    })
  }));
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async input => {
      calls.acquisition = input;
      return {candidateCollection: candidates, retrievedArticles: candidates.candidates.map(articleFor)};
    }},
    evidenceConstruction: {constructProvisionalEvidence: input => {
      calls.construction = input;
      return {ok: true, type: 'SUCCESS', constructedEvidence: records};
    }},
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });
  assert.equal((await service.researchNews({targetSessionDate: '2026-09-08', horizons})).ok, true);
  assert.deepEqual(calls.acquisition, {
    targetSessionDate: '2026-09-08', horizons, bounds: candidateBounds, articleRetrievalBounds
  });
  assert.deepEqual(calls.construction.evidenceConstructionBounds, evidenceConstructionBounds);
});

test('candidate absence and provider failures skip construction', async () => {
  for (const [acquireCandidates, expectedType] of [
    [async () => {
      const error = new Error('detail'); error.code = 'DISCOVERY_PROVIDER_FAILURE'; throw error;
    }, 'DISCOVERY_PROVIDER_FAILURE'],
    [async () => { throw new Error('detail'); }, 'CANDIDATE_ACQUISITION_FAILURE']
  ]) {
    let constructionCalls = 0;
    const service = createCnbcUsNewsResearchOrchestrationService({
      candidateAcquisition: {acquireCandidates},
      evidenceConstruction: {constructProvisionalEvidence: () => { constructionCalls++; }},
      candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
    });
    assert.equal((await service.researchNews({horizons})).type, expectedType);
    assert.equal(constructionCalls, 0);
  }
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => ({
      candidateCollection: createNewsEvidenceCandidateCollection(
        {market: 'US', candidates: []}, {bounds: candidateBounds}
      ), retrievedArticles: []
    })},
    evidenceConstruction: {constructProvisionalEvidence: () => { throw new Error('not expected'); }},
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });
  assert.equal((await service.researchNews({horizons})).type, 'NOT_FOUND');
});

test('article identity mismatch fails before construction and construction failure is atomic', async () => {
  const candidates = collection();
  const articles = candidates.candidates.map(articleFor);
  articles[0] = {...articles[0], reference: 'c2'};
  let constructionCalls = 0;
  let service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => ({
      candidateCollection: candidates, retrievedArticles: articles
    })},
    evidenceConstruction: {constructProvisionalEvidence: () => { constructionCalls++; }},
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });
  assert.equal((await service.researchNews({horizons})).type, 'ARTICLE_RETRIEVAL_FAILURE');
  assert.equal(constructionCalls, 0);
  service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => ({
      candidateCollection: candidates, retrievedArticles: candidates.candidates.map(articleFor)
    })},
    evidenceConstruction: {constructProvisionalEvidence: () => ({ok: false})},
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });
  assert.equal((await service.researchNews({horizons})).type, 'EVIDENCE_CONSTRUCTION_FAILURE');
});

test('construction failure evicts and fallback-discovers only the affected cached intent', async () => {
  const candidates = createNewsEvidenceCandidateCollection({
    market: 'US', candidates: Array.from({length: 5}, (_, index) => candidate(`c${index + 1}`))
  }, {bounds: candidateBounds});
  let acquisitionCalls = 0;
  let constructionCalls = 0;
  let completionCalls = 0;
  const cachedSearchIndexes = new Set([1, 2]);
  const searchCalls = [0, 0];
  const intentForReference = reference => Number(reference.slice(1)) <= 3 ? 1 : 2;
  const candidateAcquisition = {
    async acquireCandidates() {
      acquisitionCalls++;
      for (const searchIndex of [1, 2]) {
        if (!cachedSearchIndexes.has(searchIndex)) searchCalls[searchIndex - 1]++;
      }
      return {
        candidateCollection: candidates,
        retrievedArticles: candidates.candidates.map(articleFor)
      };
    },
    evictValidatedCacheHits(acquired, failedCandidateReferences) {
      const affected = [...new Set(failedCandidateReferences.map(intentForReference))];
      for (const searchIndex of affected) cachedSearchIndexes.delete(searchIndex);
      return true;
    },
    completeValidatedDiscoveries() {
      completionCalls++;
      cachedSearchIndexes.add(1);
      cachedSearchIndexes.add(2);
    }
  };
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition,
    evidenceConstruction: {
      constructProvisionalEvidence() {
        constructionCalls++;
        return constructionCalls === 1 ? {
          ok: false,
          type: 'EVIDENCE_CONTRACT_FAILURE',
          message: 'sanitized',
          failedCandidateReferences: ['c2']
        }
          : createCnbcRetrievedArticleEvidenceConstructionService({
            candidateBounds, evidenceConstructionBounds
          }).constructProvisionalEvidence({
            candidateCollection: candidates,
            retrievedArticles: candidates.candidates.map(articleFor),
            evidenceConstructionBounds
          });
      }
    },
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });

  const result = await service.researchNews({targetSessionDate: '2026-09-08', horizons});
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), [
    'c1', 'c2', 'c3', 'c4', 'c5'
  ]);
  assert.equal(acquisitionCalls, 2);
  assert.equal(constructionCalls, 2);
  assert.deepEqual(searchCalls, [1, 0]);
  assert.deepEqual([...cachedSearchIndexes], [2, 1]);
  assert.equal(completionCalls, 1);
});

test('mapped cached failure does not rediscover when actual eviction reports false', async () => {
  const candidates = collection();
  let acquisitionCalls = 0;
  let constructionCalls = 0;
  let evictionCalls = 0;
  let fallbackSearchCalls = 0;
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {
      async acquireCandidates() {
        acquisitionCalls++;
        if (acquisitionCalls > 1) fallbackSearchCalls++;
        return {
          candidateCollection: candidates,
          retrievedArticles: candidates.candidates.map(articleFor)
        };
      },
      evictValidatedCacheHits(acquired, failedCandidateReferences) {
        evictionCalls++;
        assert.deepEqual(failedCandidateReferences, ['c1']);
        return false;
      }
    },
    evidenceConstruction: {
      constructProvisionalEvidence() {
        constructionCalls++;
        return {
          ok: false,
          type: 'EVIDENCE_CONTRACT_FAILURE',
          message: 'sanitized',
          failedCandidateReferences: ['c1']
        };
      }
    },
    candidateBounds, articleRetrievalBounds, evidenceConstructionBounds
  });

  const result = await service.researchNews({targetSessionDate: '2026-09-08', horizons});

  assert.equal(result.type, 'EVIDENCE_CONSTRUCTION_FAILURE');
  assert.equal(acquisitionCalls, 1);
  assert.equal(constructionCalls, 1);
  assert.equal(evictionCalls, 1);
  assert.equal(fallbackSearchCalls, 0);
});

test('diagnostics prove zero materiality calls and contain only safe counts and timing', async () => {
  const diagnostics = [];
  const result = await composedService({onDiagnostics: value => diagnostics.push(value)})
    .researchNews({horizons});
  assert.equal(result.ok, true);
  const diagnostic = diagnostics.at(-1);
  assert.deepEqual(diagnostic.counts, {
    candidateCount: 3, useCount: 0, skipCount: 0, retrievedArticleCount: 3,
    constructedEvidenceCount: 3, materialityInvocationCount: 0
  });
  for (const forbidden of ['c1', 'cnbc.com', 'Canonical title', 'Compact extract']) {
    assert.equal(JSON.stringify(diagnostic).includes(forbidden), false);
  }
});

test('result is deeply immutable and contains no final eN references', async () => {
  const result = await composedService().researchNews({horizons});
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.constructedEvidence[0].evidenceItem), true);
  assert.equal(JSON.stringify(result).includes('evidenceRef'), false);
});

test('active path contains no materiality or final-package dependency', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/cnbc-us-news-research-orchestration.js'), 'utf8'
  );
  for (const forbidden of [
    'invokeMaterialitySelection', 'createClaudeNewsMaterialityOutput',
    'us-analysis-package-orchestration', 'claude-analysis-invocation', 'evidenceRefs'
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

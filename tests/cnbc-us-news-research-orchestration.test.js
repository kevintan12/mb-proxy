const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {createEvidenceItem} = require('../lib/evidence-items');
const {
  createCnbcSelectedArticleRetrievalOrchestrationService
} = require('../lib/cnbc-selected-article-retrieval-orchestration');
const {
  createCnbcRetrievedArticleEvidenceConstructionService
} = require('../lib/cnbc-retrieved-article-evidence-construction');
const {
  CNBC_US_NEWS_RESEARCH_RESULT_KEYS,
  CNBC_US_NEWS_RESEARCH_RESULT_TYPES,
  createCnbcUsNewsResearchOrchestrationService
} = require('../lib/cnbc-us-news-research-orchestration');

const candidateBounds = Object.freeze({
  maxCandidates: 10,
  maxTitleBytes: 200,
  maxSummaryBytes: 500,
  maxExtractBytes: 500,
  maxCollectionBytes: 20000
});
const articleRetrievalBounds = Object.freeze({
  timeoutMs: 100,
  maxResponseBytes: 10000,
  maxArticleTextBytes: 1000,
  maxTitleBytes: 200,
  maxResultBytes: 3000
});
const evidenceConstructionBounds = Object.freeze({
  maxEvidenceTextBytes: 1000,
  maxTitleBytes: 200,
  maxCollectionBytes: 10000
});
const horizons = Object.freeze([Object.freeze({
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-08T10:00:00Z',
  endsAtInclusive: '2026-09-08T22:00:00Z'
})]);

function candidate(reference) {
  return createNewsEvidenceCandidate({
    reference,
    horizon: horizons[0],
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: `Canonical title ${reference}`,
    summary: `Canonical summary ${reference}.`,
    extract: null,
    canonicalUrl: `https://www.cnbc.com/2026/09/08/${reference}.html`,
    publishedAt: '2026-09-08T12:00:00Z',
    symbols: []
  }, {bounds: candidateBounds});
}

function collection() {
  return createNewsEvidenceCandidateCollection({
    market: 'US',
    candidates: [candidate('c1'), candidate('c2'), candidate('c3')]
  }, {bounds: candidateBounds});
}

function selectionOutput(decisions) {
  return {selections: decisions.map((decision, index) => ({
    reference: `c${index + 1}`,
    decision,
    category: 'news',
    materiality: decision === 'USE' ? 'HIGH' : 'LOW',
    reason: decision === 'USE' ? 'Selected for research.' : 'Not material.'
  }))};
}

function articleFor(item) {
  return {
    reference: item.reference,
    sourceId: item.sourceId,
    canonicalUrl: item.canonicalUrl,
    publishedAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T13:00:00.000Z',
    title: item.title,
    articleText: `Bounded article text for ${item.reference}.`,
    provenance: {...item.provenance}
  };
}

function composedService(decisions, overrides = {}) {
  const acquired = collection();
  const articleCalls = [];
  const selectedArticleRetrieval = createCnbcSelectedArticleRetrievalOrchestrationService({
    articleContentAcquisition: {
      async acquireArticleContent({candidate: item}) {
        articleCalls.push(item.reference);
        return articleFor(item);
      }
    },
    candidateBounds,
    articleRetrievalBounds
  });
  const evidenceConstruction = createCnbcRetrievedArticleEvidenceConstructionService({
    candidateBounds,
    evidenceConstructionBounds
  });
  let materialityCalls = 0;
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => acquired},
    invokeMaterialitySelection: async () => {
      materialityCalls++;
      return {ok: true, type: 'SUCCESS', output: selectionOutput(decisions)};
    },
    selectedArticleRetrieval,
    evidenceConstruction,
    candidateBounds,
    articleRetrievalBounds,
    evidenceConstructionBounds,
    ...overrides
  });
  return {service, articleCalls, materialityCalls: () => materialityCalls};
}

test('all SKIP completes all four stages with zero article fetches and empty evidence', async () => {
  const composed = composedService(['SKIP', 'SKIP', 'SKIP']);
  const result = await composed.service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result), CNBC_US_NEWS_RESEARCH_RESULT_KEYS);
  assert.deepEqual(composed.articleCalls, []);
  assert.equal(composed.materialityCalls(), 1);
  assert.deepEqual(result.retrievedArticles, []);
  assert.deepEqual(result.constructedEvidence, []);
});

test('one USE preserves cN linkage through selection, article and evidence', async () => {
  const composed = composedService(['SKIP', 'USE', 'SKIP']);
  const result = await composed.service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(composed.articleCalls, ['c2']);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c2']);
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), ['c2']);
  assert.equal(result.constructedEvidence[0].selection.reference, 'c2');
  assert.equal(result.constructedEvidence[0].evidenceItem.summary, result.retrievedArticles[0].articleText);
});

test('multiple USE candidates retain deterministic candidate order and identity', async () => {
  const composed = composedService(['USE', 'SKIP', 'USE']);
  const result = await composed.service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(composed.articleCalls, ['c1', 'c3']);
  assert.deepEqual(result.candidateCollection.candidates.map(item => item.reference), ['c1', 'c2', 'c3']);
  assert.deepEqual(result.selections.map(item => item.reference), ['c1', 'c2', 'c3']);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c1', 'c3']);
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), ['c1', 'c3']);
  for (const record of result.constructedEvidence) {
    const candidateItem = result.candidateCollection.candidates.find(
      item => item.reference === record.candidateReference
    );
    assert.equal(record.evidenceItem.sourceId, candidateItem.sourceId);
    assert.equal(record.evidenceItem.canonicalUrl, candidateItem.canonicalUrl);
    assert.deepEqual(record.evidenceItem.provenance, candidateItem.provenance);
    assert.deepEqual(record.horizon, candidateItem.horizon);
  }
});

test('forwards the explicit bounds to their respective stage boundaries', async () => {
  const candidates = collection();
  const output = selectionOutput(['SKIP', 'SKIP', 'SKIP']);
  const calls = {};
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {
      acquireCandidates: async input => {
        calls.acquisition = input;
        return candidates;
      }
    },
    invokeMaterialitySelection: async input => {
      calls.materiality = input;
      return {ok: true, type: 'SUCCESS', output};
    },
    selectedArticleRetrieval: {
      retrieveSelectedArticles: async input => {
        calls.retrieval = input;
        return {
          ok: true,
          type: 'SUCCESS',
          candidateCollection: candidates,
          selections: output.selections,
          retrievedArticles: []
        };
      }
    },
    evidenceConstruction: {
      constructEvidence: input => {
        calls.construction = input;
        return {ok: true, type: 'SUCCESS', constructedEvidence: []};
      }
    },
    candidateBounds,
    articleRetrievalBounds,
    evidenceConstructionBounds
  });
  const result = await service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(calls.acquisition, {horizons, bounds: candidateBounds});
  assert.deepEqual(calls.materiality.candidateBounds, candidateBounds);
  assert.deepEqual(calls.retrieval.articleRetrievalBounds, articleRetrievalBounds);
  assert.deepEqual(calls.construction.evidenceConstructionBounds, evidenceConstructionBounds);
});

test('candidate acquisition failure and empty output fail before materiality', async () => {
  for (const acquireCandidates of [
    async () => { throw new Error('provider detail'); },
    async () => createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds: candidateBounds})
  ]) {
    let materialityCalls = 0;
    const service = createCnbcUsNewsResearchOrchestrationService({
      candidateAcquisition: {acquireCandidates},
      invokeMaterialitySelection: async () => { materialityCalls++; },
      selectedArticleRetrieval: {retrieveSelectedArticles: async () => {}},
      evidenceConstruction: {constructEvidence: () => {}},
      candidateBounds,
      articleRetrievalBounds,
      evidenceConstructionBounds
    });
    assert.deepEqual(await service.researchNews({horizons}), {
      ok: false,
      type: 'CANDIDATE_ACQUISITION_FAILURE',
      message: 'CNBC news candidate acquisition failed'
    });
    assert.equal(materialityCalls, 0);
  }
});

test('materiality provider, contract and size failures remain distinct with one invocation', async () => {
  const cases = [
    ['UPSTREAM_FAILURE', 'MATERIALITY_PROVIDER_FAILURE'],
    ['CONTRACT_FAILURE', 'MATERIALITY_CONTRACT_FAILURE'],
    ['INPUT_FAILURE', 'MATERIALITY_CONTRACT_FAILURE'],
    ['REQUEST_TOO_LARGE', 'MATERIALITY_REQUEST_TOO_LARGE']
  ];
  for (const [sourceType, expectedType] of cases) {
    let calls = 0;
    const service = createCnbcUsNewsResearchOrchestrationService({
      candidateAcquisition: {acquireCandidates: async () => collection()},
      invokeMaterialitySelection: async () => {
        calls++;
        return {ok: false, type: sourceType};
      },
      selectedArticleRetrieval: {retrieveSelectedArticles: async () => {}},
      evidenceConstruction: {constructEvidence: () => {}},
      candidateBounds,
      articleRetrievalBounds,
      evidenceConstructionBounds
    });
    const result = await service.researchNews({horizons});
    assert.equal(result.type, expectedType);
    assert.equal(calls, 1);
  }
});

test('invalid materiality success output fails contract validation before retrieval', async () => {
  let retrievalCalls = 0;
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => collection()},
    invokeMaterialitySelection: async () => ({ok: true, type: 'SUCCESS', output: {selections: []}}),
    selectedArticleRetrieval: {retrieveSelectedArticles: async () => { retrievalCalls++; }},
    evidenceConstruction: {constructEvidence: () => {}},
    candidateBounds,
    articleRetrievalBounds,
    evidenceConstructionBounds
  });
  const result = await service.researchNews({horizons});
  assert.equal(result.type, 'MATERIALITY_CONTRACT_FAILURE');
  assert.equal(retrievalCalls, 0);
});

test('article retrieval failure prevents evidence construction and partial success', async () => {
  let constructionCalls = 0;
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => collection()},
    invokeMaterialitySelection: async () => ({
      ok: true, type: 'SUCCESS', output: selectionOutput(['USE', 'SKIP', 'SKIP'])
    }),
    selectedArticleRetrieval: {
      retrieveSelectedArticles: async () => ({ok: false, type: 'ARTICLE_RETRIEVAL_FAILURE'})
    },
    evidenceConstruction: {constructEvidence: () => { constructionCalls++; }},
    candidateBounds,
    articleRetrievalBounds,
    evidenceConstructionBounds
  });
  const result = await service.researchNews({horizons});
  assert.deepEqual(result, {
    ok: false,
    type: 'ARTICLE_RETRIEVAL_FAILURE',
    message: 'CNBC selected article retrieval failed'
  });
  assert.equal(constructionCalls, 0);
});

test('evidence construction failure returns no partial research result', async () => {
  const candidates = collection();
  const output = selectionOutput(['USE', 'SKIP', 'SKIP']);
  const service = createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition: {acquireCandidates: async () => candidates},
    invokeMaterialitySelection: async () => ({ok: true, type: 'SUCCESS', output}),
    selectedArticleRetrieval: {
      retrieveSelectedArticles: async () => ({
        ok: true,
        type: 'SUCCESS',
        candidateCollection: candidates,
        selections: output.selections,
        retrievedArticles: [articleFor(candidates.candidates[0])]
      })
    },
    evidenceConstruction: {constructEvidence: () => ({ok: false, type: 'EVIDENCE_TOO_LARGE'})},
    candidateBounds,
    articleRetrievalBounds,
    evidenceConstructionBounds
  });
  const result = await service.researchNews({horizons});
  assert.deepEqual(result, {
    ok: false,
    type: 'EVIDENCE_CONSTRUCTION_FAILURE',
    message: 'CNBC canonical evidence construction failed'
  });
  assert.equal(Object.hasOwn(result, 'constructedEvidence'), false);
});

test('emits sanitized stage timings/counts and preserves materiality diagnostics callback', async () => {
  const diagnostics = [];
  const providerDiagnostic = Object.freeze({model: 'provider-model', fetchCount: 1});
  const composed = composedService(['USE', 'SKIP', 'USE'], {
    onDiagnostics: value => diagnostics.push(value),
    invokeMaterialitySelection: async ({onDiagnostics}) => {
      onDiagnostics(providerDiagnostic);
      return {ok: true, type: 'SUCCESS', output: selectionOutput(['USE', 'SKIP', 'USE'])};
    }
  });
  const result = await composed.service.researchNews({horizons});
  assert.equal(result.ok, true);
  assert.deepEqual(diagnostics[0], providerDiagnostic);
  const stageDiagnostic = diagnostics[1];
  assert.equal(stageDiagnostic.stage, 'cnbcNewsResearch');
  for (const value of Object.values(stageDiagnostic.timing)) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0);
  }
  assert.deepEqual(stageDiagnostic.counts, {
    candidateCount: 3,
    useCount: 2,
    skipCount: 1,
    retrievedArticleCount: 2,
    constructedEvidenceCount: 2,
    materialityInvocationCount: 1
  });
  const serialized = JSON.stringify(stageDiagnostic);
  for (const forbidden of ['c1', 'cnbc.com', 'Canonical title', 'Bounded article', 'reason']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('returns an immutable input-independent result without final evidence references', async () => {
  const composed = composedService(['USE', 'SKIP', 'USE']);
  const result = await composed.service.researchNews({horizons});
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidateCollection), true);
  assert.equal(Object.isFrozen(result.selections), true);
  assert.equal(Object.isFrozen(result.retrievedArticles), true);
  assert.equal(Object.isFrozen(result.constructedEvidence), true);
  assert.equal(JSON.stringify(result).includes('evidenceRef'), false);
  assert.equal(result.constructedEvidence.every(record =>
    createEvidenceItem({
      sourceId: record.evidenceItem.sourceId,
      market: record.evidenceItem.market,
      evidenceCategory: record.evidenceItem.evidenceCategory,
      title: record.evidenceItem.title,
      summary: record.evidenceItem.summary,
      canonicalUrl: record.evidenceItem.canonicalUrl,
      publishedAt: record.evidenceItem.publishedAt,
      symbols: record.evidenceItem.symbols
    }).canonicalUrl === record.evidenceItem.canonicalUrl), true);
});

test('contains no final package, synthesis, provider expansion, or reference assignment', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/cnbc-us-news-research-orchestration.js'),
    'utf8'
  );
  for (const forbidden of [
    'us-analysis-package-orchestration',
    'analysis-package-service',
    'claude-analysis-invocation',
    'evidenceRefs',
    'yahoo',
    'reuters',
    'poems'
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.deepEqual(CNBC_US_NEWS_RESEARCH_RESULT_TYPES, [
    'SUCCESS',
    'CANDIDATE_ACQUISITION_FAILURE',
    'MATERIALITY_PROVIDER_FAILURE',
    'MATERIALITY_CONTRACT_FAILURE',
    'MATERIALITY_REQUEST_TOO_LARGE',
    'ARTICLE_RETRIEVAL_FAILURE',
    'EVIDENCE_CONSTRUCTION_FAILURE'
  ]);
});

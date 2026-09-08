const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {invokeClaudeNewsMaterialitySelection} = require('../lib/claude-news-materiality-selection');
const {
  CNBC_US_NEWS_MATERIALITY_RESULT_TYPES,
  createCnbcUsNewsMaterialityOrchestrationService
} = require('../lib/cnbc-us-news-materiality-orchestration');

const bounds = Object.freeze({
  maxCandidates: 30,
  maxTitleBytes: 200,
  maxSummaryBytes: 1000,
  maxExtractBytes: 1000,
  maxCollectionBytes: 50000
});
const horizons = Object.freeze([{
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-07T20:00:00Z',
  endsAtInclusive: '2026-09-08T20:00:00Z'
}]);

function candidate(reference, overrides = {}, candidateBounds = bounds) {
  return createNewsEvidenceCandidate({
    reference,
    horizon: horizons[0],
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: `MarketBrief-owned ${reference}`,
    summary: `Canonical evidence content for ${reference}.`,
    extract: null,
    canonicalUrl: `https://www.cnbc.com/${reference}.html`,
    publishedAt: '2026-09-08T13:00:00Z',
    symbols: [],
    ...overrides
  }, {bounds: candidateBounds});
}

function candidateCollection(candidateBounds = bounds, candidates = [candidate('c1'), candidate('c2')]) {
  return createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds: candidateBounds});
}

function materialityOutput() {
  return {
    selections: [{
      reference: 'c1', decision: 'USE', category: 'news', materiality: 'HIGH',
      reason: 'Material broad-market development.'
    }, {
      reference: 'c2', decision: 'SKIP', category: 'news', materiality: 'LOW',
      reason: 'Limited incremental relevance.'
    }]
  };
}

function anthropicResponse(output) {
  return {
    ok: true,
    status: 200,
    headers: {get: () => 'req_orchestration_1'},
    async json() {
      return {content: [{type: 'text', text: JSON.stringify(output)}], usage: {input_tokens: 100}};
    }
  };
}

test('acquires canonical CNBC candidates and invokes materiality exactly once', async () => {
  const acquired = candidateCollection();
  const acquisitionCalls = [];
  const anthropicCalls = [];
  const diagnostics = [];
  const service = createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    onDiagnostics: value => diagnostics.push(value),
    candidateAcquisition: {
      async acquireCandidates(input) {
        acquisitionCalls.push(input);
        return acquired;
      }
    },
    invokeMaterialitySelection: input => invokeClaudeNewsMaterialitySelection({
      ...input,
      apiKey: 'secret',
      fetchImpl: async (...args) => {
        anthropicCalls.push(args);
        return anthropicResponse(materialityOutput());
      }
    })
  });

  const result = await service.selectMaterialNews({horizons});
  assert.equal(result.ok, true);
  assert.equal(acquisitionCalls.length, 1);
  assert.deepEqual(acquisitionCalls[0], {horizons, bounds});
  assert.equal(anthropicCalls.length, 1);
  const request = JSON.parse(anthropicCalls[0][1].body);
  assert.deepEqual(JSON.parse(request.messages[0].content), result.candidateCollection);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].fetchCount, 1);
});

test('returns immutable canonical candidates and validated metadata joined only by original references', async () => {
  const acquired = candidateCollection();
  const service = createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    candidateAcquisition: {acquireCandidates: async () => acquired},
    invokeMaterialitySelection: async () => ({ok: true, type: 'SUCCESS', output: materialityOutput()})
  });
  const result = await service.selectMaterialNews({horizons});
  assert.deepEqual(Object.keys(result), ['ok', 'type', 'candidateCollection', 'selections']);
  assert.deepEqual(result.selections.map(item => item.reference),
    result.candidateCollection.candidates.map(item => item.reference));
  assert.deepEqual(result.candidateCollection, acquired);
  assert.notEqual(result.candidateCollection, acquired);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidateCollection), true);
  assert.equal(Object.isFrozen(result.selections), true);
  assert.equal(Object.isFrozen(result.selections[0]), true);

  const selectionText = JSON.stringify(result.selections);
  for (const forbidden of ['canonicalUrl', 'provenance', 'title', 'summary', 'symbols', 'cnbc.com']) {
    assert.equal(selectionText.includes(forbidden), false);
  }
  assert.equal(result.candidateCollection.candidates[0].canonicalUrl, acquired.candidates[0].canonicalUrl);
  assert.deepEqual(result.candidateCollection.candidates[0].provenance, acquired.candidates[0].provenance);
  assert.equal(result.candidateCollection.candidates[0].title, acquired.candidates[0].title);
});

test('reports CNBC acquisition failure distinctly without invoking materiality', async () => {
  let invocations = 0;
  const service = createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    candidateAcquisition: {acquireCandidates: async () => { throw new Error('provider detail'); }},
    invokeMaterialitySelection: async () => { invocations++; }
  });
  assert.deepEqual(await service.selectMaterialNews({horizons}), {
    ok: false,
    type: 'CANDIDATE_ACQUISITION_FAILURE',
    message: 'CNBC news candidate acquisition failed'
  });
  assert.equal(invocations, 0);
});

test('rejects a canonical empty candidate collection without invoking materiality', async () => {
  let invocations = 0;
  const empty = createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds});
  const service = createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    candidateAcquisition: {acquireCandidates: async () => empty},
    invokeMaterialitySelection: async () => { invocations++; }
  });
  const result = await service.selectMaterialNews({horizons});
  assert.deepEqual(result, {
    ok: false,
    type: 'CANDIDATE_ACQUISITION_FAILURE',
    message: 'CNBC news candidate acquisition failed'
  });
  assert.equal(invocations, 0);
  assert.notEqual(result.type, 'SUCCESS');
});

test('reports materiality provider failure distinctly without fallback', async () => {
  for (const invokeMaterialitySelection of [
    async () => ({ok: false, type: 'UPSTREAM_FAILURE'}),
    async () => { throw new Error('private upstream detail'); }
  ]) {
    const result = await createCnbcUsNewsMaterialityOrchestrationService({
      candidateBounds: bounds,
      candidateAcquisition: {acquireCandidates: async () => candidateCollection()},
      invokeMaterialitySelection
    }).selectMaterialNews({horizons});
    assert.deepEqual(result, {
      ok: false,
      type: 'MATERIALITY_PROVIDER_FAILURE',
      message: 'CNBC news materiality invocation failed'
    });
    assert.equal(Object.hasOwn(result, 'candidateCollection'), false);
    assert.equal(Object.hasOwn(result, 'selections'), false);
  }
});

test('reports invocation and independently detected materiality contract failures distinctly', async () => {
  for (const output of [
    {ok: false, type: 'CONTRACT_FAILURE'},
    {ok: true, type: 'SUCCESS', output: {selections: []}},
    {ok: true, type: 'SUCCESS', output: {
      selections: materialityOutput().selections.map(item => ({...item, reference: 'unknown'}))
    }}
  ]) {
    const result = await createCnbcUsNewsMaterialityOrchestrationService({
      candidateBounds: bounds,
      candidateAcquisition: {acquireCandidates: async () => candidateCollection()},
      invokeMaterialitySelection: async () => output
    }).selectMaterialNews({horizons});
    assert.deepEqual(result, {
      ok: false,
      type: 'MATERIALITY_CONTRACT_FAILURE',
      message: 'CNBC news materiality output failed validation'
    });
  }
});

test('propagates the materiality request-size failure distinctly without fallback', async () => {
  const result = await createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    candidateAcquisition: {acquireCandidates: async () => candidateCollection()},
    invokeMaterialitySelection: async () => ({ok: false, type: 'REQUEST_TOO_LARGE'})
  }).selectMaterialNews({horizons});
  assert.deepEqual(result, {
    ok: false,
    type: 'MATERIALITY_REQUEST_TOO_LARGE',
    message: 'CNBC news materiality request exceeds its provisional size limit'
  });
});

test('rejects invalid acquired collections as acquisition failures before materiality', async () => {
  let invocations = 0;
  const altered = JSON.parse(JSON.stringify(candidateCollection()));
  altered.candidates[0].provenance.publisher = 'Spoofed';
  const result = await createCnbcUsNewsMaterialityOrchestrationService({
    candidateBounds: bounds,
    candidateAcquisition: {acquireCandidates: async () => altered},
    invokeMaterialitySelection: async () => { invocations++; }
  }).selectMaterialNews({horizons});
  assert.equal(result.type, 'CANDIDATE_ACQUISITION_FAILURE');
  assert.equal(invocations, 0);
});

test('does not import or integrate the final analysis package or Claude synthesis paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-us-news-materiality-orchestration.js'), 'utf8');
  for (const forbidden of [
    'us-analysis-package-orchestration',
    'analysis-package-service',
    'claude-analysis-invocation',
    'createClaudeAnalysisInput',
    'evidenceRefs',
    'upcomingEvents',
    'furtherReadings'
  ]) {
    assert.equal(source.includes(forbidden), false);
  }
  assert.deepEqual(CNBC_US_NEWS_MATERIALITY_RESULT_TYPES, [
    'SUCCESS',
    'CANDIDATE_ACQUISITION_FAILURE',
    'MATERIALITY_PROVIDER_FAILURE',
    'MATERIALITY_CONTRACT_FAILURE',
    'MATERIALITY_REQUEST_TOO_LARGE'
  ]);
});

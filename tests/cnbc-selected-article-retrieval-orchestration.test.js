const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {
  CNBC_ARTICLE_ACQUISITION_DIAGNOSTIC_FAILURE_TYPES,
  CNBC_SELECTED_ARTICLE_RETRIEVAL_RESULT_TYPES,
  createCnbcSelectedArticleRetrievalOrchestrationService
} = require('../lib/cnbc-selected-article-retrieval-orchestration');

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
const horizon = Object.freeze({
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-08T10:00:00Z',
  endsAtInclusive: '2026-09-08T22:00:00Z'
});

function candidate(reference) {
  return createNewsEvidenceCandidate({
    reference,
    horizon,
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

function selections(decisions = ['USE', 'SKIP', 'USE']) {
  return decisions.map((decision, index) => ({
    reference: `c${index + 1}`,
    decision,
    category: 'news',
    materiality: decision === 'USE' ? 'HIGH' : 'LOW',
    reason: decision === 'USE' ? 'Selected for bounded retrieval.' : 'Not selected.'
  }));
}

function articleFor(item, overrides = {}) {
  return {
    reference: item.reference,
    sourceId: item.sourceId,
    canonicalUrl: item.canonicalUrl,
    publishedAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T13:00:00.000Z',
    title: item.title,
    articleText: `Bounded article text for ${item.reference}.`,
    provenance: {...item.provenance},
    ...overrides
  };
}

function serviceWith(acquireArticleContent, onDiagnostics) {
  return createCnbcSelectedArticleRetrievalOrchestrationService({
    articleContentAcquisition: {acquireArticleContent},
    candidateBounds,
    articleRetrievalBounds,
    onDiagnostics
  });
}

test('all SKIP selections preserve canonical inputs and perform zero article fetches', async () => {
  const inputCollection = collection();
  const inputSelections = selections(['SKIP', 'SKIP', 'SKIP']);
  let calls = 0;
  const result = await serviceWith(async () => { calls++; }).retrieveSelectedArticles({
    candidateCollection: inputCollection,
    selections: inputSelections
  });

  assert.deepEqual(Object.keys(result), [
    'ok', 'type', 'candidateCollection', 'selections', 'retrievedArticles'
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(calls, 0);
  assert.deepEqual(result.retrievedArticles, []);
  assert.deepEqual(result.candidateCollection, inputCollection);
  assert.deepEqual(result.selections, inputSelections);
  assert.notEqual(result.candidateCollection, inputCollection);
  assert.notEqual(result.selections, inputSelections);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidateCollection), true);
  assert.equal(Object.isFrozen(result.selections), true);
  assert.equal(Object.isFrozen(result.retrievedArticles), true);
});

test('one USE performs one retrieval with the exact canonical candidate and bounds', async () => {
  const inputCollection = collection();
  const calls = [];
  const result = await serviceWith(async input => {
    calls.push(input);
    return articleFor(input.candidate);
  }).retrieveSelectedArticles({
    candidateCollection: inputCollection,
    selections: selections(['SKIP', 'USE', 'SKIP'])
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidate.reference, 'c2');
  assert.deepEqual(calls[0].bounds, articleRetrievalBounds);
  assert.deepEqual(result.retrievedArticles.map(article => article.reference), ['c2']);
  assert.equal(Object.isFrozen(result.retrievedArticles[0]), true);
  assert.equal(Object.isFrozen(result.retrievedArticles[0].provenance), true);
});

test('multiple USE candidates are retrieved once each, sequentially, in canonical order', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const result = await serviceWith(async ({candidate: item}) => {
    calls.push(item.reference);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return articleFor(item);
  }).retrieveSelectedArticles({
    candidateCollection: collection(),
    selections: selections()
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['c1', 'c3']);
  assert.deepEqual(result.retrievedArticles.map(article => article.reference), ['c1', 'c3']);
  assert.equal(maximumActive, 1);
});

test('revalidates full ordered selection coverage before any article retrieval', async () => {
  const valid = selections();
  const invalidSelections = [
    valid.slice(0, 2),
    [...valid, {...valid[0]}],
    [{...valid[0], reference: 'c9'}, valid[1], valid[2]],
    [valid[1], valid[0], valid[2]]
  ];
  for (const invalid of invalidSelections) {
    let calls = 0;
    const result = await serviceWith(async () => { calls++; }).retrieveSelectedArticles({
      candidateCollection: collection(),
      selections: invalid
    });
    assert.deepEqual(result, {
      ok: false,
      type: 'INPUT_FAILURE',
      message: 'Invalid CNBC candidate collection or materiality selections'
    });
    assert.equal(calls, 0);
  }
});

test('revalidates canonical candidate content before any article retrieval', async () => {
  const altered = JSON.parse(JSON.stringify(collection()));
  altered.candidates[0].provenance.publisher = 'Spoofed';
  let calls = 0;
  const result = await serviceWith(async () => { calls++; }).retrieveSelectedArticles({
    candidateCollection: altered,
    selections: selections()
  });
  assert.equal(result.type, 'INPUT_FAILURE');
  assert.equal(calls, 0);
});

test('rejects a canonical non-CNBC collection before any article retrieval', async () => {
  const fedCandidate = createNewsEvidenceCandidate({
    reference: 'c1',
    horizon,
    sourceId: 'us.federal-reserve',
    market: 'US',
    evidenceCategory: 'monetary-policy',
    title: 'Canonical Federal Reserve item',
    summary: null,
    extract: null,
    canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/example.htm',
    publishedAt: '2026-09-08T12:00:00Z',
    symbols: []
  }, {bounds: candidateBounds});
  const nonCnbcCollection = createNewsEvidenceCandidateCollection({
    market: 'US', candidates: [fedCandidate]
  }, {bounds: candidateBounds});
  const nonCnbcSelections = [{
    reference: 'c1',
    decision: 'USE',
    category: 'monetary-policy',
    materiality: 'HIGH',
    reason: 'Not valid input for the CNBC-only boundary.'
  }];
  let calls = 0;
  const result = await serviceWith(async () => { calls++; }).retrieveSelectedArticles({
    candidateCollection: nonCnbcCollection,
    selections: nonCnbcSelections
  });
  assert.equal(result.type, 'INPUT_FAILURE');
  assert.equal(calls, 0);
});

test('fails closed when retrieved identity attempts to override canonical candidate data', async () => {
  const overrideCases = [
    {reference: 'c9'},
    {sourceId: 'us.reuters'},
    {canonicalUrl: 'https://www.cnbc.com/other.html'},
    {title: 'Page-owned replacement title'},
    {provenance: {publisher: 'Spoofed'}}
  ];
  for (const override of overrideCases) {
    const result = await serviceWith(async ({candidate: item}) => articleFor(item, override))
      .retrieveSelectedArticles({
        candidateCollection: collection(),
        selections: selections(['USE', 'SKIP', 'SKIP'])
      });
    assert.deepEqual(result, {
      ok: false,
      type: 'ARTICLE_CONTRACT_FAILURE',
      message: 'CNBC retrieved article failed validation'
    });
  }
});

test('fails the whole orchestration when any selected article retrieval fails', async () => {
  const calls = [];
  const result = await serviceWith(async ({candidate: item}) => {
    calls.push(item.reference);
    if (item.reference === 'c3') throw new Error('private provider detail');
    return articleFor(item);
  }).retrieveSelectedArticles({
    candidateCollection: collection(),
    selections: selections()
  });

  assert.deepEqual(calls, ['c1', 'c3']);
  assert.deepEqual(result, {
    ok: false,
    type: 'ARTICLE_RETRIEVAL_FAILURE',
    message: 'CNBC selected article retrieval failed'
  });
  assert.equal(Object.hasOwn(result, 'retrievedArticles'), false);
});

test('emits only the allowlisted adapter subtype and exact failed cN before failure', async () => {
  assert.deepEqual(CNBC_ARTICLE_ACQUISITION_DIAGNOSTIC_FAILURE_TYPES, [
    'INVALID_INPUT',
    'TIMEOUT',
    'NETWORK_FAILURE',
    'HTTP_FAILURE',
    'INVALID_PAGE',
    'EXTRACTION_FAILURE',
    'HORIZON_MISMATCH',
    'CONTENT_TOO_LARGE'
  ]);
  for (const code of CNBC_ARTICLE_ACQUISITION_DIAGNOSTIC_FAILURE_TYPES) {
    const diagnostics = [];
    const error = new Error(
      'private https://www.cnbc.com/article title article content provider response stack prompt credential'
    );
    error.code = code;
    const result = await serviceWith(async () => { throw error; }, value => diagnostics.push(value))
      .retrieveSelectedArticles({
        candidateCollection: collection(),
        selections: selections(['SKIP', 'USE', 'SKIP'])
      });
    assert.deepEqual(result, {
      ok: false,
      type: 'ARTICLE_RETRIEVAL_FAILURE',
      message: 'CNBC selected article retrieval failed'
    });
    const expectedDiagnostic = {
      stage: 'cnbcSelectedArticleRetrieval',
      failedCandidateReference: 'c2',
      failureType: code
    };
    if (code === 'CONTENT_TOO_LARGE') {
      expectedDiagnostic.sizeFailureType = 'UNKNOWN_SIZE_FAILURE';
    }
    assert.deepEqual(diagnostics, [expectedDiagnostic]);
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of ['https://', 'title', 'article content', 'provider response', 'stack', 'prompt', 'credential']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});

test('emits only recognized size subtypes for CONTENT_TOO_LARGE failures', async () => {
  for (const sizeFailureType of [
    'TITLE_TOO_LARGE',
    'RESPONSE_TOO_LARGE',
    'ARTICLE_TEXT_TOO_LARGE',
    'RESULT_TOO_LARGE'
  ]) {
    const diagnostics = [];
    const error = new Error('private size details 999999 https://www.cnbc.com/private');
    error.code = 'CONTENT_TOO_LARGE';
    error.sizeFailureType = sizeFailureType;
    const result = await serviceWith(async () => { throw error; }, value => diagnostics.push(value))
      .retrieveSelectedArticles({
        candidateCollection: collection(),
        selections: selections(['USE', 'SKIP', 'SKIP'])
      });
    assert.deepEqual(result, {
      ok: false,
      type: 'ARTICLE_RETRIEVAL_FAILURE',
      message: 'CNBC selected article retrieval failed'
    });
    assert.deepEqual(diagnostics, [{
      stage: 'cnbcSelectedArticleRetrieval',
      failedCandidateReference: 'c1',
      failureType: 'CONTENT_TOO_LARGE',
      sizeFailureType
    }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /999999|https:\/\/|private size details/);
  }
});

test('maps missing or unrecognized size subtypes to UNKNOWN_SIZE_FAILURE', async () => {
  for (const sizeFailureType of [undefined, 'PRIVATE_SIZE_CODE']) {
    const diagnostics = [];
    const error = new Error('private size failure');
    error.code = 'CONTENT_TOO_LARGE';
    if (sizeFailureType !== undefined) error.sizeFailureType = sizeFailureType;
    await serviceWith(async () => { throw error; }, value => diagnostics.push(value))
      .retrieveSelectedArticles({
        candidateCollection: collection(),
        selections: selections(['USE', 'SKIP', 'SKIP'])
      });
    assert.deepEqual(diagnostics, [{
      stage: 'cnbcSelectedArticleRetrieval',
      failedCandidateReference: 'c1',
      failureType: 'CONTENT_TOO_LARGE',
      sizeFailureType: 'UNKNOWN_SIZE_FAILURE'
    }]);
  }
});

test('maps an unrecognized exception to one sanitized UNKNOWN_FAILURE diagnostic', async () => {
  const diagnostics = [];
  const error = new Error('private upstream details');
  error.code = 'PRIVATE_PROVIDER_CODE';
  const result = await serviceWith(async () => { throw error; }, value => diagnostics.push(value))
    .retrieveSelectedArticles({
      candidateCollection: collection(),
      selections: selections(['USE', 'SKIP', 'SKIP'])
    });
  assert.deepEqual(result, {
    ok: false,
    type: 'ARTICLE_RETRIEVAL_FAILURE',
    message: 'CNBC selected article retrieval failed'
  });
  assert.deepEqual(diagnostics, [{
    stage: 'cnbcSelectedArticleRetrieval',
    failedCandidateReference: 'c1',
    failureType: 'UNKNOWN_FAILURE'
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_PROVIDER_CODE'), false);
  assert.equal(JSON.stringify(diagnostics).includes('private upstream details'), false);
});

test('emits ARTICLE_CONTRACT_FAILURE only when acquired output fails validation', async () => {
  const diagnostics = [];
  const result = await serviceWith(
    async ({candidate: item}) => articleFor(item, {articleText: ''}),
    value => diagnostics.push(value)
  ).retrieveSelectedArticles({
    candidateCollection: collection(),
    selections: selections(['USE', 'SKIP', 'SKIP'])
  });
  assert.deepEqual(result, {
    ok: false,
    type: 'ARTICLE_CONTRACT_FAILURE',
    message: 'CNBC retrieved article failed validation'
  });
  assert.deepEqual(diagnostics, [{
    stage: 'cnbcSelectedArticleRetrieval',
    failedCandidateReference: 'c1',
    failureType: 'ARTICLE_CONTRACT_FAILURE'
  }]);
});

test('successful retrieval emits no failure diagnostic and remains unchanged', async () => {
  const diagnostics = [];
  const result = await serviceWith(
    async ({candidate: item}) => articleFor(item),
    value => diagnostics.push(value)
  ).retrieveSelectedArticles({
    candidateCollection: collection(),
    selections: selections(['SKIP', 'USE', 'SKIP'])
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.retrievedArticles.map(article => article.reference), ['c2']);
  assert.deepEqual(diagnostics, []);
});

test('rejects malformed, out-of-horizon and oversized retrieved article results', async () => {
  const cases = [
    item => ({...articleFor(item), extra: true}),
    item => articleFor(item, {articleText: ''}),
    item => articleFor(item, {publishedAt: '2026-09-08T23:00:00.000Z'}),
    item => articleFor(item, {articleText: 'x'.repeat(1001)})
  ];
  for (const acquired of cases) {
    const result = await serviceWith(async ({candidate: item}) => acquired(item))
      .retrieveSelectedArticles({
        candidateCollection: collection(),
        selections: selections(['USE', 'SKIP', 'SKIP'])
      });
    assert.equal(result.type, 'ARTICLE_CONTRACT_FAILURE');
  }
});

test('contains no final-package, evidence-reference, Claude, or provider expansion integration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/cnbc-selected-article-retrieval-orchestration.js'),
    'utf8'
  );
  for (const forbidden of [
    'us-analysis-package-orchestration',
    'analysis-package-service',
    'claude-analysis-invocation',
    'invokeClaude',
    'evidenceRefs',
    'createEvidenceItem',
    'yahoo',
    'reuters',
    'poems'
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.deepEqual(CNBC_SELECTED_ARTICLE_RETRIEVAL_RESULT_TYPES, [
    'SUCCESS',
    'INPUT_FAILURE',
    'ARTICLE_RETRIEVAL_FAILURE',
    'ARTICLE_CONTRACT_FAILURE'
  ]);
});

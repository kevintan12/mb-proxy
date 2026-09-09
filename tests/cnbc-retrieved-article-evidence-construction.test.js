const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {validateEvidenceItem} = require('../lib/evidence-items');
const {
  CNBC_CONSTRUCTED_EVIDENCE_RECORD_KEYS,
  CNBC_RETRIEVED_ARTICLE_EVIDENCE_RESULT_TYPES,
  createCnbcRetrievedArticleEvidenceConstructionService
} = require('../lib/cnbc-retrieved-article-evidence-construction');

const candidateBounds = Object.freeze({
  maxCandidates: 10,
  maxTitleBytes: 200,
  maxSummaryBytes: 500,
  maxExtractBytes: 500,
  maxCollectionBytes: 20000
});
const constructionBounds = Object.freeze({
  maxEvidenceTextBytes: 1000,
  maxTitleBytes: 200,
  maxCollectionBytes: 10000
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
    summary: `Canonical RSS summary ${reference}.`,
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
    reason: decision === 'USE' ? 'Selected for canonical evidence.' : 'Not selected.'
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
    articleText: `Bounded article content for ${item.reference}.`,
    provenance: {...item.provenance},
    ...overrides
  };
}

function service(bounds = constructionBounds) {
  return createCnbcRetrievedArticleEvidenceConstructionService({
    candidateBounds,
    evidenceConstructionBounds: bounds
  });
}

test('all SKIP produces an immutable empty constructed evidence result', () => {
  const result = service().constructEvidence({
    candidateCollection: collection(),
    selections: selections(['SKIP', 'SKIP', 'SKIP']),
    retrievedArticles: []
  });
  assert.deepEqual(result, {ok: true, type: 'SUCCESS', constructedEvidence: []});
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.constructedEvidence), true);
});

test('constructs one canonical evidence item with explicit cN audit linkage', () => {
  const candidates = collection();
  const inputArticle = articleFor(candidates.candidates[1]);
  const result = service().constructEvidence({
    candidateCollection: candidates,
    selections: selections(['SKIP', 'USE', 'SKIP']),
    retrievedArticles: [inputArticle]
  });

  assert.equal(result.ok, true);
  assert.equal(result.constructedEvidence.length, 1);
  const record = result.constructedEvidence[0];
  assert.deepEqual(Object.keys(record), CNBC_CONSTRUCTED_EVIDENCE_RECORD_KEYS);
  assert.equal(record.candidateReference, 'c2');
  assert.equal(record.selection.reference, 'c2');
  assert.equal(record.selection.decision, 'USE');
  assert.equal(record.horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
  assert.equal(validateEvidenceItem(record.evidenceItem).valid, true);
  assert.deepEqual(record.evidenceItem, {
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: candidates.candidates[1].title,
    summary: inputArticle.articleText,
    canonicalUrl: candidates.candidates[1].canonicalUrl,
    publishedAt: candidates.candidates[1].publishedAt,
    symbols: [],
    provenance: candidates.candidates[1].provenance
  });
});

test('constructs multiple evidence items in original USE candidate order', () => {
  const candidates = collection();
  const result = service().constructEvidence({
    candidateCollection: candidates,
    selections: selections(),
    retrievedArticles: [
      articleFor(candidates.candidates[0]),
      articleFor(candidates.candidates[2])
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.constructedEvidence.map(record => record.candidateReference),
    ['c1', 'c3']
  );
  assert.deepEqual(
    result.constructedEvidence.map(record => record.evidenceItem.summary),
    ['Bounded article content for c1.', 'Bounded article content for c3.']
  );
});

test('revalidates candidate collection and full ordered selection coverage', () => {
  const canonicalCollection = collection();
  const alteredCollection = JSON.parse(JSON.stringify(canonicalCollection));
  alteredCollection.candidates[0].provenance.publisher = 'Spoofed';
  const valid = selections();
  const cases = [
    {candidateCollection: alteredCollection, selections: valid},
    {candidateCollection: canonicalCollection, selections: valid.slice(0, 2)},
    {candidateCollection: canonicalCollection, selections: [...valid, {...valid[0]}]},
    {candidateCollection: canonicalCollection, selections: [{...valid[0], reference: 'c9'}, valid[1], valid[2]]},
    {candidateCollection: canonicalCollection, selections: [valid[1], valid[0], valid[2]]}
  ];
  for (const input of cases) {
    const result = service().constructEvidence({...input, retrievedArticles: []});
    assert.equal(result.type, 'INPUT_FAILURE');
  }
});

test('fails closed for missing, duplicate, extra or reordered USE articles', () => {
  const candidates = collection();
  const first = articleFor(candidates.candidates[0]);
  const third = articleFor(candidates.candidates[2]);
  for (const retrievedArticles of [
    [first],
    [first, first],
    [first, third, third],
    [third, first]
  ]) {
    const result = service().constructEvidence({
      candidateCollection: candidates,
      selections: selections(),
      retrievedArticles
    });
    assert.equal(result.type, 'ARTICLE_VALIDATION_FAILURE');
    assert.equal(Object.hasOwn(result, 'constructedEvidence'), false);
  }
});

test('rejects retrieved article identity, provenance and horizon mismatches', () => {
  const candidates = collection();
  const selected = selections(['USE', 'SKIP', 'SKIP']);
  const overrides = [
    {reference: 'c9'},
    {sourceId: 'us.reuters'},
    {canonicalUrl: 'https://www.cnbc.com/different.html'},
    {title: 'Page-supplied replacement'},
    {provenance: {publisher: 'Spoofed'}},
    {publishedAt: '2026-09-08T23:00:00.000Z'},
    {updatedAt: '2026-09-08T09:00:00.000Z'}
  ];
  for (const override of overrides) {
    const result = service().constructEvidence({
      candidateCollection: candidates,
      selections: selected,
      retrievedArticles: [articleFor(candidates.candidates[0], override)]
    });
    assert.equal(result.type, 'ARTICLE_VALIDATION_FAILURE');
  }
});

test('uses candidate-owned identity and publication timing instead of page metadata', () => {
  const candidates = collection();
  const article = articleFor(candidates.candidates[0], {
    publishedAt: '2026-09-08T14:00:00.000Z',
    updatedAt: '2026-09-08T15:00:00.000Z'
  });
  const result = service().constructEvidence({
    candidateCollection: candidates,
    selections: selections(['USE', 'SKIP', 'SKIP']),
    retrievedArticles: [article]
  });
  const evidence = result.constructedEvidence[0].evidenceItem;
  assert.equal(evidence.publishedAt, candidates.candidates[0].publishedAt);
  assert.equal(evidence.canonicalUrl, candidates.candidates[0].canonicalUrl);
  assert.equal(evidence.title, candidates.candidates[0].title);
  assert.deepEqual(evidence.provenance, candidates.candidates[0].provenance);
});

test('rejects evidence title, text and total collection bounds atomically', () => {
  const candidates = collection();
  const input = {
    candidateCollection: candidates,
    selections: selections(['USE', 'SKIP', 'SKIP']),
    retrievedArticles: [articleFor(candidates.candidates[0])]
  };
  for (const bounds of [
    {...constructionBounds, maxTitleBytes: 5},
    {...constructionBounds, maxEvidenceTextBytes: 5},
    {...constructionBounds, maxCollectionBytes: 10}
  ]) {
    const result = service(bounds).constructEvidence(input);
    assert.deepEqual(result, {
      ok: false,
      type: 'EVIDENCE_TOO_LARGE',
      message: 'CNBC constructed evidence exceeds configured bounds'
    });
  }
});

test('returns deeply immutable input-independent records without final eN references', () => {
  const candidates = collection();
  const inputSelections = selections(['USE', 'SKIP', 'SKIP']);
  const articles = [articleFor(candidates.candidates[0])];
  const originals = JSON.stringify({candidates, inputSelections, articles});
  const result = service().constructEvidence({
    candidateCollection: candidates,
    selections: inputSelections,
    retrievedArticles: articles
  });
  assert.equal(JSON.stringify({candidates, inputSelections, articles}), originals);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.constructedEvidence), true);
  assert.equal(Object.isFrozen(result.constructedEvidence[0]), true);
  assert.equal(Object.isFrozen(result.constructedEvidence[0].horizon), true);
  assert.equal(Object.isFrozen(result.constructedEvidence[0].selection), true);
  assert.equal(Object.isFrozen(result.constructedEvidence[0].evidenceItem), true);
  assert.equal(Object.keys(result.constructedEvidence[0]).some(key => /^e\d+$/.test(key)), false);
  assert.equal(JSON.stringify(result).includes('evidenceRef'), false);
});

test('contains no fetch, Claude invocation, final package, or provider expansion integration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/cnbc-retrieved-article-evidence-construction.js'),
    'utf8'
  );
  for (const forbidden of [
    'fetch(',
    'invokeClaude',
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
  assert.deepEqual(CNBC_RETRIEVED_ARTICLE_EVIDENCE_RESULT_TYPES, [
    'SUCCESS',
    'INPUT_FAILURE',
    'ARTICLE_VALIDATION_FAILURE',
    'EVIDENCE_TOO_LARGE',
    'EVIDENCE_CONTRACT_FAILURE'
  ]);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NEWS_EVIDENCE_CANDIDATE_KEYS,
  createNewsEvidenceCandidate,
  validateNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection,
  validateNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');

const bounds = Object.freeze({
  maxCandidates: 3,
  maxTitleBytes: 80,
  maxSummaryBytes: 120,
  maxExtractBytes: 160,
  maxCollectionBytes: 5000
});

function candidateInput(overrides = {}) {
  return {
    reference: 'c1',
    horizon: {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-04T20:00:00Z',
      endsAtInclusive: '2026-09-08T08:00:00Z'
    },
    sourceId: 'us.reuters',
    market: 'US',
    evidenceCategory: 'news',
    title: 'Markets assess new economic data',
    summary: 'Investors reviewed the latest economic release.',
    extract: 'The release changed expectations for the coming policy meeting.',
    canonicalUrl: 'https://www.reuters.com/markets/example',
    publishedAt: '2026-09-07T16:30:00-04:00',
    symbols: ['^GSPC'],
    ...overrides
  };
}

test('normalizes a bounded candidate with deterministic shape and registry provenance', () => {
  const candidate = createNewsEvidenceCandidate(candidateInput(), {bounds});
  assert.deepEqual(Object.keys(candidate), NEWS_EVIDENCE_CANDIDATE_KEYS);
  assert.equal(candidate.reference, 'c1');
  assert.equal(candidate.publishedAt, '2026-09-07T20:30:00.000Z');
  assert.deepEqual(candidate.symbols, ['^GSPC']);
  assert.equal(candidate.provenance.publisher, 'Reuters');
  assert.equal(validateNewsEvidenceCandidate(candidate, {bounds}).valid, true);
});

test('returns deeply immutable candidates without retaining caller references', () => {
  const input = candidateInput();
  const candidate = createNewsEvidenceCandidate(input, {bounds});
  input.symbols[0] = 'MUTATED';
  input.horizon.classification = 'COMPLETED_SESSION';
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.horizon), true);
  assert.equal(Object.isFrozen(candidate.symbols), true);
  assert.equal(Object.isFrozen(candidate.provenance), true);
  assert.deepEqual(candidate.symbols, ['^GSPC']);
  assert.equal(candidate.horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
});

test('rejects invalid sources, categories, timestamps, URLs and spoofed provenance', () => {
  for (const override of [
    {sourceId: 'missing.source'},
    {evidenceCategory: 'market-research'},
    {publishedAt: 'not-a-time'},
    {canonicalUrl: 'http://www.reuters.com/markets/example'},
    {provenance: {publisher: 'Spoofed'}}
  ]) {
    assert.throws(() => createNewsEvidenceCandidate(candidateInput(override), {bounds}), TypeError);
  }
});

test('requires explicit valid bounds and rejects oversized title, summary and extract', () => {
  assert.throws(() => createNewsEvidenceCandidate(candidateInput()), TypeError);
  assert.throws(() => createNewsEvidenceCandidate(candidateInput(), {bounds: {...bounds, extra: 1}}), TypeError);
  assert.throws(() => createNewsEvidenceCandidate(candidateInput({title: 'x'.repeat(81)}), {bounds}), /text exceeds/);
  assert.throws(() => createNewsEvidenceCandidate(candidateInput({summary: 'x'.repeat(121)}), {bounds}), /text exceeds/);
  assert.throws(() => createNewsEvidenceCandidate(candidateInput({extract: 'x'.repeat(161)}), {bounds}), /text exceeds/);
});

test('supports completed-session and subsequent horizons and enforces publication windows', () => {
  const completed = createNewsEvidenceCandidate(candidateInput({
    horizon: {
      classification: 'COMPLETED_SESSION',
      startsAtExclusive: '2026-09-03T20:00:00Z',
      endsAtInclusive: '2026-09-04T20:00:00Z'
    },
    publishedAt: '2026-09-04T19:59:59Z'
  }), {bounds});
  assert.equal(completed.horizon.classification, 'COMPLETED_SESSION');

  assert.throws(() => createNewsEvidenceCandidate(candidateInput({
    horizon: {
      classification: 'COMPLETED_SESSION',
      startsAtExclusive: '2026-09-03T20:00:00Z',
      endsAtInclusive: '2026-09-04T20:00:00Z'
    },
    publishedAt: '2026-09-04T20:00:01Z'
  }), {bounds}), /outside its evidence horizon/);
  assert.throws(() => createNewsEvidenceCandidate(candidateInput({
    horizon: {...candidateInput().horizon, classification: 'UNKNOWN'}
  }), {bounds}), /Invalid news evidence horizon/);
});

test('preserves order and enforces deterministic c1 through cN references', () => {
  const first = createNewsEvidenceCandidate(candidateInput(), {bounds});
  const second = createNewsEvidenceCandidate(candidateInput({
    reference: 'c2',
    canonicalUrl: 'https://www.reuters.com/markets/second',
    title: 'Second market development'
  }), {bounds});
  const collection = createNewsEvidenceCandidateCollection({market: 'US', candidates: [first, second]}, {bounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.reference), ['c1', 'c2']);
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), [
    'Markets assess new economic data',
    'Second market development'
  ]);
  assert.equal(validateNewsEvidenceCandidateCollection(collection, {bounds}).valid, true);

  assert.throws(() => createNewsEvidenceCandidateCollection({market: 'US', candidates: [first, first]}, {bounds}), TypeError);
  assert.throws(() => createNewsEvidenceCandidateCollection({market: 'US', candidates: [second]}, {bounds}), /deterministic collection order/);
});

test('enforces candidate-count and serialized collection-byte bounds atomically', () => {
  const candidates = [1, 2, 3].map(index => createNewsEvidenceCandidate(candidateInput({
    reference: `c${index}`,
    canonicalUrl: `https://www.reuters.com/markets/${index}`,
    title: `Market development ${index}`
  }), {bounds}));
  assert.throws(() => createNewsEvidenceCandidateCollection(
    {market: 'US', candidates},
    {bounds: {...bounds, maxCandidates: 2}}
  ), /candidate bound/);
  assert.throws(() => createNewsEvidenceCandidateCollection(
    {market: 'US', candidates: [candidates[0]]},
    {bounds: {...bounds, maxCollectionBytes: 10}}
  ), /byte bound/);
});

test('does not require or encode portfolio membership', () => {
  const candidate = createNewsEvidenceCandidate(candidateInput({symbols: []}), {bounds});
  assert.deepEqual(candidate.symbols, []);
  assert.equal(Object.hasOwn(candidate, 'myStocks'), false);
  assert.equal(Object.hasOwn(candidate, 'watchlist'), false);
});

test('leaves existing canonical evidence item and collection contracts unchanged', () => {
  const item = createEvidenceItem({
    sourceId: 'us.reuters',
    market: 'US',
    evidenceCategory: 'news',
    title: 'Existing evidence',
    canonicalUrl: 'https://www.reuters.com/existing',
    publishedAt: '2026-09-08T07:00:00Z'
  });
  const collection = createEvidenceCollection({market: 'US', items: [item, item]});
  assert.equal(collection.items.length, 2);
  assert.equal(Object.hasOwn(item, 'reference'), false);
  assert.equal(Object.hasOwn(item, 'horizon'), false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createCnbcRecapEvidenceConstructionService
} = require('../lib/cnbc-recap-evidence-construction');

const bounds = Object.freeze({
  maxEvidenceTextBytes: 8192,
  maxTitleBytes: 512,
  maxResultBytes: 12288
});

function article(overrides = {}) {
  return Object.freeze({
    sourceId: 'us.cnbc',
    canonicalUrl: 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html',
    publishedAt: '2026-09-11T20:15:23.000Z',
    updatedAt: '2026-09-11T20:20:00.000Z',
    title: 'Stock market news for Sept. 11, 2026',
    articleText: 'Stocks closed higher after the session.',
    provenance: Object.freeze({
      publisher: 'CNBC', authority: 'secondary', homepage: 'https://www.cnbc.com/',
      applicableMarket: 'US', sourceJurisdiction: 'GLOBAL', locator: 'source-homepage'
    }),
    targetSessionDate: '2026-09-11',
    selectedArticleType: 'BlogPosting',
    ...overrides
  });
}

function horizon(overrides = {}) {
  return Object.freeze({
    classification: 'SUBSEQUENT_DEVELOPMENT',
    startsAtExclusive: '2026-09-11T20:00:00.000Z',
    endsAtInclusive: '2026-09-11T22:00:00.000Z',
    ...overrides
  });
}

function service(customBounds = bounds) {
  return createCnbcRecapEvidenceConstructionService({evidenceConstructionBounds: customBounds});
}

test('constructs one immutable canonical CNBC recap record without cN or eN references', () => {
  const result = service().constructEvidence({articleContent: article(), horizon: horizon()});
  assert.equal(result.ok, true);
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(result.constructedEvidence.targetSessionDate, '2026-09-11');
  assert.deepEqual(result.constructedEvidence.updatedAt, '2026-09-11T20:20:00.000Z');
  assert.equal(result.constructedEvidence.horizon, null);
  assert.deepEqual(result.constructedEvidence.evidenceItem, {
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: 'Stock market news for Sept. 11, 2026',
    summary: 'Stocks closed higher after the session.',
    canonicalUrl: 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html',
    publishedAt: null, symbols: [],
    provenance: {
      publisher: 'CNBC', authority: 'secondary', homepage: 'https://www.cnbc.com/',
      applicableMarket: 'US', sourceJurisdiction: 'GLOBAL', locator: 'source-homepage'
    }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('candidateReference'), false);
  assert.equal(serialized.includes('selection'), false);
  assert.equal(serialized.includes('evidenceRef'), false);
  assert.equal(Object.isFrozen(result.constructedEvidence), true);
  assert.equal(Object.isFrozen(result.constructedEvidence.evidenceItem.provenance), true);
});

test('does not assign a causal horizon from recap publication metadata', () => {
  const result = service().constructEvidence({articleContent: article(), horizon: horizon()});
  assert.equal(result.constructedEvidence.horizon, null);
  assert.equal(result.constructedEvidence.targetSessionDate, '2026-09-11');
});

test('constructs predicted recap evidence despite prior-day publication and mismatched editorial date', () => {
  const completed = Object.freeze({
    classification: 'COMPLETED_SESSION',
    startsAtExclusive: '2026-09-10T20:00:00.000Z',
    endsAtInclusive: '2026-09-11T20:00:00.000Z'
  });
  const priorDayArticle = article({
    publishedAt: '2026-09-10T22:15:00.000Z',
    updatedAt: '2026-09-10T22:20:00.000Z'
  });
  const result = service().constructEvidence({
    articleContent: priorDayArticle, horizon: completed
  });
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.targetSessionDate, '2026-09-11');
  assert.equal(result.constructedEvidence.horizon, null);
  assert.equal(result.constructedEvidence.evidenceItem.publishedAt,
    null);
  const mismatchedEditorialDate = service().constructEvidence({
    articleContent: article({...priorDayArticle, title: 'Stock market news for Sept. 12, 2026'}),
    horizon: completed
  });
  assert.equal(mismatchedEditorialDate.type, 'SUCCESS');
  assert.equal(mismatchedEditorialDate.constructedEvidence.evidenceItem.title,
    'Stock market news for Sept. 12, 2026');
});

test('fails closed for altered recap identity and provenance', () => {
  for (const [articleContent, valueHorizon] of [
    [article({canonicalUrl: 'https://www.cnbc.com/2026/09/11/other.html'}), horizon()],
    [article({targetSessionDate: '2026-09-10'}), horizon()],
    [article({provenance: Object.freeze({...article().provenance, publisher: 'Other'})}), horizon()]
  ]) {
    assert.equal(service().constructEvidence({articleContent, horizon: valueHorizon}).type, 'INPUT_FAILURE');
  }
});

test('accepts missing, malformed, reversed, and out-of-horizon recap timestamps without inventing publication time', () => {
  for (const metadata of [
    {publishedAt: null, updatedAt: null},
    {publishedAt: 'not-a-date', updatedAt: 'also-invalid'},
    {publishedAt: '2026-09-11T20:15:23.000Z', updatedAt: '2026-09-11T19:00:00.000Z'},
    {publishedAt: '2026-09-18T20:15:23.000Z', updatedAt: null}
  ]) {
    const result = service().constructEvidence({articleContent: article(metadata), horizon: horizon()});
    assert.equal(result.type, 'SUCCESS');
    assert.equal(result.constructedEvidence.evidenceItem.publishedAt, null);
    assert.equal(result.constructedEvidence.horizon, null);
    assert.equal(result.constructedEvidence.updatedAt, null);
  }
});

test('enforces explicit evidence and normalized-result bounds', () => {
  assert.equal(service({...bounds, maxEvidenceTextBytes: 10})
    .constructEvidence({articleContent: article(), horizon: horizon()}).type, 'EVIDENCE_TOO_LARGE');
  assert.equal(service({...bounds, maxResultBytes: 10})
    .constructEvidence({articleContent: article(), horizon: horizon()}).type, 'EVIDENCE_TOO_LARGE');
  assert.throws(() => service({...bounds, extra: 1}), TypeError);
});

test('contains no fetch, discovery, materiality, package, or session-association behavior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-recap-evidence-construction.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|materiality|analysis-package|sessionAssociations|createPostClose/i);
});

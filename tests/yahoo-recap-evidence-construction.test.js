const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS,
  YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS,
  YAHOO_RECAP_HORIZON_KEYS,
  YAHOO_RECAP_EVIDENCE_RESULT_TYPES,
  createYahooRecapEvidenceConstructionService
} = require('../lib/yahoo-recap-evidence-construction');
const {validateEvidenceItem} = require('../lib/evidence-items');

const bounds = Object.freeze({
  maxHeadlineBytes: 512,
  maxPublisherNameBytes: 256,
  maxEvidenceTextBytes: 8192,
  maxResultBytes: 12288
});

function articleContent(overrides = {}) {
  return Object.freeze({
    sourceId: 'us.yahoo-finance',
    publisher: Object.freeze({name: 'Yahoo! Finance'}),
    canonicalUrl: 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
    headline: 'Stock market today: US stocks finish lower',
    publishedAt: '2026-09-09T20:03:54.000Z',
    updatedAt: null,
    targetSessionDate: '2026-09-09',
    articleText: 'US stocks finished lower after Treasury yields rose.',
    ...overrides
  });
}

function horizon(overrides = {}) {
  return Object.freeze({
    classification: 'SUBSEQUENT_DEVELOPMENT',
    startsAtExclusive: '2026-09-09T20:00:00.000Z',
    endsAtInclusive: '2026-09-10T12:00:00.000Z',
    ...overrides
  });
}

function service(overrides = {}) {
  return createYahooRecapEvidenceConstructionService({
    evidenceConstructionBounds: bounds,
    ...overrides
  });
}

test('exports exact immutable construction contracts', () => {
  assert.deepEqual(YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS, [
    'maxHeadlineBytes', 'maxPublisherNameBytes', 'maxEvidenceTextBytes', 'maxResultBytes'
  ]);
  assert.deepEqual(YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS, [
    'targetSessionDate', 'updatedAt', 'horizon', 'evidenceItem'
  ]);
  assert.deepEqual(YAHOO_RECAP_HORIZON_KEYS, [
    'classification', 'startsAtExclusive', 'endsAtInclusive'
  ]);
  assert.deepEqual(YAHOO_RECAP_EVIDENCE_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'EVIDENCE_TOO_LARGE', 'EVIDENCE_CONTRACT_FAILURE'
  ]);
  for (const value of [
    YAHOO_RECAP_EVIDENCE_CONSTRUCTION_BOUND_KEYS,
    YAHOO_RECAP_CONSTRUCTED_EVIDENCE_KEYS,
    YAHOO_RECAP_HORIZON_KEYS,
    YAHOO_RECAP_EVIDENCE_RESULT_TYPES
  ]) assert.equal(Object.isFrozen(value), true);
});

test('constructs one canonical Yahoo-authored news evidence record', () => {
  const result = service().constructEvidence({articleContent: articleContent(), horizon: horizon()});
  assert.deepEqual(result, {
    ok: true,
    type: 'SUCCESS',
    constructedEvidence: {
      targetSessionDate: '2026-09-09',
      updatedAt: null,
      horizon: {
        classification: 'SUBSEQUENT_DEVELOPMENT',
        startsAtExclusive: '2026-09-09T20:00:00.000Z',
        endsAtInclusive: '2026-09-10T12:00:00.000Z'
      },
      evidenceItem: {
        sourceId: 'us.yahoo-finance',
        market: 'US',
        evidenceCategory: 'news',
        title: 'Stock market today: US stocks finish lower',
        summary: 'US stocks finished lower after Treasury yields rose.',
        canonicalUrl: 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
        publishedAt: '2026-09-09T20:03:54.000Z',
        symbols: [],
        provenance: {
          publisher: 'Yahoo! Finance',
          authority: 'secondary',
          homepage: 'https://finance.yahoo.com/',
          applicableMarket: 'US',
          sourceJurisdiction: 'GLOBAL',
          locator: 'source-homepage'
        }
      }
    }
  });
  assert.equal(validateEvidenceItem(result.constructedEvidence.evidenceItem).valid, true);
});

test('preserves a third-party publisher distinctly from the Yahoo acquisition source', () => {
  const result = service().constructEvidence({
    articleContent: articleContent({publisher: Object.freeze({name: 'Independent Publisher'})}),
    horizon: horizon()
  });
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.constructedEvidence.evidenceItem.sourceId, 'us.yahoo-finance');
  assert.equal(result.constructedEvidence.evidenceItem.provenance.publisher, 'Independent Publisher');
  assert.notEqual(result.constructedEvidence.evidenceItem.provenance.publisher, 'Yahoo');
});

test('preserves explicit target session separately from publication horizon', () => {
  const subsequent = service().constructEvidence({
    articleContent: articleContent(),
    horizon: horizon({classification: 'SUBSEQUENT_DEVELOPMENT'})
  });
  assert.equal(subsequent.type, 'SUCCESS');
  assert.equal(subsequent.constructedEvidence.targetSessionDate, '2026-09-09');
  assert.equal(subsequent.constructedEvidence.horizon.classification, 'SUBSEQUENT_DEVELOPMENT');

  const completed = service().constructEvidence({
    articleContent: articleContent({publishedAt: '2026-09-09T19:59:00.000Z'}),
    horizon: horizon({
      classification: 'COMPLETED_SESSION',
      startsAtExclusive: '2026-09-08T20:00:00.000Z',
      endsAtInclusive: '2026-09-09T20:00:00.000Z'
    })
  });
  assert.equal(completed.type, 'SUCCESS');
  assert.equal(completed.constructedEvidence.horizon.classification, 'COMPLETED_SESSION');
});

test('rejects invalid source, publisher, URL, title, text, timestamps and target date', () => {
  const cases = [
    articleContent({sourceId: 'us.reuters'}),
    articleContent({publisher: null}),
    articleContent({publisher: Object.freeze({name: ''})}),
    articleContent({publisher: Object.freeze({name: ' Yahoo! Finance'})}),
    articleContent({canonicalUrl: 'https://example.com/markets/live/stock-market-today-example.html'}),
    articleContent({headline: ''}),
    articleContent({articleText: ''}),
    articleContent({publishedAt: '2026-09-09'}),
    articleContent({updatedAt: 'invalid'}),
    articleContent({targetSessionDate: '2026-02-30'}),
    articleContent({targetSessionDate: '2026-09-08'}),
    Object.freeze({...articleContent(), extra: true})
  ];
  for (const value of cases) {
    assert.deepEqual(service().constructEvidence({articleContent: value, horizon: horizon()}), {
      ok: false,
      type: 'INPUT_FAILURE',
      message: 'Invalid Yahoo recap article content'
    });
  }
});

test('requires an explicit canonical horizon containing publication and update times', () => {
  const article = articleContent({updatedAt: '2026-09-09T21:00:00.000Z'});
  const cases = [
    undefined,
    {...horizon(), classification: 'UNKNOWN'},
    {...horizon(), startsAtExclusive: 'invalid'},
    {...horizon(), endsAtInclusive: '2026-09-09T20:02:00.000Z'},
    {...horizon(), endsAtInclusive: '2026-09-09T20:30:00.000Z'}
  ];
  for (const value of cases) {
    const result = service().constructEvidence({articleContent: article, horizon: value});
    assert.equal(result.type, 'INPUT_FAILURE');
  }
});

test('enforces UTF-8 headline, publisher, evidence-text and result bounds atomically', () => {
  const cases = [
    [articleContent({headline: 'x'.repeat(513)}), bounds],
    [articleContent({publisher: Object.freeze({name: 'é'.repeat(129)})}), bounds],
    [articleContent({articleText: 'x'.repeat(8193)}), bounds]
  ];
  for (const [article, limits] of cases) {
    const result = createYahooRecapEvidenceConstructionService({
      evidenceConstructionBounds: limits
    }).constructEvidence({articleContent: article, horizon: horizon()});
    assert.equal(result.type, 'EVIDENCE_TOO_LARGE');
  }
  const resultOverflow = createYahooRecapEvidenceConstructionService({
    evidenceConstructionBounds: {...bounds, maxResultBytes: 10}
  }).constructEvidence({articleContent: articleContent(), horizon: horizon()});
  assert.equal(resultOverflow.type, 'EVIDENCE_TOO_LARGE');
  assert.equal('constructedEvidence' in resultOverflow, false);
});

test('requires exact positive construction bounds', () => {
  for (const invalid of [
    undefined,
    {...bounds, maxEvidenceTextBytes: 0},
    {...bounds, extra: 1}
  ]) {
    assert.throws(() => createYahooRecapEvidenceConstructionService({
      evidenceConstructionBounds: invalid
    }), TypeError);
  }
});

test('returns deterministic deeply immutable output without final eN references', () => {
  const inputArticle = articleContent();
  const inputHorizon = horizon();
  const first = service().constructEvidence({articleContent: inputArticle, horizon: inputHorizon});
  const second = service().constructEvidence({articleContent: inputArticle, horizon: inputHorizon});
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.constructedEvidence), true);
  assert.equal(Object.isFrozen(first.constructedEvidence.horizon), true);
  assert.equal(Object.isFrozen(first.constructedEvidence.evidenceItem), true);
  assert.equal(Object.isFrozen(first.constructedEvidence.evidenceItem.provenance), true);
  assert.equal('reference' in first.constructedEvidence.evidenceItem, false);
  assert.equal('evidenceRef' in first.constructedEvidence.evidenceItem, false);
});

test('does not fetch, discover, invoke Claude, aggregate updates or integrate a package', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/yahoo-recap-evidence-construction.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|liveBlogUpdate|analysis-package|claude|cnbc|reuters/i);
});

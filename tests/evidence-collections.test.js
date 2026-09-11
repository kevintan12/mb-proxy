const test = require('node:test');
const assert = require('node:assert/strict');

const { createEvidenceItem } = require('../lib/evidence-items');
const {
  EVIDENCE_COLLECTION_KEYS,
  createEvidenceCollection,
  validateEvidenceCollectionInput
} = require('../lib/evidence-collections');

function item(sourceId, evidenceCategory, title, canonicalUrl) {
  return createEvidenceItem({
    sourceId,
    market: sourceId.slice(0, 2).toUpperCase(),
    evidenceCategory,
    title,
    canonicalUrl,
    publishedAt: '2026-09-06T08:00:00Z'
  });
}

test('creates empty and populated immutable collections with fixed shape', () => {
  const empty = createEvidenceCollection({market: 'sg', items: []});
  assert.deepEqual(Object.keys(empty), EVIDENCE_COLLECTION_KEYS);
  assert.deepEqual(empty, {market: 'SG', items: []});
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.items), true);

  const populated = createEvidenceCollection({market: 'US', items: [
    item('us.reuters', 'news', 'First', 'https://www.reuters.com/first'),
    item('us.sec-edgar', 'regulatory-filings', 'Second', 'https://www.sec.gov/second')
  ]});
  assert.deepEqual(populated.items.map(value => value.title), ['First', 'Second']);
  assert.equal(validateEvidenceCollectionInput(populated).valid, true);
});

test('preserves caller order and duplicate items without sorting or deduplication', () => {
  const first = item('sg.reuters', 'news', 'Later item', 'https://www.reuters.com/duplicate');
  const second = item('sg.reuters', 'news', 'Earlier item', 'https://www.reuters.com/duplicate');
  const collection = createEvidenceCollection({market: 'SG', items: [first, second, first]});
  assert.deepEqual(collection.items.map(value => value.title), ['Later item', 'Earlier item', 'Later item']);
  assert.equal(collection.items.length, 3);
});

test('rejects mixed applicability markets atomically', () => {
  const us = item('us.reuters', 'news', 'US item', 'https://www.reuters.com/us');
  const sg = item('sg.reuters', 'news', 'SG item', 'https://www.reuters.com/sg');
  const input = {market: 'US', items: [us, sg]};
  const validation = validateEvidenceCollectionInput(input);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('items[1]: collection market mismatch'));
  assert.throws(() => createEvidenceCollection(input), TypeError);
});

test('rejects altered provenance, wrong shape and non-canonical item values', () => {
  const canonical = item('hk.reuters', 'news', 'HK item', 'https://www.reuters.com/hk');
  const spoofed = JSON.parse(JSON.stringify(canonical));
  spoofed.provenance.authority = 'primary';
  assert.equal(validateEvidenceCollectionInput({market: 'HK', items: [spoofed]}).valid, false);

  const wrongShape = {...JSON.parse(JSON.stringify(canonical)), extra: true};
  assert.equal(validateEvidenceCollectionInput({market: 'HK', items: [wrongShape]}).valid, false);

  const nonCanonical = JSON.parse(JSON.stringify(canonical));
  nonCanonical.publishedAt = '2026-09-06T16:00:00+08:00';
  assert.equal(validateEvidenceCollectionInput({market: 'HK', items: [nonCanonical]}).valid, false);
});

test('accepts structurally canonical unbranded items and retains no mutable references', () => {
  const plain = JSON.parse(JSON.stringify(item(
    'sg.sgx-sgxnet',
    'company-disclosure',
    'Disclosure',
    'https://www.sgx.com/disclosure'
  )));
  const callerItems = [plain];
  const collection = createEvidenceCollection({market: 'SG', items: callerItems});

  assert.notEqual(collection.items, callerItems);
  assert.notEqual(collection.items[0], plain);
  assert.notEqual(collection.items[0].symbols, plain.symbols);
  assert.notEqual(collection.items[0].provenance, plain.provenance);
  assert.equal(Object.isFrozen(collection.items), true);
  assert.equal(Object.isFrozen(collection.items[0]), true);
  assert.equal(Object.isFrozen(collection.items[0].symbols), true);
  assert.equal(Object.isFrozen(collection.items[0].provenance), true);

  callerItems.push(plain);
  plain.title = 'Mutated';
  plain.provenance.publisher = 'Mutated';
  assert.equal(collection.items.length, 1);
  assert.equal(collection.items[0].title, 'Disclosure');
  assert.equal(collection.items[0].provenance.publisher, 'Singapore Exchange');
});

test('preserves a canonical Yahoo recap editorial publisher through collection reconstruction', () => {
  const item = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'US market recap', summary: 'Stocks finished lower.',
    canonicalUrl: 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
    publishedAt: '2026-09-09T20:03:54.000Z', symbols: [],
    publisher: 'Independent Publisher'
  });
  const collection = createEvidenceCollection({market: 'US', items: [item]});
  assert.equal(collection.items[0].provenance.publisher, 'Independent Publisher');
  assert.equal(collection.items[0].sourceId, 'us.yahoo-finance');
  assert.equal(Object.isFrozen(collection.items[0].provenance), true);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVIDENCE_ITEM_KEYS,
  createEvidenceItem,
  validateEvidenceItemInput,
  validateEvidenceItem
} = require('../lib/evidence-items');

function validInput(overrides = {}) {
  return {
    sourceId: 'us.sec-edgar',
    market: 'US',
    evidenceCategory: 'regulatory-filings',
    title: 'Issuer files quarterly report',
    canonicalUrl: 'https://www.sec.gov/Archives/example',
    publishedAt: '2026-09-05T16:30:45+08:00',
    ...overrides
  };
}

test('creates a valid canonical evidence item with fixed property order', () => {
  const item = createEvidenceItem(validInput());
  assert.deepEqual(Object.keys(item), EVIDENCE_ITEM_KEYS);
  assert.deepEqual(item, {
    sourceId: 'us.sec-edgar',
    market: 'US',
    evidenceCategory: 'regulatory-filings',
    title: 'Issuer files quarterly report',
    summary: null,
    canonicalUrl: 'https://www.sec.gov/Archives/example',
    publishedAt: '2026-09-05T08:30:45.000Z',
    symbols: [],
    provenance: {
      publisher: 'U.S. Securities and Exchange Commission',
      authority: 'primary',
      homepage: 'https://www.sec.gov/edgar',
      applicableMarket: 'US',
      sourceJurisdiction: 'US',
      locator: 'source-homepage'
    }
  });
  assert.equal(validateEvidenceItemInput(validInput()).valid, true);
});

test('canonicalizes valid ISO-8601 offsets to UTC Z and rejects invalid timestamps', () => {
  assert.equal(
    createEvidenceItem(validInput({publishedAt: '2026-09-05T08:30:45Z'})).publishedAt,
    '2026-09-05T08:30:45.000Z'
  );
  assert.equal(
    createEvidenceItem(validInput({publishedAt: '2026-09-05T08:30:45.123456Z'})).publishedAt,
    '2026-09-05T08:30:45.123Z'
  );
  assert.equal(
    createEvidenceItem(validInput({publishedAt: '0099-09-05T08:30:45+08:00'})).publishedAt,
    '0099-09-05T00:30:45.000Z'
  );
  for (const publishedAt of [
    '2026-02-30T08:00:00Z',
    '2026-09-05',
    '2026-09-05T08:00:00',
    '2026-09-05T25:00:00Z',
    'not-a-date'
  ]) {
    assert.equal(validateEvidenceItemInput(validInput({publishedAt})).valid, false);
    assert.throws(() => createEvidenceItem(validInput({publishedAt})), TypeError);
  }
});

test('requires an HTTPS canonical URL', () => {
  assert.equal(createEvidenceItem(validInput({canonicalUrl: 'https://example.com/a b'})).canonicalUrl, 'https://example.com/a%20b');
  for (const canonicalUrl of ['http://example.com/item', 'ftp://example.com/item', '/relative', 'not a url']) {
    const result = validateEvidenceItemInput(validInput({canonicalUrl}));
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('canonicalUrl must be a valid HTTPS URL'));
  }
});

test('validates source, evidence category and applicability market', () => {
  assert.equal(validateEvidenceItemInput(validInput({sourceId: 'missing.source'})).valid, false);
  assert.equal(validateEvidenceItemInput(validInput({market: 'SG'})).valid, false);
  assert.equal(validateEvidenceItemInput(validInput({market: 'XX'})).valid, false);
  assert.equal(validateEvidenceItemInput(validInput({evidenceCategory: 'news'})).valid, false);
  assert.equal(validateEvidenceItemInput(validInput({evidenceCategory: 'unknown'})).valid, false);

  const chinaSourceForHongKong = createEvidenceItem(validInput({
    sourceId: 'hk.nbs',
    market: 'hk',
    evidenceCategory: 'economic-data',
    canonicalUrl: 'https://www.stats.gov.cn/english/example'
  }));
  assert.equal(chinaSourceForHongKong.market, 'HK');
  assert.equal(chinaSourceForHongKong.provenance.applicableMarket, 'HK');
  assert.equal(chinaSourceForHongKong.provenance.sourceJurisdiction, 'CN');
});

test('derives provenance and rejects every caller-supplied provenance value', () => {
  for (const provenance of [{publisher: 'Spoof'}, null, undefined]) {
    const result = validateEvidenceItemInput({...validInput(), provenance});
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('provenance is derived and must not be supplied'));
    assert.throws(() => createEvidenceItem({...validInput(), provenance}), TypeError);
  }
});

test('preserves provider-owned publisher only for US Yahoo Finance news evidence', () => {
  const yahooNews = createEvidenceItem({
    sourceId: 'us.yahoo-finance',
    market: 'US',
    evidenceCategory: 'news',
    title: 'US market recap',
    summary: 'Stocks ended lower.',
    canonicalUrl: 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
    publishedAt: '2026-09-09T20:03:54.000Z',
    symbols: [],
    publisher: 'Third-Party Publisher'
  });
  assert.equal(yahooNews.provenance.publisher, 'Third-Party Publisher');
  assert.equal(validateEvidenceItem(yahooNews).valid, true);
  assert.equal(validateEvidenceItemInput({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'US market recap', canonicalUrl: 'https://finance.yahoo.com/example',
    publishedAt: '2026-09-09T20:03:54.000Z'
  }).valid, false);
  assert.equal(validateEvidenceItemInput({...validInput(), publisher: 'Spoofed'}).valid, false);
});

test('canonicalizes summary and symbols defaults and copies supplied values', () => {
  const defaulted = createEvidenceItem(validInput());
  assert.equal(defaulted.summary, null);
  assert.deepEqual(defaulted.symbols, []);

  const symbols = [' AAPL ', '^GSPC'];
  const populated = createEvidenceItem(validInput({summary: '  Concise evidence.  ', symbols}));
  assert.equal(populated.summary, 'Concise evidence.');
  assert.deepEqual(populated.symbols, ['AAPL', '^GSPC']);
  symbols[0] = 'MUTATED';
  symbols.push('MSFT');
  assert.deepEqual(populated.symbols, ['AAPL', '^GSPC']);
});

test('returns deeply immutable records without retaining caller-owned references', () => {
  const input = validInput({symbols: ['AAPL'], summary: 'Evidence'});
  const item = createEvidenceItem(input);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.symbols), true);
  assert.equal(Object.isFrozen(item.provenance), true);
  assert.notEqual(item.symbols, input.symbols);
  assert.throws(() => item.symbols.push('MSFT'), TypeError);
  assert.equal(Reflect.set(item.provenance, 'publisher', 'Changed'), false);
  assert.equal(item.provenance.publisher, 'U.S. Securities and Exchange Commission');

  const validation = validateEvidenceItemInput(input);
  assert.equal(Object.isFrozen(validation), true);
  assert.equal(Object.isFrozen(validation.errors), true);
});

test('strict canonical-output validation is structural and rejects contract drift', () => {
  const canonical = createEvidenceItem(validInput({symbols: ['AAPL']}));
  assert.equal(validateEvidenceItem(canonical).valid, true);
  assert.equal(validateEvidenceItem(JSON.parse(JSON.stringify(canonical))).valid, true);

  const spoofed = JSON.parse(JSON.stringify(canonical));
  spoofed.provenance.publisher = 'Spoofed publisher';
  assert.ok(validateEvidenceItem(spoofed).errors.includes('altered or spoofed provenance'));

  const missingProvenance = JSON.parse(JSON.stringify(canonical));
  missingProvenance.provenance = null;
  assert.equal(validateEvidenceItem(missingProvenance).valid, false);

  const wrongShape = {...JSON.parse(JSON.stringify(canonical)), extra: true};
  assert.ok(validateEvidenceItem(wrongShape).errors.includes('invalid canonical property shape or order'));

  const hiddenShape = JSON.parse(JSON.stringify(canonical));
  Object.defineProperty(hiddenShape, 'hidden', {value: true});
  assert.ok(validateEvidenceItem(hiddenShape).errors.includes('invalid canonical property shape or order'));

  const wrongMarket = JSON.parse(JSON.stringify(canonical));
  wrongMarket.market = 'SG';
  assert.equal(validateEvidenceItem(wrongMarket).valid, false);

  const nonCanonical = JSON.parse(JSON.stringify(canonical));
  nonCanonical.title = ` ${nonCanonical.title}`;
  assert.ok(validateEvidenceItem(nonCanonical).errors.includes('non-canonical title'));
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOURCE_REGISTRY,
  getSourceById,
  isValidSourceId,
  listSources,
  validateSource,
  validateSourceRegistry
} = require('../lib/evidence-sources');

const EXPECTED_IDS = [
  'us.yahoo-finance', 'us.reuters', 'us.sec-edgar', 'us.federal-reserve', 'us.bls', 'us.bea',
  'us.cnbc', 'us.fred', 'us.company-ir',
  'sg.yahoo-finance', 'sg.reuters', 'sg.cna', 'sg.sgx-sgxnet', 'sg.mas', 'sg.singstat',
  'sg.business-times', 'sg.straits-times', 'sg.stocksbnb', 'sg.company-ir',
  'hk.yahoo-finance', 'hk.reuters', 'hk.hkexnews', 'hk.hkma', 'hk.csd',
  'hk.cnbc-asia', 'hk.nbs', 'hk.pboc', 'hk.csrc', 'hk.company-ir'
];

const EXPECTED_TIER_CLASSIFICATION = {
  'us.yahoo-finance': ['core', 'core'], 'us.reuters': ['core', 'core'],
  'us.sec-edgar': ['core', 'core'], 'us.federal-reserve': ['core', 'core'],
  'us.bls': ['core', 'core'], 'us.bea': ['core', 'core'],
  'us.cnbc': ['supplementary', 'supplementary'], 'us.fred': ['supplementary', 'supplementary'],
  'us.company-ir': ['supplementary', 'supplementary'],
  'sg.yahoo-finance': ['core', 'core'], 'sg.reuters': ['core', 'core'],
  'sg.cna': ['core', 'core'], 'sg.sgx-sgxnet': ['core', 'core'],
  'sg.mas': ['core', 'core'], 'sg.singstat': ['core', 'core'],
  'sg.business-times': ['supplementary', 'supplementary'],
  'sg.straits-times': ['supplementary', 'supplementary'],
  'sg.stocksbnb': ['supplementary', 'supplementary'],
  'sg.company-ir': ['supplementary', 'supplementary'],
  'hk.yahoo-finance': ['core', 'core'], 'hk.reuters': ['core', 'core'],
  'hk.hkexnews': ['core', 'core'], 'hk.hkma': ['core', 'core'], 'hk.csd': ['core', 'core'],
  'hk.cnbc-asia': ['supplementary', 'supplementary'],
  'hk.nbs': ['supplementary', 'selective'], 'hk.pboc': ['supplementary', 'selective'],
  'hk.csrc': ['supplementary', 'selective'],
  'hk.company-ir': ['supplementary', 'supplementary']
};

test('registry contains exactly the frozen US, SG and HK sources', () => {
  assert.deepEqual(SOURCE_REGISTRY.map(source => source.id), EXPECTED_IDS);
  assert.equal(SOURCE_REGISTRY.length, 29);
  assert.deepEqual(
    Object.fromEntries(['US', 'SG', 'HK'].map(market => [market, listSources({market}).length])),
    {US: 9, SG: 10, HK: 10}
  );
  assert.equal(validateSourceRegistry().valid, true);
  assert.deepEqual(
    Object.fromEntries(SOURCE_REGISTRY.map(source => [source.id, [source.tier, source.classification]])),
    EXPECTED_TIER_CLASSIFICATION
  );
});

test('lookup normalizes stable IDs and unknown IDs remain absent', () => {
  assert.equal(getSourceById(' SG.MAS ').name, 'MAS');
  assert.equal(isValidSourceId('hk.hkexnews'), true);
  assert.equal(getSourceById('sg.unknown'), null);
  assert.equal(isValidSourceId(null), false);
});

test('market, tier, classification and evidence filters compose', () => {
  assert.deepEqual(
    listSources({market: 'HK', tier: 'supplementary', classification: 'selective'}).map(source => source.id),
    ['hk.nbs', 'hk.pboc', 'hk.csrc']
  );
  assert.deepEqual(
    listSources({market: 'US', evidenceCategory: 'economic-data'}).map(source => source.id),
    ['us.federal-reserve', 'us.bls', 'us.bea', 'us.fred']
  );
  assert.deepEqual(
    listSources({market: 'SG', sourceCategory: 'exchange-disclosure'}).map(source => source.id),
    ['sg.sgx-sgxnet']
  );
});

test('applicability market is distinct from provider-neutral source jurisdiction', () => {
  for (const id of ['hk.nbs', 'hk.pboc', 'hk.csrc']) {
    const source = getSourceById(id);
    assert.equal(source.market, 'HK');
    assert.equal(source.provenance.applicableMarket, 'HK');
    assert.equal(source.provenance.sourceJurisdiction, 'CN');
  }
  assert.equal(getSourceById('sg.sgx-sgxnet').sourceCategory, 'exchange-disclosure');
  assert.equal(getSourceById('hk.hkexnews').sourceCategory, 'exchange-disclosure');
});

test('registry and lookup results are deeply immutable and list results are copy-safe', () => {
  const mas = getSourceById('sg.mas');
  assert.equal(Object.isFrozen(SOURCE_REGISTRY), true);
  assert.equal(Object.isFrozen(mas), true);
  assert.equal(Object.isFrozen(mas.evidenceCategories), true);
  assert.equal(Object.isFrozen(mas.provenance), true);

  const first = listSources({market: 'SG'});
  const second = listSources({market: 'SG'});
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => first.push(mas), TypeError);
  assert.equal(second.length, 10);
});

test('validation reports malformed sources and duplicate IDs without mutating input', () => {
  const malformed = {
    id: 'bad id', name: '', market: 'XX', tier: 'core', classification: 'selective',
    sourceCategory: 'unknown', evidenceCategories: [], provenance: {}
  };
  const snapshot = JSON.stringify(malformed);
  const result = validateSource(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid id'));
  assert.ok(result.errors.includes('invalid market'));
  assert.ok(result.errors.includes('core tier requires core classification'));
  assert.equal(JSON.stringify(malformed), snapshot);

  const duplicate = validateSourceRegistry([SOURCE_REGISTRY[0], SOURCE_REGISTRY[0]]);
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.includes('source[1]: duplicate id'));
});

test('company IR provenance remains primary without inventing a retrieval URL', () => {
  for (const market of ['US', 'SG', 'HK']) {
    const companyIr = getSourceById(`${market.toLowerCase()}.company-ir`);
    assert.equal(companyIr.sourceCategory, 'company-primary');
    assert.equal(companyIr.provenance.authority, 'primary');
    assert.equal(companyIr.provenance.homepage, null);
    assert.equal(companyIr.provenance.locator, 'company-specific');
  }
});

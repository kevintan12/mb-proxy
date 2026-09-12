const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createCompletedRegularSession,
  createThreeSessionSnapshot
} = require('../lib/three-session-snapshot');
const {validateClaudeAnalysisInput} = require('../lib/claude-analysis-contract');
const {
  ANALYSIS_PACKAGE_REQUEST_KEYS,
  ANALYSIS_PACKAGE_MEMBERSHIP_KEYS,
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
} = require('../lib/analysis-package-service');

const FIXED_NOW = '2026-09-06T10:00:00.000Z';
const MARKET_CONFIG = {
  US: {zone: 'America/New_York', symbol: '^GSPC', source: 'us.yahoo-finance', news: 'us.reuters'},
  SG: {zone: 'Asia/Singapore', symbol: '^STI', source: 'sg.yahoo-finance', news: 'sg.reuters'},
  HK: {zone: 'Asia/Hong_Kong', symbol: '^HSI', source: 'hk.yahoo-finance', news: 'hk.reuters'}
};

function request(selectedScope = 'SG', overrides = {}) {
  return {
    selectedScope,
    initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore',
    myStocks: [],
    watchlist: [],
    ...overrides
  };
}

function marketPackage(market, reference) {
  const config = MARKET_CONFIG[market];
  const session = createCompletedRegularSession({
    market,
    sessionDate: '2026-09-04',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    previousClose: 100,
    volume: null,
    asOf: market === 'US' ? '2026-09-04T16:00:00-04:00' : '2026-09-04T16:00:00+08:00',
    sourceId: config.source,
    validationState: 'VALIDATED'
  });
  const snapshot = createThreeSessionSnapshot({
    market,
    symbol: config.symbol,
    instrumentName: `${market} benchmark`,
    instrumentType: 'INDEX',
    currency: market === 'US' ? 'USD' : market === 'SG' ? 'SGD' : 'HKD',
    marketState: 'CLOSED',
    completedSessions: [session],
    currentOverlay: null
  });
  const item = createEvidenceItem({
    sourceId: config.news,
    market,
    evidenceCategory: 'news',
    title: `${market} market report`,
    canonicalUrl: `https://www.reuters.com/markets/${market.toLowerCase()}-report`,
    publishedAt: '2026-09-05T08:00:00Z'
  });
  return {
    market,
    marketContext: {
      exchangeTimezone: config.zone,
      marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-04',
      includesCurrentOverlay: false,
      calendarContext: 'Exchange calendar context acquired by mb-proxy.'
    },
    telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
    evidenceCollection: createEvidenceCollection({market, items: [item]}),
    evidenceContext: {
      materialEvents: [reference],
      authoritativeFacts: [],
      principalCatalysts: [reference],
      supportingEvidence: [reference],
      conflictingEvidence: [],
      subsequentDevelopments: [],
      unresolvedGaps: [],
      furtherReadings: []
    }
  };
}

function acquiredMaterial(context) {
  let evidenceNumber = 0;
  const marketPackages = context.markets.map(market => marketPackage(market, `e${++evidenceNumber}`));
  function enrich(items) {
    return items.map(item => ({
      market: item.market,
      symbol: item.symbol,
      telemetryRefs: [],
      evidenceRefs: [],
      upcomingEvents: []
    }));
  }
  return {
    marketPackages,
    portfolioContext: {
      myStocks: enrich(context.myStocks),
      watchlist: enrich(context.watchlist)
    }
  };
}

function service(acquireAnalysisMaterial = async context => acquiredMaterial(context)) {
  return createAnalysisPackageService({
    acquireAnalysisMaterial,
    now: () => new Date(FIXED_NOW)
  });
}

test('canonicalizes and assembles US, SG, HK and ALL scopes with exact frozen shapes', async () => {
  assert.deepEqual(ANALYSIS_PACKAGE_REQUEST_KEYS, [
    'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
  ]);
  assert.deepEqual(ANALYSIS_PACKAGE_MEMBERSHIP_KEYS, ['market', 'symbol']);
  for (const scope of ['US', 'SG', 'HK', 'ALL']) {
    const canonical = canonicalizeAnalysisPackageRequest(request(scope.toLowerCase()));
    assert.equal(canonical.selectedScope, scope);
    assert.equal(canonical.initiatingList, 'myStocks');
    assert.equal(Object.isFrozen(canonical), true);
    const output = await service().assemble(request(scope.toLowerCase()));
    assert.deepEqual(output.marketPackages.map(item => item.market),
      scope === 'ALL' ? ['US', 'SG', 'HK'] : [scope]);
  }
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('EU')), /selectedScope/);
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('US', {initiatingList: 'other'})), /initiatingList/);
  assert.throws(() => canonicalizeAnalysisPackageRequest({...request(), extra: true}), /shape/);
});

test('preserves normalized My Stocks and Watchlist order independently', async () => {
  const input = request('ALL', {
    myStocks: [{market: 'sg', symbol: ' d05.si '}, {market: 'us', symbol: 'aapl'}],
    watchlist: [{market: 'hk', symbol: '0700.hk'}, {market: 'sg', symbol: '^sti'}]
  });
  const output = await service().assemble(input);
  assert.deepEqual(output.portfolioContext.myStocks.map(item => [item.market, item.symbol]), [
    ['SG', 'D05.SI'], ['US', 'AAPL']
  ]);
  assert.deepEqual(output.portfolioContext.watchlist.map(item => [item.market, item.symbol]), [
    ['HK', '0700.HK'], ['SG', '^STI']
  ]);
  assert.notEqual(output.portfolioContext.myStocks, output.portfolioContext.watchlist);
});

test('rejects invalid, duplicate, cross-scope and symbol-market membership', async () => {
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('US', {
    myStocks: [{market: 'SG', symbol: 'D05.SI'}]
  })), /cross-scope/);
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('ALL', {
    myStocks: [{market: 'US', symbol: 'AAPL'}, {market: 'US', symbol: 'aapl'}]
  })), /duplicate/);
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('ALL', {
    watchlist: [{market: 'US', symbol: '0700.HK'}]
  })), /cross-scope/);
  assert.throws(() => canonicalizeAnalysisPackageRequest(request('SG', {
    myStocks: [{market: 'SG', symbol: '^STI', extra: true}]
  })), /membership item/);
  await assert.rejects(service(async context => {
    const material = acquiredMaterial(context);
    material.portfolioContext.myStocks[0].symbol = 'O39.SI';
    return material;
  }).assemble(request('SG', {
    myStocks: [{market: 'SG', symbol: 'D05.SI'}]
  })), /inconsistent/);
});

test('invokes acquisition once with market order and no user timezone', async () => {
  const calls = [];
  const output = await service(async context => {
    calls.push(context);
    return acquiredMaterial(context);
  }).assemble(request('ALL', {userTimezone: 'America/New_York'}));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].markets, ['US', 'SG', 'HK']);
  assert.equal(calls[0].acquisitionStartedAt, FIXED_NOW);
  assert.equal(Object.hasOwn(calls[0], 'generatedAt'), false);
  assert.equal(Object.hasOwn(calls[0], 'userTimezone'), false);
  assert.equal(Object.isFrozen(calls[0].markets), true);
  assert.equal(output.analysisRequest.userTimezone, 'America/New_York');
  assert.deepEqual(output.marketPackages.map(item => item.marketContext.exchangeTimezone), [
    'America/New_York', 'Asia/Singapore', 'Asia/Hong_Kong'
  ]);
});

test('rejects invalid IANA timezone before acquisition', async () => {
  let calls = 0;
  await assert.rejects(createAnalysisPackageService({
    acquireAnalysisMaterial: async () => { calls++; },
    now: () => FIXED_NOW
  }).assemble(request('SG', {userTimezone: 'S.tz'})), /userTimezone/);
  assert.equal(calls, 0);
});

test('fails closed for acquisition failure, missing material and empty acquired content', async () => {
  await assert.rejects(service(async () => { throw new Error('provider unavailable'); }).assemble(request()), /provider unavailable/);
  await assert.rejects(service(async () => null).assemble(request()), /unavailable/);
  await assert.rejects(service(async context => {
    const material = acquiredMaterial(context);
    material.marketPackages[0].telemetry.benchmarkSnapshots = [];
    return material;
  }).assemble(request()), /unavailable/);
  await assert.rejects(service(async context => {
    const material = acquiredMaterial(context);
    material.marketPackages[0].evidenceCollection = createEvidenceCollection({market: 'SG', items: []});
    return material;
  }).assemble(request()), /unavailable/);
});

test('reports only the sanitized fatal package-assembly stage and preserves the thrown failure', async () => {
  const cases = [
    'FUTURE_DATED_EVIDENCE_VALIDATION',
    'EVIDENCE_COLLECTION_CONSTRUCTION',
    'EVIDENCE_ROLE_CLASSIFICATION'
  ];
  for (const failureStage of cases) {
    const diagnostics = [];
    const expected = new Error('sensitive failure detail');
    const packageService = createAnalysisPackageService({
      acquireAnalysisMaterial: async (context, setFailureStage) => {
        setFailureStage(failureStage);
        throw expected;
      },
      now: () => new Date(FIXED_NOW),
      onDiagnostics(value) { diagnostics.push(value); }
    });
    await assert.rejects(packageService.assemble(request()), error => error === expected);
    assert.deepEqual(diagnostics, [{stage: 'analysisPackageAssemblyFailure', failureStage}]);
    assert.equal(Object.isFrozen(diagnostics[0]), true);
    assert.equal(JSON.stringify(diagnostics).includes('sensitive failure detail'), false);
  }

  const diagnostics = [];
  await assert.rejects(createAnalysisPackageService({
    acquireAnalysisMaterial: async () => null,
    now: () => new Date(FIXED_NOW),
    onDiagnostics(value) { diagnostics.push(value); }
  }).assemble(request()), /unavailable/);
  assert.deepEqual(diagnostics, [{
    stage: 'analysisPackageAssemblyFailure',
    failureStage: 'ACQUIRED_MATERIAL_VALIDATION'
  }]);
});

test('returns a complete canonical envelope with server-derived fields', async () => {
  const output = await service().assemble(request('SG', {userTimezone: 'UTC'}));
  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(output.analysisRequest.generatedAt, FIXED_NOW);
  assert.equal(output.analysisRequest.reportType, 'MARKET_BRIEF');
  assert.equal(output.analysisRequest.initiatingList, 'myStocks');
  assert.equal(output.analysisRequest.userTimezone, 'UTC');
  assert.equal(output.outputRequirements.header, 'REPORT HEADER / ANALYSIS CONTEXT');
  assert.equal(output.outputRequirements.sections.length, 11);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.outputRequirements.sections), true);
});

test('does not retain or mutate request and acquisition-owned references', async () => {
  const input = request('SG', {myStocks: [{market: 'SG', symbol: 'D05.SI'}]});
  let sourceMaterial;
  const output = await service(async context => {
    sourceMaterial = acquiredMaterial(context);
    return sourceMaterial;
  }).assemble(input);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(sourceMaterial), false);
  input.myStocks[0].symbol = 'O39.SI';
  sourceMaterial.marketPackages[0].marketContext.marketState = 'REGULAR';
  sourceMaterial.portfolioContext.myStocks[0].symbol = 'O39.SI';
  assert.equal(output.portfolioContext.myStocks[0].symbol, 'D05.SI');
  assert.equal(output.marketPackages[0].marketContext.marketState, 'CLOSED');
  assert.equal(validateClaudeAnalysisInput(output), true);
});

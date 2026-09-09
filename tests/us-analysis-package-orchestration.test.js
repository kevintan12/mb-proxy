const test = require('node:test');
const assert = require('node:assert/strict');
const {createCompletedRegularSession, createThreeSessionSnapshot} = require('../lib/three-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS
} = require('../lib/cnbc-news-research-runtime');
const {validateClaudeAnalysisInput} = require('../lib/claude-analysis-contract');
const {
  BENCHMARK_ANCHOR_KEYS,
  CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
  FEDERAL_RESERVE_UNAVAILABLE_GAP,
  ORCHESTRATION_REQUEST_KEYS,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
} = require('../lib/us-analysis-package-orchestration');

const GENERATED_AT = '2026-09-06T10:00:00.000Z';

function request(selectedScope = 'US', overrides = {}) {
  return {
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}],
    selectedScope,
    initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore',
    myStocks: [],
    watchlist: [],
    ...overrides
  };
}

function snapshot(symbol) {
  const previousSession = createCompletedRegularSession({
    market: 'US',
    sessionDate: '2026-09-03',
    open: 95,
    high: 102,
    low: 94,
    close: 100,
    previousClose: 96,
    volume: 900,
    asOf: '2026-09-03T16:00:00-04:00',
    sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  const session = createCompletedRegularSession({
    market: 'US',
    sessionDate: '2026-09-04',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    previousClose: 100,
    volume: 1000,
    asOf: '2026-09-04T16:00:00-04:00',
    sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  return createThreeSessionSnapshot({
    market: 'US',
    symbol,
    instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY',
    currency: 'USD',
    marketState: 'CLOSED',
    completedSessions: [previousSession, session],
    currentOverlay: null
  });
}

function cnbcCandidate(reference, horizon) {
  const number = reference.slice(1);
  const publishedAt = new Date(
    (Date.parse(horizon.startsAtExclusive) + Date.parse(horizon.endsAtInclusive)) / 2
  ).toISOString();
  return createNewsEvidenceCandidate({
    reference,
    horizon,
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: `CNBC market news item ${number}`,
    summary: `CNBC candidate summary item ${number}.`,
    extract: null,
    canonicalUrl: `https://www.cnbc.com/2026/09/04/item-${number}.html`,
    publishedAt,
    symbols: []
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds});
}

function cnbcResearchSuccess(horizons, classifications = []) {
  const candidates = classifications.map((classification, index) => cnbcCandidate(
    `c${index + 1}`,
    horizons.find(horizon => horizon.classification === classification)
  ));
  const candidateCollection = createNewsEvidenceCandidateCollection({
    market: 'US',
    candidates
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds});
  const selections = candidates.map(candidate => ({
    reference: candidate.reference,
    decision: 'USE',
    category: 'news',
    materiality: 'HIGH',
    reason: 'Material market development.'
  }));
  const retrievedArticles = candidates.map(candidate => ({
    reference: candidate.reference,
    sourceId: candidate.sourceId,
    canonicalUrl: candidate.canonicalUrl,
    publishedAt: candidate.publishedAt,
    updatedAt: null,
    title: candidate.title,
    articleText: `Bounded CNBC article content item ${candidate.reference.slice(1)}.`,
    provenance: candidate.provenance
  }));
  const constructedEvidence = candidates.map((candidate, index) => ({
    candidateReference: candidate.reference,
    horizon: candidate.horizon,
    selection: selections[index],
    evidenceItem: createEvidenceItem({
      sourceId: candidate.sourceId,
      market: candidate.market,
      evidenceCategory: candidate.evidenceCategory,
      title: candidate.title,
      summary: retrievedArticles[index].articleText,
      canonicalUrl: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt,
      symbols: candidate.symbols
    })
  }));
  return {ok: true, type: 'SUCCESS', candidateCollection, selections, retrievedArticles, constructedEvidence};
}

function cnbcAllSkipSuccess(horizons) {
  const candidateCollection = createNewsEvidenceCandidateCollection({
    market: 'US', candidates: [cnbcCandidate('c1', horizons[0])]
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds});
  return {
    ok: true,
    type: 'SUCCESS',
    candidateCollection,
    selections: [{
      reference: 'c1', decision: 'SKIP', category: 'news', materiality: 'LOW', reason: 'Not material.'
    }],
    retrievedArticles: [],
    constructedEvidence: []
  };
}

function yahooEvidence(symbol, publishedAt = '2026-09-05T20:00:00Z') {
  return createEvidenceCollection({
    market: 'US',
    items: [createEvidenceItem({
      sourceId: 'us.yahoo-finance',
      market: 'US',
      evidenceCategory: 'market-data',
      title: `${symbol} market data`,
      summary: `${symbol} factual market data.`,
      canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
      publishedAt,
      symbols: [symbol]
    })]
  });
}

function fedEvidence(publishedAt = '2026-09-05T18:00:00Z') {
  return createEvidenceCollection({
    market: 'US',
    items: [
      createEvidenceItem({
        sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
        title: 'Federal Reserve policy statement',
        canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm',
        publishedAt, symbols: []
      }),
      createEvidenceItem({
        sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
        title: 'Federal Reserve minutes',
        canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
        publishedAt: '2026-09-04T18:00:00Z', symbols: []
      })
    ]
  });
}

function harness(overrides = {}) {
  const calls = {factories: [], telemetry: [], persistence: [], yahoo: [], fed: 0, cnbc: []};
  const dependencies = {
    createTelemetryAcquisition: ({generatedAt}) => {
      calls.factories.push(generatedAt);
      return {
        async acquireSnapshot({market, symbol}) {
          calls.telemetry.push({market, symbol, generatedAt});
          return snapshot(symbol);
        }
      };
    },
    snapshotPersistence: {
      async persistSnapshot(value) {
        calls.persistence.push(value.symbol);
        return value;
      }
    },
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) {
        calls.yahoo.push(symbol);
        return yahooEvidence(symbol);
      }
    },
    federalReserveEvidenceAcquisition: {
      async acquireEvidence() {
        calls.fed++;
        return fedEvidence();
      }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        calls.cnbc.push(horizons);
        return cnbcAllSkipSuccess(horizons);
      }
    },
    now: () => new Date(GENERATED_AT),
    ...overrides
  };
  return {service: createUsAnalysisPackageOrchestrationService(dependencies), calls};
}

test('assembles a canonical US package with supplied benchmarks and deterministic refs', async () => {
  const {service, calls} = harness();
  const output = await service.assemble(request('US', {
    benchmarkAnchors: [
      {market: 'us', symbol: ' ^rut '},
      {market: 'US', symbol: '^DJI'},
      {market: 'US', symbol: '^RUT'}
    ],
    myStocks: [{market: 'US', symbol: 'MSFT'}, {market: 'US', symbol: 'AAPL'}],
    watchlist: [{market: 'US', symbol: 'AAPL'}, {market: 'US', symbol: 'NVDA'}]
  }));

  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(output.analysisRequest.generatedAt, GENERATED_AT);
  assert.equal(output.analysisRequest.initiatingList, 'myStocks');
  assert.equal(output.analysisRequest.userTimezone, 'Asia/Singapore');
  assert.deepEqual(calls.factories, [GENERATED_AT]);
  assert.deepEqual(calls.telemetry, [
    {market: 'US', symbol: '^RUT', generatedAt: GENERATED_AT},
    {market: 'US', symbol: '^DJI', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'MSFT', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'AAPL', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'NVDA', generatedAt: GENERATED_AT}
  ]);
  assert.deepEqual(calls.persistence, ['^RUT', '^DJI', 'MSFT', 'AAPL', 'NVDA']);
  assert.deepEqual(calls.yahoo, ['^RUT', '^DJI', 'MSFT', 'AAPL', 'NVDA']);
  assert.equal(calls.fed, 1);
  assert.equal(calls.cnbc.length, 1);
  assert.deepEqual(calls.cnbc[0], [
    {
      classification: 'COMPLETED_SESSION',
      startsAtExclusive: '2026-09-03T20:00:00.000Z',
      endsAtInclusive: '2026-09-04T20:00:00.000Z'
    },
    {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-04T20:00:00.000Z',
      endsAtInclusive: GENERATED_AT
    }
  ]);

  const marketPackage = output.marketPackages[0];
  assert.deepEqual(marketPackage.telemetry.benchmarkSnapshots.map(item => [item.reference, item.snapshot.symbol]), [
    ['t1', '^RUT'], ['t2', '^DJI']
  ]);
  assert.deepEqual(marketPackage.telemetry.stockSnapshots.map(item => [item.reference, item.snapshot.symbol]), [
    ['t3', 'MSFT'], ['t4', 'AAPL'], ['t5', 'NVDA']
  ]);
  assert.deepEqual(marketPackage.evidenceContext.evidence.map(item => [item.reference, item.item.sourceId, item.item.symbols[0] || null]), [
    ['e1', 'us.yahoo-finance', '^RUT'],
    ['e2', 'us.yahoo-finance', '^DJI'],
    ['e3', 'us.yahoo-finance', 'MSFT'],
    ['e4', 'us.yahoo-finance', 'AAPL'],
    ['e5', 'us.yahoo-finance', 'NVDA'],
    ['e6', 'us.federal-reserve', null],
    ['e7', 'us.federal-reserve', null]
  ]);
  assert.deepEqual(marketPackage.evidenceContext.materialEvents, []);
  assert.deepEqual(marketPackage.evidenceContext.principalCatalysts, []);
  assert.deepEqual(marketPackage.evidenceContext.authoritativeFacts, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.deepEqual(marketPackage.evidenceContext.supportingEvidence, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.deepEqual(marketPackage.evidenceContext.furtherReadings, []);
  assert.equal(marketPackage.marketContext.calendarContext, null);

  assert.deepEqual(output.portfolioContext.myStocks, [
    {market: 'US', symbol: 'MSFT', telemetryRefs: ['t3'], evidenceRefs: ['e3'], upcomingEvents: []},
    {market: 'US', symbol: 'AAPL', telemetryRefs: ['t4'], evidenceRefs: ['e4'], upcomingEvents: []}
  ]);
  assert.deepEqual(output.portfolioContext.watchlist, [
    {market: 'US', symbol: 'AAPL', telemetryRefs: ['t4'], evidenceRefs: ['e4'], upcomingEvents: []},
    {market: 'US', symbol: 'NVDA', telemetryRefs: ['t5'], evidenceRefs: ['e5'], upcomingEvents: []}
  ]);
});

test('reports sanitized non-negative timings for existing package stages', async () => {
  const diagnostics = [];
  const {service} = harness({onDiagnostics(value) { diagnostics.push(value); }});
  const output = await service.assemble(request('US', {
    myStocks: [{market: 'US', symbol: 'MSFT'}]
  }));

  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]), ['timing']);
  assert.deepEqual(Object.keys(diagnostics[0].timing), [
    'yahooTelemetryAcquisitionMs',
    'postgresPersistenceReadbackMs',
    'yahooMarketDataEvidenceAcquisitionMs',
    'federalReserveEvidenceAcquisitionMs',
    'cnbcNewsResearchMs',
    'packageAssemblyFinalizationMs',
    'packageRuntimeTotalMs'
  ]);
  for (const elapsed of Object.values(diagnostics[0].timing)) {
    assert.equal(typeof elapsed, 'number');
    assert.equal(Number.isFinite(elapsed), true);
    assert.equal(elapsed >= 0, true);
  }
  assert.equal(Object.isFrozen(diagnostics[0]), true);
  assert.equal(Object.isFrozen(diagnostics[0].timing), true);
  const serialized = JSON.stringify(diagnostics[0]);
  assert.equal(serialized.includes('MSFT'), false);
  assert.equal(serialized.includes('Federal Reserve policy statement'), false);
});

test('keeps portfolio membership validation independent of the Claude byte guard', () => {
  const memberships = Array.from({length: 50}, (_, index) => ({
    market: 'US',
    symbol: `STOCK${index + 1}`
  }));
  const result = validateUsAnalysisOrchestrationRequest(request('US', {myStocks: memberships}));
  assert.equal(result.canonicalRequest.myStocks.length, 50);
});

test('supports an empty portfolio without fabricating stock or event context', async () => {
  const {service, calls} = harness();
  const output = await service.assemble(request());
  assert.deepEqual(calls.telemetry.map(item => item.symbol), ['^RUT']);
  assert.deepEqual(output.marketPackages[0].telemetry.stockSnapshots, []);
  assert.deepEqual(output.portfolioContext, {myStocks: [], watchlist: []});
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('rejects SG, HK and ALL explicitly before runtime acquisition', async () => {
  for (const selectedScope of ['SG', 'HK', 'ALL']) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request(selectedScope)), /supports selectedScope US only/);
    assert.deepEqual(calls.factories, []);
  }
});

test('rejects overlap between supplied anchors and either portfolio list before any acquisition', async () => {
  const cases = [
    {myStocks: [{market: 'US', symbol: '^RUT'}]},
    {watchlist: [{market: 'US', symbol: '^RUT'}]}
  ];
  for (const membership of cases) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request('US', membership)), /cannot be portfolio membership/);
    assert.deepEqual(calls, {factories: [], telemetry: [], persistence: [], yahoo: [], fed: 0, cnbc: []});
  }
});

test('integrates completed and subsequent CNBC evidence after Yahoo and Fed with package-owned refs', async () => {
  let researchCalls = 0;
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        researchCalls++;
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT']);
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(researchCalls, 1);
  assert.deepEqual(context.evidence.map(entry => [entry.reference, entry.item.sourceId]), [
    ['e1', 'us.yahoo-finance'],
    ['e2', 'us.federal-reserve'],
    ['e3', 'us.federal-reserve'],
    ['e4', 'us.cnbc'],
    ['e5', 'us.cnbc']
  ]);
  assert.deepEqual(context.supportingEvidence, ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(context.subsequentDevelopments, ['e5']);
  assert.deepEqual(context.principalCatalysts, []);
  assert.equal(JSON.stringify(output).includes('c1'), false);
  assert.equal(JSON.stringify(output).includes('c2'), false);
});

test('CNBC all-SKIP adds no evidence or gap', async () => {
  const {service} = harness();
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
  assert.deepEqual(context.unresolvedGaps, []);
});

test('every CNBC stage failure degrades to one deterministic package gap', async () => {
  for (const type of [
    'CANDIDATE_ACQUISITION_FAILURE',
    'MATERIALITY_PROVIDER_FAILURE',
    'MATERIALITY_CONTRACT_FAILURE',
    'MATERIALITY_REQUEST_TOO_LARGE',
    'ARTICLE_RETRIEVAL_FAILURE',
    'EVIDENCE_CONSTRUCTION_FAILURE'
  ]) {
    const diagnostics = [];
    const {service} = harness({
      cnbcNewsResearch: {async researchNews() { return {ok: false, type}; }},
      onDiagnostics(value) { diagnostics.push(value); }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    assert.equal(validateClaudeAnalysisInput(output), true);
    assert.deepEqual(context.unresolvedGaps, [CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP]);
    assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
    assert.equal(diagnostics.some(item => item.failureType === type), true);
  }
});

test('unavailable or inconsistent canonical benchmark boundaries degrade CNBC only', async () => {
  const oneSession = createThreeSessionSnapshot({
    market: 'US', symbol: '^RUT', instrumentName: 'benchmark', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED',
    completedSessions: [snapshot('^RUT').completedSessions[1]], currentOverlay: null
  });
  let researchCalls = 0;
  const {service} = harness({
    createTelemetryAcquisition: () => ({async acquireSnapshot() { return oneSession; }}),
    cnbcNewsResearch: {async researchNews() { researchCalls++; }}
  });
  const output = await service.assemble(request());
  assert.equal(researchCalls, 0);
  assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
    CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP
  ]);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('requires non-empty normalized US anchors without any backend symbol assumption', async () => {
  assert.deepEqual(ORCHESTRATION_REQUEST_KEYS, [
    'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
  ]);
  assert.deepEqual(BENCHMARK_ANCHOR_KEYS, ['market', 'symbol']);
  for (const benchmarkAnchors of [[], [{market: 'SG', symbol: '^STI'}], [{market: 'US', symbol: '0700.HK'}]]) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request('US', {benchmarkAnchors})), /benchmarkAnchors/);
    assert.deepEqual(calls.factories, []);
  }

  const {service, calls} = harness();
  const output = await service.assemble(request('US', {
    benchmarkAnchors: [{market: 'US', symbol: 'CUSTOM-BENCH'}]
  }));
  assert.deepEqual(calls.telemetry.map(entry => entry.symbol), ['CUSTOM-BENCH']);
  assert.deepEqual(output.marketPackages[0].telemetry.benchmarkSnapshots.map(entry => entry.snapshot.symbol), ['CUSTOM-BENCH']);
  assert.deepEqual(output.marketPackages[0].telemetry.stockSnapshots, []);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('continues with one deterministic unresolved gap when Federal Reserve acquisition fails', async () => {
  const {service} = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { throw new Error('unavailable'); }}
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(context.evidence.map(item => item.item.sourceId), ['us.yahoo-finance']);
  assert.deepEqual(context.unresolvedGaps, [FEDERAL_RESERVE_UNAVAILABLE_GAP]);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('fails closed for future-dated Yahoo or Federal Reserve evidence', async () => {
  const future = '2026-09-07T10:00:00Z';
  const yahoo = harness({
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) { return yahooEvidence(symbol, future); }}
  }).service;
  await assert.rejects(yahoo.assemble(request()), /Future-dated evidence/);

  const fed = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return fedEvidence(future); }}
  }).service;
  await assert.rejects(fed.assemble(request()), /Future-dated evidence/);
});

test('fails closed for required telemetry, persistence and Yahoo evidence failures', async () => {
  const telemetry = harness({
    createTelemetryAcquisition: () => ({async acquireSnapshot() { throw new Error('telemetry failed'); }})
  }).service;
  await assert.rejects(telemetry.assemble(request()), /telemetry failed/);

  const persistence = harness({
    snapshotPersistence: {async persistSnapshot() { throw new Error('persistence failed'); }}
  }).service;
  await assert.rejects(persistence.assemble(request()), /persistence failed/);

  const yahoo = harness({
    yahooEvidenceAcquisition: {async acquireEvidence() { throw new Error('Yahoo failed'); }}
  }).service;
  await assert.rejects(yahoo.assemble(request()), /Yahoo failed/);
});

test('rejects inconsistent persisted reconstruction and malformed provider material', async () => {
  const wrongPersistence = harness({
    snapshotPersistence: {async persistSnapshot() { return snapshot('WRONG'); }}
  }).service;
  await assert.rejects(wrongPersistence.assemble(request()), /Invalid canonical US snapshot/);

  const malformedFed = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return null; }}
  });
  const output = await malformedFed.service.assemble(request());
  assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [FEDERAL_RESERVE_UNAVAILABLE_GAP]);
});

test('returns immutable output without mutating membership or acquired canonical objects', async () => {
  const input = request('US', {
    myStocks: [{market: 'US', symbol: 'aapl'}],
    watchlist: [{market: 'US', symbol: 'msft'}]
  });
  const original = JSON.parse(JSON.stringify(input));
  const acquiredSnapshot = snapshot('^RUT');
  const acquiredEvidence = yahooEvidence('^RUT');
  const {service} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) { return symbol === '^RUT' ? acquiredSnapshot : snapshot(symbol); }
    }),
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) { return symbol === '^RUT' ? acquiredEvidence : yahooEvidence(symbol); }
    }
  });
  const output = await service.assemble(input);
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.marketPackages), true);
  assert.equal(Object.isFrozen(output.portfolioContext.myStocks), true);
  assert.equal(Object.isFrozen(acquiredSnapshot), true);
  assert.equal(Object.isFrozen(acquiredEvidence), true);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createThreeSessionSnapshot
} = require('../lib/three-session-snapshot');
const {
  ANALYTICAL_STATUSES,
  SELECTED_SCOPES,
  REPORT_TYPES,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  REPORT_SECTION_REQUIREMENTS,
  CLAUDE_ANALYSIS_INPUT_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_KEYS,
  REPORT_SECTION_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  createClaudeAnalysisInput,
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  createClaudeAnalysisOutput
} = require('../lib/claude-analysis-contract');

const MARKET_CONFIG = {
  US: {zone: 'America/New_York', source: 'us.yahoo-finance', news: 'us.reuters', symbol: '^GSPC'},
  SG: {zone: 'Asia/Singapore', source: 'sg.yahoo-finance', news: 'sg.reuters', symbol: '^STI'},
  HK: {zone: 'Asia/Hong_Kong', source: 'hk.yahoo-finance', news: 'hk.reuters', symbol: '^HSI'}
};

function evidence(market, overrides = {}) {
  const config = MARKET_CONFIG[market];
  return createEvidenceItem({
    sourceId: config.news,
    market,
    evidenceCategory: 'news',
    title: `${market} market update`,
    summary: 'A supported market observation.',
    canonicalUrl: `https://www.reuters.com/markets/${market.toLowerCase()}-example`,
    publishedAt: '2026-09-06T08:00:00Z',
    symbols: [config.symbol],
    ...overrides
  });
}

function snapshot(market, symbol = MARKET_CONFIG[market].symbol, withOverlay = false) {
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
  const currentOverlay = withOverlay ? createCurrentSessionOverlay({
    market,
    marketState: 'REGULAR',
    sessionDate: '2026-09-07',
    asOf: market === 'US' ? '2026-09-07T10:00:00-04:00' : '2026-09-07T10:00:00+08:00',
    lastPrice: 106,
    referenceClose: 105,
    volume: 0,
    sourceId: config.source,
    validationState: 'LIVE VALIDATED'
  }) : null;
  return createThreeSessionSnapshot({
    market,
    symbol,
    instrumentName: `${symbol} instrument`,
    instrumentType: 'INDEX',
    currency: market === 'US' ? 'USD' : market === 'SG' ? 'SGD' : 'HKD',
    marketState: withOverlay ? 'REGULAR' : 'CLOSED',
    completedSessions: [session],
    currentOverlay
  });
}

function marketPackage(market, {evidenceRef = 'e1', telemetrySnapshots, items} = {}) {
  const packageItems = items || [evidence(market)];
  const snapshots = telemetrySnapshots || [snapshot(market)];
  return {
    market,
    marketContext: {
      exchangeTimezone: MARKET_CONFIG[market].zone,
      marketState: snapshots[0]?.marketState || 'CLOSED',
      primaryCompletedSessionDate: snapshots.length ? '2026-09-04' : null,
      includesCurrentOverlay: snapshots.some(item => item.currentOverlay !== null),
      calendarContext: 'Applicable regular-session calendar is resolved by MarketBrief.'
    },
    telemetry: {benchmarkSnapshots: snapshots, stockSnapshots: []},
    evidenceCollection: createEvidenceCollection({market, items: packageItems}),
    evidenceContext: {
      materialEvents: [evidenceRef],
      authoritativeFacts: [],
      principalCatalysts: [evidenceRef],
      supportingEvidence: [evidenceRef],
      conflictingEvidence: [],
      subsequentDevelopments: [],
      unresolvedGaps: [],
      furtherReadings: []
    }
  };
}

function canonicalInput(overrides = {}) {
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG',
      generatedAt: '2026-09-06T18:00:00+08:00',
      userTimezone: 'Asia/Singapore',
      reportType: 'MARKET_BRIEF'
    },
    marketPackages: [marketPackage('SG')],
    portfolioContext: {myStocks: [], watchlist: []},
    ...overrides
  });
}

function reportContext(input) {
  return {
    header: REPORT_HEADER,
    selectedScope: input.analysisRequest.selectedScope,
    generatedAt: input.analysisRequest.generatedAt,
    userTimezone: input.analysisRequest.userTimezone,
    reportType: input.analysisRequest.reportType,
    markets: input.marketPackages.map(item => item.market)
  };
}

function sections({content = 'Supported analysis.', evidenceRefs = ['e1'], telemetryRefs = ['t1']} = {}) {
  return REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === REPORT_SECTION_NAMES.length - 1 ? null : content,
    evidenceRefs: index === REPORT_SECTION_NAMES.length - 1 ? [] : evidenceRefs.slice(),
    telemetryRefs: index === REPORT_SECTION_NAMES.length - 1 ? [] : telemetryRefs.slice(),
    uncertainties: []
  }));
}

function normalOutput(input, overrides = {}) {
  return {
    status: 'NORMAL',
    reportContext: reportContext(input),
    sections: sections(),
    evidenceReferences: ['e1'],
    furtherReadings: [],
    evidenceGaps: [],
    ...overrides
  };
}

test('creates the frozen MARKET_BRIEF package with deterministic shape and requirements', () => {
  const input = canonicalInput();
  assert.deepEqual(SELECTED_SCOPES, ['US', 'SG', 'HK', 'ALL']);
  assert.deepEqual(REPORT_TYPES, ['MARKET_BRIEF']);
  assert.equal(REPORT_HEADER, 'REPORT HEADER / ANALYSIS CONTEXT');
  assert.deepEqual(REPORT_SECTION_NAMES, [
    'EXECUTIVE MARKET SUMMARY', 'KEY MARKET DRIVERS',
    'WHAT DROVE / IS DRIVING THE MARKET', 'STOCKS & SECTORS IN FOCUS',
    'MY STOCKS & WATCHLIST - MATERIAL MOVEMENTS', 'MARKET INTERPRETATION',
    'KEY RISKS', 'OPPORTUNITIES', 'WHAT TO WATCH FOR NEXT',
    'MARKETBRIEF TAKEAWAY', 'FURTHER READINGS'
  ]);
  assert.deepEqual(Object.keys(input), CLAUDE_ANALYSIS_INPUT_KEYS);
  assert.equal(input.analysisRequest.generatedAt, '2026-09-06T10:00:00.000Z');
  assert.equal(input.analysisRequest.reportType, 'MARKET_BRIEF');
  assert.equal(input.marketPackages[0].evidenceContext.evidence[0].reference, 'e1');
  assert.equal(input.marketPackages[0].telemetry.benchmarkSnapshots[0].reference, 't1');
  assert.deepEqual(input.outputRequirements.sections, REPORT_SECTION_REQUIREMENTS);
  assert.equal(input.outputRequirements.maximumWords, 2500);
  assert.equal(validateClaudeAnalysisInput(input), true);
});

test('enforces selected scope and deterministic US, SG, HK ordering for ALL', () => {
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'ALL', generatedAt: '2026-09-06T10:00:00Z',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [
      marketPackage('US', {evidenceRef: 'e1'}),
      marketPackage('SG', {evidenceRef: 'e2'}),
      marketPackage('HK', {evidenceRef: 'e3'})
    ],
    portfolioContext: {myStocks: [], watchlist: []}
  });
  assert.deepEqual(input.marketPackages.map(item => item.market), ['US', 'SG', 'HK']);
  assert.deepEqual(input.marketPackages.flatMap(item =>
    item.evidenceContext.evidence.map(entry => entry.reference)), ['e1', 'e2', 'e3']);
  assert.deepEqual(input.marketPackages.flatMap(item =>
    item.telemetry.benchmarkSnapshots.map(entry => entry.reference)), ['t1', 't2', 't3']);
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: {...input.analysisRequest, generatedAt: '2026-09-06T10:00:00Z'},
    marketPackages: [marketPackage('SG', {evidenceRef: 'e1'})],
    portfolioContext: {myStocks: [], watchlist: []}
  }), /selected scope/);
});

test('rejects invalid request values and caller-supplied output requirements', () => {
  for (const override of [
    {selectedScope: 'EU'}, {reportType: 'SEARCH_ANALYSIS'},
    {generatedAt: '2026-09-06'}, {userTimezone: 'S.tz'}
  ]) {
    assert.throws(() => createClaudeAnalysisInput({
      analysisRequest: {
        selectedScope: 'SG', generatedAt: '2026-09-06T10:00:00Z',
        userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF', ...override
      },
      marketPackages: [marketPackage('SG')],
      portfolioContext: {myStocks: [], watchlist: []}
    }), /request/);
  }
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: canonicalInput().analysisRequest,
    marketPackages: [marketPackage('SG')],
    portfolioContext: {myStocks: [], watchlist: []},
    outputRequirements: {}
  }), /must not be supplied/);
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: canonicalInput().analysisRequest,
    marketPackages: [marketPackage('SG')],
    portfolioContext: {myStocks: [], watchlist: []},
    provenance: {publisher: 'caller'}
  }), /property shape/);
});

test('validates market/session context against canonical 8B.3 snapshots and overlays', () => {
  const liveSnapshot = snapshot('SG', '^STI', true);
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', generatedAt: '2026-09-07T03:00:00Z',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [marketPackage('SG', {telemetrySnapshots: [liveSnapshot]})],
    portfolioContext: {myStocks: [], watchlist: []}
  });
  assert.equal(input.marketPackages[0].marketContext.includesCurrentOverlay, true);
  assert.equal(input.marketPackages[0].telemetry.benchmarkSnapshots[0].snapshot.currentOverlay.isFinal, false);

  const wrongZone = marketPackage('SG');
  wrongZone.marketContext.exchangeTimezone = 'America/New_York';
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: input.analysisRequest,
    marketPackages: [wrongZone], portfolioContext: {myStocks: [], watchlist: []}
  }), /market context/);

  const spoofed = marketPackage('SG');
  spoofed.telemetry.benchmarkSnapshots[0] = JSON.parse(JSON.stringify(spoofed.telemetry.benchmarkSnapshots[0]));
  spoofed.telemetry.benchmarkSnapshots[0].completedSessions[0].provenance.publisher = 'Spoof';
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: input.analysisRequest,
    marketPackages: [spoofed], portfolioContext: {myStocks: [], watchlist: []}
  }), /canonical/);
});

test('normalizes evidence roles and protects evidence provenance and Further Readings dates', () => {
  const usItems = [
    createEvidenceItem({
      sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
      title: 'Yahoo session recap', canonicalUrl: 'https://finance.yahoo.com/news/session-recap',
      publishedAt: '2026-09-04T21:00:00Z'
    }),
    createEvidenceItem({
      sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
      title: 'CNBC session recap', canonicalUrl: 'https://www.cnbc.com/2026/09/04/session-recap.html',
      publishedAt: '2026-09-04T21:00:00Z'
    })
  ];
  const packageInput = marketPackage('US', {items: usItems, evidenceRef: 'e1'});
  packageInput.evidenceContext.furtherReadings = [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'},
    {evidenceRef: 'e2', sessionDate: '2026-09-04'}
  ];
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', generatedAt: '2026-09-06T10:00:00Z',
      userTimezone: 'America/New_York', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [packageInput], portfolioContext: {myStocks: [], watchlist: []}
  });
  assert.deepEqual(input.marketPackages[0].evidenceContext.furtherReadings.map(item => item.evidenceRef), ['e1', 'e2']);
  assert.equal(Object.isFrozen(input.marketPackages[0].evidenceContext.evidence[0].item.provenance), true);

  packageInput.evidenceContext.furtherReadings[0].sessionDate = '2026-09-03';
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: input.analysisRequest,
    marketPackages: [packageInput], portfolioContext: {myStocks: [], watchlist: []}
  }), /primary completed/);
});

test('keeps My Stocks and Watchlist separate with telemetry, evidence and 14-day events', () => {
  const stockSnapshot = snapshot('SG', 'D05.SI');
  const packageInput = marketPackage('SG');
  packageInput.telemetry.stockSnapshots = [stockSnapshot];
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', generatedAt: '2026-09-06T10:00:00Z',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [packageInput],
    portfolioContext: {
      myStocks: [{
        market: 'SG', symbol: ' d05.si ', telemetryRefs: ['t2'], evidenceRefs: ['e1'],
        upcomingEvents: [{
          title: 'Results announcement', scheduledAt: '2026-09-15T09:00:00+08:00', evidenceRefs: ['e1']
        }]
      }],
      watchlist: [{market: 'SG', symbol: '^STI', telemetryRefs: ['t1'], evidenceRefs: [], upcomingEvents: []}]
    }
  });
  assert.equal(input.portfolioContext.myStocks[0].symbol, 'D05.SI');
  assert.equal(input.portfolioContext.myStocks[0].upcomingEvents[0].scheduledAt, '2026-09-15T01:00:00.000Z');
  assert.notEqual(input.portfolioContext.myStocks, input.portfolioContext.watchlist);

  const late = JSON.parse(JSON.stringify(input));
  late.portfolioContext.myStocks[0].upcomingEvents[0].scheduledAt = '2026-10-01T01:00:00.000Z';
  assert.equal(validateClaudeAnalysisInput(late), false);
});

test('returns a deeply immutable input-independent canonical package', () => {
  const raw = marketPackage('SG');
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', generatedAt: '2026-09-06T10:00:00Z',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [raw], portfolioContext: {myStocks: [], watchlist: []}
  });
  raw.marketContext.marketState = 'MUTATED';
  raw.evidenceContext.materialEvents.length = 0;
  assert.equal(input.marketPackages[0].marketContext.marketState, 'CLOSED');
  assert.deepEqual(input.marketPackages[0].evidenceContext.materialEvents, ['e1']);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.marketPackages), true);
  assert.equal(Object.isFrozen(input.outputRequirements.sections[0]), true);
});

test('accepts the exact ordered NORMAL report and returns an immutable copy', () => {
  const input = canonicalInput();
  const supplied = normalOutput(input);
  const output = createClaudeAnalysisOutput(supplied, input);
  assert.deepEqual(ANALYTICAL_STATUSES, ['NORMAL', 'DEGRADED', 'FAILED']);
  assert.deepEqual(Object.keys(output), CLAUDE_ANALYSIS_OUTPUT_KEYS);
  assert.deepEqual(output.sections.map(section => section.name), REPORT_SECTION_NAMES);
  assert.deepEqual(Object.keys(output.sections[0]), REPORT_SECTION_KEYS);
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  supplied.sections[0].content = 'Mutated';
  assert.equal(output.sections[0].content, 'Supported analysis.');
  assert.equal(Object.isFrozen(output.sections[0].evidenceRefs), true);
});

test('rejects reordered sections, unknown references, model URLs and mismatched context', () => {
  const input = canonicalInput();
  const reordered = normalOutput(input);
  [reordered.sections[0], reordered.sections[1]] = [reordered.sections[1], reordered.sections[0]];
  assert.equal(validateClaudeAnalysisOutput(reordered, input).valid, false);
  assert.equal(validateClaudeAnalysisOutput(normalOutput(input, {
    sections: sections({evidenceRefs: ['e2']})
  }), input).valid, false);
  assert.equal(validateClaudeAnalysisOutput({...normalOutput(input), canonicalUrl: 'https://example.com/'}, input).valid, false);
  const contextMismatch = normalOutput(input);
  contextMismatch.reportContext.selectedScope = 'US';
  assert.equal(validateClaudeAnalysisOutput(contextMismatch, input).valid, false);
  const malformedReferences = normalOutput(input);
  malformedReferences.sections[10].evidenceRefs = null;
  assert.equal(validateClaudeAnalysisOutput(malformedReferences, input).valid, false);
  const malformedUncertainties = normalOutput(input);
  malformedUncertainties.sections[0].uncertainties = {text: 'not an array'};
  assert.equal(validateClaudeAnalysisOutput(malformedUncertainties, input).valid, false);
  const telemetryOnly = normalOutput(input);
  telemetryOnly.sections[0].evidenceRefs = [];
  assert.equal(validateClaudeAnalysisOutput(telemetryOnly, input).valid, false);
});

test('enforces NORMAL, DEGRADED and FAILED semantics separately from contract failure', () => {
  const input = canonicalInput();
  const degradedSections = sections();
  degradedSections[7] = {
    name: REPORT_SECTION_NAMES[7], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Opportunity evidence is incomplete.']
  };
  assert.equal(validateClaudeAnalysisOutput({
    status: 'DEGRADED', reportContext: reportContext(input), sections: degradedSections,
    evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: ['Material catalyst remains unresolved.']
  }, input).valid, true);
  assert.equal(validateClaudeAnalysisOutput({
    status: 'FAILED', reportContext: reportContext(input),
    sections: sections({content: null, evidenceRefs: [], telemetryRefs: []}),
    evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Reliable core telemetry is unavailable.']
  }, input).valid, true);
  assert.equal(validateClaudeAnalysisOutput({
    status: 'FAILED', reportContext: reportContext(input), sections: sections(),
    evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: ['Failure.']
  }, input).valid, false);
  assert.throws(() => createClaudeAnalysisOutput({status: 'FAILED'}, input), /Invalid Claude analysis output/);
});

test('requires Further Readings to exactly match MarketBrief-owned supplied references', () => {
  const usItems = [createEvidenceItem({
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: 'Session recap',
    canonicalUrl: 'https://www.cnbc.com/session-recap.html', publishedAt: '2026-09-04T21:00:00Z'
  })];
  const packageInput = marketPackage('US', {items: usItems});
  packageInput.evidenceContext.furtherReadings = [{evidenceRef: 'e1', sessionDate: '2026-09-04'}];
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', generatedAt: '2026-09-06T10:00:00Z',
      userTimezone: 'America/New_York', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [packageInput], portfolioContext: {myStocks: [], watchlist: []}
  });
  assert.equal(validateClaudeAnalysisOutput(normalOutput(input, {furtherReadings: ['e1']}), input).valid, true);
  assert.equal(validateClaudeAnalysisOutput(normalOutput(input, {furtherReadings: []}), input).valid, false);
});

test('exports an immutable provider schema while runtime validation remains authoritative', () => {
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.required, CLAUDE_ANALYSIS_OUTPUT_KEYS);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.minItems, 11);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.maxItems, 11);
  assert.equal(Object.isFrozen(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA), true);
  assert.equal(Object.isFrozen(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.items), true);
});

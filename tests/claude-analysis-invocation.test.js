const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT,
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  MAX_ACTIVE_FURTHER_READINGS,
  NO_CURRENT_SESSION_EVIDENCE_GAP,
  NO_CURRENT_SESSION_SUMMARY,
  noCurrentSessionEvidenceOutput,
  resolveActiveFurtherReadings
} = require('../lib/claude-analysis-contract');
const {
  CLAUDE_ANALYSIS_MODEL,
  CLAUDE_ANALYSIS_MAX_TOKENS,
  CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  CLAUDE_ANALYSIS_RESULT_TYPES,
  CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA,
  buildClaudeAnalysisRequest,
  invokeClaudeAnalysis
} = require('../lib/claude-analysis-invocation');
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');
const {
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor
} = require('../lib/us-active-session-evidence');

function canonicalInput({
  includeSecondEvidence = false,
  evidenceTitle = 'Technology sector update',
  evidenceSummary,
  materialEvents = ['e1'],
  principalCatalysts = ['e1'],
  supportingEvidence = ['e1'],
  subsequentDevelopments = [],
  sessionAssociations = [],
  broadMarketFocus = [{evidenceRef: 'e1', subjects: [{kind: 'SECTOR', name: 'Technology'}]}],
  includeCurrentOverlay = false
} = {}) {
  const item = createEvidenceItem({
    sourceId: 'sg.reuters', market: 'SG', evidenceCategory: 'news', title: evidenceTitle,
    canonicalUrl: 'https://www.reuters.com/markets/example', publishedAt: '2026-09-06T08:00:00Z',
    ...(evidenceSummary === undefined ? {} : {summary: evidenceSummary})
  });
  const evidenceItems = [item];
  if (includeSecondEvidence) evidenceItems.push(createEvidenceItem({
    sourceId: 'sg.cna', market: 'SG', evidenceCategory: 'news', title: 'Second market update',
    canonicalUrl: 'https://www.channelnewsasia.com/business/example', publishedAt: '2026-09-06T09:00:00Z'
  }));
  const session = createCompletedRegularSession({
    market: 'SG', sessionDate: '2026-09-04', open: 5700, high: 5800, low: 5650,
    close: 5747, previousClose: 5710, volume: null, asOf: '2026-09-04T17:00:00+08:00',
    sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  });
  const currentOverlay = includeCurrentOverlay ? createCurrentSessionOverlay({
    market: 'SG', marketState: 'OPEN', sessionDate: '2026-09-05',
    asOf: '2026-09-05T10:00:00+08:00', lastPrice: 5760, referenceClose: 5747,
    volume: 123456, sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  }) : null;
  const snapshot = createFiveSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'Straits Times Index', instrumentType: 'INDEX',
    currency: 'SGD', marketState: includeCurrentOverlay ? 'OPEN' : 'CLOSED',
    completedSessions: [session], currentOverlay
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', initiatingList: 'myStocks', generatedAt: '2026-09-06T18:00:00+08:00',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'SG',
      marketContext: {
        exchangeTimezone: 'Asia/Singapore', marketState: includeCurrentOverlay ? 'OPEN' : 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: includeCurrentOverlay,
        calendarContext: 'Weekend; latest completed session remains applicable.'
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
      evidenceCollection: createEvidenceCollection({market: 'SG', items: evidenceItems}),
      evidenceContext: {
        materialEvents, authoritativeFacts: [], principalCatalysts,
        supportingEvidence, conflictingEvidence: [], subsequentDevelopments,
        sessionAssociations,
        broadMarketFocus,
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext: {myStocks: [], watchlist: []}
  });
}

function activeUsInput({
  marketState = 'REGULAR',
  generatedAt = '2026-09-08T15:00:00.000Z',
  overlayAsOf = '2026-09-08T14:55:00.000Z',
  currentPublishedAt = '2026-09-08T14:30:00.000Z',
  additionalItems = [],
  includeOverlay = true,
  materialEvents = ['e1', 'e2'],
  principalCatalysts = ['e1', 'e2'],
  supportingEvidence = ['e2']
} = {}) {
  const activeSessionAnchor = serializeUsActiveSessionAnchor(createUsActiveSessionAnchor({
    marketState,
    cutoffAt: generatedAt
  }));
  assert.ok(activeSessionAnchor);
  const completed = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-04', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-04T16:00:00-04:00', sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  const overlay = includeOverlay ? createCurrentSessionOverlay({
    market: 'US', marketState, sessionDate: '2026-09-08',
    asOf: overlayAsOf, lastPrice: 106, referenceClose: 104,
    volume: 1200000, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }) : null;
  const snapshot = createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState, completedSessions: [completed],
    currentOverlay: overlay
  });
  const current = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Microsoft outlook lifts stocks',
    summary: 'Microsoft raised its outlook during the active US session.',
    canonicalUrl: 'https://finance.yahoo.com/news/microsoft-outlook-lifts-stocks.html',
    publishedAt: currentPublishedAt, symbols: ['MSFT'],
    publisher: 'Yahoo Finance'
  });
  const completedEvidence = createEvidenceItem({
    sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
    title: 'Prior completed-session market driver',
    summary: 'A supported driver of the prior completed session.',
    canonicalUrl: 'https://www.reuters.com/markets/us/prior-driver',
    publishedAt: '2026-09-04T19:00:00.000Z', symbols: []
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks',
      generatedAt, userTimezone: 'Asia/Singapore',
      reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: includeOverlay,
        calendarContext: activeSessionAnchor
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
      evidenceCollection: createEvidenceCollection({
        market: 'US', items: [current, completedEvidence, ...additionalItems]
      }),
      evidenceContext: {
        materialEvents, authoritativeFacts: [],
        principalCatalysts, supportingEvidence,
        conflictingEvidence: [], subsequentDevelopments: [], sessionAssociations: [],
        broadMarketFocus: [{
          evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]
        }],
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext: {myStocks: [], watchlist: []}
  });
}

function reportContext(input) {
  return {
    header: REPORT_HEADER, selectedScope: input.analysisRequest.selectedScope,
    generatedAt: input.analysisRequest.generatedAt,
    userTimezone: input.analysisRequest.userTimezone,
    reportType: input.analysisRequest.reportType,
    markets: input.marketPackages.map(item => item.market)
  };
}

function sections(content = 'Supported analysis.') {
  return REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 7 ? null : index === 3 ? EMPTY_INITIATING_LIST_CONTENT.myStocks
      : content === null ? null : index === 2 ? 'Supported Technology analysis.' : content,
    evidenceRefs: index === 7 || index === 3 || content === null ? [] : ['e1'],
    telemetryRefs: index === 7 || index === 3 || content === null ? [] : ['t1'],
    uncertainties: []
  }));
}

function normalOutput(input, overrides = {}) {
  const reportSections = sections();
  const activeState = input.marketPackages.find(item => item.market === 'US')
    ?.marketContext?.marketState;
  if (['PRE', 'REGULAR', 'POST'].includes(activeState)) {
    const lead = activeState === 'PRE' ? 'pre-market'
      : activeState === 'POST' ? 'post-market' : 'regular session';
    reportSections[0].content = `In the ${lead}, current developments lead the analysis. `
      + 'The previous completed session provides comparison only.';
  }
  const firstFocus = input.marketPackages.flatMap(item => item.evidenceContext.broadMarketFocus)[0];
  if (firstFocus) reportSections[2].content = `Supported ${firstFocus.subjects[0].name} analysis.`;
  return {
    status: 'NORMAL', reportContext: reportContext(input), sections: reportSections,
    evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: [], ...overrides
  };
}

function activeOutputWithoutCurrentCitation(input) {
  const output = normalOutput(input, {
    status: 'DEGRADED',
    evidenceGaps: ['Validated broad-market company or sector evidence was not used.']
  });
  for (const [index, section] of output.sections.entries()) {
    if (index === 3 || index === 7) continue;
    output.sections[index] = {...section, evidenceRefs: ['e2']};
  }
  output.sections[2] = {
    ...output.sections[2], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No broad-market focus analysis was generated.']
  };
  output.evidenceReferences = ['e2'];
  return output;
}

function providerTransport(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)
      || !Array.isArray(output.sections)) return output;
  const {sections: reportSections, ...rest} = output;
  const sectionsById = {};
  for (const section of reportSections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)
        || typeof section.name !== 'string') continue;
    const {name, ...payload} = section;
    sectionsById[name] = payload;
  }
  return {...rest, sectionsById};
}

function anthropicResponse(output, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; },
    ...overrides
  };
}

test('builds one deterministic server-owned request with a projected package and no tools', () => {
  const input = canonicalInput({
    subsequentDevelopments: ['e1'],
    sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
    includeCurrentOverlay: true
  });
  const original = JSON.stringify(input);
  const request = buildClaudeAnalysisRequest(input);
  const modelInput = JSON.parse(request.messages[0].content);
  assert.equal(CLAUDE_ANALYSIS_MODEL, 'claude-haiku-4-5-20251001');
  assert.equal(CLAUDE_ANALYSIS_MAX_TOKENS, 4000);
  assert.equal(request.model, CLAUDE_ANALYSIS_MODEL);
  assert.equal(request.max_tokens, CLAUDE_ANALYSIS_MAX_TOKENS);
  assert.deepEqual(request.messages, [{role: 'user', content: JSON.stringify(
    projectClaudeAnalysisInput(input)
  )}]);
  assert.equal(JSON.stringify(input), original);
  assert.equal(modelInput.analysisRequest.initiatingList, 'myStocks');
  assert.deepEqual(modelInput.sectionFourReferenceAllowlist, {
    initiatingList: 'myStocks', evidenceRefs: [], telemetryRefs: []
  });
  assert.equal(Object.hasOwn(modelInput, 'currentSessionContext'), false);
  assert.equal(request.system.includes('ACTIVE_SESSION request-specific semantics'), false);
  assert.equal(modelInput.marketPackages[0].telemetry.benchmarkSnapshots[0].reference, 't1');
  const canonicalTelemetry = input.marketPackages[0].telemetry;
  const projectedTelemetry = modelInput.marketPackages[0].telemetry;
  assert.equal(projectedTelemetry.benchmarkSnapshots.length,
    canonicalTelemetry.benchmarkSnapshots.length);
  assert.equal(projectedTelemetry.stockSnapshots.length, canonicalTelemetry.stockSnapshots.length);
  const canonicalSession = canonicalTelemetry.benchmarkSnapshots[0].snapshot.completedSessions[0];
  const projectedSession = projectedTelemetry.benchmarkSnapshots[0].snapshot.completedSessions[0];
  assert.deepEqual(projectedSession, {
    ...canonicalSession,
    provenance: {
      publisher: canonicalSession.provenance.publisher,
      authority: canonicalSession.provenance.authority
    }
  });
  assert.equal(projectedSession.sourceId, canonicalSession.sourceId);
  assert.deepEqual(Object.keys(projectedSession.provenance), ['publisher', 'authority']);
  const canonicalOverlay = canonicalTelemetry.benchmarkSnapshots[0].snapshot.currentOverlay;
  const projectedOverlay = projectedTelemetry.benchmarkSnapshots[0].snapshot.currentOverlay;
  assert.deepEqual(projectedOverlay, {
    ...canonicalOverlay,
    provenance: {
      publisher: canonicalOverlay.provenance.publisher,
      authority: canonicalOverlay.provenance.authority
    }
  });
  assert.equal(projectedOverlay.sourceId, canonicalOverlay.sourceId);
  for (const omitted of ['homepage', 'locator', 'applicableMarket', 'sourceJurisdiction']) {
    assert.equal(omitted in projectedSession.provenance, false);
    assert.equal(omitted in projectedOverlay.provenance, false);
  }
  assert.deepEqual(modelInput.marketPackages[0].evidenceContext.sessionAssociations, [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'}
  ]);
  const projectedItem = modelInput.marketPackages[0].evidenceContext.evidence[0].item;
  assert.deepEqual(Object.keys(projectedItem.provenance), ['publisher', 'authority']);
  assert.equal(projectedItem.sourceId, 'sg.reuters');
  assert.equal(projectedItem.provenance.publisher, 'Reuters');
  assert.equal(projectedItem.provenance.authority, 'secondary');
  assert.equal('canonicalUrl' in projectedItem, false);
  for (const omitted of ['homepage', 'locator', 'applicableMarket', 'sourceJurisdiction']) {
    assert.equal(omitted in projectedItem.provenance, false);
  }
  assert.equal(Object.isFrozen(input.marketPackages[0].evidenceContext.sessionAssociations), true);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema, CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(JSON.stringify(request).includes('web_search'), false);
  assert.equal(Object.isFrozen(request), true);
  const projection = projectClaudeAnalysisInput(input);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(
    projection.marketPackages[0].evidenceContext.evidence[0].item.provenance
  ), true);
  assert.deepEqual(projection, projectClaudeAnalysisInput(input));

  const spoofedTelemetry = JSON.parse(JSON.stringify(input));
  spoofedTelemetry.marketPackages[0].telemetry.benchmarkSnapshots[0]
    .snapshot.completedSessions[0].provenance.authority = 'primary';
  assert.throws(() => buildClaudeAnalysisRequest(spoofedTelemetry),
    /invalid canonical Claude analysis input/);
});

test('active synthesis receives exact CURRENT_SESSION refs and state-aware section semantics', () => {
  const input = activeUsInput();
  const original = JSON.stringify(input);
  const request = buildClaudeAnalysisRequest(input);
  const modelInput = JSON.parse(request.messages[0].content);
  assert.deepEqual(modelInput.currentSessionContext, [{
    market: 'US', sessionDate: '2026-09-08', evidenceRefs: ['e1']
  }]);
  for (const instruction of [
    'current in-progress session as the primary analytical focus',
    'previous completed session only as historical comparison or baseline',
    'Section 1 must lead with the current session',
    'Section 2 must explain current-session drivers',
    'must never be presented as causing the earlier completed-session move',
    'must not list every Most Active security',
    'Section 4 may use supported CURRENT_SESSION news only when its reference is present',
    'Section 5 should interpret current breadth, risk appetite, momentum',
    'Section 6 keeps all existing risk and grounded-opportunity rules',
    'Section 7 should prioritize unresolved current-session developments',
    'output top-level furtherReadings as []',
    'deterministically resolves it from eligible CURRENT_SESSION Yahoo evidence actually cited'
  ]) assert.equal(request.system.includes(instruction), true, instruction);
  assert.equal(modelInput.marketPackages[0].telemetry.benchmarkSnapshots[0]
    .snapshot.completedSessions[0].sessionDate, '2026-09-04');
  assert.equal(modelInput.marketPackages[0].telemetry.benchmarkSnapshots[0]
    .snapshot.currentOverlay.sessionDate, '2026-09-08');
  assert.equal(JSON.stringify(input), original);
  assert.equal(Object.hasOwn(input, 'currentSessionContext'), false);
});

test('PRE summary must cite current evidence and lead with it, while prior close remains context', async () => {
  const input = activeUsInput({
    marketState: 'PRE', generatedAt: '2026-09-08T12:00:00.000Z',
    overlayAsOf: '2026-09-08T11:55:00.000Z',
    currentPublishedAt: '2026-09-08T11:30:00.000Z'
  });
  const current = normalOutput(input, {furtherReadings: ['e1']});
  assert.equal(validateClaudeAnalysisOutput(current, input).valid, true);
  const fridayFirst = structuredClone(current);
  fridayFirst.sections[0].content = 'Friday\'s completed-session move dominated the week. '
    + 'In the pre-market, current Microsoft news provided later context.';
  assert.ok(validateClaudeAnalysisOutput(fridayFirst, input).errors.some(error =>
    error.includes('active summary must lead with the current session')));
  const rejectedDiagnostics = [];
  const rejected = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(fridayFirst),
    onDiagnostics: event => rejectedDiagnostics.push(event)
  });
  assert.equal(rejected.type, 'CONTRACT_FAILURE');
  assert.equal(rejectedDiagnostics.find(event => event.stage === 'activeSessionOutput')
    .sectionOneCurrentFirst, false);
  const noSummaryCitation = structuredClone(current);
  noSummaryCitation.sections[0].evidenceRefs = ['e2'];
  noSummaryCitation.evidenceReferences = ['e2', 'e1'];
  assert.ok(validateClaudeAnalysisOutput(noSummaryCitation, input).errors.some(error =>
    error.includes('active summary requires a CURRENT_SESSION evidence reference')));

  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'PRIVATE_API_KEY', fetchImpl: async () => anthropicResponse(
      normalOutput(input, {furtherReadings: []})
    ), onDiagnostics: event => diagnostics.push(event)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.furtherReadings, ['e1']);
  assert.deepEqual(diagnostics.find(event => event.stage === 'activeSessionProjection'), {
    stage: 'activeSessionProjection', projectedCurrentSessionRefCount: 1
  });
  assert.deepEqual(diagnostics.find(event => event.stage === 'activeSessionOutput'), {
    stage: 'activeSessionOutput', projectedCurrentSessionRefCount: 1,
    citedCurrentSessionRefCount: 1, returnedCurrentSessionRefCount: 1,
    deterministicCitationRepairApplied: false, repairedCurrentSessionRefCount: 0,
    sectionOneCurrentRefFirst: true,
    sectionOneCurrentFirst: true,
    activeFurtherReadingsEligibleCount: 1,
    activeFurtherReadingsSelectedCount: 1
  });
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_API_KEY'), false);
  assert.equal(JSON.stringify(diagnostics).includes('Microsoft raised its outlook'), false);
});

test('REGULAR and POST apply the same current-first Section 1 guard', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const current = normalOutput(input, {furtherReadings: ['e1']});
    assert.equal(validateClaudeAnalysisOutput(current, input).valid, true, marketState);
    const priorFirst = structuredClone(current);
    priorFirst.sections[0].content = 'Friday dominated the market report. '
      + `In the ${marketState === 'POST' ? 'post-market' : 'regular session'}, current news followed.`;
    assert.equal(validateClaudeAnalysisOutput(priorFirst, input).valid, false, marketState);
  }
});

test('PRE, REGULAR and POST repair one omitted current citation only when attribution is unique', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const raw = activeOutputWithoutCurrentCitation(input);
    assert.equal(validateClaudeAnalysisOutput(raw, input).valid, false);
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: event => diagnostics.push(event)
    });
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.deepEqual(result.output.sections[0].evidenceRefs, ['e1', 'e2']);
    assert.deepEqual(result.output.furtherReadings, ['e1']);
    assert.deepEqual(diagnostics.find(event => event.stage === 'activeSessionOutput'), {
      stage: 'activeSessionOutput', projectedCurrentSessionRefCount: 1,
      citedCurrentSessionRefCount: 1, returnedCurrentSessionRefCount: 0,
      deterministicCitationRepairApplied: true, repairedCurrentSessionRefCount: 1,
      sectionOneCurrentRefFirst: true, sectionOneCurrentFirst: true,
      activeFurtherReadingsEligibleCount: 1, activeFurtherReadingsSelectedCount: 1
    });
  }
});

test('PRE, REGULAR and POST accept natural current-first wording, later current citations, and zero overlays', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    for (const includeOverlay of [true, false]) {
      const input = activeUsInput({
        marketState, generatedAt, overlayAsOf, currentPublishedAt, includeOverlay
      });
      const output = normalOutput(input, {furtherReadings: ['e1']});
      output.sections[0].content = 'Stocks are responding to live developments now; the prior close is context only.';
      output.sections[0].evidenceRefs = ['e2', 'e1'];
      output.evidenceReferences = ['e2', 'e1'];
      assert.equal(validateClaudeAnalysisOutput(output, input).valid, true,
        `${marketState} overlay=${includeOverlay}`);
    }
  }
});

test('active citation repair rejects ambiguous or invalid generated attribution', async () => {
  const secondCurrent = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Apple current-session update', summary: 'Apple moved in the regular session.',
    canonicalUrl: 'https://finance.yahoo.com/news/apple-current-session-update.html',
    publishedAt: '2026-09-08T14:35:00.000Z', symbols: ['AAPL'], publisher: 'Yahoo Finance'
  });
  const ambiguousInput = activeUsInput({additionalItems: [secondCurrent]});
  const ambiguousDiagnostics = [];
  const ambiguous = await invokeClaudeAnalysis({
    input: ambiguousInput, apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(activeOutputWithoutCurrentCitation(ambiguousInput)),
    onDiagnostics: event => ambiguousDiagnostics.push(event)
  });
  assert.equal(ambiguous.type, 'CONTRACT_FAILURE');
  const ambiguousEvent = ambiguousDiagnostics.find(event => event.stage === 'activeSessionOutput');
  assert.equal(ambiguousEvent.projectedCurrentSessionRefCount, 2);
  assert.equal(ambiguousEvent.returnedCurrentSessionRefCount, 0);
  assert.equal(ambiguousEvent.deterministicCitationRepairApplied, false);
  assert.equal(ambiguousEvent.repairedCurrentSessionRefCount, 0);

  const invalidInput = activeUsInput();
  const invalid = activeOutputWithoutCurrentCitation(invalidInput);
  invalid.sections[0].evidenceRefs = ['e999'];
  const invalidDiagnostics = [];
  const invalidResult = await invokeClaudeAnalysis({
    input: invalidInput, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(invalid),
    onDiagnostics: event => invalidDiagnostics.push(event)
  });
  assert.equal(invalidResult.type, 'CONTRACT_FAILURE');
  const invalidEvent = invalidDiagnostics.find(event => event.stage === 'activeSessionOutput');
  assert.equal(invalidEvent.deterministicCitationRepairApplied, false);
  assert.equal(invalidEvent.repairedCurrentSessionRefCount, 0);
});

test('PRE, REGULAR and POST preserve strict ambiguity when multiple current refs exist', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    const secondCurrent = createEvidenceItem({
      sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
      title: 'Apple current-session update', summary: 'Apple moved in the active session.',
      canonicalUrl: `https://finance.yahoo.com/news/apple-${marketState.toLowerCase()}-update.html`,
      publishedAt: currentPublishedAt, symbols: ['AAPL'], publisher: 'Yahoo Finance'
    });
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf, currentPublishedAt,
      additionalItems: [secondCurrent]
    });
    const raw = activeOutputWithoutCurrentCitation(input);
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE', marketState);
  }
});

test('single-current citation repair also applies when the sole current ref was cited outside Section 1', async () => {
  const input = activeUsInput();
  const raw = activeOutputWithoutCurrentCitation(input);
  raw.sections[4].evidenceRefs = ['e1'];
  raw.evidenceReferences = ['e2', 'e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e1', 'e2']);
});

test('active FAILED is rejected when usable current evidence exists', async () => {
  const input = activeUsInput();
  const failed = {
    status: 'FAILED', reportContext: reportContext(input), sections: sections(null),
    evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Coverage is sparse.']
  };
  assert.ok(validateClaudeAnalysisOutput(failed, input).errors.includes(
    'active analysis with CURRENT_SESSION evidence cannot use FAILED status'
  ));
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(failed)
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
});

test('active optional unknown references localize while an unknown Section 1 ref remains a hard failure', async () => {
  const input = activeUsInput();
  const optional = normalOutput(input, {furtherReadings: []});
  optional.sections[4].evidenceRefs = ['e999'];
  const localized = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(optional)
  });
  assert.equal(localized.type, 'SUCCESS', localized.message);
  assert.equal(localized.output.status, 'DEGRADED');
  assert.equal(localized.output.sections[4].content, null);
  assert.deepEqual(localized.output.sections[4].evidenceRefs, []);

  const summary = normalOutput(input, {furtherReadings: []});
  summary.sections[0].evidenceRefs = ['e999'];
  const rejected = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(summary)
  });
  assert.equal(rejected.type, 'CONTRACT_FAILURE');
});

test('active causal safety hard-fails Section 1 and localizes unsupported Sections 5-7', async () => {
  const input = activeUsInput({
    materialEvents: ['e1', 'e2'], principalCatalysts: ['e2'], supportingEvidence: ['e1']
  });
  const summary = normalOutput(input, {furtherReadings: []});
  summary.sections[0].content = 'Inflation data sent stocks higher in the current session.';
  const summaryResult = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(summary)
  });
  assert.equal(summaryResult.type, 'CONTRACT_FAILURE');

  for (const index of [4, 5, 6]) {
    const output = normalOutput(input, {furtherReadings: []});
    output.sections[index].content = 'Inflation data sent stocks higher in the current session.';
    output.sections[index].evidenceRefs = ['e1'];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'SUCCESS', `section ${index + 1}: ${result.message}`);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections[index].content, null);
    assert.deepEqual(result.output.sections[index].evidenceRefs, []);
  }
});

test('active Section 2 localizes missing current driver or current principal-catalyst support', async () => {
  const noDriverInput = activeUsInput();
  const noDriver = normalOutput(noDriverInput, {furtherReadings: []});
  noDriver.sections[1].evidenceRefs = ['e2'];
  const noDriverResult = await invokeClaudeAnalysis({
    input: noDriverInput, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(noDriver)
  });
  assert.equal(noDriverResult.type, 'SUCCESS', noDriverResult.message);
  assert.equal(noDriverResult.output.sections[1].content, null);

  const noCurrentCatalystInput = activeUsInput({
    materialEvents: ['e1', 'e2'], principalCatalysts: ['e2'], supportingEvidence: ['e1']
  });
  const noCurrentCatalyst = normalOutput(noCurrentCatalystInput, {furtherReadings: []});
  noCurrentCatalyst.sections[1].content = 'Inflation data sent stocks higher in the current session.';
  const noCurrentCatalystResult = await invokeClaudeAnalysis({
    input: noCurrentCatalystInput, apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(noCurrentCatalyst)
  });
  assert.equal(noCurrentCatalystResult.type, 'SUCCESS', noCurrentCatalystResult.message);
  assert.equal(noCurrentCatalystResult.output.sections[1].content, null);
});

test('PRE, REGULAR and POST with zero current refs return an explicit eight-section degraded report without a provider call', async () => {
  for (const [marketState, generatedAt, overlayAsOf] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z']
  ]) {
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf,
      currentPublishedAt: '2026-09-04T19:00:00.000Z'
    });
    assert.ok(noCurrentSessionEvidenceOutput(input));
    assert.equal(validateClaudeAnalysisOutput(normalOutput(input), input).valid, false);
    let calls = 0;
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => { calls++; throw new Error('not expected'); },
      onDiagnostics: event => diagnostics.push(event)
    });
    assert.equal(calls, 0);
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections.length, 8);
    assert.equal(result.output.sections[0].content, NO_CURRENT_SESSION_SUMMARY);
    assert.equal(result.output.sections.slice(1).every(section => section.content === null), true);
    assert.deepEqual(result.output.evidenceReferences, []);
    assert.deepEqual(result.output.furtherReadings, []);
    assert.deepEqual(result.output.evidenceGaps, [NO_CURRENT_SESSION_EVIDENCE_GAP]);
    assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
    assert.equal(diagnostics.find(event => event.stage === 'activeSessionProjection')
      .projectedCurrentSessionRefCount, 0);
    assert.equal(diagnostics.find(event => event.stage === 'activeSessionOutput')
      .citedCurrentSessionRefCount, 0);
  }
});

test('current-session catalysts support current moves but not prior-session causality', () => {
  const input = activeUsInput();
  const current = normalOutput(input);
  current.furtherReadings = ['e1'];
  current.sections[1].content = 'Microsoft outlook sent stocks higher in the current session.';
  assert.equal(validateClaudeAnalysisOutput(current, input).valid, true);

  for (const content of [
    'Microsoft outlook sent stocks lower in yesterday\'s session.',
    'Microsoft outlook sent stocks lower at Friday\'s close.',
    'Microsoft outlook sent stocks lower on September 4.',
    'Microsoft outlook sent stocks lower on 2026-09-04.',
    'Microsoft outlook sent stocks lower at the completed-session close.'
  ]) {
    const prior = normalOutput(input);
    prior.furtherReadings = ['e1'];
    prior.sections[1].content = content;
    const validation = validateClaudeAnalysisOutput(prior, input);
    assert.equal(validation.valid, false, content);
    assert.equal(validation.errors.includes(
      'sections[1]: prior completed-session causality requires a completed-session principal catalyst'
    ), true, content);
  }

  const completed = normalOutput(input);
  completed.furtherReadings = ['e1'];
  completed.sections[1].content = 'The prior driver sent stocks lower at Friday\'s close.';
  completed.sections[1].evidenceRefs = ['e1', 'e2'];
  completed.evidenceReferences = ['e1', 'e2'];
  assert.equal(validateClaudeAnalysisOutput(completed, input).valid, true);

  const supportedBaseline = normalOutput(input);
  supportedBaseline.furtherReadings = ['e1'];
  supportedBaseline.sections[0].content = 'Stocks are responding to current developments now. '
    + 'The prior driver sent stocks lower at Friday\'s close.';
  supportedBaseline.sections[0].evidenceRefs = ['e1', 'e2'];
  supportedBaseline.evidenceReferences = ['e1', 'e2'];
  assert.equal(validateClaudeAnalysisOutput(supportedBaseline, input).valid, true);
});

test('active Further Readings resolve only cited current Yahoo evidence in citation order', async () => {
  const secondYahoo = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Apple gains during the active session', summary: 'Apple shares gained in current trading.',
    canonicalUrl: 'https://finance.yahoo.com/news/apple-gains-active-session.html',
    publishedAt: '2026-09-08T14:40:00.000Z', symbols: ['AAPL'], publisher: 'Yahoo Finance'
  });
  const duplicateYahooUrl = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Duplicate Apple citation', summary: 'The same article has another evidence reference.',
    canonicalUrl: 'https://finance.yahoo.com/news/apple-gains-active-session.html',
    publishedAt: '2026-09-08T14:41:00.000Z', symbols: ['AAPL'], publisher: 'Yahoo Finance'
  });
  const cnbcCurrent = createEvidenceItem({
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: 'CNBC current item',
    canonicalUrl: 'https://www.cnbc.com/2026/09/08/current-item.html',
    publishedAt: '2026-09-08T14:42:00.000Z'
  });
  const staleYahoo = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Stale Yahoo recap', summary: 'Prior-session recap.',
    canonicalUrl: 'https://finance.yahoo.com/news/stale-yahoo-recap.html',
    publishedAt: '2026-09-04T20:30:00.000Z', symbols: [], publisher: 'Yahoo Finance'
  });
  const uncitedYahoo = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Uncited current Yahoo article', summary: 'Current session but not used by the report.',
    canonicalUrl: 'https://finance.yahoo.com/news/uncited-current-yahoo.html',
    publishedAt: '2026-09-08T14:45:00.000Z', symbols: [], publisher: 'Yahoo Finance'
  });
  const additionalCurrentYahoo = Array.from({length: 4}, (_, index) => createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: `Current Yahoo article ${index + 1}`, summary: 'Validated current-session Yahoo coverage.',
    canonicalUrl: `https://finance.yahoo.com/news/current-yahoo-${index + 1}.html`,
    publishedAt: `2026-09-08T14:4${index + 6}:00.000Z`, symbols: [], publisher: 'Yahoo Finance'
  }));
  const input = activeUsInput({
    additionalItems: [secondYahoo, duplicateYahooUrl, cnbcCurrent, staleYahoo, uncitedYahoo, ...additionalCurrentYahoo]
  });
  const raw = normalOutput(input, {furtherReadings: ['e2', 'e4', 'e5']});
  raw.sections[0].evidenceRefs = ['e3', 'e4', 'e1', 'e8', 'e9', 'e10', 'e11'];
  raw.sections[1].evidenceRefs = ['e3', 'e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.furtherReadings, ['e3', 'e1', 'e8', 'e9', 'e10']);
  assert.equal(result.output.furtherReadings.includes('e2'), false);
  assert.equal(result.output.furtherReadings.includes('e4'), false);
  assert.equal(result.output.furtherReadings.includes('e5'), false);
  assert.equal(result.output.furtherReadings.includes('e6'), false);
  assert.equal(result.output.furtherReadings.includes('e7'), false);
  assert.equal(result.output.furtherReadings.includes('e11'), false);
  for (const invalidReference of ['e2', 'e4', 'e5', 'e6', 'e7', 'e11']) {
    const invalid = structuredClone(result.output);
    invalid.furtherReadings = ['e3', 'e1', 'e8', 'e9', 'e10', invalidReference];
    assert.equal(validateClaudeAnalysisOutput(invalid, input).valid, false, invalidReference);
  }
  assert.equal(MAX_ACTIVE_FURTHER_READINGS, 5);
});

test('active Further Readings resolve empty without citations before single-ref repair', async () => {
  const input = activeUsInput();
  const raw = normalOutput(input, {
    status: 'DEGRADED', furtherReadings: ['e1'],
    evidenceGaps: ['Validated current Yahoo evidence was not cited by populated analytical sections.']
  });
  for (const [index, section] of raw.sections.slice(0, 7).entries()) {
    if (index !== 3 && section.content !== null) section.evidenceRefs = ['e2'];
  }
  raw.sections[2] = {
    ...raw.sections[2], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No current broad-market focus evidence was cited.']
  };
  assert.deepEqual(resolveActiveFurtherReadings(raw, input).furtherReadings, []);
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.furtherReadings, ['e1']);
});

test('active Further Readings permit an empty cited-result set and apply PRE, REGULAR, and POST semantics', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const cited = normalOutput(input, {furtherReadings: []});
    assert.deepEqual(resolveActiveFurtherReadings(cited, input).furtherReadings, ['e1']);
    const uncited = normalOutput(input, {furtherReadings: ['e1']});
    for (const section of uncited.sections.slice(0, 7)) {
      if (section.content !== null) section.evidenceRefs = ['e2'];
    }
    assert.deepEqual(resolveActiveFurtherReadings(uncited, input).furtherReadings, []);
  }
});

test('prior-session causality supported only by CURRENT_SESSION evidence localizes safely', async () => {
  const input = activeUsInput();
  const raw = normalOutput(input);
  raw.sections[1].content = 'Microsoft outlook sent stocks lower at Friday\'s close.';
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(raw),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.ok, true);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[1].content, null);
  assert.deepEqual(result.output.sections[1].evidenceRefs, []);
  assert.ok(diagnostics.some(value => value.violationCategory
    === 'MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST'));
});

function canonicalInputAtRequestSize(targetBytes) {
  const minimum = canonicalInput({evidenceSummary: 'x'});
  const minimumBytes = Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(minimum)), 'utf8');
  assert.equal(minimumBytes <= targetBytes, true);
  const input = canonicalInput({evidenceSummary: 'x'.repeat(targetBytes - minimumBytes + 1)});
  assert.equal(Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input)), 'utf8'), targetBytes);
  return input;
}

test('accepts the provisional request-size boundary and rejects one byte above without fetch', async () => {
  const boundaryInput = canonicalInputAtRequestSize(
    CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES
  );
  let boundaryFetches = 0;
  const boundary = await invokeClaudeAnalysis({
    input: boundaryInput,
    apiKey: 'test-key',
    fetchImpl: async () => {
      boundaryFetches++;
      return anthropicResponse(normalOutput(boundaryInput));
    }
  });
  assert.equal(boundary.type, 'SUCCESS', boundary.message);
  assert.equal(boundaryFetches, 1);

  const oversizedInput = canonicalInputAtRequestSize(
    CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1
  );
  const diagnostics = [];
  let oversizedFetches = 0;
  const oversized = await invokeClaudeAnalysis({
    input: oversizedInput,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => { oversizedFetches++; }
  });
  assert.equal(oversized.type, 'REQUEST_TOO_LARGE');
  assert.equal(oversized.message, 'Claude request exceeds provisional size limit');
  assert.equal(oversized.upstreamStatus, null);
  assert.equal(oversizedFetches, 0);
  assert.deepEqual(diagnostics, [{
    model: CLAUDE_ANALYSIS_MODEL,
    completeRequestBodyBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1,
    limitBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
    providerInvocationSkipped: true
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('xxxxx'), false);
  assert.deepEqual(CLAUDE_ANALYSIS_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'CONTRACT_FAILURE'
  ]);
});

test('reports deterministic sanitized request sizes and provider usage on success', async () => {
  const input = canonicalInput({evidenceTitle: '亚洲 Technology sector update'});
  const request = buildClaudeAnalysisRequest(input);
  const serializedRequest = JSON.stringify(request);
  const projectedPackage = JSON.parse(request.messages[0].content);
  const diagnostics = [];
  let sentBody;
  let monotonicTime = 0;
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    monotonicNow: () => monotonicTime++,
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async (url, options) => {
      sentBody = options.body;
      return anthropicResponse(normalOutput(input), {
        async json() {
          return {
            content: [{type: 'text', text: JSON.stringify(providerTransport(normalOutput(input))) }],
            usage: {
              input_tokens: 123,
              output_tokens: 45,
              cache_creation_input_tokens: 6,
              cache_read_input_tokens: 7,
              future_numeric_counter: 8,
              service_tier: 'standard',
              nested: {tokens: 9}
            }
          };
        },
        headers: {get(name) { return name === 'request-id' ? 'req_test_123' : null; }}
      });
    }
  });

  assert.equal(result.type, 'SUCCESS');
  assert.equal(sentBody, serializedRequest);
  const invocationDiagnostics = diagnostics.filter(value => value.model === CLAUDE_ANALYSIS_MODEL);
  assert.equal(invocationDiagnostics.length, 1);
  const invocationDiagnostic = invocationDiagnostics[0];
  assert.deepEqual(invocationDiagnostic, {
    model: CLAUDE_ANALYSIS_MODEL,
    requestId: 'req_test_123',
    requestSize: {
      systemPromptBytes: Buffer.byteLength(request.system, 'utf8'),
      canonicalPackageBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
      projectedModelInputBytes: Buffer.byteLength(request.messages[0].content, 'utf8'),
      telemetryBytes: Buffer.byteLength(JSON.stringify(
        input.marketPackages.map(item => item.telemetry)
      ), 'utf8'),
      projectedTelemetryBytes: Buffer.byteLength(JSON.stringify(
        projectedPackage.marketPackages.map(item => item.telemetry)
      ), 'utf8'),
      evidenceContextBytes: Buffer.byteLength(JSON.stringify(
        input.marketPackages.map(item => item.evidenceContext)
      ), 'utf8'),
      portfolioContextBytes: Buffer.byteLength(JSON.stringify(input.portfolioContext), 'utf8'),
      providerSchemaBytes: Buffer.byteLength(JSON.stringify(request.output_config.format.schema), 'utf8'),
      completeRequestBodyBytes: Buffer.byteLength(serializedRequest, 'utf8')
    },
    timing: {
      anthropicFetchMs: 1,
      responseBodyReadParseMs: 1,
      marketBriefValidationMs: 1,
      invocationTotalMs: 7
    },
    usage: {
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 7,
      future_numeric_counter: 8
    }
  });
  const encodedCanonicalPackage = JSON.stringify(request.messages[0].content);
  assert.equal(sentBody.split(encodedCanonicalPackage).length - 1, 1);
  assert.equal(Object.isFrozen(invocationDiagnostic), true);
  assert.equal(Object.isFrozen(invocationDiagnostic.requestSize), true);
  assert.equal(Object.isFrozen(invocationDiagnostic.timing), true);
  assert.equal(Object.isFrozen(invocationDiagnostic.usage), true);
  assert.equal(invocationDiagnostic.requestSize.projectedTelemetryBytes
    < invocationDiagnostic.requestSize.telemetryBytes, true);
  assert.equal(invocationDiagnostic.requestSize.projectedModelInputBytes
    < invocationDiagnostic.requestSize.canonicalPackageBytes, true);
  const serializedDiagnostics = JSON.stringify(invocationDiagnostic);
  assert.equal(serializedDiagnostics.includes('亚洲 Technology sector update'), false);
  assert.equal(serializedDiagnostics.includes('^STI'), false);
  assert.equal(serializedDiagnostics.includes('Analyze only'), false);
  assert.equal(serializedDiagnostics.includes('test-key'), false);
});

test('reports request sizes and optional usage on later contract failure', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[0].evidenceRefs = ['e2'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => anthropicResponse(invalidOutput, {
      async json() {
        return {
          content: [{type: 'text', text: JSON.stringify(providerTransport(invalidOutput))}],
          usage: {input_tokens: 321, service_tier: 'standard'}
        };
      }
    })
  });

  assert.equal(result.type, 'CONTRACT_FAILURE');
  const invocationDiagnostics = diagnostics.filter(value => value.model === CLAUDE_ANALYSIS_MODEL);
  assert.equal(invocationDiagnostics.length, 1);
  const invocationDiagnostic = invocationDiagnostics[0];
  assert.equal(invocationDiagnostic.requestId, null);
  assert.deepEqual(invocationDiagnostic.usage, {input_tokens: 321});
  assert.equal(Number.isInteger(invocationDiagnostic.requestSize.completeRequestBodyBytes), true);
  for (const elapsed of Object.values(invocationDiagnostic.timing)) {
    assert.equal(typeof elapsed, 'number');
    assert.equal(elapsed >= 0, true);
  }
});

test('reports only sanitized Section 4 structure when populated content lacks evidence', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[2].content = 'PRIVATE SECTION PROSE';
  invalidOutput.sections[2].evidenceRefs = [];
  invalidOutput.sections[2].telemetryRefs = ['t1'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => anthropicResponse(invalidOutput, {
      headers: {get: name => name === 'request-id' ? 'req_contract_4' : null},
      async json() {
        return {
          content: [{type: 'text', text: JSON.stringify(providerTransport(invalidOutput))}],
          usage: {input_tokens: 321, output_tokens: 45}
        };
      }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    type: 'CONTRACT_FAILURE',
    message: 'Invalid Claude analysis output: sections[2]: stocks and sectors require broad-market focus evidence; sections[2]: factual content requires supplied evidence',
    upstreamStatus: 200
  });
  const invocationDiagnostics = diagnostics.filter(value => value.model === CLAUDE_ANALYSIS_MODEL);
  assert.equal(invocationDiagnostics.length, 1);
  const invocationDiagnostic = invocationDiagnostics[0];
  assert.deepEqual(invocationDiagnostic.contractFailure, {
    sectionIndex: 2,
    sectionName: 'STOCKS & SECTORS IN FOCUS',
    contentIsNull: false,
    evidenceRefCount: 0,
    telemetryRefCount: 1
  });
  assert.equal(invocationDiagnostic.requestId, 'req_contract_4');
  assert.deepEqual(invocationDiagnostic.usage, {input_tokens: 321, output_tokens: 45});
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of [
    'PRIVATE SECTION PROSE', '亚洲 Technology sector update', '^STI', 'https://',
    'Analyze only', 'test-key'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.isFrozen(invocationDiagnostic.contractFailure), true);
});

test('pre-normalization diagnostics report grounded Sections 6 and 7 without changing output', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  output.sections[5].content = 'Technology has a qualified constructive opportunity.';
  output.sections[6].content = 'Watch the supported Technology development.';
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[5], output.sections[5]);
  assert.deepEqual(result.output.sections[6], output.sections[6]);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisPreNormalization'), [
    {
      stage: 'claudeAnalysisPreNormalization', sectionIndex: 5,
      rawContentIsNull: false, evidenceRefs: ['e1'], telemetryRefs: ['t1'],
      suppliedReferenceCount: 1, hasCitedFocus: true, hasExactCitedSubject: true
    },
    {
      stage: 'claudeAnalysisPreNormalization', sectionIndex: 6,
      rawContentIsNull: false, evidenceRefs: ['e1'], telemetryRefs: ['t1'],
      suppliedReferenceCount: 1
    }
  ]);
});

test('pre-normalization diagnostics identify Section 6 violation and raw Section 7 null safely', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  output.sections[5].content = 'PRIVATE rebound opportunity for an unnamed company.';
  output.sections[6] = {
    name: REPORT_SECTION_NAMES[6], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No supported future development.']
  };
  const diagnostics = [];
  const withDiagnostics = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  });
  const withoutDiagnostics = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });
  assert.equal(withDiagnostics.type, 'SUCCESS', withDiagnostics.message);
  assert.equal(JSON.stringify(withDiagnostics.output), JSON.stringify(withoutDiagnostics.output));
  assert.equal(withDiagnostics.output.sections[5].content, null);
  assert.equal(withDiagnostics.output.sections[6].content, null);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisPreNormalization'), [
    {
      stage: 'claudeAnalysisPreNormalization', sectionIndex: 5,
      rawContentIsNull: false, evidenceRefs: ['e1'], telemetryRefs: ['t1'],
      suppliedReferenceCount: 1, hasCitedFocus: true, hasExactCitedSubject: false,
      violationCategory: 'GENERIC_OPPORTUNITY_CLAIM',
      violationSubtype: 'MISSING_GROUNDED_SUBJECT'
    },
    {
      stage: 'claudeAnalysisPreNormalization', sectionIndex: 6,
      rawContentIsNull: true, evidenceRefs: [], telemetryRefs: [], suppliedReferenceCount: 0
    }
  ]);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(diagnostics).includes('Technology'), false);
});

test('pre-normalization diagnostics mark a raw null Section 6 without changing degradation', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  output.status = 'DEGRADED';
  output.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No supported risk or opportunity.']
  };
  output.evidenceGaps = ['No supported risk or opportunity.'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[5], output.sections[5]);
  assert.deepEqual(diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
    && value.sectionIndex === 5), {
    stage: 'claudeAnalysisPreNormalization', sectionIndex: 5,
    rawContentIsNull: true, evidenceRefs: [], telemetryRefs: [], suppliedReferenceCount: 0,
    hasCitedFocus: false, hasExactCitedSubject: false
  });
});

test('pre-normalization refs are capped and exclude unknown or noncanonical values', async () => {
  const input = canonicalInput({includeSecondEvidence: true});
  const output = normalOutput(input);
  output.sections[6].content = 'PRIVATE PROVIDER RESPONSE';
  output.sections[6].evidenceRefs = [
    ...Array.from({length: 20}, (_, index) => index % 2 ? 'e2' : 'e1'),
    'e999', 'e1-secret', 'https://private.example'
  ];
  output.sections[6].telemetryRefs = ['t1', 't999', 't1-secret'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.deepEqual(diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
    && value.sectionIndex === 6), {
    stage: 'claudeAnalysisPreNormalization', sectionIndex: 6, rawContentIsNull: false,
    evidenceRefs: ['e1', 'e2'], telemetryRefs: ['t1'], suppliedReferenceCount: 5
  });
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of ['PRIVATE PROVIDER RESPONSE', 'e999', 'e1-secret', 't999',
    't1-secret', 'https://private.example']) assert.equal(serialized.includes(forbidden), false);
});

test('pre-normalization logging failures cannot change analysis output', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics() { throw new Error('private diagnostic failure'); }
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections, output.sections);
});

test('gives Claude explicit validator-sensitive Section 4 and Further Readings instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'determine the initiating list from analysisRequest.initiatingList',
    'if it is myStocks, use only portfolioContext.myStocks',
    'if it is watchlist, use only portfolioContext.watchlist',
    "initiating list's direct evidenceRefs",
    "initiating security's upcomingEvents[].evidenceRefs",
    'only telemetryRefs belonging to securities in that initiating list',
    'Never use securities, evidenceRefs, or telemetryRefs from the non-initiating list',
    'top-level sectionFourReferenceAllowlist in the supplied model input',
    'Section 4 evidenceRefs must be drawn only from its evidenceRefs',
    'Section 4 telemetryRefs only from its telemetryRefs',
    'No securities are configured in My Stocks.',
    'No securities are configured in Watchlist.',
    'Section 4 evidenceRefs, telemetryRefs, and uncertainties must all be empty arrays',
    'In sectionsById, the FURTHER READINGS payload must be exactly {"content":null,"evidenceRefs":[],"telemetryRefs":[],"uncertainties":[]}',
    'MarketBrief resolves and renders Further Readings separately',
    "evidenceRef values from each market package's evidenceContext.furtherReadings",
    'If none are supplied, top-level furtherReadings must be []',
    'scanning sections in report order',
    "each section's evidenceRefs in listed order",
    'adding each evidence reference only once at its first appearance'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('keeps an empty initiating Section 4 allowlist even when the other list has refs', () => {
  const input = structuredClone(canonicalInput());
  input.portfolioContext.watchlist = [{
    market: 'SG', symbol: '^STI', telemetryRefs: ['t1'], evidenceRefs: ['e1'], upcomingEvents: []
  }];
  const request = buildClaudeAnalysisRequest(input);
  assert.deepEqual(JSON.parse(request.messages[0].content).sectionFourReferenceAllowlist, {
    initiatingList: 'myStocks', evidenceRefs: [], telemetryRefs: []
  });
  assert.match(request.system,
    /Request-specific Section 4 reference allowlist for myStocks: evidenceRefs may contain only these exact refs: \[\]; telemetryRefs may contain only these exact refs: \[\]\./);
});

test('adds the exact package benchmark refs to the request-specific Section 3 allowlist', () => {
  const input = canonicalInput();
  const request = buildClaudeAnalysisRequest(input);
  assert.match(request.system,
    /Request-specific Section 3 telemetry allowlist: Section 3 telemetryRefs may contain only these exact benchmark refs: \["t1"\]\./);
  assert.match(request.system, /Do not cite any other telemetry ref in Section 3\./);
  assert.match(request.system,
    /even when a company is both in evidenceContext\.broadMarketFocus and My Stocks or Watchlist/);
  assert.equal(request.system.includes('"t2"'), false);
});

test('gives Claude the exact top-level evidenceGaps status relationship', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'The top-level evidenceGaps array controls report status',
    'NORMAL is permitted only when top-level evidenceGaps is exactly []',
    'any non-empty top-level evidenceGaps array prohibits NORMAL',
    'Section uncertainties are separate',
    'input evidenceContext.unresolvedGaps does not automatically determine output status',
    'Material unresolved gaps requiring supported analysis must use DEGRADED',
    'Use FAILED when the reliable analytical foundation is insufficient and return no normal-analysis content'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude the global NORMAL null-section status rule', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'NORMAL requires non-null content for every analytical section, Sections 1-7',
    'If any analytical section in Sections 1-7 is null, NORMAL must not be used',
    'If a section is null because material evidence is unavailable, status must be DEGRADED',
    'that null section must include a genuine section uncertainty',
    'the corresponding material evidence gap must be included in the top-level evidenceGaps array',
    'Section 8 FURTHER READINGS remains the required null placeholder and does not force DEGRADED'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude evidence-bound Section 7 fallback instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Hard output constraint for Sections 6-7',
    'content must be either null or a non-empty already-trimmed string',
    'evidenceRefs must contain at least one valid supplied evidence reference',
    'telemetryRefs alone never satisfy this grounding requirement',
    'Every factual claim or qualified interpretation in a populated section must be grounded in its listed supplied evidenceRefs',
    'For Section 7 WHAT TO WATCH FOR NEXT',
    'every factual or watch-next statement must be grounded in one or more valid supplied evidenceRefs listed in Section 7',
    'Cite each scheduled event or catalyst with its supplied supporting evidenceRef',
    'Omit unsupported factual predictions, events, dates, earnings, macro releases, catalysts, or forward-looking developments',
    'do not invent them or attach an unrelated reference',
    'If the supplied package does not support a meaningful Section 7, set content to null, evidenceRefs and telemetryRefs to [], and status to DEGRADED',
    'include at least one genuine section uncertainty',
    'add the corresponding material evidence gap to the top-level evidenceGaps array'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude supplied-evidence-only Section 2 macro comparison instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 2 KEY MARKET DRIVERS',
    'explicit current, consensus or expected, and previous comparable values',
    'present that three-way comparison and explain both',
    'surprise versus expectations and the change versus the previous reading',
    'Use only values explicitly supplied in the package',
    'do not invent any missing comparison value',
    'do not force immaterial macro items into a three-number format',
    'do not repeat the same comparison unnecessarily across Sections 1 and 2'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Sections 1-2 concise prioritization and supported causal instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 1 EXECUTIVE MARKET SUMMARY, write two or three concise paragraphs',
    'dominant market story, supported direction and magnitude, overall sentiment and themes',
    'distinction between completed results and developing conditions',
    'Avoid low-value repetition and padding',
    'present only a small prioritized set of the most material supported drivers',
    'distinguish established facts, developing conditions, and qualified interpretation',
    'never invent a driver merely to fill the section',
    'For Section 2 KEY MARKET DRIVERS',
    'Explain supported interactions among drivers where materially relevant',
    'If no principal catalyst supports causality, describe the material drivers without claiming they caused the move',
    'Temporal proximity alone is not causality',
    'never present a SUBSEQUENT_DEVELOPMENT as causing an earlier completed-session move'
  ]) assert.equal(system.includes(requirement), true, requirement);
});

test('gives Section 3 non-causal broad-market session-association instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 3 STOCKS & SECTORS IN FOCUS',
    'Review evidenceContext.sessionAssociations',
    'when materially relevant',
    'independently in broadMarketFocus',
    'associated supplied evidence reference as current-session recap or context',
    'marketContext.primaryCompletedSessionDate',
    'even when that evidence is also a SUBSEQUENT_DEVELOPMENT',
    'broad-market leadership and laggards, notable individual movers, closing-session breadth, sector rotation',
    'Never present post-close session-associated evidence as having caused the earlier completed-session move',
    'never treat session association as PRINCIPAL_CATALYST eligibility',
    'Section 3 must remain broad-market and independent of My Stocks and Watchlist',
    'membership in either list must not determine which broad-market movers Section 3 discusses',
    'Do not require Section 3 to use every associated reference',
    'or use an association that is immaterial',
    'all materially relevant broad-market materialEvents, supportingEvidence, recap and general CNBC evidence',
    'Rank the significant companies and sectors',
    'explaining why each matters and comparing it with the broader market where useful',
    'Do not produce a generic mover list',
    'If the evidence is insufficient, use qualified analysis or the existing null/DEGRADED behavior',
    'When Section 3 uses a session-associated broad-market evidence reference that is also in broadMarketFocus, cite that reference in Section 3 evidenceRefs',
    'Section 3 evidenceRefs may contain only broadMarketFocus references',
    'telemetryRefs may contain only benchmark telemetry references',
    'never portfolio or watchlist stock telemetry',
    'Discuss a My Stocks or Watchlist company in Section 3 only when it is independently present as a validated COMPANY subject in broadMarketFocus',
    "cite that company's focus reference",
    'Do not copy such a reference into Section 4 merely because it is session-associated, broad-market evidence',
    'relevant to market leadership, sectors, movers, breadth, or rotation',
    "Section 4 remains strictly limited to the initiating-list securities' permitted telemetryRefs, permitted direct evidenceRefs, and permitted upcoming-event evidenceRefs",
    'a reference may appear in Section 4 only when it independently satisfies those existing initiating-list eligibility rules'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Sections 5-6 interpretation and combined risk/opportunity instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 5 MARKET INTERPRETATION',
    'supported sentiment, risk appetite, breadth, momentum, and rotation',
    'continuation, reversal, consolidation, or a change in narrative',
    'participation is broad or concentrated',
    'For Section 6 KEY RISKS & OPPORTUNITIES',
    'specific constructive broad-market opportunities in supported sectors, themes, or companies',
    'clearly label or otherwise distinguish risk from opportunity',
    'distinguish positive constructive evidence from a speculative scenario',
    'Each opportunity claim must cite its own relevant broadMarketFocus evidenceRef and name an exact validated subject from that cited focus entry in the Section 6 prose',
    'If no such grounded opportunity can be stated, omit the opportunity; risks-only output remains valid and bullish content is not required',
    'a risk citation cannot support an unrelated opportunity',
    'Never use a rebound, buy-the-dip, oversold condition, or similar price-decline filler as an opportunity without specific constructive evidence',
    'Risks alone may populate Section 6 when no defensible opportunity is supported',
    'Supported opportunities alone may also populate it',
    'If neither is supported, set content to null'
  ]) assert.equal(system.includes(requirement), true, requirement);
});

test('keeps overlapping evidence concise without merging the frozen section roles', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  assert.match(system, /Keep the report sections distinct/);
  assert.match(system, /place each supported fact or conclusion where it adds the most value/);
  assert.match(system, /do not repeat the same sentence or substantially identical explanation/);
  assert.match(system, /Sections 1, 2, 5, 6, and 7/);
});

test('gives Claude time-safe materially relevant subsequent-development instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Review evidenceContext.subsequentDevelopments',
    'only as later/current or forward-looking context',
    'Never cite subsequentDevelopments as causes of the earlier primary completed-session move',
    'When materially relevant',
    'using their supplied evidence references',
    'appropriate forward-looking Sections 6-7',
    'especially Section 7 WHAT TO WATCH FOR NEXT',
    'material risks, opportunities, and next-session watch items',
    'Do not include subsequentDevelopments when they are immaterial to the report'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude the exact section uncertainty canonicality requirements', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Every section uncertainties entry must be a plain string',
    'non-empty after trimming',
    'already trimmed',
    'unique within that section',
    'Do not use blank strings, whitespace-only strings, placeholders, or duplicates',
    'use [] when a section has no uncertainty',
    'For a DEGRADED section with content: null, include at least one genuine uncertainty'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude plain-language and locked movement presentation instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'clear, normal spoken English for an informed layperson, not a professional market analyst',
    'Prefer common words when they are equally accurate',
    'short, direct sentences where practical',
    'Avoid institutional or analyst-desk jargon',
    'If a technical or financial term is unavoidable, explain it briefly in plain language',
    'Preserve analytical depth: simplify wording, not reasoning',
    'Apple fell $8.24 (2.51%) to $319.97.',
    'Apple gained $3.25 (1.00%) to $328.21.',
    'S&P 500 fell by 29.11 points (0.38%) to 7,718.60.',
    'S&P 500 gained 81.11 points (1.06%) to 7,747.71.',
    'absolute movement first, percentage in brackets second, and resulting price or level last',
    'Do not omit absolute movement when the package supplies it',
    'incorporate it naturally into the section prose and explain what is unknown and why it matters',
    'Do not write implementation-style labels such as "Uncertainty:" inside the prose',
    'continue to provide the structured uncertainties arrays separately'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('provider schema uses an exact keyed section transport without weakening runtime validation', () => {
  assert.deepEqual(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.required, [
    'status', 'reportContext', 'sectionsById', 'evidenceReferences', 'furtherReadings', 'evidenceGaps'
  ]);
  assert.equal(Object.hasOwn(
    CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.evidenceGaps.items, 'minLength'
  ), false);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.evidenceGaps.items.minLength, 1);
  assert.equal(Object.hasOwn(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties, 'sections'), false);
  assert.equal(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.sectionsById.additionalProperties, false);
  assert.deepEqual(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.sectionsById.required, REPORT_SECTION_NAMES);
  for (const sectionName of REPORT_SECTION_NAMES) {
    assert.deepEqual(
      CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.sectionsById.properties[sectionName],
      {type: 'object'}
    );
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA), 'utf8') < 2811,
    'provider transport schema should be materially smaller than the prior 4,685-byte schema'
  );
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.minItems, 8);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.maxItems, 8);
});

test('accepts valid NORMAL, DEGRADED and FAILED structured reports with one request each', async () => {
  const input = canonicalInput();
  const degradedSections = sections();
  degradedSections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Evidence is incomplete.']
  };
  const outputs = [
    normalOutput(input),
    {
      status: 'DEGRADED', reportContext: reportContext(input), sections: degradedSections,
      evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: ['A material cause is unresolved.']
    },
    {
      status: 'FAILED', reportContext: reportContext(input), sections: sections(null),
      evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Core evidence is insufficient.']
    }
  ];
  for (const output of outputs) {
    let calls = 0;
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, CLAUDE_MESSAGES_URL);
        assert.equal(options.method, 'POST');
        return anthropicResponse(output);
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.type, 'SUCCESS');
    assert.equal(result.output.status, output.status);
  }
  assert.deepEqual(CLAUDE_ANALYSIS_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'CONTRACT_FAILURE'
  ]);
});

test('deterministically downgrades evidence-limited NORMAL output while preserving strict validation', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  output.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []
  };
  const strictValidation = validateClaudeAnalysisOutput(output, input);
  assert.deepEqual(strictValidation.errors, ['NORMAL requires every analysis section']);

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  const message = 'The supplied evidence did not support a reliable KEY RISKS & OPPORTUNITIES section.';
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[5], {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: [message]
  });
  assert.deepEqual(result.output.evidenceGaps, [message]);
});

test('deterministically nulls impossible Sections 2-4 and recomputes first-use references', async () => {
  const input = canonicalInput({
    includeSecondEvidence: true,
    materialEvents: [],
    principalCatalysts: [],
    broadMarketFocus: []
  });
  const output = normalOutput(input);
  output.sections[0].evidenceRefs = ['e2'];
  output.sections[1].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.sections[1].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.sections[2].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.evidenceReferences = ['e1'];

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  const expected = [
    'The supplied evidence did not establish a material market driver.',
    'Validated broad-market company or sector evidence was unavailable.'
  ];
  for (const [offset, message] of expected.entries()) {
    const section = result.output.sections[offset + 1];
    assert.equal(section.content, null);
    assert.deepEqual(section.evidenceRefs, []);
    assert.deepEqual(section.telemetryRefs, []);
    assert.deepEqual(section.uncertainties, [message]);
    assert.equal(result.output.evidenceGaps.includes(message), true);
  }
  assert.deepEqual(result.output.evidenceReferences, ['e2', 'e1']);
});

test('localizes empty broad-market focus to Section 3 without removing valid driver evidence', async () => {
  const input = canonicalInput({broadMarketFocus: []});
  const output = normalOutput(input);

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.notEqual(result.output.sections[1].content, null);
  assert.notEqual(result.output.sections[1].content, null);
  assert.deepEqual(result.output.sections[2], {
    name: REPORT_SECTION_NAMES[2],
    content: null,
    evidenceRefs: [],
    telemetryRefs: [],
    uncertainties: ['Validated broad-market company or sector evidence was unavailable.']
  });
});

test('keeps unrelated driver and broad-market hard-gate violations strict', async () => {
  const input = canonicalInput();
  const invalidDriver = normalOutput(input);
  invalidDriver.sections[1].evidenceRefs = [];
  const invalidFocus = normalOutput(input);
  invalidFocus.sections[2].content = 'Generic index commentary.';

  for (const output of [invalidDriver, invalidFocus]) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('does not normalize structurally inconsistent null sections or unusable reports', async () => {
  const input = canonicalInput();
  const referencedNull = normalOutput(input);
  referencedNull.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: ['e1'], telemetryRefs: [],
    uncertainties: []
  };
  const allUnavailable = normalOutput(input);
  allUnavailable.sections = allUnavailable.sections.map((section, index) => index === 7
    ? section
    : {...section, content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []});

  for (const output of [referencedNull, allUnavailable]) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('derives top-level evidenceReferences from section first-use order', async () => {
  const input = canonicalInput({includeSecondEvidence: true});
  const output = normalOutput(input);
  output.sections[0].evidenceRefs = ['e2', 'e1'];
  output.sections[1].evidenceRefs = ['e1'];
  output.evidenceReferences = ['e1', 'e2'];

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.evidenceReferences, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[1].evidenceRefs, ['e1']);
});

test('still rejects missing, extra or invalid section-level evidenceRefs', async () => {
  const missing = normalOutput(canonicalInput());
  delete missing.sections[0].evidenceRefs;
  const extra = normalOutput(canonicalInput());
  extra.sections[0].evidenceRefs = ['e1', 'e2'];
  const invalid = normalOutput(canonicalInput());
  invalid.sections[0].evidenceRefs = 'e1';

  for (const output of [missing, extra, invalid]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(), apiKey: 'test-key',
      fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('rejects non-canonical input before invoking Anthropic', async () => {
  const input = JSON.parse(JSON.stringify(canonicalInput()));
  input.analysisRequest.reportType = 'SEARCH_ANALYSIS';
  let calls = 0;
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(result.type, 'INPUT_FAILURE');
});

test('classifies malformed or contract-invalid structured reports as CONTRACT_FAILURE', async () => {
  const input = canonicalInput();
  const malformed = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(null, {
      async json() { return {content: [{type: 'text', text: '{bad json'}]}; }
    })
  });
  assert.equal(malformed.type, 'CONTRACT_FAILURE');

  const missing = normalOutput(input);
  missing.sections.pop();
  const renamed = normalOutput(input);
  renamed.sections[0].name = 'RENAMED SECTION';

  for (const output of [missing, renamed]) {
    const invalid = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(invalid.type, 'CONTRACT_FAILURE');
  }
});

test('converts keyed provider sections in canonical order and ignores Section 8 transport content', async () => {
  const input = canonicalInput();
  const raw = providerTransport(normalOutput(input));
  raw.sectionsById = Object.fromEntries(Object.entries(raw.sectionsById).reverse());
  raw.sectionsById[REPORT_SECTION_NAMES[0]] = Object.fromEntries(
    Object.entries(raw.sectionsById[REPORT_SECTION_NAMES[0]]).reverse()
  );
  raw.sectionsById[REPORT_SECTION_NAMES[7]] = {unexpected: 'provider placeholder'};
  raw.evidenceReferences = ['e999', 'e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections.map(section => section.name), REPORT_SECTION_NAMES);
  assert.deepEqual(result.output.sections[7], {
    name: REPORT_SECTION_NAMES[7], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []
  });
  assert.deepEqual(result.output.evidenceReferences, ['e1']);
});

test('hard-fails missing, unknown, and malformed keyed provider section transport with safe diagnostics', async () => {
  const input = canonicalInput();
  const cases = [];
  const missing = providerTransport(normalOutput(input));
  delete missing.sectionsById[REPORT_SECTION_NAMES[0]];
  cases.push(missing);
  const unknown = providerTransport(normalOutput(input));
  unknown.sectionsById.UNRELATED = {...unknown.sectionsById[REPORT_SECTION_NAMES[0]]};
  cases.push(unknown);
  const malformedPayload = providerTransport(normalOutput(input));
  malformedPayload.sectionsById[REPORT_SECTION_NAMES[1]] = {content: 'Malformed'};
  cases.push(malformedPayload);
  for (const raw of cases) {
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
    const event = diagnostics.find(value => value.stage === 'claudeAnalysisStructureNormalization');
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes('Supported analysis.'), false);
  }
});

test('normalizes supported FAILED output with sparse optional sections to DEGRADED', async () => {
  const input = canonicalInput();
  const raw = normalOutput(input, {status: 'FAILED', evidenceGaps: []});
  raw.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []
  };
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[0].content !== null, true);
  assert.deepEqual(result.output.sections[5].evidenceRefs, []);
  assert.equal(result.output.evidenceGaps.length, 1);
});

test('rejects model-supplied URLs, provenance and unknown references', async () => {
  const input = canonicalInput();
  const outputs = [
    {...normalOutput(input), canonicalUrl: 'https://example.com/'},
    normalOutput(input, {sections: REPORT_SECTION_NAMES.map((name, index) => ({
      name, content: index === 7 ? null : 'Finding.',
      evidenceRefs: index === 7 ? [] : ['e2'], telemetryRefs: index === 7 ? [] : ['t1'],
      uncertainties: []
    }))})
  ];
  for (const output of outputs) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('keeps network, HTTP and response-body failures distinct and never retries', async () => {
  const input = canonicalInput();
  let networkCalls = 0;
  const network = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => {
      networkCalls++;
      throw new Error('offline');
    }
  });
  let upstreamCalls = 0;
  const upstream = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => {
      upstreamCalls++;
      return {ok: false, status: 429};
    }
  });
  const bodyRead = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => ({
      ok: true, status: 200, async json() { throw new Error('interrupted'); }
    })
  });
  assert.equal(networkCalls, 1);
  assert.equal(upstreamCalls, 1);
  assert.equal(network.type, 'UPSTREAM_FAILURE');
  assert.equal(upstream.type, 'UPSTREAM_FAILURE');
  assert.equal(upstream.upstreamStatus, 429);
  assert.equal(bodyRead.type, 'UPSTREAM_FAILURE');
});

test('logs only sanitized Anthropic details for a failed final synthesis request', async () => {
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      headers: {get: name => name === 'request-id' ? 'req_final_123' : null},
      async json() {
        return {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_request',
            message: 'bad request https://api.anthropic.com/v1/messages '
              + 'prompt=PRIVATE_PROMPT article=PRIVATE_ARTICLE'
          },
          sensitive: 'PRIVATE_FULL_PROVIDER_RESPONSE'
        };
      }
    })
  });
  assert.equal(result.type, 'UPSTREAM_FAILURE');
  const event = diagnostics.find(value => value.stage === 'claudeAnalysisUpstreamFailure');
  assert.deepEqual(event, {
    stage: 'claudeAnalysisUpstreamFailure',
    upstreamStatus: 400,
    upstreamErrorType: 'invalid_request_error',
    upstreamErrorMessage: 'bad request [url] prompt=PRIVATE_PROMPT article=PRIVATE_ARTICLE',
    requestId: 'req_final_123'
  });
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('PRIVATE_FULL_PROVIDER_RESPONSE'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('logs a sanitized NETWORK_FAILURE when the final Claude fetch rejects', async () => {
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input: canonicalInput(), apiKey: 'test-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => { throw new Error('PRIVATE raw exception and prompt contents'); }
  });
  assert.equal(result.type, 'UPSTREAM_FAILURE');
  assert.deepEqual(diagnostics.find(value => value.stage === 'claudeAnalysisUpstreamFailure'), {
    stage: 'claudeAnalysisUpstreamFailure',
    upstreamStatus: null,
    upstreamErrorType: 'NETWORK_FAILURE',
    upstreamErrorMessage: 'Claude network request failed',
    requestId: null
  });
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes('PRIVATE raw exception'), false);
  assert.equal(serialized.includes('prompt contents'), false);
});

test('successful final synthesis emits no upstream-failure diagnostic', async () => {
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input: canonicalInput(), apiKey: 'test-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => anthropicResponse(normalOutput(canonicalInput()))
  });
  assert.equal(result.type, 'SUCCESS');
  assert.equal(diagnostics.some(value => value.stage === 'claudeAnalysisUpstreamFailure'), false);
});

test('treats successfully read malformed Anthropic envelopes as contract failures', async () => {
  for (const envelope of [{}, {content: []}, {content: [{type: 'image', source: {}}]}]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(), apiKey: 'test-key',
      fetchImpl: async () => ({ok: true, status: 200, async json() { return envelope; }})
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

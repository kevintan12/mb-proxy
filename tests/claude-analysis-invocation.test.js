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
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  MAX_ACTIVE_FURTHER_READINGS,
  NO_CURRENT_SESSION_EVIDENCE_GAP,
  NO_CURRENT_SESSION_SUMMARY,
  noCurrentSessionEvidenceOutput,
  resolveActiveFurtherReadings,
  eligibleActiveFurtherReadingReferences,
  hasDirectMarketCausalClaim
} = require('../lib/claude-analysis-contract');
const {
  CLAUDE_ANALYSIS_MODEL,
  CLAUDE_ANALYSIS_MAX_TOKENS,
  CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  CLAUDE_ANALYSIS_RESULT_TYPES,
  CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA,
  buildClaudeAnalysisRequest,
  fitWriterArticleBudget,
  invokeClaudeAnalysis
} = require('../lib/claude-analysis-invocation');
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');
const {
  richCompletedUsWeekInput,
  supportedOutput: supportedCompletedUsOutput
} = require('./fixtures/us-market-brief-quality');
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
  supportingEvidence = ['e2'],
  subsequentDevelopments = [],
  broadMarketFocus = [{evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]}],
  portfolioContext = {myStocks: [], watchlist: []}
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
        conflictingEvidence: [], subsequentDevelopments, sessionAssociations: [],
        broadMarketFocus,
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext
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

function activeOutputWithOnlySection(input, index) {
  const output = normalOutput(input, {
    status: 'DEGRADED',
    evidenceGaps: ['Other analytical sections were not supported by the supplied evidence.']
  });
  for (let sectionIndex = 0; sectionIndex < REPORT_SECTION_NAMES.length - 1; sectionIndex++) {
    if (sectionIndex === index) continue;
    output.sections[sectionIndex] = {...output.sections[sectionIndex], content: null,
      evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['The supplied evidence did not support this analytical section.']};
  }
  output.evidenceReferences = output.sections[index].evidenceRefs.slice();
  return output;
}

function providerTransport(output) {
  const encode = values => values.join('|');
  return {
    status: output.status,
    evidenceGaps: output.evidenceGaps,
    ...Object.fromEntries(output.sections.map((section, index) => [`s${index + 1}`, index === 7 ? {} : {
      content: section.content,
      evidenceRefs: encode(section.evidenceRefs),
      telemetryRefs: encode(section.telemetryRefs),
      uncertainties: encode(section.uncertainties)
    }]))
  };
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
    'inspect each listed reference together with its title and summary',
    'citation is optional when the evidence is immaterial',
    'Do not force a citation or attach a reference automatically',
    'previous completed session only as historical comparison or baseline',
    'Use CURRENT_SESSION evidence in whichever analytical section it genuinely supports',
    'Section 2 must explain current-session drivers',
    'must never be presented as causing the earlier completed-session move',
    'must not list every Most Active security',
    'Section 4 may use supported CURRENT_SESSION news only when its reference is present',
    'Section 5 should explain in plain language whether market gains or losses are broad',
    'when populated, cite current evidence before any earlier-session context',
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
  const evidenceByRef = new Map(modelInput.marketPackages[0].evidenceContext.evidence.map(
    entry => [entry.reference, entry.item]
  ));
  assert.equal(evidenceByRef.get('e1').ageHoursAtGeneration, 0.5);
  assert.equal(Object.hasOwn(evidenceByRef.get('e2'), 'ageHoursAtGeneration'), false);
});

test('Step 8P.2(a) lead-with-live-session sentence appears for PRE, REGULAR and POST when current evidence exists', () => {
  const sentence = 'This applies the same way whichever active session is in progress — PRE, REGULAR '
    + '(Trading), or POST (After-Hours): open Section 1 and Section 2 by describing the current session '
    + 'itself, its live move and immediate drivers, and use the previous completed session’s close '
    + 'only as background for comparison. Do not state or imply that current-session evidence caused a '
    + 'move, or name any cause, beyond what the cited evidence actually supports.';
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const request = buildClaudeAnalysisRequest(input);
    assert.equal(request.system.includes(sentence), true, marketState);
  }
});

test('Step 8P.2(a) sentence is absent when no validated current-session evidence survives', () => {
  const sentence = 'This applies the same way whichever active session is in progress';
  const input = activeUsInput({
    marketState: 'REGULAR', generatedAt: '2026-09-08T15:00:00.000Z',
    overlayAsOf: '2026-09-08T14:55:00.000Z',
    currentPublishedAt: '2026-08-01T00:00:00.000Z'
  });
  const modelInput = projectClaudeAnalysisInput(input);
  assert.deepEqual(modelInput.currentSessionContext, [
    {market: 'US', sessionDate: '2026-09-08', evidenceRefs: []}
  ]);
  const request = buildClaudeAnalysisRequest(input);
  assert.equal(request.system.includes(sentence), false);
  assert.equal(request.system.includes('ACTIVE_SESSION evidence is limited'), true);
});

test('Step 8P.2(a) sentence is absent for non-active (no currentSessionContext) analyses', () => {
  const sentence = 'This applies the same way whichever active session is in progress';
  const input = canonicalInput();
  const request = buildClaudeAnalysisRequest(input);
  assert.equal(request.system.includes(sentence), false);
  assert.equal(request.system.includes('ACTIVE_SESSION request-specific semantics'), false);
});

test('ageHoursAtGeneration is present and rounded to one decimal only on current-session evidence', () => {
  const input = activeUsInput({
    marketState: 'REGULAR', generatedAt: '2026-09-08T15:00:00.000Z',
    overlayAsOf: '2026-09-08T14:55:00.000Z',
    currentPublishedAt: '2026-09-08T02:07:00.000Z'
  });
  const modelInput = projectClaudeAnalysisInput(input);
  const evidenceByRef = new Map(modelInput.marketPackages[0].evidenceContext.evidence.map(
    entry => [entry.reference, entry.item]
  ));
  // generatedAt 15:00 minus publishedAt 02:07 = 12h53m = 12.9 hours (rounded to one decimal).
  assert.equal(evidenceByRef.get('e1').ageHoursAtGeneration, 12.9);
  assert.equal(Object.hasOwn(evidenceByRef.get('e2'), 'ageHoursAtGeneration'), false);
});

test('the ageHoursAtGeneration overnight-background prompt sentence appears exactly once', () => {
  const sentence = 'Items with ageHoursAtGeneration above 12 are overnight background from before '
    + 'the session, not fresh news; do not present them as new.';
  for (const input of [canonicalInput(), activeUsInput()]) {
    const request = buildClaudeAnalysisRequest(input);
    const occurrences = request.system.split(sentence).length - 1;
    assert.equal(occurrences, 1);
  }
});

test('PRE permits grounded prior-session context in Section 1 without requiring it to carry current evidence', async () => {
  const input = activeUsInput({
    marketState: 'PRE', generatedAt: '2026-09-08T12:00:00.000Z',
    overlayAsOf: '2026-09-08T11:55:00.000Z',
    currentPublishedAt: '2026-09-08T11:30:00.000Z'
  });
  const current = normalOutput(input, {furtherReadings: ['e1']});
  assert.equal(validateClaudeAnalysisOutput(current, input).valid, true);
  const priorFirst = structuredClone(current);
  priorFirst.sections[0].content = 'Friday\'s completed-session move remains useful context. '
    + 'The current pre-market picture is covered where the evidence supports it.';
  priorFirst.sections[0].evidenceRefs = ['e2'];
  priorFirst.evidenceReferences = ['e2', 'e1'];
  assert.equal(validateClaudeAnalysisOutput(priorFirst, input).valid, true);

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

test('PRE, REGULAR and POST do not require Section 1 to lead with current-session analysis', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const current = normalOutput(input, {furtherReadings: ['e1']});
    assert.equal(validateClaudeAnalysisOutput(current, input).valid, true, marketState);
    const priorFirst = structuredClone(current);
    priorFirst.sections[0].content = 'The S&P 500 finished Friday higher after a mixed session. '
      + 'Current developments are discussed only afterward.';
    const validation = validateClaudeAnalysisOutput(priorFirst, input);
    assert.equal(validation.valid, true, marketState);
  }
});

test('PRE, REGULAR and POST retain grounded output without synthesizing a Section 1 current citation', async () => {
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
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: event => diagnostics.push(event)
    });
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.deepEqual(result.output.sections[0].evidenceRefs, ['e2']);
    assert.deepEqual(result.output.furtherReadings, []);
    assert.deepEqual(diagnostics.find(event => event.stage === 'activeSessionOutput'), {
      stage: 'activeSessionOutput', projectedCurrentSessionRefCount: 1,
      citedCurrentSessionRefCount: 0, returnedCurrentSessionRefCount: 0,
      deterministicCitationRepairApplied: false, repairedCurrentSessionRefCount: 0,
      sectionOneCurrentRefFirst: false, sectionOneCurrentFirst: true,
      activeFurtherReadingsEligibleCount: 1, activeFurtherReadingsSelectedCount: 0
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
      output.sections[0].content = 'Stocks are responding to live developments now. '
        + 'The prior close is context only.';
      output.sections[0].evidenceRefs = ['e2', 'e1'];
      output.evidenceReferences = ['e2', 'e1'];
      assert.equal(validateClaudeAnalysisOutput(output, input).valid, true,
        `${marketState} overlay=${includeOverlay}`);
    }
  }
});

test('active Sections 5 and 7 may retain grounded earlier-session context', async () => {
  const input = activeUsInput();
  const output = normalOutput(input, {furtherReadings: ['e1']});
  output.sections[4].content = 'The market is broadening, but the earlier session remains context.';
  output.sections[4].evidenceRefs = ['e2'];
  output.sections[6].content = 'Watch for the next development after the earlier session.';
  output.sections[6].evidenceRefs = ['e2'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  for (const index of [4, 6]) {
    assert.notEqual(result.output.sections[index].content, null);
    assert.deepEqual(result.output.sections[index].evidenceRefs, ['e2']);
  }
});

test('active output does not require deterministic current citation repair, while unknown refs still fail', async () => {
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
  assert.equal(ambiguous.type, 'SUCCESS', ambiguous.message);
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
  assert.equal(invalidDiagnostics.some(event => event.stage === 'activeSessionOutput'), false);
});

test('PRE, REGULAR and POST permit uncited current evidence when it supports no surviving section', async () => {
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
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
  }
});

test('current evidence may be cited outside Section 1 without a synthetic Section 1 citation', async () => {
  const input = activeUsInput();
  const raw = activeOutputWithoutCurrentCitation(input);
  raw.sections[4].evidenceRefs = ['e1'];
  raw.evidenceReferences = ['e2', 'e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e2']);
  assert.deepEqual(result.output.sections[4].evidenceRefs, ['e1']);
});

test('active FAILED remains valid when zero analytical sections survive', async () => {
  const input = activeUsInput();
  const failed = {
    status: 'FAILED', reportContext: reportContext(input), sections: sections(null),
    evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Coverage is sparse.']
  };
  assert.equal(validateClaudeAnalysisOutput(failed, input).valid, true);
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(failed)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
});

test('active analysis survives when any one independently grounded section remains', async () => {
  for (const index of [0, 2, 5, 6]) {
    const input = activeUsInput();
    const raw = activeOutputWithOnlySection(input, index);
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
    });
    assert.equal(result.type, 'SUCCESS', `section ${index + 1}: ${result.message}`);
    assert.equal(result.output.status, 'DEGRADED');
    assert.notEqual(result.output.sections[index].content, null);
    for (let other = 0; other < 7; other++) {
      if (other !== index && other !== 3) assert.equal(result.output.sections[other].content, null);
    }
  }

  const sectionFourInput = activeUsInput({portfolioContext: {
    myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'], upcomingEvents: []}],
    watchlist: []
  }});
  const sectionFour = activeOutputWithOnlySection(sectionFourInput, 3);
  sectionFour.sections[3] = {...sectionFour.sections[3],
    content: 'Microsoft moved during current trading.', evidenceRefs: ['e1'], telemetryRefs: []};
  sectionFour.evidenceReferences = ['e1'];
  const sectionFourResult = await invokeClaudeAnalysis({
    input: sectionFourInput, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(sectionFour)
  });
  assert.equal(sectionFourResult.type, 'SUCCESS', sectionFourResult.message);
  assert.notEqual(sectionFourResult.output.sections[3].content, null);
});

test('active Section 1 may localize while a current-supported Section 3 survives', async () => {
  const input = activeUsInput();
  const raw = activeOutputWithOnlySection(input, 2);
  raw.sections[0] = {...raw.sections[0],
    content: 'Microsoft news sent stocks higher at Friday\'s close.', evidenceRefs: ['e1'], telemetryRefs: ['t1'],
    uncertainties: []};
  raw.evidenceReferences = ['e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[0].content, null);
  assert.notEqual(result.output.sections[2].content, null);
  assert.deepEqual(result.output.furtherReadings, ['e1']);
});

test('active zero surviving sections normalize to the deterministic FAILED outcome', async () => {
  const input = activeUsInput();
  const raw = activeOutputWithOnlySection(input, 0);
  raw.sections[0] = {...raw.sections[0],
    content: 'Microsoft news sent stocks higher at Friday\'s close.', evidenceRefs: ['e1'], telemetryRefs: ['t1'],
    uncertainties: []};
  raw.evidenceReferences = ['e1'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'FAILED');
  assert.equal(result.output.sections.slice(0, 7).every((section, index) =>
    index === 3 || section.content === null), true);
  assert.deepEqual(result.output.furtherReadings, []);
});

test('unknown references empty an active optional section, while Section 1 stays a hard failure', async () => {
  const input = activeUsInput();
  const optional = normalOutput(input, {furtherReadings: []});
  optional.sections[4].evidenceRefs = ['e999'];
  // Step 8U.5: the made-up ref empties only Section 5; the report survives.
  const localizedOptional = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(optional)
  });
  assert.equal(localizedOptional.type, 'SUCCESS', localizedOptional.message);
  assert.equal(localizedOptional.output.sections[4].content, null);
  assert.equal(localizedOptional.output.sections[0].content, optional.sections[0].content);

  const summary = normalOutput(input, {furtherReadings: []});
  summary.sections[0].evidenceRefs = ['e999'];
  const rejected = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(summary)
  });
  assert.equal(rejected.type, 'CONTRACT_FAILURE');
});

test('active causal safety localizes unsupported sections independently', async () => {
  const input = activeUsInput({
    materialEvents: ['e1', 'e2'], principalCatalysts: ['e2'], supportingEvidence: ['e1']
  });
  const summary = normalOutput(input, {furtherReadings: []});
  summary.sections[0].content = 'Inflation data sent stocks higher in the current session.';
  const summaryResult = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(summary)
  });
  assert.equal(summaryResult.type, 'SUCCESS', summaryResult.message);
  assert.equal(summaryResult.output.sections[0].content, null);

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

test('PRE, REGULAR and POST retain a cautious Section 1 with one LOW current article', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt, sessionPhrase] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z', 'on September 8'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z', 'on 2026-09-08'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z', 'on 9/8/2026']
  ]) {
    const input = structuredClone(activeUsInput({
      marketState, generatedAt, overlayAsOf, currentPublishedAt,
      materialEvents: [], principalCatalysts: [], supportingEvidence: ['e1'],
      broadMarketFocus: []
    }));
    const output = normalOutput(input);
    output.sections[0].content = `Stocks rose ${sessionPhrase} in the current session as Microsoft news was reported. `
      + 'The previous close is comparison only.';
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections[0].content, output.sections[0].content);
    assert.deepEqual(result.output.sections[0].evidenceRefs, ['e1']);
    assert.equal(result.output.sections[1].content, null);
    assert.equal(result.output.sections[2].content, null);
  }
});

test('active optional section defects localize together without retaining unsupported prose', async () => {
  const input = activeUsInput({
    materialEvents: ['e1', 'e2'], principalCatalysts: ['e2'], supportingEvidence: ['e1']
  });
  const output = normalOutput(input);
  output.sections[1].content = 'Current news sent stocks higher.';
  output.sections[2].content = 'Generic broad-market mover commentary.';
  output.sections[3].content = 'Unsupported initiating-list movement.';
  output.sections[5].content = 'A bullish opportunity may exist.';
  output.sections[6].content = 'An unsupported future catalyst is certain.';
  output.sections[6].evidenceRefs = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  for (const index of [1, 2, 5, 6]) {
    assert.equal(result.output.sections[index].content, null, `section ${index + 1}`);
    assert.deepEqual(result.output.sections[index].evidenceRefs, []);
    assert.deepEqual(result.output.sections[index].telemetryRefs, []);
    assert.equal(result.output.sections[index].uncertainties.length > 0, true);
  }
  assert.equal(result.output.sections[3].content, EMPTY_INITIATING_LIST_CONTENT.myStocks);
  assert.deepEqual(result.output.sections[3].evidenceRefs, []);
});

test('active Section 4 with a nonempty initiating list localizes cross-list support', async () => {
  const input = structuredClone(activeUsInput());
  input.portfolioContext.myStocks = [{
    market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'], upcomingEvents: []
  }];
  input.portfolioContext.watchlist = [{
    market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: ['e2'], upcomingEvents: []
  }];
  const output = normalOutput(input);
  output.sections[3].content = 'Apple watchlist movement was material.';
  output.sections[3].evidenceRefs = ['e2'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[3].content, null);
  assert.deepEqual(result.output.sections[3].evidenceRefs, []);
});

test('active optional formatting and whole-report word overflow localize without changing Section 1', async () => {
  const input = activeUsInput();
  for (const [mutate, expectedStatus, localized] of [
    [output => { output.sections[4].uncertainties = ['Repeated.', 'Repeated.']; }, 'NORMAL', false],
    [output => { output.sections[4].content = 'context '.repeat(2550).trim(); }, 'DEGRADED', true]
  ]) {
    const output = normalOutput(input);
    mutate(output);
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, expectedStatus);
    assert.notEqual(result.output.sections[0].content, null);
    if (localized) {
      assert.equal(result.output.sections[4].content, null);
      assert.deepEqual(result.output.sections[4].evidenceRefs, []);
    } else {
      assert.deepEqual(result.output.sections[4].uncertainties, ['Repeated.']);
    }
  }
});

test('active Section 3 lacking cited focus or an exact focus subject localizes', async () => {
  const input = activeUsInput();
  for (const evidenceRefs of [['e2'], ['e1']]) {
    const output = normalOutput(input);
    output.sections[2].content = 'Generic stocks and sectors discussion.';
    output.sections[2].evidenceRefs = evidenceRefs;
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.sections[2].content, null);
    assert.equal(result.output.status, 'DEGRADED');
  }
});

test('active supported analysis overrides model FAILED while strong causality localizes only its section', async () => {
  const input = activeUsInput({
    materialEvents: [], principalCatalysts: [], supportingEvidence: ['e1'],
    broadMarketFocus: []
  });
  const failed = normalOutput(input, {status: 'FAILED', evidenceGaps: []});
  const normalized = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(failed)
  });
  assert.equal(normalized.type, 'SUCCESS', normalized.message);
  assert.equal(normalized.output.status, 'DEGRADED');
  assert.notEqual(normalized.output.sections[0].content, null);

  for (const content of [
    'Microsoft news sent stocks higher in the current session.',
    "Microsoft news sent stocks higher at Friday's close."
  ]) {
    const strong = normalOutput(input);
    strong.sections[0].content = content;
    const localized = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(strong)
    });
    assert.equal(localized.type, 'SUCCESS', localized.message);
    assert.equal(localized.output.sections[0].content, null);
  }
});

test('active report status follows surviving content and material evidence gaps', async () => {
  const input = activeUsInput();
  for (const [status, evidenceGaps, expectedStatus] of [
    ['NORMAL', ['A current market driver remains unresolved.'], 'DEGRADED'],
    ['DEGRADED', [], 'NORMAL']
  ]) {
    const output = normalOutput(input, {status, evidenceGaps});
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, expectedStatus);
    assert.notEqual(result.output.sections[0].content, null);
  }
});

test('active transport metadata is canonicalized without changing grounded analysis', async () => {
  const input = activeUsInput();
  const output = normalOutput(input, {status: 'unexpected', evidenceGaps: [null, ' ', ' Gap. ', 'Gap.']});
  output.sections[0].telemetryRefs = ['t1', 't1'];
  output.sections[0].uncertainties = [' Current coverage is limited. ', '', 'Current coverage is limited.'];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.evidenceGaps, ['Gap.']);
  assert.deepEqual(result.output.sections[0].telemetryRefs, ['t1']);
  assert.deepEqual(result.output.sections[0].uncertainties, ['Current coverage is limited.']);
});

test('CLOSED, WEEKEND and HOLIDAY retain completed sections and empty only an unsupported Section 3', async () => {
  for (const [marketState, generatedAt] of [
    ['CLOSED', '2026-09-04T22:00:00.000Z'],
    ['WEEKEND', '2026-09-06T10:00:00.000Z'],
    ['HOLIDAY', '2026-09-07T16:00:00.000Z']
  ]) {
    const input = structuredClone(richCompletedUsWeekInput());
    input.analysisRequest.generatedAt = generatedAt;
    input.marketPackages[0].marketContext.marketState = marketState;
    for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
      input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
    const completedFirst = supportedCompletedUsOutput(input);
    completedFirst.sections[0].content = 'Friday\'s completed session remains the main market context.';
    const valid = await invokeClaudeAnalysis({
      input, apiKey: 'test-key',
      fetchImpl: async () => anthropicResponse(completedFirst)
    });
    assert.equal(valid.type, 'SUCCESS', `${marketState}: ${valid.message}`);
    for (const index of [1, 2, 5, 6]) {
      assert.equal(valid.output.sections[index].content, completedFirst.sections[index].content);
      assert.deepEqual(valid.output.sections[index].evidenceRefs,
        completedFirst.sections[index].evidenceRefs);
    }
    const invalid = supportedCompletedUsOutput(input);
    invalid.sections[2].content = 'Generic index commentary.';
    // Step 8U.2: the unsupported Section 3 is emptied; the rest of the report survives.
    const localized = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(invalid)
    });
    assert.equal(localized.type, 'SUCCESS', `${marketState}: ${localized.message}`);
    assert.equal(localized.output.status, 'DEGRADED');
    assert.equal(localized.output.sections[2].content, null);
    assert.deepEqual(localized.output.sections[2].uncertainties,
      ['Not enough data to write the STOCKS & SECTORS IN FOCUS section.']);
    assert.equal(localized.output.sections[0].content, invalid.sections[0].content);
    assert.deepEqual(localized.output.furtherReadings, invalid.furtherReadings);
  }
});

function step8U2Case(marketState, generatedAt, overlayAsOf, currentPublishedAt) {
  if (overlayAsOf) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    return {input, output: normalOutput(input, {furtherReadings: ['e1']})};
  }
  const input = structuredClone(richCompletedUsWeekInput());
  input.analysisRequest.generatedAt = generatedAt;
  input.marketPackages[0].marketContext.marketState = marketState;
  for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
    input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
  return {input, output: supportedCompletedUsOutput(input)};
}

const STEP_8U2_BREAKERS = [
  ['an internal-identifier leak', 4, ({output}) => {
    output.sections[4].content =
      `${output.sections[4].content} It examines evidenceContext.broadMarketFocus directly.`;
  }],
  ['a section with no evidence', 4, ({output}) => {
    output.sections[4].evidenceRefs = [];
  }],
  ['a Section 3 that names no focus subject', 2, ({output}) => {
    output.sections[2].content = 'Generic index commentary.';
  }],
  ['word overflow', 4, ({output}) => {
    output.sections[4].content = Array(1300).fill('Supported analysis.').join(' ');
  }],
  ['the wrong empty-list text for Section 4', 3, ({input, output}) => {
    input.portfolioContext.myStocks = [];
    output.sections[3] = {...output.sections[3], content: 'There are no stocks to show.',
      evidenceRefs: [], telemetryRefs: [], uncertainties: []};
  }]
];

test('Step 8U.2: in every state group each rule break empties one section, not the report', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z'],
    ['CLOSED', '2026-09-04T22:00:00.000Z'],
    ['WEEKEND', '2026-09-06T10:00:00.000Z'],
    ['HOLIDAY', '2026-09-07T16:00:00.000Z']
  ]) {
    for (const [label, targetIndex, breakOutput] of STEP_8U2_BREAKERS) {
      const fixture = step8U2Case(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const baseline = structuredClone(fixture.output);
      breakOutput(fixture);
      const {input, output} = fixture;
      const context = `${marketState}: ${label}`;
      let calls = 0;
      const diagnostics = [];
      const result = await invokeClaudeAnalysis({
        input, apiKey: 'test-key',
        fetchImpl: async () => { calls++; return anthropicResponse(output); },
        onDiagnostics: value => diagnostics.push(value)
      });
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, `${context}: no Step 8L retry is needed`);
      const target = result.output.sections[targetIndex];
      if (targetIndex === 3) {
        assert.equal(target.content, EMPTY_INITIATING_LIST_CONTENT.myStocks, context);
      } else {
        assert.equal(result.output.status, 'DEGRADED', context);
        assert.equal(target.content, null, context);
        assert.deepEqual(target.uncertainties,
          [`Not enough data to write the ${REPORT_SECTION_NAMES[targetIndex]} section.`], context);
        assert.equal(result.output.evidenceGaps.includes(target.uncertainties[0]), true, context);
      }
      for (let index = 0; index < 7; index++) {
        if (index === targetIndex) continue;
        assert.equal(result.output.sections[index].content, baseline.sections[index].content,
          `${context}: section ${index + 1} survives`);
      }
      assert.deepEqual(result.output.furtherReadings, baseline.furtherReadings, context);
      assert.equal(diagnostics.some(value => value.stage === 'claudeAnalysisSectionNormalization'
        && value.sectionIndex === targetIndex), true, context);
    }
  }
});

test('Step 8U.2: completed Section 1 must still survive, so a broken Section 1 fails with one retry', async () => {
  const fixture = step8U2Case('WEEKEND', '2026-09-06T10:00:00.000Z');
  fixture.output.sections[0].evidenceRefs = [];
  let calls = 0;
  const result = await invokeClaudeAnalysis({
    input: fixture.input, apiKey: 'test-key',
    fetchImpl: async () => { calls++; return anthropicResponse(fixture.output); }
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.match(result.message, /sections\[0\]: factual content requires supplied evidence/);
  assert.equal(calls, 2);
});

const STEP_8U_STATES = [
  ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
  ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
  ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z'],
  ['CLOSED', '2026-09-04T22:00:00.000Z'],
  ['WEEKEND', '2026-09-06T10:00:00.000Z'],
  ['HOLIDAY', '2026-09-07T16:00:00.000Z']
];

async function invokeCounted(input, output) {
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async () => { calls++; return anthropicResponse(output); },
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, calls, diagnostics};
}

test('Step 8U.5: in every state a made-up ref in Section 5 empties only Section 5', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U2Case(marketState, ...times);
    const baseline = structuredClone(fixture.output);
    fixture.output.sections[4].evidenceRefs = ['e999'];
    fixture.output.sections[4].telemetryRefs = ['t1', 't999'];
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, `${marketState}: no Step 8L retry is needed`);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    const target = result.output.sections[4];
    assert.equal(target.content, null, marketState);
    assert.deepEqual(target.evidenceRefs, [], marketState);
    assert.deepEqual(target.telemetryRefs, [], marketState);
    assert.deepEqual(target.uncertainties,
      ['Not enough data to write the MARKET INTERPRETATION section.'], marketState);
    assert.equal(result.output.evidenceGaps.includes(target.uncertainties[0]), true, marketState);
    for (let index = 0; index < 7; index++) {
      if (index === 4) continue;
      assert.equal(result.output.sections[index].content, baseline.sections[index].content,
        `${marketState}: section ${index + 1} survives`);
    }
    assert.deepEqual(result.output.furtherReadings, baseline.furtherReadings, marketState);
    assert.equal(JSON.stringify(result.output).includes('999'), false, marketState);
    assert.deepEqual(diagnostics.filter(value =>
      value.violationCategory === 'UNKNOWN_SECTION_REFERENCE'), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 4,
      violationCategory: 'UNKNOWN_SECTION_REFERENCE',
      suppliedReferenceCount: 3, allowedReferenceCount: 1, offendingReferenceCount: 2
    }], marketState);
    assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, marketState);
  }
});

test('Step 8U.5: in every state made-up refs beside a valid evidence ref are dropped and the section is kept', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U2Case(marketState, ...times);
    const baseline = structuredClone(fixture.output);
    const validRefs = baseline.sections[4].evidenceRefs;
    fixture.output.sections[4].evidenceRefs = [...validRefs, 'e999'];
    fixture.output.sections[4].telemetryRefs = ['t1', 't999'];
    const baselineRun = await invokeCounted(fixture.input, baseline);
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, marketState);
    assert.deepEqual(result.output, baselineRun.result.output, `${marketState}: same as the clean reply`);
    assert.deepEqual(result.output.sections[4].evidenceRefs, validRefs, marketState);
    assert.deepEqual(result.output.sections[4].telemetryRefs, ['t1'], marketState);
    assert.deepEqual(diagnostics.filter(value =>
      value.violationCategory === 'UNKNOWN_SECTION_REFERENCE'), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 4,
      violationCategory: 'UNKNOWN_SECTION_REFERENCE',
      suppliedReferenceCount: validRefs.length + 3,
      allowedReferenceCount: validRefs.length + 1,
      offendingReferenceCount: 2, action: 'TRIMMED'
    }], marketState);
  }
});

test('Step 8U.5: in every state a made-up ref in Section 1 or a malformed ref still fails with one retry', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const [label, mutate] of [
      ['Section 1 made-up ref', output => {
        output.sections[0].evidenceRefs = [...output.sections[0].evidenceRefs, 'e999'];
      }],
      ['Section 5 malformed ref token', output => { output.sections[4].evidenceRefs = ['ref-one']; }],
      ['Section 5 empty ref token', output => { output.sections[4].telemetryRefs = ['t1', '']; }]
    ]) {
      const fixture = step8U2Case(marketState, ...times);
      mutate(fixture.output);
      const {result, calls} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'CONTRACT_FAILURE', `${marketState}: ${label}`);
      assert.match(result.message, /unknown or invalid reference/, `${marketState}: ${label}`);
      assert.equal(calls, 2, `${marketState}: ${label} gets the one Step 8L retry`);
    }
  }
});

test('Step 8U.5: a made-up ref beside the empty-list Section 4 text keeps the exact text', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U2Case(marketState, ...times);
    fixture.input.portfolioContext.myStocks = [];
    fixture.output.sections[3] = {...fixture.output.sections[3],
      content: EMPTY_INITIATING_LIST_CONTENT.myStocks, evidenceRefs: ['e999'], telemetryRefs: [],
      uncertainties: []};
    const {result} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.deepEqual(result.output.sections[3], {name: REPORT_SECTION_NAMES[3],
      content: EMPTY_INITIATING_LIST_CONTENT.myStocks, evidenceRefs: [], telemetryRefs: [],
      uncertainties: []}, marketState);
  }
});

function step8U9Case(marketState, ...times) {
  const fixture = step8U2Case(marketState, ...times);
  if (fixture.input.analysisRequest.generatedAt.startsWith('2026-09-08')) {
    // Active fixtures have no portfolio; add a Watchlist company that is not in focus.
    fixture.input = structuredClone(fixture.input);
    fixture.input.portfolioContext.watchlist = [{
      market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []
    }];
  }
  return fixture;
}

test('Step 8U.9: in every state a Section 3 sentence naming an unfocused portfolio company is removed', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U9Case(marketState, ...times);
    const original = fixture.output.sections[2].content;
    fixture.output.sections[2].content = `${original} Apple (AAPL) also moved.`;
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.sections[2].content, original, marketState);
    assert.deepEqual(result.output.sections[2].evidenceRefs, fixture.output.sections[2].evidenceRefs,
      marketState);
    assert.equal(result.output.evidenceGaps.includes(
      'Not enough data to point out specific stocks or sectors.'), false, marketState);
    assert.deepEqual(diagnostics.filter(value =>
      value.violationCategory === 'UNFOCUSED_PORTFOLIO_MENTION'), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
      violationCategory: 'UNFOCUSED_PORTFOLIO_MENTION', action: 'TRIMMED',
      suppliedReferenceCount: 0, allowedReferenceCount: 0, offendingReferenceCount: 0,
      removedSentenceCount: 1
    }], marketState);
    assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, marketState);
  }
});

test('Step 8U.9: in every state Section 3 is still emptied when no focus subject would remain', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const content of [
      'Apple (AAPL) moved with the market.',
      'Broadcom, Microsoft and Apple (AAPL) moved with the market. Shares were mixed.'
    ]) {
      const fixture = step8U9Case(marketState, ...times);
      fixture.output.sections[2].content = content;
      const {result, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
      assert.equal(result.output.status, 'DEGRADED', marketState);
      assert.equal(result.output.sections[2].content, null, `${marketState}: ${content}`);
      assert.deepEqual(result.output.sections[2].uncertainties,
        ['Not enough data to point out specific stocks or sectors.'], marketState);
      assert.equal(diagnostics.some(value => value.violationCategory === 'UNFOCUSED_PORTFOLIO_MENTION'
        && value.action === undefined), true, marketState);
      assert.equal(diagnostics.some(value => value.action === 'TRIMMED'
        && value.violationCategory === 'UNFOCUSED_PORTFOLIO_MENTION'), false, marketState);
    }
  }
});

test('Step 8U.9: pre-normalization diagnostics count only unlinked stock telemetry in Section 3', async () => {
  const input = structuredClone(activeUsInput());
  input.portfolioContext.myStocks = [
    {market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: [], upcomingEvents: []}
  ];
  input.marketPackages[0].telemetry.stockSnapshots.push({
    reference: 't2',
    snapshot: {...structuredClone(input.marketPackages[0].telemetry.benchmarkSnapshots[0].snapshot),
      symbol: 'MSFT', instrumentName: 'Microsoft', instrumentType: 'EQUITY'}
  });
  assert.equal(validateClaudeAnalysisInput(input), true);
  const output = normalOutput(input, {furtherReadings: ['e1']});
  output.sections[2].telemetryRefs = ['t1', 't2'];
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[2].telemetryRefs, ['t1', 't2']);
  const event = diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
    && value.sectionIndex === 2);
  assert.equal(event.violationCategories, undefined);
});

function step8U6Case(marketState, ...times) {
  const fixture = step8U2Case(marketState, ...times);
  const active = Boolean(times[1]);
  return {
    ...fixture,
    risk: active ? 'Higher interest rates remain a risk for stocks.'
      : 'Policy uncertainty remains a material risk to the market outlook.',
    focusRefs: active ? ['e1'] : ['e3', 'e5'],
    nonFocusRefs: active ? ['e2'] : ['e3']
  };
}

const STEP_8U6_UNGROUNDED = [
  ['UNGROUNDED_OPPORTUNITY_SUBJECT', 'An unnamed company has a constructive opportunity.', 'focusRefs'],
  ['UNSUPPORTED_OPPORTUNITY_CLAIM', 'An unnamed company has a constructive opportunity.', 'nonFocusRefs'],
  ['GENERIC_OPPORTUNITY_CLAIM', 'An oversold rebound creates a buy-the-dip opportunity.', 'focusRefs']
];

test('Step 8U.6: in every state an ungrounded Section 6 opportunity sentence is removed and the risk is kept', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const [category, opportunity, refsKey] of STEP_8U6_UNGROUNDED) {
      const fixture = step8U6Case(marketState, ...times);
      const context = `${marketState}: ${category}`;
      fixture.output.sections[5].evidenceRefs = fixture[refsKey].slice();
      const clean = structuredClone(fixture.output);
      clean.sections[5].content = fixture.risk;
      fixture.output.sections[5].content = `${fixture.risk} ${opportunity}`;
      assert.equal(validateClaudeAnalysisOutput(fixture.output, fixture.input).valid, false, context);
      const cleanRun = await invokeCounted(fixture.input, clean);
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, `${context}: no Step 8L retry is needed`);
      assert.equal(result.output.status, 'NORMAL', `${context}: the trim alone does not degrade`);
      assert.equal(result.output.sections[5].content, fixture.risk, context);
      assert.deepEqual(result.output.sections[5].evidenceRefs, fixture[refsKey], context);
      assert.deepEqual(result.output, cleanRun.result.output, `${context}: same as the risk-only reply`);
      assert.equal(result.output.evidenceGaps.includes(
        'Not enough data to point out a clear opportunity.'), false, context);
      const events = diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 5);
      assert.deepEqual(events.map(value =>
        [value.violationCategory, value.action, value.removedSentenceCount]),
      [[category, 'TRIMMED', 1]], context);
      assert.equal(JSON.stringify(diagnostics).includes(opportunity), false, context);
      assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, context);
    }
  }
});

test('Step 8U.6: in every state an all-ungrounded Section 6 is still emptied and a grounded one is unchanged', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const [category, opportunity, refsKey] of STEP_8U6_UNGROUNDED) {
      const fixture = step8U6Case(marketState, ...times);
      const context = `${marketState}: ${category}`;
      fixture.output.sections[5].evidenceRefs = fixture[refsKey].slice();
      fixture.output.sections[5].content = `${opportunity} Another opportunity may follow.`;
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, context);
      assert.equal(result.output.status, 'DEGRADED', context);
      assert.deepEqual(result.output.sections[5], {
        name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
        uncertainties: ['Not enough data to point out a clear opportunity.']
      }, context);
      assert.equal(result.output.evidenceGaps.includes(
        'Not enough data to point out a clear opportunity.'), true, context);
      assert.deepEqual(diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 5)
        .map(value => [value.violationCategory, value.action]), [[category, undefined]], context);
    }

    const grounded = step8U6Case(marketState, ...times);
    grounded.output.sections[5].evidenceRefs = grounded.focusRefs.slice();
    grounded.output.sections[5].content = times[1]
      ? `Microsoft has a supported constructive opportunity. ${grounded.risk}`
      : `Constructive Health-care developments support a sector opportunity. ${grounded.risk}`;
    assert.equal(validateClaudeAnalysisOutput(grounded.output, grounded.input).valid, true, marketState);
    const {result, diagnostics} = await invokeCounted(grounded.input, grounded.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.deepEqual(result.output.sections[5], grounded.output.sections[5], marketState);
    assert.equal(diagnostics.some(value => value.stage === 'claudeAnalysisSectionNormalization'
      && value.sectionIndex === 5), false, marketState);
  }
});

const STEP_8U8_QUALIFIER = 'The news does not show for certain what moved the market.';
const STEP_8U8_CAUSALITY_GAP = 'Not enough data to say what moved the market.';

function withStep8U8References(output) {
  output.evidenceReferences = [...new Set(output.sections.slice(0, 7)
    .flatMap(section => section.evidenceRefs))];
  return output;
}

// Sections 1 and 3-7 with descriptive text and refs that hold no principal catalyst of the needed
// kind. Active: e1 is current Yahoo news (focus, current catalyst) and e2 the completed-session
// catalyst, so a claim about the previous session citing only e1 names current news as its cause.
// Completed: e1 is the Yahoo recap published after Friday's close (a later development, never a
// catalyst) and e5 a focus item that is not a catalyst.
function step8U8Case(marketState, ...times) {
  const fixture = step8U2Case(marketState, ...times);
  const active = Boolean(times[1]);
  const input = structuredClone(fixture.input);
  const output = structuredClone(fixture.output);
  if (active) {
    input.portfolioContext.myStocks = [{market: 'US', symbol: 'MSFT', telemetryRefs: [],
      evidenceRefs: ['e1'], upcomingEvents: []}];
    output.sections[2].content = 'Supported Microsoft analysis.';
    output.sections[3] = {...output.sections[3], content: 'Microsoft was in focus.',
      evidenceRefs: ['e1'], telemetryRefs: [], uncertainties: []};
  } else {
    input.portfolioContext.myStocks[0].evidenceRefs = ['e1', 'e2'];
    output.sections[2] = {...output.sections[2], content: 'Health-care stocks advanced.',
      evidenceRefs: ['e5']};
    output.sections[3].evidenceRefs = ['e1'];
    output.sections[5].content = 'Policy uncertainty remains a material risk to the market outlook.';
    for (const index of [0, 4, 5, 6]) output.sections[index].evidenceRefs = ['e1'];
  }
  assert.equal(validateClaudeAnalysisInput(input), true, marketState);
  return {
    input, output: withStep8U8References(output), active,
    causal: active ? 'Rate-cut hopes drove stocks higher in the previous session.'
      : 'Rate-cut hopes drove stocks higher in the session.',
    category: active ? 'MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST' : 'MISSING_PRINCIPAL_CATALYST'
  };
}

test('Step 8U.8: in every state an uncatalyzed causal sentence in Sections 1 and 3-7 is removed and the section kept', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const index of [0, 2, 3, 4, 5, 6]) {
      const fixture = step8U8Case(marketState, ...times);
      const context = `${marketState}: section ${index + 1}`;
      const clean = structuredClone(fixture.output);
      fixture.output.sections[index].content =
        `${clean.sections[index].content} ${fixture.causal}`;
      const errors = validateClaudeAnalysisOutput(fixture.output, fixture.input).errors;
      if (fixture.active || index !== 0) {
        assert.equal(errors.includes(fixture.active
          ? `sections[${index}]: active market causality lacks the required principal catalyst`
          : `sections[${index}]: completed-session market causality lacks a principal catalyst`),
        true, context);
      } else {
        assert.equal(errors.length, 0, `${context}: completed Section 1 is not checked`);
      }

      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, `${context}: no Step 8L retry is needed`);
      assert.equal(result.output.status, 'NORMAL', `${context}: the trim alone does not degrade`);
      assert.deepEqual(result.output.evidenceGaps, [], context);
      assert.deepEqual(result.output.sections[index], {
        ...clean.sections[index],
        uncertainties: [...clean.sections[index].uncertainties, STEP_8U8_QUALIFIER]
      }, context);
      for (let other = 0; other < 7; other++) {
        if (other !== index) {
          assert.deepEqual(result.output.sections[other], clean.sections[other],
            `${context}: section ${other + 1} unchanged`);
        }
      }
      assert.deepEqual(diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization'), [{
        stage: 'claudeAnalysisSectionNormalization', sectionIndex: index,
        violationCategory: fixture.category, action: 'TRIMMED',
        suppliedReferenceCount: clean.sections[index].evidenceRefs.length,
        allowedReferenceCount: fixture.active ? 1 : 3, offendingReferenceCount: 0,
        removedSentenceCount: 1
      }], context);
      assert.equal(JSON.stringify(diagnostics).includes('Rate-cut hopes'), false, context);
      // The removed sentence named post-close (completed) or current (active) news as the cause
      // of the completed-session move; nothing of it reaches the report.
      assert.equal(JSON.stringify(result.output).includes('Rate-cut hopes'), false, context);
      assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, context);
    }
  }
});

test('Step 8U.8: on active days a current-session causal sentence without a current catalyst is removed', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES.filter(state => state[2])) {
    for (const index of [0, 4, 5, 6]) {
      const fixture = step8U8Case(marketState, ...times);
      const context = `${marketState}: section ${index + 1}`;
      const clean = structuredClone(fixture.output);
      clean.sections[index].evidenceRefs = ['e2'];
      fixture.output.sections[index].evidenceRefs = ['e2'];
      fixture.output.sections[index].content =
        `${clean.sections[index].content} Rate-cut hopes drove stocks higher in the session.`;
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, context);
      assert.equal(result.output.status, 'NORMAL', context);
      assert.deepEqual(result.output.sections[index], {
        ...clean.sections[index], uncertainties: [STEP_8U8_QUALIFIER]
      }, context);
      assert.deepEqual(diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization').map(value =>
        [value.sectionIndex, value.violationCategory, value.action, value.removedSentenceCount]),
      [[index, 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST', 'TRIMMED', 1]], context);
      assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, context);
    }
  }
});

test('Step 8U.8: in every state a section with only uncatalyzed causal text is emptied, except completed Section 1', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const index of [0, 2, 3, 4, 5, 6]) {
      const fixture = step8U8Case(marketState, ...times);
      const context = `${marketState}: section ${index + 1}`;
      const clean = structuredClone(fixture.output);
      // Section 3 keeps its focus subject but loses it with the causal sentence.
      fixture.output.sections[index].content = index === 2
        ? (fixture.active ? 'Microsoft news drove stocks higher in the previous session.'
          : 'Health-care news drove stocks higher in the session.')
        : fixture.causal;
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, context);
      const events = diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization');
      if (index === 0 && !fixture.active) {
        // Completed Section 1 must survive: it is kept exactly as written, as before this step.
        assert.equal(result.output.status, 'NORMAL', context);
        assert.deepEqual(result.output.sections[0], fixture.output.sections[0], context);
        assert.deepEqual(events, [], context);
        continue;
      }
      assert.equal(result.output.status, 'DEGRADED', context);
      assert.equal(result.output.sections[index].content, null, context);
      assert.deepEqual(result.output.sections[index].evidenceRefs, [], context);
      if (index === 0) {
        // Active Section 1 keeps the Step 8U.2 blank.
        assert.deepEqual(events.map(value => [value.sectionIndex, value.violationCategory]),
          [[0, 'OPTIONAL_SECTION_VALIDATION']], context);
      } else {
        assert.deepEqual(result.output.sections[index].uncertainties, [STEP_8U8_CAUSALITY_GAP],
          context);
        assert.equal(result.output.evidenceGaps.includes(STEP_8U8_CAUSALITY_GAP), true, context);
        assert.deepEqual(events.map(value => [value.sectionIndex, value.violationCategory,
          value.action]), [[index, fixture.category, undefined]], context);
      }
      for (let other = 0; other < 7; other++) {
        if (other !== index) {
          assert.equal(result.output.sections[other].content, clean.sections[other].content,
            `${context}: section ${other + 1} survives`);
        }
      }
      assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, context);
    }
  }
});

test('Step 8U.8: in every state a causal sentence backed by the needed catalyst is unchanged', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const index of [0, 4, 6]) {
      const fixture = step8U8Case(marketState, ...times);
      const context = `${marketState}: section ${index + 1}`;
      // Active: the earlier-session claim cites the completed-session catalyst e2. Completed: it
      // cites the principal catalyst e3 (Federal Reserve) beside the post-close recap.
      fixture.output.sections[index].evidenceRefs = fixture.active ? ['e1', 'e2'] : ['e1', 'e3'];
      fixture.output.sections[index].content =
        `${fixture.output.sections[index].content} ${fixture.causal}`;
      withStep8U8References(fixture.output);
      assert.equal(validateClaudeAnalysisOutput(fixture.output, fixture.input).valid, true, context);
      const {result, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(result.output.status, 'NORMAL', context);
      assert.deepEqual(result.output.sections[index], fixture.output.sections[index], context);
      assert.deepEqual(diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization'), [], context);
    }
  }
});

function step8U7Case(marketState, ...times) {
  const fixture = step8U2Case(marketState, ...times);
  if (times[1]) {
    // Active fixtures have no portfolio; My Stocks holds MSFT (e1) and the Watchlist AAPL (e2).
    fixture.input = structuredClone(fixture.input);
    fixture.input.portfolioContext = {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'],
        upcomingEvents: []}],
      watchlist: [{market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: ['e2'],
        upcomingEvents: []}]
    };
    fixture.output.sections[3] = {...fixture.output.sections[3],
      content: 'Microsoft raised its outlook.', evidenceRefs: ['e1'], telemetryRefs: [],
      uncertainties: []};
    return {...fixture, initiatingRef: 'e1', otherRef: 'e2'};
  }
  // Completed fixtures: My Stocks holds MSFT (e2, t2); give the Watchlist AAPL its own ref (e4).
  fixture.input.portfolioContext.watchlist[0].evidenceRefs = ['e4'];
  return {...fixture, initiatingRef: 'e2', otherRef: 'e4'};
}

test('Step 8U.7: in every state Section 4 drops refs from the other list and keeps the section', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U7Case(marketState, ...times);
    assert.equal(validateClaudeAnalysisInput(fixture.input), true, marketState);
    const clean = structuredClone(fixture.output);
    fixture.output.sections[3].evidenceRefs = [fixture.initiatingRef, fixture.otherRef];
    assert.equal(validateClaudeAnalysisOutput(fixture.output, fixture.input).errors.includes(
      'sections[3]: evidence references must belong to the initiating list'), true, marketState);
    const cleanRun = await invokeCounted(fixture.input, clean);
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, `${marketState}: no Step 8L retry is needed`);
    assert.equal(result.output.status, 'NORMAL', `${marketState}: the trim alone does not degrade`);
    assert.deepEqual(result.output, cleanRun.result.output, `${marketState}: same as the clean reply`);
    assert.deepEqual(result.output.sections[3].evidenceRefs, [fixture.initiatingRef], marketState);
    assert.equal(result.output.sections[3].content, clean.sections[3].content, marketState);
    assert.deepEqual(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 3), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 3,
      violationCategory: 'NON_INITIATING_EVIDENCE', action: 'TRIMMED',
      suppliedReferenceCount: 2, allowedReferenceCount: 1, offendingReferenceCount: 1
    }], marketState);
    assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, marketState);
  }
});

// Step 9B: the "names a Watchlist security" and "a ref from outside both lists" cases that this
// test used to blank now trim; they are covered by the Step 9B tests below.
test('Step 8U.7: in every state Section 4 is still emptied when it keeps no initiating ref or only unrelated text', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    for (const [label, mutate] of [
      ['only other-list refs', (section, fixture) => {
        section.evidenceRefs = [fixture.otherRef];
      }],
      ['only unrelated content', (section, fixture) => {
        section.content = 'Apple (AAPL) slipped.';
        section.evidenceRefs = [fixture.initiatingRef, fixture.otherRef];
      }],
      ['only unrelated content and refs', (section, fixture) => {
        section.content = 'Apple (AAPL) slipped.';
        section.evidenceRefs = [fixture.otherRef];
        section.telemetryRefs = ['t1'];
      }]
    ]) {
      const fixture = step8U7Case(marketState, ...times);
      const context = `${marketState}: ${label}`;
      mutate(fixture.output.sections[3], fixture);
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${context}: ${result.message}`);
      assert.equal(calls, 1, context);
      assert.equal(result.output.status, 'DEGRADED', context);
      assert.deepEqual(result.output.sections[3], {
        name: REPORT_SECTION_NAMES[3], content: null, evidenceRefs: [], telemetryRefs: [],
        uncertainties: ['Not enough data to comment on the stocks in this list.']
      }, context);
      const events = diagnostics.filter(value =>
        value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 3);
      assert.equal(events.length > 0, true, context);
      assert.equal(events.every(value => /^NON_INITIATING_/.test(value.violationCategory)
        && value.action === undefined), true, context);
    }
  }
});

const STEP_9B_SYMBOLS = ['MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'COST', 'NFLX'];

function step9BCase(marketState, ...times) {
  // Ten My Stocks securities sharing the initiating ref; the Watchlist holds AAPL (otherRef).
  const fixture = step8U7Case(marketState, ...times);
  const [first] = fixture.input.portfolioContext.myStocks;
  fixture.input.portfolioContext.myStocks = [first, ...STEP_9B_SYMBOLS.slice(1).map(symbol => ({
    market: 'US', symbol, telemetryRefs: [], evidenceRefs: [fixture.initiatingRef], upcomingEvents: []
  }))];
  fixture.output.sections[3].content = STEP_9B_SYMBOLS.map(symbol => `${symbol} held steady.`)
    .join(' ');
  return fixture;
}

test('Step 9B: in every state one unrelated stock sentence is removed and the other nine stocks are kept', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step9BCase(marketState, ...times);
    assert.equal(validateClaudeAnalysisInput(fixture.input), true, marketState);
    assert.equal(fixture.input.portfolioContext.myStocks.length, 10, marketState);
    // The text discusses ten stocks: nine from My Stocks and one Watchlist stock (AAPL).
    const unrelated = 'Apple (AAPL) slipped.';
    const keptSymbols = STEP_9B_SYMBOLS.filter((symbol, index) => index !== 5);
    const kept = keptSymbols.map(symbol => `${symbol} held steady.`);
    const clean = structuredClone(fixture.output);
    clean.sections[3].content = kept.join(' ');
    fixture.output.sections[3].content = [...kept.slice(0, 5), unrelated, ...kept.slice(5)].join(' ');
    fixture.output.sections[3].evidenceRefs = [fixture.initiatingRef, fixture.otherRef];
    const cleanRun = await invokeCounted(fixture.input, clean);
    assert.equal(cleanRun.result.type, 'SUCCESS', `${marketState}: ${cleanRun.result.message}`);
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, `${marketState}: no Step 8L retry is needed`);
    assert.equal(result.output.status, 'NORMAL', `${marketState}: the trim alone does not degrade`);
    assert.equal(result.output.sections[3].content, kept.join(' '), marketState);
    assert.equal(keptSymbols.length, 9, marketState);
    for (const symbol of keptSymbols) {
      assert.match(result.output.sections[3].content, new RegExp(`\\b${symbol}\\b`), marketState);
    }
    assert.doesNotMatch(result.output.sections[3].content, /AAPL|Apple/, marketState);
    assert.deepEqual(result.output.sections[3].evidenceRefs, [fixture.initiatingRef], marketState);
    assert.deepEqual(result.output, cleanRun.result.output, `${marketState}: same as the clean reply`);
    assert.deepEqual(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 3)
      .map(value => [value.violationCategory, value.action, value.removedSentenceCount]), [
      ['NON_INITIATING_EVIDENCE', 'TRIMMED', undefined],
      ['NON_INITIATING_MENTION', 'TRIMMED', 1]
    ], marketState);
    assert.equal(JSON.stringify(diagnostics).includes(unrelated), false, marketState);
    assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, marketState);
  }
});

test('Step 9B: in every state an index reference in Section 4 is dropped and the section is kept', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step8U7Case(marketState, ...times);
    fixture.output.sections[3].content = `${fixture.output.sections[3].content} The S&P 500 edged up.`;
    const clean = structuredClone(fixture.output);
    fixture.output.sections[3].telemetryRefs = fixture.output.sections[3].telemetryRefs.concat('t1');
    assert.equal(validateClaudeAnalysisOutput(fixture.output, fixture.input).errors.includes(
      'sections[3]: telemetry references must belong to the initiating list'), true, marketState);
    const cleanRun = await invokeCounted(fixture.input, clean);
    assert.equal(cleanRun.result.type, 'SUCCESS', `${marketState}: ${cleanRun.result.message}`);
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.deepEqual(result.output.sections[3], cleanRun.result.output.sections[3], marketState);
    assert.equal(result.output.sections[3].content, clean.sections[3].content, marketState);
    assert.equal(result.output.sections[3].telemetryRefs.includes('t1'), false, marketState);
    assert.deepEqual(result.output, cleanRun.result.output, `${marketState}: same as the clean reply`);
    assert.deepEqual(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 3)
      .map(value => [value.violationCategory, value.action, value.offendingReferenceCount]),
    [['NON_INITIATING_TELEMETRY', 'TRIMMED', 1]], marketState);
    assert.equal(validateClaudeAnalysisOutput(result.output, fixture.input).valid, true, marketState);
  }
});

test('Step 9B: in every state a Section 4 with only unrelated content is emptied with the Step 8J wording', async () => {
  for (const [marketState, ...times] of STEP_8U_STATES) {
    const fixture = step9BCase(marketState, ...times);
    const baseline = structuredClone(fixture.output);
    fixture.output.sections[3].content = 'Apple (AAPL) slipped. AAPL may stay volatile.';
    fixture.output.sections[3].evidenceRefs = [fixture.otherRef];
    fixture.output.sections[3].telemetryRefs = ['t1'];
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    assert.deepEqual(result.output.sections[3], {
      name: REPORT_SECTION_NAMES[3], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['Not enough data to comment on the stocks in this list.']
    }, marketState);
    assert.equal(result.output.evidenceGaps.includes(
      'Not enough data to comment on the stocks in this list.'), true, marketState);
    for (let index = 0; index < 7; index++) {
      if (index === 3) continue;
      assert.equal(result.output.sections[index].content, baseline.sections[index].content,
        `${marketState}: section ${index + 1} survives`);
    }
    assert.equal(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization' && value.sectionIndex === 3)
      .every(value => value.action === undefined), true, marketState);
  }
});

test('completed US report retains the pre-fail-soft executive-summary survival boundary', async () => {
  const input = richCompletedUsWeekInput();
  const oneSection = supportedCompletedUsOutput(input);
  oneSection.status = 'DEGRADED';
  oneSection.evidenceGaps = ['Other analytical sections could not be supported.'];
  for (let index = 0; index < 7; index++) {
    if (index === 2) continue;
    oneSection.sections[index] = {
      ...oneSection.sections[index], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['This section could not be supported.']
    };
  }
  const rejected = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(oneSection)
  });
  assert.equal(rejected.type, 'CONTRACT_FAILURE');
  assert.match(rejected.message, /executive market summary requires supported content/);

  const modelFailed = structuredClone(oneSection);
  modelFailed.status = 'FAILED';
  modelFailed.evidenceGaps = [];
  const failedStatus = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(modelFailed)
  });
  assert.equal(failedStatus.type, 'CONTRACT_FAILURE');

  const none = structuredClone(oneSection);
  none.sections[2] = {...none.sections[2], content: null, evidenceRefs: [],
    telemetryRefs: [], uncertainties: ['This section could not be supported.']};
  const noSupport = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(none)
  });
  assert.equal(noSupport.type, 'CONTRACT_FAILURE');
});

test('PRE, REGULAR and POST can synthesize a grounded section when current news is unavailable', async () => {
  for (const [marketState, generatedAt, overlayAsOf] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z']
  ]) {
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf,
      currentPublishedAt: '2026-09-04T19:00:00.000Z'
    });
    assert.equal(noCurrentSessionEvidenceOutput(input), null);
    assert.match(buildClaudeAnalysisRequest(input).system,
      /no validated CURRENT_SESSION Yahoo article references/);
    const output = activeOutputWithOnlySection(input, 4);
    output.sections[4].content = 'Earlier validated evidence remains useful context while current news is unavailable.';
    let calls = 0;
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => { calls++; return anthropicResponse(output); },
      onDiagnostics: event => diagnostics.push(event)
    });
    assert.equal(calls, 1);
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections.length, 8);
    assert.equal(result.output.sections[4].content, output.sections[4].content);
    assert.deepEqual(result.output.sections[4].evidenceRefs, ['e1']);
    assert.deepEqual(result.output.furtherReadings, []);
    assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
    assert.equal(diagnostics.find(event => event.stage === 'activeSessionProjection')
      .projectedCurrentSessionRefCount, 0);
    assert.equal(diagnostics.find(event => event.stage === 'activeSessionOutput')
      .citedCurrentSessionRefCount, 0);
    const unsupportedCause = structuredClone(output);
    unsupportedCause.sections[4].content =
      'Earlier news sent stocks higher in the current session.';
    const causalResult = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(unsupportedCause)
    });
    assert.equal(causalResult.type, 'SUCCESS', causalResult.message);
    assert.equal(causalResult.output.status, 'FAILED');
    assert.equal(causalResult.output.sections[4].content, null);
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
    canonicalUrl: 'https://finance.yahoo.com/markets/stocks/articles/apple-gains-active-session.html',
    publishedAt: '2026-09-08T14:40:00.000Z', symbols: ['AAPL'], publisher: 'Yahoo Finance'
  });
  const duplicateYahooUrl = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Duplicate Apple citation', summary: 'The same article has another evidence reference.',
    canonicalUrl: 'https://finance.yahoo.com/markets/stocks/articles/apple-gains-active-session.html',
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
  const unapprovedYahoo = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Yahoo topic page, not an article', summary: 'Landing page must not qualify.',
    canonicalUrl: 'https://finance.yahoo.com/topic/latestnews/',
    publishedAt: '2026-09-08T14:45:00.000Z', symbols: [], publisher: 'Yahoo Finance'
  });
  const additionalCurrentYahoo = Array.from({length: 4}, (_, index) => createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: `Current Yahoo article ${index + 1}`, summary: 'Validated current-session Yahoo coverage.',
    canonicalUrl: `https://finance.yahoo.com/news/current-yahoo-${index + 1}.html`,
    publishedAt: `2026-09-08T14:4${index + 6}:00.000Z`, symbols: [], publisher: 'Yahoo Finance'
  }));
  const input = activeUsInput({
    additionalItems: [secondYahoo, duplicateYahooUrl, cnbcCurrent, staleYahoo, uncitedYahoo,
      ...additionalCurrentYahoo]
  });
  assert.equal(eligibleActiveFurtherReadingReferences(input).has('e3'), true);
  const invalidUrlInput = activeUsInput({additionalItems: [unapprovedYahoo]});
  assert.equal(eligibleActiveFurtherReadingReferences(invalidUrlInput).has('e3'), false);
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

test('active Further Readings resolve empty when no current Yahoo evidence is cited', async () => {
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
  assert.deepEqual(result.output.furtherReadings, []);
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

const ACTIVE_STATE_TIMES = [
  ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
  ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
  ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
];
const UNSUPPORTED_CAUSALITY_QUALIFIER = 'The news does not show for certain what moved the market.';

async function invokeWithSectionEvents(input, raw) {
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, events: diagnostics.filter(value =>
    value.stage === 'claudeAnalysisSectionNormalization')};
}

test('Step 8U.3: PRE, REGULAR and POST Section 2 drops only a current-session causal sentence without a current catalyst', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of ACTIVE_STATE_TIMES) {
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf, currentPublishedAt, principalCatalysts: []
    });
    const raw = normalOutput(input);
    raw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
      + 'The Microsoft outlook drove stocks higher. The S&P 500 was 1.9% above the prior close.';
    const {result, events} = await invokeWithSectionEvents(input, raw);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.deepEqual(result.output.evidenceGaps, []);
    assert.deepEqual(result.output.sections[1], {
      ...raw.sections[1],
      content: 'Microsoft raised its outlook during the U.S. session. '
        + 'The S&P 500 was 1.9% above the prior close.',
      uncertainties: [UNSUPPORTED_CAUSALITY_QUALIFIER]
    });
    // The cited current Yahoo ref stays cited, so it still reaches Further Readings.
    assert.deepEqual(result.output.furtherReadings, ['e1']);
    assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true, marketState);
    assert.deepEqual(events, [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 1,
      violationCategory: 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST', action: 'TRIMMED',
      suppliedReferenceCount: 1, allowedReferenceCount: 0, offendingReferenceCount: 0,
      removedSentenceCount: 1
    }]);
  }
});

test('Step 8U.3: PRE, REGULAR and POST never keep current evidence as the cause of the earlier completed-session move', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of ACTIVE_STATE_TIMES) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const raw = normalOutput(input);
    raw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
      + 'Microsoft outlook sent stocks lower at Friday\'s close.';
    const {result, events} = await invokeWithSectionEvents(input, raw);
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.equal(result.output.sections[1].content,
      'Microsoft raised its outlook during the U.S. session.');
    assert.deepEqual(result.output.sections[1].evidenceRefs, ['e1']);
    assert.deepEqual(result.output.sections[1].uncertainties, [UNSUPPORTED_CAUSALITY_QUALIFIER]);
    assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true, marketState);
    assert.deepEqual(events.map(event => [event.violationCategory, event.action,
      event.removedSentenceCount]),
    [['MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST', 'TRIMMED', 1]]);

    // Every sentence is an unsupported causal claim: the section is emptied as before.
    const allCausal = normalOutput(input);
    allCausal.sections[1].content = 'Microsoft outlook sent stocks lower at Friday\'s close.';
    const blanked = await invokeWithSectionEvents(input, allCausal);
    assert.equal(blanked.result.type, 'SUCCESS', blanked.result.message);
    assert.equal(blanked.result.output.status, 'DEGRADED');
    assert.equal(blanked.result.output.sections[1].content, null);
    assert.deepEqual(blanked.result.output.sections[1].uncertainties,
      ['Not enough data to say what moved the market.']);
    assert.deepEqual(blanked.events.map(event => [event.violationCategory, event.action]),
      [['MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST', undefined]]);
  }
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
  // Step 9F.1f: the writer budget flags first that there is no Yahoo article to trim.
  assert.deepEqual(diagnostics, [{
    stage: 'writerArticleBudget',
    outcome: 'DOES_NOT_FIT_AT_FLOOR',
    limitBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
    floorBytes: 4096,
    requestBytesBefore: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1,
    requestBytesAfter: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1,
    yahooArticleCount: 0,
    trimmedArticleCount: 0,
    trimmed: []
  }, {
    // Step 9F.2b: the request-size summary, emitted right before the hard check.
    stage: 'requestSizeSummary', call: 'writer',
    requestBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1,
    limitBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
    percentOfLimit: 100,
    trimmedBytes: 0,
    trimmedArticleCount: 0
  }, {
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
  // Step 8L: a contract failure is retried once, so there is one diagnostic per attempt.
  assert.equal(invocationDiagnostics.length, 2);
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
  // Step 8L: a contract failure is retried once, so there is one diagnostic per attempt.
  assert.equal(invocationDiagnostics.length, 2);
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

test('Step 8L: writer retries once silently after a contract failure and then succeeds', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[0].evidenceRefs = ['e2'];
  const validOutput = normalOutput(input);
  const responses = [anthropicResponse(invalidOutput), anthropicResponse(validOutput)];
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => responses[calls++]
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  const retries = diagnostics.filter(value => value.stage === 'contractRetry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].call, 'writer');
  assert.equal(retries[0].firstFailureType, 'CONTRACT_FAILURE');
  assert.equal(retries[0].retryOutcome, 'SUCCESS');
  assert.equal(JSON.stringify(diagnostics).includes('test-key'), false);
});

test('Step 8L: writer stops after one retry when the second answer also fails', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[0].evidenceRefs = ['e2'];
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => { calls++; return anthropicResponse(invalidOutput); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(result.upstreamStatus, 200);
  assert.equal(calls, 2);
  const retries = diagnostics.filter(value => value.stage === 'contractRetry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].retryOutcome, 'CONTRACT_FAILURE');
});

test('Step 8L: writer first-try success makes one call and logs no retry', async () => {
  const input = canonicalInput();
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => { calls++; return anthropicResponse(normalOutput(input)); }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(diagnostics.some(value => value.stage === 'contractRetry'), false);
});

test('Step 8L: writer never retries upstream, input, truncated or oversized failures', async () => {
  const input = canonicalInput();
  const truncated = {
    ok: true, status: 200,
    async json() { return {stop_reason: 'max_tokens', content: [{type: 'text', text: '{"status":'}]}; }
  };
  const transports = [
    async () => { throw new Error('network secret'); },
    async () => ({ok: false, status: 401, headers: {get: () => null}}),
    async () => ({ok: false, status: 429, headers: {get: () => null}}),
    async () => ({ok: false, status: 503, headers: {get: () => null}}),
    async () => ({ok: true, status: 200, async json() { throw new Error('unreadable'); }}),
    async () => truncated
  ];
  for (const transport of transports) {
    let calls = 0;
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async (...args) => { calls++; return transport(...args); }
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const missingKey = await invokeClaudeAnalysis({input, apiKey: '', fetchImpl: async () => { calls++; }});
  assert.equal(missingKey.type, 'UPSTREAM_FAILURE');
  const invalidInput = await invokeClaudeAnalysis({input: {}, apiKey: 'test-key', fetchImpl: async () => { calls++; }});
  assert.equal(invalidInput.type, 'INPUT_FAILURE');
  assert.equal(calls, 0);
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

test('active coverage diagnostics expose Section 3 refs, focus roles and localization without prose', async () => {
  const input = activeUsInput();
  const output = normalOutput(input);
  output.sections[2] = {...output.sections[2], content: null, evidenceRefs: [],
    telemetryRefs: [], uncertainties: ['No focus content was generated.']};
  output.status = 'DEGRADED';
  output.evidenceGaps = ['No focus content was generated.'];
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
  const section3 = diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
    && value.sectionIndex === 2);
  assert.deepEqual(section3, {
    stage: 'claudeAnalysisPreNormalization', sectionIndex: 2,
    rawContentIsNull: true, evidenceRefs: [], telemetryRefs: [], suppliedReferenceCount: 0,
    suppliedEvidenceRefCount: 0, suppliedTelemetryRefCount: 0, broadMarketFocusRefCount: 1,
    broadMarketFocus: [{evidenceRef: 'e1', classificationRoles: [
      'MATERIAL_EVENT', 'PRINCIPAL_CATALYST'
    ], materialityTier: 'HIGH_OR_MEDIUM', confidence: null, specificSubjectCount: 1}]
  });

  const populated = normalOutput(input);
  populated.sections[2] = {...populated.sections[2], evidenceRefs: ['e2']};
  populated.evidenceReferences = ['e1', 'e2'];
  const localizedDiagnostics = [];
  const localized = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(populated),
    onDiagnostics: value => localizedDiagnostics.push(value)
  });
  const localizedWithoutDiagnostics = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(populated)
  });
  assert.equal(localized.type, 'SUCCESS', localized.message);
  assert.equal(JSON.stringify(localized.output), JSON.stringify(localizedWithoutDiagnostics.output));
  assert.equal(localized.output.sections[2].content, null);
  assert.deepEqual(localizedDiagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
    && value.sectionIndex === 2).violationCategories,
  ['MISSING_BROAD_MARKET_FOCUS', 'NON_FOCUS_EVIDENCE']);
  assert.ok(localizedDiagnostics.some(value => value.stage === 'claudeAnalysisSectionNormalization'
    && value.sectionIndex === 2 && value.violationCategory === 'NON_FOCUS_EVIDENCE'));
  const serialized = JSON.stringify(localizedDiagnostics);
  assert.equal(serialized.includes(populated.sections[2].content), false);
  assert.equal(serialized.includes('Microsoft'), false);

  const subjectMismatch = normalOutput(input);
  subjectMismatch.sections[2].content = 'Broad-market conditions remain mixed.';
  const subjectDiagnostics = [];
  const subjectResult = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(subjectMismatch),
    onDiagnostics: value => subjectDiagnostics.push(value)
  });
  assert.equal(subjectResult.type, 'SUCCESS', subjectResult.message);
  assert.equal(subjectResult.output.sections[2].content, null);
  assert.ok(subjectDiagnostics.some(value => value.stage === 'claudeAnalysisSectionNormalization'
    && value.sectionIndex === 2
    && value.validationViolationCategories?.includes('MISSING_VALIDATED_FOCUS_SUBJECT')));
});

test('active coverage diagnostics distinguish Section 6 subject match and mismatch safely', async () => {
  const input = activeUsInput();
  for (const [content, expectedMatch, expectedViolation] of [
    ['Microsoft has a supported constructive opportunity.', true, null],
    ['An unnamed company has a constructive opportunity.', false, 'UNGROUNDED_OPPORTUNITY_SUBJECT']
  ]) {
    const output = normalOutput(input);
    output.sections[5].content = content;
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
    const section6 = diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
      && value.sectionIndex === 5);
    assert.equal(section6.rawContentIsNull, false);
    assert.deepEqual(section6.citedFocus, [{evidenceRef: 'e1', inBroadMarketFocus: true,
      normalizedSubjectTokens: ['microsoft']}]);
    assert.equal(section6.opportunityClaimDetected, true);
    assert.equal(section6.hasExactCitedSubject, expectedMatch);
    assert.equal(section6.violationCategory ?? null, expectedViolation);
    assert.equal(JSON.stringify(diagnostics).includes(content), false);
  }
});

test('active Section 7 diagnostics distinguish no forward support from omitted available support', async () => {
  const forwardEvidence = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Upcoming Federal Reserve decision',
    canonicalUrl: 'https://finance.yahoo.com/news/upcoming-fed-decision.html',
    publishedAt: '2026-09-08T14:00:00.000Z', publisher: 'Yahoo Finance', symbols: []
  });
  for (const [subsequentDevelopments, additionalItems, expectedRefs] of [
    [[], [], []],
    [['e3'], [forwardEvidence], ['e3']]
  ]) {
    const input = activeUsInput({subsequentDevelopments, additionalItems});
    const output = normalOutput(input);
    output.status = 'DEGRADED';
    output.sections[6] = {...output.sections[6], content: null, evidenceRefs: [],
      telemetryRefs: [], uncertainties: ['No supported next development was generated.']};
    output.evidenceGaps = ['No supported next development was generated.'];
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
    const section7 = diagnostics.find(value => value.stage === 'claudeAnalysisPreNormalization'
      && value.sectionIndex === 6);
    assert.equal(section7.rawContentIsNull, true);
    assert.equal(section7.eligibleForwardLookingEvidenceCount, expectedRefs.length);
    assert.deepEqual(section7.eligibleForwardLookingEvidenceRefs, expectedRefs);
    assert.equal(section7.citedEligibleForwardLookingRefCount, 0);
    assert.equal(section7.upcomingEventCount, 0);
    assert.equal(section7.unresolvedDevelopmentCount, expectedRefs.length);
  }
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
    'Section slot s8 FURTHER READINGS must be exactly {}',
    'MarketBrief resolves and renders Further Readings separately',
    'MarketBrief derives top-level Further Readings and evidenceReferences from the validated sections'
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
  // Step 8U.9: the line now matches Step 8R.A (linked stock telemetry is allowed) instead of
  // forbidding all stock telemetry.
  assert.match(request.system,
    /Stock telemetry is allowed only for a company that is a COMPANY subject of a cited broadMarketFocus entry\. Cite no other telemetry ref in Section 3\./);
  assert.equal(request.system.includes('This prohibition applies even when'), false);
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
    'broad-market leadership and laggards, notable individual movers, closing-session breadth, money moving between sectors',
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
    'except as the Section 3 telemetry allowlist below permits',
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
    'whether investors are broadly willing to take risk',
    'whether recent moves are continuing or pausing',
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

test('Step 8J citation fix: Section 2 and 3 citation instructions and no causal-pattern style example', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    "including plain wording such as 'rose on', 'because' or 'so', its evidenceRefs must include at least one evidenceContext.principalCatalysts reference",
    'When evidenceContext.principalCatalysts is not empty, Section 2 must cite at least one of them.',
    'Never add a recap, session, index or weekly-summary reference to Section 3; put index and weekly moves in Sections 1 or 5 and keep Section 3 to the focus companies and sectors'
  ]) assert.equal(system.includes(requirement), true, requirement);
  assert.equal(system.includes('Style example only — do not reuse its wording or facts; the placeholders in brackets are not data'), true);
  assert.equal(system.includes('Stocks rose on'), false);
});

const STYLE_HEADING = 'FINAL STYLE CHECK — apply to every section before you finish.';
const STYLE_LAST_LINE = 'Before finishing each section, reread it: split any sentence over 25 words into two, and replace any banned word with the plain fact.';
const DYNAMIC_MARKER = ' Request-specific Section 3 telemetry allowlist';

test('Step 8J readability round: FINAL STYLE CHECK sits after the citation rules and before the dynamic allowlists', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  assert.equal(system.split(STYLE_HEADING).length, 2);
  const at = system.indexOf(STYLE_HEADING);
  const staticPrompt = system.split(DYNAMIC_MARKER)[0];
  assert.equal(staticPrompt.endsWith(STYLE_LAST_LINE), true);
  assert.equal(at < system.indexOf(DYNAMIC_MARKER), true);
  assert.equal(at < system.indexOf('Request-specific Section 4 reference allowlist'), true);
  for (const citation of [
    'When evidenceContext.principalCatalysts is not empty, Section 2 must cite at least one of them.',
    'Never add a recap, session, index or weekly-summary reference to Section 3',
    'Hard output constraint for Sections 6-7',
    'Section slot s8 FURTHER READINGS must be exactly {}',
    'MarketBrief derives top-level Further Readings and evidenceReferences from the validated sections'
  ]) {
    assert.equal(system.indexOf(citation) >= 0 && system.indexOf(citation) < at, true, citation);
  }
  // Moved sentences appear exactly once (nothing left behind at the old position).
  for (const once of [
    'Write in plain English that a retail investor with no finance training can follow',
    'Never use these words or phrases: tailwind',
    'Hedging words are allowed, but state uncertainty once',
    'Keep every sentence under 25 words and give each sentence one idea',
    'Style example only'
  ]) assert.equal(system.split(once).length, 2, once);
});

test('Step 8J readability round: the worked style example cannot trigger the causal-claim validator', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  const match = system.match(/the placeholders in brackets are not data: "([^"]+)"/);
  assert.notEqual(match, null);
  const example = match[1];
  assert.equal(hasDirectMarketCausalClaim(example), false);
  for (const sentence of example.split(/(?<=.) /)) {
    assert.equal(hasDirectMarketCausalClaim(sentence), false, sentence);
  }
  for (const sentence of example.split(/(?<=.) /)) {
    assert.equal(sentence.split(/s+/).length < 25, true, sentence);
  }
});

test('gives Claude plain-language and locked movement presentation instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Write in plain English that a retail investor with no finance training can follow',
    'Use short sentences and everyday words',
    'using plain links such as "so" where a cited principal catalyst supports the link',
    'Keep every sentence under 25 words and give each sentence one idea',
    'Do not join two ideas with "while", "as", "with" or a semicolon',
    'Never use these words or phrases: tailwind, headwind, durable, resilience, resilient, bifurcated, cohort, wall of worry, validates, validated, underpinned, cascaded, narrative, renaissance, sustained investor appetite',
    'If a banned word feels needed, write the plain fact instead',
    'Keep every number and concrete detail: simplify the words, not the reasoning',
    'Do not use analyst phrases',
    'cyclical participants, asymmetric risk-reward',
    'If a technical or financial term is unavoidable, explain it in a few plain words',
    '[Company] fell $[amount] ([percent]%) to $[price].',
    '[Company] gained $[amount] ([percent]%) to $[price].',
    '[Index] fell by [points] points ([percent]%) to [level].',
    '[Index] gained [points] points ([percent]%) to [level].',
    'absolute movement first, percentage in brackets second, and resulting price or level last',
    'Do not omit absolute movement when the package supplies it',
    'Hedging words are allowed, but state uncertainty once, where it matters',
    'if [cited fact], then [consequence]',
    'Never stack hedges such as "could potentially" and never hedge a fact that is cited',
    'Do not write implementation-style labels such as "Uncertainty:" inside the prose',
    'continue to provide the structured uncertainties arrays separately'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
  // Step 8J: example facts must not be able to leak into briefs.
  for (const leak of ['Apple fell', 'Apple gained', '319.97', '328.21', '7,718.60', '7,747.71']) {
    assert.equal(system.includes(leak), false, leak);
  }
});

test('Step 8J: Section 6 forbids unsupported forward claims', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Do not make forward claims such as "years of runway", "tailwinds ahead", or "durable margin expansion"',
    'unless a cited source says so or the claim follows directly from cited facts'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('PRE, REGULAR and POST share safe wording normalization without changing citations', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z',
      '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z',
      '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z',
      '2026-09-08T20:30:00.000Z']
  ]) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const raw = normalOutput(input);
    raw.sections[4].content = 'Growth-oriented stocks gained.';
    const originalRefs = raw.sections[4].evidenceRefs.slice();
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
    });
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.sections[4].content,
      'Shares of companies expected to grow quickly gained.');
    assert.deepEqual(result.output.sections[4].evidenceRefs, originalRefs);
  }
});

test('active broken replacement prose localizes its section while preserving other analysis', async () => {
  const input = activeUsInput();
  const raw = normalOutput(input);
  raw.sections[4].content =
    'Defensive healthcare how investors are already invested in UNH has provided relative shelter.';
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.sections[4].content, null);
  assert.deepEqual(result.output.sections[4].evidenceRefs, []);
  assert.notEqual(result.output.sections[0].content, null);
});

const STYLE_ONLY_SENTENCE =
  'Fed commentary sounded hawkish, positioning stayed cautious and risk exposure was debated.';
const STYLE_ONLY_UNCERTAINTY = 'It is unclear whether hawkish commentary will persist.';
const MALFORMED_SPLICE =
  'Defensive healthcare how investors are already invested in UNH has provided relative shelter.';
const ACTIVE_STATES = [
  ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
  ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
  ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
];

function styledActiveOutput(input) {
  const output = normalOutput(input, {
    status: 'DEGRADED',
    evidenceGaps: ['Market exposure to later rate news remains unresolved.']
  });
  output.sections[5].content = 'Microsoft offers an opportunity if its raised outlook holds.';
  for (const index of [1, 2, 4, 5, 6]) {
    output.sections[index].content = `${output.sections[index].content} ${STYLE_ONLY_SENTENCE}`;
    output.sections[index].uncertainties = [STYLE_ONLY_UNCERTAINTY];
  }
  return output;
}

test('T1-T3 T8 T9 PRE, REGULAR and POST grounded sections survive style-only jargon with citations and Further Readings', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of ACTIVE_STATES) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const raw = styledActiveOutput(input);
    assert.equal(validateClaudeAnalysisOutput(raw, input).errors.some(error =>
      /plain-language/.test(error)), false, marketState);
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(result.output.status, 'DEGRADED');
    for (const index of [0, 1, 2, 4, 5, 6]) {
      assert.equal(result.output.sections[index].content, raw.sections[index].content,
        `${marketState} section ${index + 1}`);
      assert.deepEqual(result.output.sections[index].evidenceRefs, raw.sections[index].evidenceRefs);
      assert.deepEqual(result.output.sections[index].telemetryRefs, raw.sections[index].telemetryRefs);
      assert.deepEqual(result.output.sections[index].uncertainties, raw.sections[index].uncertainties);
    }
    assert.deepEqual(result.output.evidenceGaps, raw.evidenceGaps);
    assert.deepEqual(result.output.evidenceReferences, ['e1']);
    assert.deepEqual(result.output.furtherReadings, ['e1']);
    assert.deepEqual(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization'), [], marketState);
    const residue = diagnostics.filter(value => value.stage === 'plainLanguageStyleResidue');
    assert.equal(residue.length, 1, marketState);
    assert.deepEqual(residue[0].sections, [1, 2, 4, 5, 6].map(sectionIndex => ({
      sectionIndex, contentMatchCount: 3, uncertaintyMatchCount: 1
    })));
    assert.equal(residue[0].evidenceGapMatchCount, 1);
    assert.equal(/hawkish|positioning|exposure/i.test(JSON.stringify(residue)), false);
  }
});

test('T5 active malformed prose in content or uncertainties localizes only its section', async () => {
  const input = activeUsInput();
  for (const mutate of [
    output => { output.sections[5].content = MALFORMED_SPLICE; },
    output => { output.sections[5].uncertainties = [MALFORMED_SPLICE]; }
  ]) {
    const raw = normalOutput(input);
    mutate(raw);
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections[5].content, null);
    assert.deepEqual(result.output.sections[5].evidenceRefs, []);
    assert.equal(JSON.stringify(result.output).includes('how investors are already invested'), false);
    for (const index of [0, 1, 2, 4, 6]) {
      assert.notEqual(result.output.sections[index].content, null, `section ${index + 1}`);
    }
    const event = diagnostics.find(value => value.stage === 'claudeAnalysisSectionNormalization'
      && value.sectionIndex === 5);
    assert.deepEqual(event.validationViolationCategories, ['PLAIN_LANGUAGE_VALIDATION']);
  }
});

const INTERNAL_IDENTIFIER_LEAK_TEXT =
  'Supported risks remain material. It cites evidenceContext.broadMarketFocus directly.';

test('Step 8M: active internal-identifier leak in content or uncertainties localizes only its section', async () => {
  const input = activeUsInput();
  for (const mutate of [
    output => { output.sections[5].content = INTERNAL_IDENTIFIER_LEAK_TEXT; },
    output => { output.sections[5].uncertainties = [INTERNAL_IDENTIFIER_LEAK_TEXT]; }
  ]) {
    const raw = normalOutput(input);
    mutate(raw);
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'DEGRADED');
    assert.equal(result.output.sections[5].content, null);
    assert.deepEqual(result.output.sections[5].evidenceRefs, []);
    assert.equal(JSON.stringify(result.output).includes('evidenceContext'), false);
    for (const index of [0, 1, 2, 4, 6]) {
      assert.notEqual(result.output.sections[index].content, null, `section ${index + 1}`);
    }
    const event = diagnostics.find(value => value.stage === 'claudeAnalysisSectionNormalization'
      && value.sectionIndex === 5);
    assert.deepEqual(event.validationViolationCategories, ['INTERNAL_IDENTIFIER_LEAK']);
  }
});

test('T6 ungrounded Section 6 opportunity is still detected when style words are present; Step 8U.6 removes only that sentence', async () => {
  const input = activeUsInput();
  const raw = styledActiveOutput(input);
  raw.sections[5].content = `Apple offers an opportunity. ${STYLE_ONLY_SENTENCE}`;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  // Step 8U.6: the ungrounded opportunity sentence is removed; the style-only risk sentence stays.
  assert.equal(result.output.sections[5].content, STYLE_ONLY_SENTENCE);
  assert.deepEqual(result.output.sections[5].evidenceRefs, raw.sections[5].evidenceRefs);
  assert.equal(result.output.evidenceGaps.includes(
    'Not enough data to point out a clear opportunity.'), false);
  const normalizationEvents = diagnostics.filter(value =>
    value.stage === 'claudeAnalysisSectionNormalization');
  assert.deepEqual(normalizationEvents.map(value =>
    [value.sectionIndex, value.violationCategory, value.action]),
  [[5, 'UNGROUNDED_OPPORTUNITY_SUBJECT', 'TRIMMED']]);
  for (const index of [1, 2, 4, 6]) {
    assert.equal(result.output.sections[index].content, raw.sections[index].content);
  }
});

test('T7 Section 4 uses the same style policy: style survives, malformed prose localizes', async () => {
  const input = structuredClone(activeUsInput());
  input.portfolioContext.myStocks = [{
    market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'], upcomingEvents: []
  }];
  for (const [content, survives] of [
    [`Microsoft raised its outlook. ${STYLE_ONLY_SENTENCE}`, true],
    [MALFORMED_SPLICE, false]
  ]) {
    const raw = normalOutput(input);
    raw.sections[3] = {...raw.sections[3], content, evidenceRefs: ['e1'], telemetryRefs: []};
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw)
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    if (survives) {
      assert.equal(result.output.sections[3].content, content);
      assert.deepEqual(result.output.sections[3].evidenceRefs, ['e1']);
    } else {
      assert.equal(result.output.sections[3].content, null);
      assert.deepEqual(result.output.sections[3].evidenceRefs, []);
      assert.notEqual(result.output.sections[1].content, null);
    }
  }
});

test('provider schema uses compact named string fields without nested section arrays or report section grammar', () => {
  const sectionPayload = {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'evidenceRefs', 'telemetryRefs', 'uncertainties'],
    properties: {
      content: {type: ['string', 'null']},
      evidenceRefs: {type: 'string'}, telemetryRefs: {type: 'string'}, uncertainties: {type: 'string'}
    }
  };
  assert.deepEqual(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA, {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'evidenceGaps', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
    properties: {
      status: {type: 'string'},
      evidenceGaps: {type: 'array'},
      s1: sectionPayload, s2: sectionPayload, s3: sectionPayload, s4: sectionPayload,
      s5: sectionPayload, s6: sectionPayload, s7: sectionPayload,
      s8: {type: 'object', additionalProperties: false, properties: {}}
    }
  });
  assert.equal(JSON.stringify(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA).includes('reportJson'), false);
  assert.ok(
    Buffer.byteLength(JSON.stringify(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA), 'utf8') < 3000,
    'provider direct transport schema should remain compact'
  );
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.minItems, 8);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.maxItems, 8);
});

test('every provider schema object explicitly rejects additional properties', () => {
  const visit = (node, path = 'schema') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, path);
    }
    Object.entries(node).forEach(([key, child]) => visit(child, `${path}.${key}`));
  };
  visit(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA);
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

  const message = 'Not enough data to write the KEY RISKS & OPPORTUNITIES section.';
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
    'Not enough data to point to a main market driver.',
    'Not enough data to point out specific stocks or sectors.'
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
    uncertainties: ['Not enough data to point out specific stocks or sectors.']
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
  const missing = providerTransport(normalOutput(canonicalInput()));
  delete missing.s1.evidenceRefs;
  const extra = providerTransport(normalOutput(canonicalInput()));
  extra.s1.evidenceRefs = 'e1|e2';
  const invalid = providerTransport(normalOutput(canonicalInput()));
  invalid.s1.evidenceRefs = [];

  for (const output of [missing, extra, invalid]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(), apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true, status: 200,
        async json() { return {content: [{type: 'text', text: JSON.stringify(output)}]}; }
      })
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

  for (const output of [missing]) {
    const invalid = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(invalid.type, 'CONTRACT_FAILURE');
  }
});

test('reconstructs a complete direct transport and preserves the canonical Section 8 placeholder', async () => {
  const input = canonicalInput();
  const raw = normalOutput(input);
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

test('parses zero, one, and multiple delimiter-encoded compact section fields deterministically', async () => {
  const input = canonicalInput({includeSecondEvidence: true});
  const output = normalOutput(input, {
    status: 'DEGRADED', evidenceGaps: ['Section 6 has no supported opportunity.']
  });
  output.sections[0].evidenceRefs = ['e1', 'e2'];
  output.sections[0].telemetryRefs = ['t1'];
  output.sections[0].uncertainties = ['First uncertainty.', 'Second uncertainty.'];
  output.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No grounded opportunity is available.']
  };
  const raw = providerTransport(output);
  assert.equal(raw.s1.evidenceRefs, 'e1|e2');
  assert.equal(raw.s1.telemetryRefs, 't1');
  assert.equal(raw.s6.evidenceRefs, '');
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => ({
      ok: true, status: 200,
      async json() { return {content: [{type: 'text', text: JSON.stringify(raw)}]}; }
    })
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.sections[0].content !== null, true);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e1', 'e2']);
  assert.deepEqual(result.output.sections[0].telemetryRefs, ['t1']);
  assert.deepEqual(result.output.sections[0].uncertainties, ['First uncertainty.', 'Second uncertainty.']);
  assert.equal(result.output.sections[5].content, null);
  assert.deepEqual(result.output.sections[5].evidenceRefs, []);
});

test('rejects malformed or unknown delimiter-encoded compact references without repair', async () => {
  const input = canonicalInput();
  const malformed = providerTransport(normalOutput(input));
  malformed.s1.evidenceRefs = 'e1||e2';
  const unknown = providerTransport(normalOutput(input));
  unknown.s1.evidenceRefs = 'e1|e999';
  for (const raw of [malformed, unknown]) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => ({
        ok: true, status: 200,
        async json() { return {content: [{type: 'text', text: JSON.stringify(raw)}]}; }
      })
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('hard-fails malformed direct transport and preserves internal structural and value validation', async () => {
  const input = canonicalInput();
  const missingSection = normalOutput(input);
  missingSection.sections.pop();
  const missingSlot = providerTransport(normalOutput(input));
  delete missingSlot.s1;
  const unknownTopLevel = providerTransport(normalOutput(input));
  unknownTopLevel.unrelated = true;
  const malformedSlot = providerTransport(normalOutput(input));
  malformedSlot.s2 = {content: 'Malformed'};
  const wrongValueType = providerTransport(normalOutput(input));
  wrongValueType.s2.evidenceRefs = [];
  const cases = [
    {raw: providerTransport(missingSection)},
    {raw: wrongValueType},
    {raw: missingSlot},
    {raw: unknownTopLevel},
    {raw: malformedSlot}
  ];
  for (const {raw} of cases) {
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return {content: [{type: 'text', text: JSON.stringify(raw)}]}; }
      }),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
    const event = diagnostics.find(value => value.stage === 'claudeAnalysisStructureNormalization');
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes('Supported analysis.'), false);
  }
});

test('logs sanitized malformed compact section slot diagnostics without changing validation', async () => {
  const input = canonicalInput();
  const cases = [
    {mutate: raw => { raw.s1 = {content: 'content'}; }, suppliedFieldCount: 1,
      fieldTypes: {content: 'STRING', evidenceRefs: 'MISSING', telemetryRefs: 'MISSING', uncertainties: 'MISSING'}},
    {mutate: raw => { raw.s1.content = []; },
      fieldTypes: {content: 'ARRAY', evidenceRefs: 'STRING', telemetryRefs: 'STRING', uncertainties: 'STRING'}},
    {mutate: raw => { raw.s1.evidenceRefs = []; },
      fieldTypes: {content: 'STRING', evidenceRefs: 'ARRAY', telemetryRefs: 'STRING', uncertainties: 'STRING'}},
    {mutate: raw => { raw.s1.telemetryRefs = []; },
      fieldTypes: {content: 'STRING', evidenceRefs: 'STRING', telemetryRefs: 'ARRAY', uncertainties: 'STRING'}},
    {mutate: raw => { raw.s1.uncertainties = []; },
      fieldTypes: {content: 'STRING', evidenceRefs: 'STRING', telemetryRefs: 'STRING', uncertainties: 'ARRAY'}}
  ];
  for (const testCase of cases) {
    const raw = providerTransport(normalOutput(input));
    testCase.mutate(raw);
    const diagnostics = [];
    const result = await invokeClaudeAnalysis({
      input,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return {content: [{type: 'text', text: JSON.stringify(raw)}]}; }
      }),
      onDiagnostics: value => diagnostics.push(value)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
    const event = diagnostics.find(value => value.stage === 'claudeAnalysisMalformedSectionSlot');
    assert.ok(event);
    assert.equal(event.sectionSlot, 's1');
    assert.equal(event.isObject, true);
    if (Object.prototype.hasOwnProperty.call(testCase, 'suppliedFieldCount')) assert.equal(event.suppliedFieldCount, testCase.suppliedFieldCount);
    assert.deepEqual(event.fieldTypes, testCase.fieldTypes);
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes('Supported analysis.'), false);
    assert.equal(serialized.includes('uncertainty'), false);
  }
});

test('valid compact section slots emit no malformed-slot diagnostic', async () => {
  const input = canonicalInput();
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(normalOutput(input)),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(diagnostics.some(value => value.stage === 'claudeAnalysisMalformedSectionSlot'), false);
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

test('rejects unknown references that survive the direct transport', async () => {
  const input = canonicalInput();
  const outputs = [
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

// ---------------------------------------------------------------------------
// Step 9F.1f (temporary until Step 9F.2): writer article budget. Over the writer
// cap, Yahoo news texts are trimmed longest first to a 4 KB floor; nothing is
// dropped and no other source is trimmed.
// ---------------------------------------------------------------------------

function step9F1fText(seed, bytes) {
  let text = seed;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += ' Markets weighed rates and earnings.';
  return text.slice(0, bytes).trim();
}

function step9F1fWriterInput({yahooBytes, fillerBytes, focusSubjectAt = null}) {
  const yahoo = yahooBytes.map((bytes, index) => createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: `Yahoo budget story ${index + 1}`,
    summary: index === 0 && focusSubjectAt !== null
      ? `${step9F1fText('Opening text.', focusSubjectAt)} Nvidia shares rose. ${step9F1fText('Closing text.', bytes - focusSubjectAt - 21)}`
      : step9F1fText(`Story ${index + 1} text.`, bytes),
    canonicalUrl: `https://finance.yahoo.com/news/yahoo-budget-story-${index + 1}.html`,
    publishedAt: `2026-09-08T14:${String(20 + index).padStart(2, '0')}:00.000Z`,
    symbols: [], publisher: 'Yahoo Finance'
  }));
  const filler = createEvidenceItem({
    sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
    title: 'Reuters filler story', summary: step9F1fText('Reuters filler.', fillerBytes),
    canonicalUrl: 'https://www.reuters.com/markets/us/filler-story',
    publishedAt: '2026-09-04T18:00:00.000Z', symbols: []
  });
  return activeUsInput({
    additionalItems: [...yahoo, filler],
    ...(focusSubjectAt !== null ? {
      materialEvents: ['e1', 'e2', 'e3'],
      broadMarketFocus: [
        {evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
        {evidenceRef: 'e3', subjects: [{kind: 'COMPANY', name: 'Nvidia'}]}
      ]
    } : {})
  });
}

function step9F1fRequestBytes(input) {
  return Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input)), 'utf8');
}

function step9F1fItems(input) {
  return new Map(input.marketPackages[0].evidenceContext.evidence
    .map(entry => [entry.reference, entry.item]));
}

function step9F1fOverCapInput(options, overBy) {
  const probe = step9F1fWriterInput({...options, fillerBytes: 100});
  const fillerBytes = CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES - step9F1fRequestBytes(probe) + overBy;
  const input = step9F1fWriterInput({...options, fillerBytes});
  assert.ok(step9F1fRequestBytes(input) > CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES);
  return input;
}

test('Step 9F.1f writer budget: under the cap the input is returned unchanged with no event', () => {
  const input = step9F1fWriterInput({yahooBytes: [16384, 8000], fillerBytes: 1000});
  const diagnostics = [];
  assert.equal(fitWriterArticleBudget(input, value => diagnostics.push(value)), input);
  assert.deepEqual(diagnostics, []);
});

test('Step 9F.1f writer budget: trims Yahoo articles longest first, keeps every article, floor 4 KB, other sources untouched', () => {
  const input = step9F1fOverCapInput({yahooBytes: [16384, 12000, 9000, 6000, 3000, 2000]}, 15000);
  const diagnostics = [];
  const fitted = fitWriterArticleBudget(input, value => diagnostics.push(value));
  assert.ok(step9F1fRequestBytes(fitted) <= CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES);
  const before = step9F1fItems(input);
  const after = step9F1fItems(fitted);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  const trimmedRefs = [];
  for (const [reference, item] of before) {
    const now = after.get(reference);
    assert.equal(item.summary.startsWith(now.summary), true, reference);
    if (item.sourceId !== 'us.yahoo-finance') assert.equal(now.summary, item.summary, reference);
    if (now.summary !== item.summary) {
      trimmedRefs.push(reference);
      assert.ok(Buffer.byteLength(now.summary, 'utf8') >= 4096, reference);
    }
  }
  // Longest first: the three longest Yahoo stories are cut, the rest kept whole.
  assert.deepEqual(trimmedRefs, ['e3', 'e4', 'e5']);
  const event = diagnostics.find(value => value.stage === 'writerArticleBudget');
  assert.equal(event.outcome, 'TRIMMED');
  assert.equal(event.yahooArticleCount, 7);
  assert.equal(event.trimmedArticleCount, 3);
  assert.deepEqual(event.trimmed.map(entry => entry.evidenceRef), ['e3', 'e4', 'e5']);
  for (const entry of event.trimmed) {
    assert.equal(entry.fromBytes, Buffer.byteLength(before.get(entry.evidenceRef).summary, 'utf8'));
    assert.equal(entry.toBytes, Buffer.byteLength(after.get(entry.evidenceRef).summary, 'utf8'));
  }
  const lengths = event.trimmed.map(entry => entry.toBytes);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 2);
  assert.ok(Math.min(...lengths) >= 6000 - 2);
  assert.equal(event.requestBytesAfter, step9F1fRequestBytes(fitted));
  assert.equal(JSON.stringify(event).includes('Markets weighed'), false);
});

test('Step 9F.1f writer budget: an article is never cut before the focus subject it grounds', () => {
  const input = step9F1fOverCapInput({yahooBytes: [16384, 16384, 16384], focusSubjectAt: 10000}, 30000);
  const fitted = fitWriterArticleBudget(input, () => {});
  assert.ok(step9F1fRequestBytes(fitted) <= CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES);
  const focused = step9F1fItems(fitted).get('e3').summary;
  assert.equal(focused.includes('Nvidia'), true);
  assert.ok(Buffer.byteLength(focused, 'utf8') < 16384);
  assert.ok(Buffer.byteLength(step9F1fItems(fitted).get('e4').summary, 'utf8')
    < Buffer.byteLength(focused, 'utf8'));
  assert.equal(validateClaudeAnalysisInput(fitted), true);
});

test('Step 9F.1f writer budget: when even the 4 KB floor does not fit it is flagged and the writer is not called', async () => {
  const input = step9F1fOverCapInput({yahooBytes: [16384, 9000, 3000]}, 40000);
  const diagnostics = [];
  let fetches = 0;
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => { fetches++; }
  });
  assert.equal(result.type, 'REQUEST_TOO_LARGE');
  assert.equal(fetches, 0);
  const event = diagnostics.find(value => value.stage === 'writerArticleBudget');
  assert.equal(event.outcome, 'DOES_NOT_FIT_AT_FLOOR');
  assert.deepEqual(event.trimmed.map(entry => entry.evidenceRef), ['e3', 'e4']);
  for (const entry of event.trimmed) assert.ok(entry.toBytes <= 4096 && entry.toBytes >= 4094);
  assert.ok(event.requestBytesAfter > CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES);
  assert.equal(diagnostics.some(value => value.providerInvocationSkipped === true), true);
});

test('Step 9F.1f writer budget: an over-cap request is sent trimmed, under the cap', async () => {
  const input = step9F1fOverCapInput({yahooBytes: [16384, 12000, 9000]}, 10000);
  let sentBytes = null;
  await invokeClaudeAnalysis({
    input, apiKey: 'test-key', onDiagnostics: () => {},
    fetchImpl: async (url, options) => {
      sentBytes = Buffer.byteLength(options.body, 'utf8');
      throw new Error('stop after capture');
    }
  });
  assert.ok(sentBytes !== null);
  assert.ok(sentBytes <= CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES);
});

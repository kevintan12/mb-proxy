const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput
} = require('../lib/claude-analysis-contract');
const {
  buildClaudeAnalysisRequest,
  invokeClaudeAnalysis
} = require('../lib/claude-analysis-invocation');
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');
const {
  createRuntimeFiveSessionSnapshotRepository
} = require('../lib/runtime-five-session-snapshot-repository');
const {
  fiveSessionSnapshot,
  richCompletedUsWeekInput,
  thinDegradedFiveSessionInput,
  supportedOutput
} = require('./fixtures/us-market-brief-quality');

function finalResponse(output) {
  return {
    ok: true,
    status: 200,
    async json() { return {content: [{type: 'text', text: JSON.stringify(output)}]}; }
  };
}

async function invokeFixture(input, output, diagnostics = []) {
  return invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => finalResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  });
}

function overlappingFocusInput() {
  const input = structuredClone(richCompletedUsWeekInput({
    stockInstrumentName: 'Microsoft', includeFollowedFocus: true
  }));
  const market = input.marketPackages[0];
  const benchmarkDefinitions = [
    ['^GSPC', 'S&P 500'],
    ['^DJI', 'Dow Jones Industrial Average'],
    ['^IXIC', 'Nasdaq Composite'],
    ['^RUT', 'Russell 2000']
  ];
  market.telemetry.benchmarkSnapshots = benchmarkDefinitions.map(([symbol, instrumentName], index) => ({
    reference: `t${index + 1}`,
    snapshot: fiveSessionSnapshot(symbol, 'INDEX', instrumentName)
  }));
  market.telemetry.stockSnapshots = [
    ['MSFT', 'Microsoft'],
    ['NVDA', 'Nvidia'],
    ['AAPL', 'Apple']
  ].map(([symbol, instrumentName], index) => ({
    reference: `t${index + 5}`,
    snapshot: fiveSessionSnapshot(symbol, 'EQUITY', instrumentName)
  }));
  const followedEvidence = market.evidenceContext.evidence.find(entry => entry.reference === 'e2').item;
  followedEvidence.title = 'Microsoft, Nvidia and Apple are broad-market companies in focus';
  followedEvidence.summary =
    'Microsoft, Nvidia and Apple supply bounded broad-market company context.';
  market.evidenceContext.broadMarketFocus.find(entry => entry.evidenceRef === 'e2').subjects = [
    {kind: 'COMPANY', name: 'Microsoft'},
    {kind: 'COMPANY', name: 'Nvidia'},
    {kind: 'COMPANY', name: 'Apple'}
  ];
  input.portfolioContext.myStocks = [
    {market: 'US', symbol: 'MSFT', telemetryRefs: ['t5'], evidenceRefs: ['e2'], upcomingEvents: []},
    {market: 'US', symbol: 'NVDA', telemetryRefs: ['t6'], evidenceRefs: [], upcomingEvents: []}
  ];
  input.portfolioContext.watchlist = [
    {market: 'US', symbol: 'AAPL', telemetryRefs: ['t7'], evidenceRefs: [], upcomingEvents: []}
  ];
  assert.equal(validateClaudeAnalysisInput(input), true);
  return input;
}

function overlappingFocusOutput(input, {content, telemetryRefs}) {
  const output = supportedOutput(input);
  output.sections[2] = {
    name: 'STOCKS & SECTORS IN FOCUS',
    content,
    evidenceRefs: ['e2'],
    telemetryRefs,
    uncertainties: []
  };
  output.sections[3].telemetryRefs = ['t5'];
  return output;
}

test('rich fixture carries one canonical five-session week into the final input', () => {
  const input = richCompletedUsWeekInput();
  const market = input.marketPackages[0];
  assert.equal(validateClaudeAnalysisInput(input), true);
  assert.equal(market.telemetry.benchmarkSnapshots[0].snapshot.completedSessions.length, 5);
  assert.equal(market.telemetry.stockSnapshots[0].snapshot.completedSessions.length, 5);
  assert.deepEqual(market.evidenceContext.sessionAssociations, [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(market.evidenceContext.evidence.slice(-2).map(entry => ({
    reference: entry.reference,
    title: entry.item.title,
    symbols: entry.item.symbols
  })), [
    {
      reference: 'e4',
      title: 'Broadcom leads semiconductor shares after a major company development',
      symbols: []
    },
    {
      reference: 'e5',
      title: 'Health-care shares advance on constructive industry developments',
      symbols: []
    }
  ]);
  assert.deepEqual(market.evidenceContext.furtherReadings.map(item => item.evidenceRef),
    ['e1', 'e2', 'e4', 'e5']);
});

test('five-session fixture survives persistence readback without truncation', async () => {
  const snapshot = fiveSessionSnapshot('^GSPC');
  const calls = [];
  const persisted = await createRuntimeFiveSessionSnapshotRepository({
    repository: {
      async upsertSnapshot(value) {
        calls.push(value);
        return value.sessions;
      }
    }
  }).persistSnapshot(snapshot);
  assert.deepEqual(calls[0].sessions.map(item => item.sessionDate),
    snapshot.completedSessions.map(item => item.sessionDate));
  assert.equal(persisted.completedSessions.length, 5);
  assert.equal(persisted.completeness, 'COMPLETE');
});

test('thin fixture remains canonical and supports deterministic degraded output', () => {
  const input = thinDegradedFiveSessionInput();
  assert.equal(validateClaudeAnalysisInput(input), true);
  const output = supportedOutput(input, {opportunity: false});
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  assert.match(output.sections[5].content, /risk/i);
  assert.doesNotMatch(output.sections[5].content, /opportunity/i);
  assert.deepEqual(output.sections[5].evidenceRefs, ['e3']);
  assert.deepEqual(output.sections[2], {
    name: 'STOCKS & SECTORS IN FOCUS',
    content: null,
    evidenceRefs: [],
    telemetryRefs: [],
    uncertainties: ['Validated broad-market company or sector evidence was unavailable.']
  });
  assert.deepEqual(output.evidenceGaps, [
    'Validated broad-market company or sector evidence was unavailable.'
  ]);
});

test('post-close and portfolio overlap fixtures retain separate temporal and list boundaries', () => {
  const input = richCompletedUsWeekInput();
  const market = input.marketPackages[0];
  assert.deepEqual(market.evidenceContext.subsequentDevelopments, ['e1']);
  assert.deepEqual(market.evidenceContext.sessionAssociations, [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(input.portfolioContext.myStocks[0].evidenceRefs, ['e2']);
  assert.deepEqual(input.portfolioContext.watchlist[0].evidenceRefs, []);
});

test('combined supported risk and opportunity pass the complete validator', () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  assert.deepEqual(output.sections[2].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(output.sections[2].telemetryRefs, ['t1']);
  assert.deepEqual(output.sections[3].evidenceRefs, ['e2']);
  assert.deepEqual(output.sections[3].telemetryRefs, ['t2']);
  assert.deepEqual(output.sections[5].evidenceRefs, ['e3', 'e5']);
  assert.match(output.sections[5].content, /why|support|Constructive/i);
  assert.doesNotMatch(output.sections[5].content, /guarantee|certain return/i);
});

test('Section 6 keeps risk-only output while localizing unsupported or generic opportunities', async () => {
  const input = JSON.parse(JSON.stringify(richCompletedUsWeekInput()));
  const focusEvidence = input.marketPackages[0].evidenceContext.evidence.find(entry =>
    entry.reference === 'e5').item;
  focusEvidence.title =
    'DuPont, Eaton, GE Vernova, Broadcom and Palo Alto Networks show constructive company developments';
  focusEvidence.summary =
    'DuPont, Eaton, GE Vernova, Broadcom and Palo Alto Networks supplied bounded constructive evidence.';
  input.marketPackages[0].evidenceContext.broadMarketFocus.find(entry =>
    entry.evidenceRef === 'e5').subjects = [
    {kind: 'COMPANY', name: 'DuPont'},
    {kind: 'COMPANY', name: 'Eaton'},
    {kind: 'COMPANY', name: 'GE Vernova'},
    {kind: 'COMPANY', name: 'Broadcom'},
    {kind: 'COMPANY', name: 'Palo Alto Networks'}
  ];
  assert.equal(validateClaudeAnalysisInput(input), true);
  const risksOnly = supportedOutput(input, {opportunity: false});
  assert.equal(validateClaudeAnalysisOutput(risksOnly, input).valid, true);

  const opportunityOnly = supportedOutput(input);
  opportunityOnly.sections[5].content =
    'Constructive Eaton developments support a qualified company opportunity.';
  opportunityOnly.sections[5].evidenceRefs = ['e5'];
  assert.equal(validateClaudeAnalysisOutput(opportunityOnly, input).valid, true);

  for (const content of [
    'Constructive Eaton evidence supports a qualified buy-the-dip opportunity.',
    'Policy uncertainty is a risk, while Broadcom evidence supports a qualified rebound opportunity.'
  ]) {
    const supportedGenericWording = supportedOutput(input);
    supportedGenericWording.sections[5].content = content;
    supportedGenericWording.sections[5].evidenceRefs = content.includes('Broadcom') ? ['e3', 'e5'] : ['e5'];
    assert.equal(validateClaudeAnalysisOutput(supportedGenericWording, input).valid, true, content);
    const result = await invokeFixture(input, supportedGenericWording);
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'NORMAL');
    assert.equal(result.output.sections[5].content, content);
  }

  for (const [content, expectedCategory, expectedSubtype] of [
    ['Policy uncertainty is a risk, while an unrelated company rally is a constructive opportunity.',
      'UNSUPPORTED_OPPORTUNITY_CLAIM'],
    ['Policy uncertainty is a risk, while an oversold rebound creates a buy-the-dip opportunity.',
      'GENERIC_OPPORTUNITY_CLAIM', 'MISSING_FOCUS_CITATION'],
    ['Policy uncertainty is a risk, while a supported issuer has a qualified rebound opportunity.',
      'GENERIC_OPPORTUNITY_CLAIM', 'MISSING_GROUNDED_SUBJECT'],
    ['Policy uncertainty is a risk, while ETN has a qualified rebound opportunity.',
      'GENERIC_OPPORTUNITY_CLAIM', 'MISSING_GROUNDED_SUBJECT']
  ]) {
    const output = supportedOutput(input);
    output.sections[5].content = content;
    output.sections[5].evidenceRefs = content.includes('supported issuer')
      || content.includes('ETN') ? ['e5'] : ['e3'];
    assert.equal(validateClaudeAnalysisOutput(output, input).valid, false);
    const diagnostics = [];
    const result = await invokeFixture(input, output, diagnostics);
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, 'DEGRADED');
    assert.deepEqual(result.output.sections[5], {
      name: 'KEY RISKS & OPPORTUNITIES', content: null,
      evidenceRefs: [], telemetryRefs: [],
      uncertainties: [
        'Constructive opportunity support could not be validated from the generated citation set.'
      ]
    });
    assert.deepEqual(diagnostics.filter(value =>
      value.stage === 'claudeAnalysisSectionNormalization'), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 5,
      violationCategory: expectedCategory, suppliedReferenceCount: 1,
      ...(expectedSubtype ? {violationSubtype: expectedSubtype} : {}),
      allowedReferenceCount: 2, offendingReferenceCount: 1
    }]);
    assert.equal(JSON.stringify(diagnostics).includes(content), false);
  }
});

test('rich and thin fixtures survive the complete final invocation boundary without network access', async () => {
  for (const [input, output, expectedStatus] of [
    [richCompletedUsWeekInput(), supportedOutput(richCompletedUsWeekInput()), 'NORMAL'],
    [thinDegradedFiveSessionInput(), supportedOutput(thinDegradedFiveSessionInput(), {
      opportunity: false
    }), 'DEGRADED']
  ]) {
    const request = buildClaudeAnalysisRequest(input);
    const serializedInput = JSON.parse(request.messages[0].content);
    assert.deepEqual(serializedInput, projectClaudeAnalysisInput(input));
    assert.deepEqual(
      serializedInput.marketPackages[0].evidenceContext.furtherReadings,
      input.marketPackages[0].evidenceContext.furtherReadings
    );
    const projectedYahoo = serializedInput.marketPackages[0].evidenceContext.evidence.find(
      entry => entry.item.sourceId === 'us.yahoo-finance'
    );
    assert.equal(projectedYahoo.item.provenance.publisher, 'Yahoo Finance');
    assert.equal(projectedYahoo.item.provenance.authority, 'secondary');
    const result = await invokeClaudeAnalysis({
      input,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: {get: () => null},
        async json() {
          return {content: [{type: 'text', text: JSON.stringify(output)}]};
        }
      })
    });
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.status, expectedStatus);
    assert.deepEqual(result.output.furtherReadings, output.furtherReadings);
  }
});

test('NORMAL cannot contain a null analytical section, while localized DEGRADED output remains valid', () => {
  const input = richCompletedUsWeekInput();
  for (const index of [2, 5]) {
    const normalWithNull = supportedOutput(input);
    normalWithNull.sections[index] = {
      name: normalWithNull.sections[index].name,
      content: null,
      evidenceRefs: [],
      telemetryRefs: [],
      uncertainties: []
    };
    assert.deepEqual(validateClaudeAnalysisOutput(normalWithNull, input).errors,
      ['NORMAL requires every analysis section']);
  }

  const degraded = supportedOutput(thinDegradedFiveSessionInput(), {opportunity: false});
  assert.equal(validateClaudeAnalysisOutput(degraded, thinDegradedFiveSessionInput()).valid, true);
});

test('an optional provider gap does not force DEGRADED when supported analytical coverage is complete', () => {
  const input = richCompletedUsWeekInput({
    unresolvedGaps: ['CNBC market-news research was unavailable at package assembly time.']
  });
  const output = supportedOutput(input);
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  assert.equal(output.status, 'NORMAL');
  assert.equal(output.sections.every((section, index) => index === 7 || section.content !== null), true);
});

test('Section 3 rejects a portfolio reference without independent broad-market focus', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[2].evidenceRefs = ['e2', 'e4', 'e5'];
  output.evidenceReferences = ['e2', 'e3', 'e4', 'e5', 'e1'];
  assert.equal(validateClaudeAnalysisOutput(output, input).errors.includes(
    'sections[2]: evidence references must belong to broad-market focus'), true);
  const originalFocus = input.marketPackages[0].evidenceContext.broadMarketFocus;
  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[2], {
    name: 'STOCKS & SECTORS IN FOCUS', content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Broad-market company and sector support could not be validated from the generated Section 3 scope.']
  });
  assert.deepEqual(result.output.sections[3].evidenceRefs, ['e2']);
  assert.deepEqual(result.output.sections[3].telemetryRefs, ['t2']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.broadMarketFocus, originalFocus);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [{
    stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
    violationCategory: 'NON_FOCUS_EVIDENCE', suppliedReferenceCount: 3,
    allowedReferenceCount: 2, offendingReferenceCount: 1
  }]);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
});

test('Section 3 accepts focus evidence and benchmark telemetry but localizes stock telemetry', async () => {
  const input = richCompletedUsWeekInput();
  const valid = supportedOutput(input);
  assert.equal(validateClaudeAnalysisOutput(valid, input).valid, true);
  assert.deepEqual(valid.sections[2].telemetryRefs, ['t1']);
  const invalid = supportedOutput(input);
  invalid.sections[2].telemetryRefs = ['t1', 't2'];
  assert.equal(validateClaudeAnalysisOutput(invalid, input).errors.includes(
    'sections[2]: telemetry references must belong to benchmark telemetry'), true);
  const result = await invokeFixture(input, invalid);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.sections[2].content, null);
  assert.deepEqual(result.output.sections[2].telemetryRefs, []);
  assert.deepEqual(result.output.sections[3].telemetryRefs, ['t2']);
});

test('Section 3 overlap fixtures pass with benchmark-only telemetry and no stock telemetry', () => {
  const focusOnlyInput = richCompletedUsWeekInput();
  assert.equal(validateClaudeAnalysisOutput(supportedOutput(focusOnlyInput), focusOnlyInput).valid,
    true);

  const input = overlappingFocusInput();
  for (const [content, telemetryRefs] of [
    ['Microsoft remained a broad-market company in focus.', ['t1']],
    ['Apple remained a broad-market company in focus.', ['t2']],
    ['Microsoft, Nvidia and Apple were broad-market companies in focus.',
      ['t1', 't2', 't3', 't4']],
    ['Microsoft remained a broad-market company in focus.', []]
  ]) {
    const output = overlappingFocusOutput(input, {content, telemetryRefs});
    assert.equal(validateClaudeAnalysisOutput(output, input).valid, true, content);
  }
});

test('Production-shaped Section 3 overlap localizes mixed stock telemetry and preserves Section 4', async () => {
  const input = overlappingFocusInput();
  const output = overlappingFocusOutput(input, {
    content: 'Microsoft, Nvidia and Apple were broad-market companies in focus.',
    telemetryRefs: ['t1', 't2', 't5', 't6', 't7']
  });
  assert.equal(validateClaudeAnalysisOutput(output, input).errors.includes(
    'sections[2]: telemetry references must belong to benchmark telemetry'), true);
  const originalFocus = structuredClone(input.marketPackages[0].evidenceContext.broadMarketFocus);
  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[2], {
    name: 'STOCKS & SECTORS IN FOCUS', content: null,
    evidenceRefs: [], telemetryRefs: [],
    uncertainties: [
      'Broad-market company and sector support could not be validated from the generated Section 3 scope.'
    ]
  });
  assert.deepEqual(result.output.sections[3], output.sections[3]);
  assert.deepEqual(result.output.sections[3].telemetryRefs, ['t5']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.broadMarketFocus, originalFocus);
  assert.deepEqual(diagnostics.filter(value =>
    value.stage === 'claudeAnalysisSectionNormalization'), [{
    stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
    violationCategory: 'NON_BENCHMARK_TELEMETRY', suppliedReferenceCount: 5,
    allowedReferenceCount: 4, offendingReferenceCount: 3
  }]);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
});

test('request-specific Section 3 allowlist contains all benchmarks and excludes overlapping stocks', () => {
  const input = overlappingFocusInput();
  const system = buildClaudeAnalysisRequest(input).system;
  assert.match(system,
    /Section 3 telemetryRefs may contain only these exact benchmark refs: \["t1","t2","t3","t4"\]\./);
  for (const stockReference of ['t5', 't6', 't7']) {
    assert.equal(system.includes(`"${stockReference}"`), false, stockReference);
  }
});

test('Section 3 localizes uncited portfolio symbols and instrument names, but allows independently focused companies', async () => {
  const input = richCompletedUsWeekInput({stockInstrumentName: 'Microsoft'});
  for (const prose of [
    'Broadcom led semiconductor shares while MSFT also advanced.',
    'Broadcom led semiconductor shares while Microsoft also advanced.',
    'Broadcom led semiconductor shares while watchlist name AAPL also advanced.'
  ]) {
    const output = supportedOutput(input);
    output.sections[2].content = prose;
    assert.equal(validateClaudeAnalysisOutput(output, input).errors.includes(
      'sections[2]: portfolio company requires independent broad-market focus'), true);
    const diagnostics = [];
    const result = await invokeFixture(input, output, diagnostics);
    assert.equal(result.type, 'SUCCESS', result.message);
    assert.equal(result.output.sections[2].content, null);
    assert.deepEqual(result.output.sections[2].evidenceRefs, []);
    assert.deepEqual(result.output.sections[3].evidenceRefs, ['e2']);
    assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
      violationCategory: 'UNFOCUSED_PORTFOLIO_MENTION', suppliedReferenceCount: 0,
      allowedReferenceCount: 0, offendingReferenceCount: 1
    }]);
    assert.equal(JSON.stringify(diagnostics).includes(prose), false);
  }

  const focused = richCompletedUsWeekInput({
    stockInstrumentName: 'Microsoft', includeFollowedFocus: true
  });
  const output = supportedOutput(focused);
  output.sections[2].content = 'Microsoft and Broadcom led their respective groups; MSFT remained in focus.';
  assert.equal(validateClaudeAnalysisOutput(output, focused).errors.includes(
    'sections[2]: portfolio company requires independent broad-market focus'), true);
  output.sections[2].evidenceRefs = ['e2', 'e4', 'e5'];
  assert.equal(validateClaudeAnalysisOutput(output, focused).valid, true);
  const result = await invokeFixture(focused, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  assert.deepEqual(result.output.sections[2], output.sections[2]);
  assert.deepEqual(result.output.sections[3], output.sections[3]);
});

test('a repaired broad-market focus package preserves valid causal and initiating-list sections', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  const originalRoles = {
    materialEvents: input.marketPackages[0].evidenceContext.materialEvents.slice(),
    principalCatalysts: input.marketPackages[0].evidenceContext.principalCatalysts.slice()
  };
  const result = await invokeFixture(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output, output);
  assert.deepEqual(result.output.sections[1].evidenceRefs, ['e2', 'e3']);
  assert.deepEqual(result.output.sections[2].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(result.output.sections[3].evidenceRefs, ['e2']);
  assert.deepEqual(result.output.sections[3].telemetryRefs, ['t2']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.materialEvents, originalRoles.materialEvents);
  assert.deepEqual(input.marketPackages[0].evidenceContext.principalCatalysts,
    originalRoles.principalCatalysts);
  assert.deepEqual(input.portfolioContext.myStocks[0].evidenceRefs, ['e2']);
});

test('localizes uncited driver causality and broad-market evidence leaking into Section 4 independently', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[1].evidenceRefs = ['e1', 'e5'];
  output.sections[3].evidenceRefs = ['e2', 'e4'];
  const rawErrors = validateClaudeAnalysisOutput(output, input).errors;
  assert.equal(rawErrors.includes('sections[1]: market causality requires a principal catalyst'), true);
  assert.equal(rawErrors.includes('sections[3]: evidence references must belong to the initiating list'), true);

  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[1], {
    name: 'KEY MARKET DRIVERS', content: null,
    evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Supported market causality could not be established from the generated citation set.']
  });
  assert.deepEqual(result.output.sections[3], {
    name: 'MY STOCKS & WATCHLIST - MATERIAL MOVEMENTS', content: null,
    evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Initiating-list support could not be validated from the generated citation set.']
  });
  assert.deepEqual(result.output.evidenceGaps, [
    'Supported market causality could not be established from the generated citation set.',
    'Initiating-list support could not be validated from the generated citation set.'
  ]);
  assert.deepEqual(result.output.sections[1].evidenceRefs, []);
  assert.deepEqual(result.output.sections[2].evidenceRefs, ['e4', 'e5']);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [
    {
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 1,
      violationCategory: 'MISSING_PRINCIPAL_CATALYST',
      suppliedReferenceCount: 2, allowedReferenceCount: 3, offendingReferenceCount: 2
    },
    {
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 3,
      violationCategory: 'NON_INITIATING_EVIDENCE',
      suppliedReferenceCount: 2, allowedReferenceCount: 1, offendingReferenceCount: 1
    }
  ]);
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of ['Broadcom', 'semiconductor', 'Microsoft', 'cnbc.com',
    'The recap and policy evidence']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.deepEqual(input.portfolioContext.myStocks[0].evidenceRefs, ['e2']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.principalCatalysts, ['e2', 'e3', 'e4']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.materialEvents,
    ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('localizes non-initiating Section 4 telemetry without filtering references into unsupported prose', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[3].telemetryRefs = ['t1', 't2'];
  assert.equal(validateClaudeAnalysisOutput(output, input).errors.includes(
    'sections[3]: telemetry references must belong to the initiating list'), true);
  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[3].content, null);
  assert.deepEqual(result.output.sections[3].evidenceRefs, []);
  assert.deepEqual(result.output.sections[3].telemetryRefs, []);
  assert.deepEqual(result.output.sections[3].uncertainties,
    ['Initiating-list support could not be validated from the generated citation set.']);
  assert.deepEqual(result.output.sections[2].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [{
    stage: 'claudeAnalysisSectionNormalization', sectionIndex: 3,
    violationCategory: 'NON_INITIATING_TELEMETRY',
    suppliedReferenceCount: 2, allowedReferenceCount: 1, offendingReferenceCount: 1
  }]);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
});

test('does not launder unknown global references through section-local normalization', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[1].evidenceRefs = ['e999'];
  output.sections[2].evidenceRefs = ['e999'];
  output.sections[3].evidenceRefs = ['e999'];
  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), []);
});

test('preserves the deterministic empty initiating-list statement', async () => {
  const original = richCompletedUsWeekInput();
  const input = structuredClone(original);
  input.portfolioContext.myStocks = [];
  assert.equal(validateClaudeAnalysisInput(input), true);
  const output = supportedOutput(input);
  output.sections[3] = {
    name: output.sections[3].name,
    content: 'No securities are configured in My Stocks.',
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  };
  const result = await invokeFixture(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[3], output.sections[3]);
});

test('plain-English fixtures characterize the prompt-owned quality boundary without runtime jargon rejection', () => {
  const input = richCompletedUsWeekInput();
  const good = supportedOutput(input, {plainEnglish: true});
  const bad = supportedOutput(input, {plainEnglish: false});
  assert.equal(validateClaudeAnalysisOutput(good, input).valid, true);
  assert.equal(validateClaudeAnalysisOutput(bad, input).valid, true);
  const system = buildClaudeAnalysisRequest(input).system;
  assert.match(system, /clear, normal spoken English/);
  assert.match(system, /Avoid institutional or analyst-desk jargon/);
  assert.match(system, /Preserve analytical depth: simplify wording, not reasoning/);
});

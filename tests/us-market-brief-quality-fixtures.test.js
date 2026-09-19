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
  assert.equal(output.sections[7].content, null);
  assert.deepEqual(output.sections[7].evidenceRefs, []);
  assert.deepEqual(output.sections[7].uncertainties, ['No defensible opportunity is supported.']);
  assert.deepEqual(output.sections[3], {
    name: 'STOCKS & SECTORS IN FOCUS',
    content: null,
    evidenceRefs: [],
    telemetryRefs: [],
    uncertainties: ['Validated broad-market company or sector evidence was unavailable.']
  });
  assert.deepEqual(output.evidenceGaps, [
    'Validated broad-market company or sector evidence was unavailable.',
    'No defensible evidence-supported opportunity was available.'
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

test('supported opportunity and Sections 7-10 grounding pass the complete validator', () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  assert.deepEqual(output.sections[3].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(output.sections[3].telemetryRefs, ['t1']);
  assert.deepEqual(output.sections[4].evidenceRefs, ['e2']);
  assert.deepEqual(output.sections[4].telemetryRefs, ['t2']);
  assert.deepEqual(output.sections[7].evidenceRefs, ['e5']);
  assert.match(output.sections[7].content, /why|support|Constructive/i);
  assert.doesNotMatch(output.sections[7].content, /guarantee|certain return/i);
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
    assert.deepEqual(serializedInput, input);
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
  }
});

test('NORMAL cannot contain a null analytical section, while localized DEGRADED output remains valid', () => {
  const input = richCompletedUsWeekInput();
  for (const index of [3, 7]) {
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
  assert.equal(output.sections.every((section, index) => index === 10 || section.content !== null), true);
});

test('a market-significant followed company may overlap Sections 4 and 5 without list contamination', () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[3].evidenceRefs = ['e2', 'e4', 'e5'];
  output.evidenceReferences = ['e2', 'e3', 'e4', 'e5', 'e1'];
  assert.equal(validateClaudeAnalysisOutput(output, input).valid, true);
  assert.equal(output.sections[3].evidenceRefs.includes('e2'), true);
  assert.deepEqual(output.sections[4].evidenceRefs, ['e2']);
  assert.deepEqual(output.sections[3].telemetryRefs, ['t1']);
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
  assert.deepEqual(result.output.sections[2].evidenceRefs, ['e2', 'e3']);
  assert.deepEqual(result.output.sections[3].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(result.output.sections[4].evidenceRefs, ['e2']);
  assert.deepEqual(result.output.sections[4].telemetryRefs, ['t2']);
  assert.deepEqual(input.marketPackages[0].evidenceContext.materialEvents, originalRoles.materialEvents);
  assert.deepEqual(input.marketPackages[0].evidenceContext.principalCatalysts,
    originalRoles.principalCatalysts);
  assert.deepEqual(input.portfolioContext.myStocks[0].evidenceRefs, ['e2']);
});

test('localizes uncited causality and broad-market evidence leaking into Section 5 independently', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[2].evidenceRefs = ['e1', 'e5'];
  output.sections[4].evidenceRefs = ['e2', 'e4'];
  const rawErrors = validateClaudeAnalysisOutput(output, input).errors;
  assert.equal(rawErrors.includes('sections[2]: market causality requires a principal catalyst'), true);
  assert.equal(rawErrors.includes('sections[4]: evidence references must belong to the initiating list'), true);

  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[2], {
    name: 'WHAT DROVE / IS DRIVING THE MARKET', content: null,
    evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Supported market causality could not be established from the generated citation set.']
  });
  assert.deepEqual(result.output.sections[4], {
    name: 'MY STOCKS & WATCHLIST - MATERIAL MOVEMENTS', content: null,
    evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Initiating-list support could not be validated from the generated citation set.']
  });
  assert.deepEqual(result.output.evidenceGaps, [
    'Supported market causality could not be established from the generated citation set.',
    'Initiating-list support could not be validated from the generated citation set.'
  ]);
  assert.deepEqual(result.output.sections[1].evidenceRefs, ['e3']);
  assert.deepEqual(result.output.sections[3].evidenceRefs, ['e4', 'e5']);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [
    {
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
      violationCategory: 'MISSING_PRINCIPAL_CATALYST',
      suppliedReferenceCount: 2, allowedReferenceCount: 3, offendingReferenceCount: 2
    },
    {
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 4,
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

test('localizes non-initiating Section 5 telemetry without filtering references into unsupported prose', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[4].telemetryRefs = ['t1', 't2'];
  assert.equal(validateClaudeAnalysisOutput(output, input).errors.includes(
    'sections[4]: telemetry references must belong to the initiating list'), true);
  const diagnostics = [];
  const result = await invokeFixture(input, output, diagnostics);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[4].content, null);
  assert.deepEqual(result.output.sections[4].evidenceRefs, []);
  assert.deepEqual(result.output.sections[4].telemetryRefs, []);
  assert.deepEqual(result.output.sections[4].uncertainties,
    ['Initiating-list support could not be validated from the generated citation set.']);
  assert.deepEqual(result.output.sections[3].evidenceRefs, ['e4', 'e5']);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), [{
    stage: 'claudeAnalysisSectionNormalization', sectionIndex: 4,
    violationCategory: 'NON_INITIATING_TELEMETRY',
    suppliedReferenceCount: 2, allowedReferenceCount: 1, offendingReferenceCount: 1
  }]);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
});

test('does not launder unknown global references through section-local normalization', async () => {
  const input = richCompletedUsWeekInput();
  const output = supportedOutput(input);
  output.sections[2].evidenceRefs = ['e999'];
  output.sections[4].evidenceRefs = ['e999'];
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
  output.sections[4] = {
    name: output.sections[4].name,
    content: 'No securities are configured in My Stocks.',
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  };
  const result = await invokeFixture(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.sections[4], output.sections[4]);
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {createEvidenceItem} = require('../lib/evidence-items');
const {isSpecificBroadMarketSubject} = require('../lib/broad-market-subjects');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_MODEL,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVIDER_JSON_SCHEMA,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT,
  CLAUDE_EVIDENCE_SUBJECT_REPAIR_SYSTEM_PROMPT,
  EVIDENCE_ROLES,
  buildClaudeEvidenceRoleClassificationRequest,
  buildClaudeEvidenceSubjectRepairRequest,
  canonicalClassificationInput,
  createClaudeEvidenceRoleClassificationOutput,
  completeClaudeEvidenceRoleClassificationOutput,
  createClaudeEvidenceSubjectRepairOutput,
  validateClaudeEvidenceRoleClassificationOutput,
  invokeClaudeEvidenceRoleClassification,
  invokeClaudeEvidenceSubjectRepair
} = require('../lib/claude-evidence-role-classification');
const {
  projectClaudeEvidenceRoleClassificationInput
} = require('../lib/claude-model-input-projection');

test('rejects generic market and broad-index labels without rejecting specific names', () => {
  for (const name of [
    'US stocks', 'stocks', 'the market', 'equities', 'S&P 500', 'Nasdaq', 'Dow',
    'market update', 'market leadership', 'notable movers', 'Wall Street'
  ]) {
    assert.equal(isSpecificBroadMarketSubject({kind: 'SECTOR', name}), false, name);
  }
  assert.equal(isSpecificBroadMarketSubject({kind: 'SECTOR', name: 'Technology'}), true);
  assert.equal(isSpecificBroadMarketSubject({kind: 'COMPANY', name: 'Microsoft'}), true);
});

function snapshot(symbol = '^GSPC') {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} benchmark`, instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
}

function evidence(index, overrides = {}) {
  return createEvidenceItem({
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: `Canonical evidence ${index}`,
    summary: `Bounded evidence summary ${index}.`,
    canonicalUrl: `https://www.cnbc.com/2026/09/11/evidence-${index}.html`,
    publishedAt: '2026-09-11T19:30:00Z', symbols: [], ...overrides
  });
}

function input(
  horizons = ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT'],
  items,
  requiredSubjectIndexes = []
) {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: snapshot()}],
    evidence: horizons.map((horizon, index) => ({
      reference: `e${index + 1}`,
      horizon,
      requiresBroadMarketSubjects: requiredSubjectIndexes.includes(index),
      item: items?.[index] || evidence(index + 1)
    }))
  };
}

function classifications(overrides = {}) {
  const values = [
    {reference: 'e1', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], subjects: []},
    {reference: 'e2', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: []},
    {reference: 'e3', materiality: 'LOW', roles: [], subjects: []}
  ];
  if (overrides.index !== undefined) values[overrides.index] = {...values[overrides.index], ...overrides.value};
  return {classifications: values};
}

function response(output, extras = {}) {
  return {
    ok: true, status: 200,
    headers: {get: name => name === 'request-id' ? 'req_role_123' : null},
    async json() {
      return {content: [{type: 'text', text: JSON.stringify(output)}], usage: {input_tokens: 300, output_tokens: 80}, ...extras};
    }
  };
}

function subjectRepairInput() {
  return {
    evidence: [
      {
        reference: 'e28',
        title: 'Friday stock stories',
        summary: `${'Market context. '.repeat(100)}Microsoft and Apple advanced while Financials, Bank of America and Goldman Sachs led.`
      },
      {
        reference: 'e30',
        title: 'Notable movers',
        summary: 'Intel, Micron, Boeing, GE Vernova and Eaton were notable movers.'
      }
    ]
  };
}

test('accepts completed material events, completed principal catalysts, and unsupported evidence', () => {
  const output = createClaudeEvidenceRoleClassificationOutput(classifications(), input());
  assert.deepEqual(output.classifications.map(item => item.roles), [
    ['MATERIAL_EVENT'], ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], []
  ]);
  assert.deepEqual(output.classifications.map(item => item.materiality), ['MEDIUM', 'HIGH', 'LOW']);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.classifications), true);
  assert.equal(Object.isFrozen(output.classifications[1].roles), true);
});

test('permits a subsequent development to be a material event', () => {
  const raw = classifications({index: 2, value: {
    materiality: 'HIGH', roles: ['MATERIAL_EVENT']
  }});
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(raw, input()).valid, true);
});

test('accepts only bounded provider-neutral subjects grounded in title or summary', () => {
  const raw = classifications({index: 0, value: {
    subjects: [{kind: 'COMPANY', name: 'Canonical evidence'}, {kind: 'SECTOR', name: 'Bounded evidence'}]
  }});
  const output = createClaudeEvidenceRoleClassificationOutput(raw, input());
  assert.deepEqual(output.classifications[0].subjects, [
    {kind: 'COMPANY', name: 'Canonical evidence'},
    {kind: 'SECTOR', name: 'Bounded evidence'}
  ]);
  assert.equal(Object.isFrozen(output.classifications[0].subjects[0]), true);
  for (const subjects of [
    [{kind: 'INDEX', name: 'Canonical evidence'}],
    [{kind: 'COMPANY', name: 'Canonical evidence'}, {kind: 'COMPANY', name: 'Canonical evidence'}],
    Array.from({length: 6}, (_, index) => ({kind: 'COMPANY', name: `Canonical evidence ${index}`})),
    [{kind: 'COMPANY', name: 'é'.repeat(65)}]
  ]) {
    assert.equal(validateClaudeEvidenceRoleClassificationOutput(
      classifications({index: 0, value: {subjects}}), input()).valid, false);
  }

  const filtered = createClaudeEvidenceRoleClassificationOutput(classifications({index: 0, value: {
    subjects: [
      {kind: 'SECTOR', name: 'market'},
      {kind: 'COMPANY', name: 'Unmatched company'},
      {kind: 'COMPANY', name: 'Canonical evidence'}
    ]
  }}), input());
  assert.deepEqual(filtered.classifications[0].subjects, [
    {kind: 'COMPANY', name: 'Canonical evidence'}
  ]);
});

test('requests grounded subjects for retained broad-market material news without making omission fatal', () => {
  const items = [
    evidence(28, {
      title: 'Friday stock stories',
      summary: 'US stocks rose as Microsoft and Apple advanced while Financials, Bank of America and Goldman Sachs led.'
    }),
    evidence(29, {
      title: 'Technology leads the rebound',
      summary: 'Tech shares led the broader market recovery.'
    }),
    evidence(30, {
      title: 'Notable movers',
      summary: 'Intel, Micron, Boeing, GE Vernova and Eaton were notable movers.'
    })
  ];
  const source = input(
    ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT'],
    items,
    [0, 1, 2]
  );
  const empty = classifications();
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(empty, source).valid, true);

  const valid = classifications();
  valid.classifications[0].subjects = [
    {kind: 'SECTOR', name: 'US stocks'},
    {kind: 'COMPANY', name: 'Microsoft'},
    {kind: 'COMPANY', name: 'Apple'},
    {kind: 'SECTOR', name: 'Financials'}
  ];
  valid.classifications[1].subjects = [{kind: 'SECTOR', name: 'Tech'}];
  valid.classifications[2] = {
    ...valid.classifications[2],
    materiality: 'MEDIUM',
    roles: ['MATERIAL_EVENT'],
    subjects: [
      {kind: 'COMPANY', name: 'Intel'},
      {kind: 'COMPANY', name: 'Micron'},
      {kind: 'COMPANY', name: 'Boeing'},
      {kind: 'COMPANY', name: 'GE Vernova'},
      {kind: 'COMPANY', name: 'Eaton'}
    ]
  };
  const output = createClaudeEvidenceRoleClassificationOutput(valid, source);
  assert.equal(output.classifications[0].subjects.some(subject => subject.name === 'Microsoft'), true);
  assert.equal(output.classifications[1].subjects[0].name, 'Tech');
  assert.equal(output.classifications[2].subjects.length, 5);

  valid.classifications[0].subjects = [{kind: 'SECTOR', name: 'US stocks'}];
  const genericOnly = createClaudeEvidenceRoleClassificationOutput(valid, source);
  assert.deepEqual(genericOnly.classifications[0].subjects, []);
});

test('allows empty subjects when broad-market subjects are not required or evidence is not retained material news', () => {
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(classifications(), input()).valid, true);

  const source = input(undefined, undefined, [2]);
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(classifications(), source).valid, true);
});

test('rejects a subsequent development classified as a principal catalyst', () => {
  const raw = classifications({index: 2, value: {
    roles: ['PRINCIPAL_CATALYST']
  }});
  assert.deepEqual(validateClaudeEvidenceRoleClassificationOutput(raw, input()).errors,
    ['subsequent development cannot be a principal catalyst']);
});

test('CURRENT_SESSION evidence may support the current move but keeps subsequent restrictions', () => {
  const source = input([
    'COMPLETED_SESSION', 'CURRENT_SESSION', 'SUBSEQUENT_DEVELOPMENT'
  ]);
  const currentCatalyst = classifications();
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(currentCatalyst, source).valid, true);
  assert.deepEqual(
    createClaudeEvidenceRoleClassificationOutput(currentCatalyst, source)
      .classifications[1].roles,
    ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']
  );
  const projected = JSON.parse(
    buildClaudeEvidenceRoleClassificationRequest(source).messages[0].content
  );
  assert.equal(projected.evidence[1].horizon, 'CURRENT_SESSION');
  const subsequentCatalyst = classifications({index: 2, value: {
    roles: ['PRINCIPAL_CATALYST']
  }});
  assert.deepEqual(validateClaudeEvidenceRoleClassificationOutput(subsequentCatalyst, source).errors,
    ['subsequent development cannot be a principal catalyst']);
  assert.equal(CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT.includes(
    'horizon CURRENT_SESSION may be MATERIAL_EVENT or PRINCIPAL_CATALYST'), true);
  assert.equal(CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT.includes(
    'must never be treated as causing an earlier completed-session move'), true);
});

test('restricts materiality and roles to their allowlists', () => {
  assert.deepEqual(EVIDENCE_ROLES, ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']);
  for (const value of ['CRITICAL', '', null]) {
    assert.equal(validateClaudeEvidenceRoleClassificationOutput(
      classifications({index: 0, value: {materiality: value}}), input()).valid, false);
  }
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(
    classifications({index: 0, value: {roles: ['MARKET_FACT']}}), input()).valid, false);
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(
    classifications({index: 1, value: {roles: ['MATERIAL_EVENT', 'MATERIAL_EVENT']}}), input()).valid, false);
});

test('rejects unknown, duplicate, missing, extra, and reordered references', () => {
  const cases = [];
  const unknown = classifications(); unknown.classifications[0].reference = 'e9'; cases.push(unknown);
  const duplicate = classifications(); duplicate.classifications[1].reference = 'e1'; cases.push(duplicate);
  const missing = classifications(); missing.classifications.pop(); cases.push(missing);
  const extra = classifications(); extra.classifications.push({...extra.classifications[0], reference: 'e4'}); cases.push(extra);
  const reordered = classifications(); [reordered.classifications[0], reordered.classifications[1]]
    = [reordered.classifications[1], reordered.classifications[0]]; cases.push(reordered);
  for (const raw of cases) assert.equal(validateClaudeEvidenceRoleClassificationOutput(raw, input()).valid, false);
});

test('conservatively completes only omitted CURRENT_SESSION classifications without relaxing reference integrity', () => {
  const source = input(['COMPLETED_SESSION', 'CURRENT_SESSION', 'CURRENT_SESSION']);
  const omitted = classifications();
  omitted.classifications.splice(1, 1);
  const completed = completeClaudeEvidenceRoleClassificationOutput(omitted, source, {
    allowConservativeCompletion: true
  });
  assert.deepEqual(completed.output.classifications.map(entry => entry.reference), ['e1', 'e2', 'e3']);
  assert.deepEqual(completed.output.classifications[1], {
    reference: 'e2', materiality: 'LOW', roles: [], subjects: []
  });
  assert.deepEqual(completed.classificationCoverage, {
    suppliedReferenceCount: 3,
    returnedReferenceCount: 2,
    missingReferenceCount: 1,
    unknownOrExtraReferenceCount: 0,
    deterministicCompletionApplied: true
  });
  assert.throws(() => completeClaudeEvidenceRoleClassificationOutput(omitted, source),
    /cover every supplied reference/);
  const unknown = classifications();
  unknown.classifications[1].reference = 'e9';
  assert.throws(() => completeClaudeEvidenceRoleClassificationOutput(unknown, source, {
    allowConservativeCompletion: true
  }), /references must match/);
});

test('classifier result shape excludes the removed reason field', () => {
  const output = createClaudeEvidenceRoleClassificationOutput(classifications(), input());
  assert.deepEqual(Object.keys(output.classifications[0]), [
    'reference', 'materiality', 'roles', 'subjects'
  ]);
  const extra = classifications();
  extra.classifications[0].reason = 'Unused explanation.';
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(extra, input()).valid, false);
});

test('canonical input is bounded, immutable, and independent of caller mutation', () => {
  const source = input();
  const canonical = canonicalClassificationInput(source);
  source.evidence[0].horizon = 'SUBSEQUENT_DEVELOPMENT';
  source.evidence[0] = source.evidence[1];
  assert.equal(canonical.evidence[0].reference, 'e1');
  assert.equal(canonical.evidence[0].horizon, 'COMPLETED_SESSION');
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.evidence[0].item.provenance), true);
  assert.throws(() => canonicalClassificationInput({...input(), model: 'caller-model'}));
});

test('rejects market-state disagreement and duplicate benchmark symbols', () => {
  const mismatchedState = input();
  mismatchedState.marketContext.marketState = 'REGULAR';
  assert.throws(() => canonicalClassificationInput(mismatchedState),
    /invalid canonical benchmark telemetry/);

  const duplicateSymbol = input();
  duplicateSymbol.benchmarkTelemetry.push({reference: 't2', snapshot: snapshot()});
  assert.throws(() => canonicalClassificationInput(duplicateSymbol),
    /duplicate canonical benchmark symbol/);
});

test('locks benchmark and evidence collection count boundaries', () => {
  const tenBenchmarks = input();
  tenBenchmarks.benchmarkTelemetry = Array.from({length: 10}, (_, index) => ({
    reference: `t${index + 1}`,
    snapshot: snapshot(`^BENCH${index + 1}`)
  }));
  assert.doesNotThrow(() => canonicalClassificationInput(tenBenchmarks));
  tenBenchmarks.benchmarkTelemetry.push({reference: 't11', snapshot: snapshot('^BENCH11')});
  assert.throws(() => canonicalClassificationInput(tenBenchmarks), /invalid bounded benchmark telemetry/);

  const fiftyEvidence = input(Array.from({length: 50}, () => 'COMPLETED_SESSION'));
  assert.doesNotThrow(() => canonicalClassificationInput(fiftyEvidence));
  fiftyEvidence.evidence.push({
    reference: 'e51', horizon: 'COMPLETED_SESSION', requiresBroadMarketSubjects: false,
    item: evidence(51)
  });
  assert.throws(() => canonicalClassificationInput(fiftyEvidence), /invalid bounded classification evidence/);
});

test('builds a fixed server-owned request with no tools and no caller override surface', () => {
  const source = input();
  const original = JSON.stringify(source);
  const canonical = canonicalClassificationInput(source);
  const request = buildClaudeEvidenceRoleClassificationRequest(source);
  const modelInput = JSON.parse(request.messages[0].content);
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.model, CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_MODEL);
  assert.equal('tools' in request, false);
  assert.equal(request.messages.length, 1);
  assert.deepEqual(modelInput, projectClaudeEvidenceRoleClassificationInput(canonical));
  assert.equal(JSON.stringify(source), original);
  assert.equal(Object.isFrozen(projectClaudeEvidenceRoleClassificationInput(canonical)), true);
  const canonicalSession = canonical.benchmarkTelemetry[0].snapshot.completedSessions[0];
  const projectedSession = modelInput.benchmarkTelemetry[0].snapshot.completedSessions[0];
  assert.deepEqual(projectedSession, {
    ...canonicalSession,
    provenance: {
      publisher: canonicalSession.provenance.publisher,
      authority: canonicalSession.provenance.authority
    }
  });
  assert.equal(projectedSession.sourceId, canonicalSession.sourceId);
  assert.deepEqual(Object.keys(projectedSession.provenance), ['publisher', 'authority']);
  const projectedItem = modelInput.evidence[0].item;
  assert.deepEqual(Object.keys(projectedItem), [
    'sourceId', 'market', 'evidenceCategory', 'title', 'summary', 'publishedAt',
    'symbols', 'provenance'
  ]);
  assert.deepEqual(Object.keys(projectedItem.provenance), ['publisher', 'authority']);
  assert.equal(projectedItem.sourceId, canonical.evidence[0].item.sourceId);
  assert.equal(projectedItem.provenance.publisher, canonical.evidence[0].item.provenance.publisher);
  assert.equal(projectedItem.provenance.authority, canonical.evidence[0].item.provenance.authority);
  assert.equal('canonicalUrl' in projectedItem, false);
  for (const omitted of ['homepage', 'locator', 'applicableMarket', 'sourceJurisdiction']) {
    assert.equal(omitted in projectedItem.provenance, false);
  }
  assert.equal(request.system, CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT);
  for (const required of [
    'Materiality and causality are distinct judgments',
    'MATERIAL_EVENT means',
    'PRINCIPAL_CATALYST is narrower',
    'SUBSEQUENT_DEVELOPMENT may be MATERIAL_EVENT',
    'must never be PRINCIPAL_CATALYST',
    'Use roles: []',
    'subjects only for materially significant broad-market companies or sectors',
    'requiresBroadMarketSubjects is true',
    'subjects must include their exact grounded names',
    'Use subjects: [] only when no qualifying company or sector is explicitly supported',
    'Subject assignment is independent of materiality and roles',
    'never lower materiality or remove MATERIAL_EVENT',
    'Generic market or broad-index labels',
    'title or summary',
    'must not depend on portfolio membership or provider identity',
    'in supplied evidence order',
    'make no provider-specific assumptions'
  ]) assert.equal(request.system.includes(required), true, required);
  assert.equal(request.system.includes('Hard constraint: when an evidence item has horizon SUBSEQUENT_DEVELOPMENT, its roles may be only [] or [MATERIAL_EVENT]; never output PRINCIPAL_CATALYST for it, either alone or together with MATERIAL_EVENT.'), true);
  assert.throws(() => buildClaudeEvidenceRoleClassificationRequest({...input(), prompt: 'override'}));
});

test('retains provider-owned Yahoo publisher while rejecting invalid canonical data before projection', () => {
  const yahoo = evidence(1, {
    sourceId: 'us.yahoo-finance',
    publisher: 'Reuters',
    canonicalUrl: 'https://finance.yahoo.com/markets/live/example.html'
  });
  const source = input(['COMPLETED_SESSION'], [yahoo]);
  const projected = JSON.parse(
    buildClaudeEvidenceRoleClassificationRequest(source).messages[0].content
  );
  assert.equal(projected.evidence[0].item.sourceId, 'us.yahoo-finance');
  assert.equal(projected.evidence[0].item.provenance.publisher, 'Reuters');
  assert.equal(projected.evidence[0].item.provenance.authority, 'secondary');

  const invalid = JSON.parse(JSON.stringify(source));
  invalid.evidence[0].item.canonicalUrl = 'http://example.com/invalid';
  assert.throws(() => buildClaudeEvidenceRoleClassificationRequest(invalid),
    /invalid canonical classification evidence/);
  const spoofed = JSON.parse(JSON.stringify(source));
  spoofed.evidence[0].item.provenance.authority = 'primary';
  assert.throws(() => buildClaudeEvidenceRoleClassificationRequest(spoofed),
    /invalid canonical classification evidence/);
  const spoofedTelemetry = JSON.parse(JSON.stringify(source));
  spoofedTelemetry.benchmarkTelemetry[0].snapshot.completedSessions[0]
    .provenance.authority = 'primary';
  assert.throws(() => buildClaudeEvidenceRoleClassificationRequest(spoofedTelemetry),
    /invalid canonical benchmark telemetry/);
});

test('uses a provider-compatible schema without weakening authoritative subject bounds', () => {
  const authoritativeSubjects = CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_OUTPUT_JSON_SCHEMA
    .properties.classifications.items.properties.subjects;
  const providerSubjects = CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVIDER_JSON_SCHEMA
    .properties.classifications.items.properties.subjects;
  const request = buildClaudeEvidenceRoleClassificationRequest(input());

  assert.equal(authoritativeSubjects.maxItems, 5);
  assert.equal(Object.hasOwn(providerSubjects, 'maxItems'), false);
  assert.equal(request.output_config.format.schema,
    CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVIDER_JSON_SCHEMA);
  const authoritativeClassification = CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_OUTPUT_JSON_SCHEMA
    .properties.classifications.items;
  const providerClassification = CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVIDER_JSON_SCHEMA
    .properties.classifications.items;
  assert.equal(authoritativeClassification.required.includes('reason'), false);
  assert.equal(Object.hasOwn(authoritativeClassification.properties, 'reason'), false);
  assert.equal(providerClassification.required.includes('reason'), false);
  assert.equal(Object.hasOwn(providerClassification.properties, 'reason'), false);
  assert.equal(Object.hasOwn(
    request.output_config.format.schema.properties.classifications.items.properties.subjects,
    'maxItems'
  ), false);

  const tooManySubjects = Array.from({length: 6}, () => ({
    kind: 'COMPANY', name: 'Canonical evidence'
  }));
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(
    classifications({index: 0, value: {subjects: tooManySubjects}}), input()
  ).valid, false);
});

test('subject-only repair remains bounded, exactly grounded, and rejects generic or aliased names', () => {
  const source = subjectRepairInput();
  const output = createClaudeEvidenceSubjectRepairOutput({repairs: [
    {
      reference: 'e28',
      subjects: [
        {kind: 'SECTOR', name: 'US stocks'},
        {kind: 'COMPANY', name: 'Microsoft'},
        {kind: 'COMPANY', name: 'Apple'},
        {kind: 'SECTOR', name: 'Financials'},
        {kind: 'COMPANY', name: 'Bank of America'}
      ]
    },
    {
      reference: 'e30',
      subjects: [
        {kind: 'COMPANY', name: 'Intel'},
        {kind: 'COMPANY', name: 'GE-Vernova'},
        {kind: 'COMPANY', name: 'GE Vernova'},
        {kind: 'COMPANY', name: 'Eaton'}
      ]
    }
  ]}, source);
  assert.deepEqual(output.repairs[0].subjects, [
    {kind: 'COMPANY', name: 'Microsoft'},
    {kind: 'COMPANY', name: 'Apple'},
    {kind: 'SECTOR', name: 'Financials'},
    {kind: 'COMPANY', name: 'Bank of America'}
  ]);
  assert.deepEqual(output.repairs[1].subjects, [
    {kind: 'COMPANY', name: 'Intel'},
    {kind: 'COMPANY', name: 'GE Vernova'},
    {kind: 'COMPANY', name: 'Eaton'}
  ]);
  assert.equal(Object.isFrozen(output.repairs[0].subjects), true);
  assert.throws(() => createClaudeEvidenceSubjectRepairOutput({repairs: [
    {reference: 'e30', subjects: []}, {reference: 'e28', subjects: []}
  ]}, source), /references must match supplied order/);
});

test('builds and invokes one fixed subject-only repair request without tools or retries', async () => {
  const source = subjectRepairInput();
  const request = buildClaudeEvidenceSubjectRepairRequest(source);
  assert.equal(request.model, CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_MODEL);
  assert.equal(request.system, CLAUDE_EVIDENCE_SUBJECT_REPAIR_SYSTEM_PROMPT);
  assert.equal('tools' in request, false);
  assert.deepEqual(Object.keys(JSON.parse(request.messages[0].content).evidence[0]),
    ['reference', 'title', 'summary']);
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeEvidenceSubjectRepair({
    input: source,
    apiKey: 'secret',
    fetchImpl: async () => {
      calls++;
      return response({repairs: [
        {reference: 'e28', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
        {reference: 'e30', subjects: [{kind: 'COMPANY', name: 'Boeing'}]}
      ]});
    },
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(diagnostics[0].stage, 'evidenceSubjectRepairInvocation');
  assert.equal(diagnostics[0].counts.evidenceCount, 2);
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of ['Microsoft', 'Boeing', 'Market context', 'secret']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('makes exactly one Anthropic fetch with no retry and returns immutable output', async () => {
  let fetchCount = 0;
  const source = input();
  const result = await invokeClaudeEvidenceRoleClassification({
    input: source, apiKey: 'secret',
    async fetchImpl(url, options) {
      fetchCount++;
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-api-key'], 'secret');
      return response(classifications());
    }
  });
  assert.equal(result.ok, true);
  assert.equal(fetchCount, 1);
  assert.equal(Object.isFrozen(result.output.classifications[0]), true);
  assert.equal(source.evidence[0].item.title, 'Canonical evidence 1');
});

test('completes omitted active classifications with conservative non-causal defaults and diagnostics', async () => {
  const source = input(['COMPLETED_SESSION', 'CURRENT_SESSION', 'CURRENT_SESSION']);
  const omitted = classifications();
  omitted.classifications.splice(1, 1);
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input: source, apiKey: 'secret', fetchImpl: async () => response(omitted),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.classifications[1], {
    reference: 'e2', materiality: 'LOW', roles: [], subjects: []
  });
  assert.deepEqual(result.classificationCoverage, {
    suppliedReferenceCount: 3,
    returnedReferenceCount: 2,
    missingReferenceCount: 1,
    unknownOrExtraReferenceCount: 0,
    deterministicCompletionApplied: true
  });
  assert.deepEqual(diagnostics[0].classificationCoverage, result.classificationCoverage);
});

test('diagnoses primary subject omission separately from subjects sanitized to empty', async () => {
  const source = input(
    ['COMPLETED_SESSION', 'COMPLETED_SESSION'],
    [
      evidence(1, {title: 'Microsoft advances', summary: 'Microsoft advanced.'}),
      evidence(2, {title: 'US stocks advance', summary: 'US stocks advanced.'})
    ],
    [0, 1]
  );
  const raw = {classifications: [
    {
      reference: 'e1', materiality: 'HIGH', roles: ['MATERIAL_EVENT'], subjects: []
    },
    {
      reference: 'e2', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'],
      subjects: [{kind: 'SECTOR', name: 'US stocks'}]
    }
  ]};
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input: source, apiKey: 'secret', fetchImpl: async () => response(raw),
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.subjectCoverage, {
    eligibleReferenceCount: 2,
    primaryOmittedSubjectCount: 1,
    primarySanitizedEmptySubjectCount: 1
  });
  assert.deepEqual(diagnostics[0].subjectCoverage, result.subjectCoverage);
});

test('never retries network, HTTP, malformed-envelope, or contract failures', async () => {
  const transports = [
    async () => { throw new Error('network secret'); },
    async () => ({ok: false, status: 503, headers: {get: () => null}}),
    async () => ({ok: true, status: 200, headers: {get: () => null}, async json() { return {content: []}; }}),
    async () => response(classifications({index: 2, value: {roles: ['PRINCIPAL_CATALYST']}}))
  ];
  for (const transport of transports) {
    let calls = 0;
    const result = await invokeClaudeEvidenceRoleClassification({
      input: input(), apiKey: 'secret', fetchImpl: async (...args) => { calls++; return transport(...args); }
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test('blocks oversized requests before fetch', async () => {
  const largeItem = evidence(1, {summary: 'x'.repeat(CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES)});
  let fetchCount = 0;
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input: input(['COMPLETED_SESSION'], [largeItem]), apiKey: 'secret',
    fetchImpl: async () => { fetchCount++; }, onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'REQUEST_TOO_LARGE');
  assert.equal(fetchCount, 0);
  assert.equal(diagnostics[0].providerInvocationSkipped, true);
  assert.equal(diagnostics[0].fetchCount, 0);
});

test('captures only sanitized size, counts, request-id, timing, usage, and fetch diagnostics', async () => {
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input: input(), apiKey: 'TOP_SECRET', fetchImpl: async () => response(classifications()),
    onDiagnostics: value => diagnostics.push(value), monotonicNow: (() => { let now = 0; return () => ++now; })()
  });
  assert.equal(result.ok, true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]), [
    'model', 'requestId', 'requestSize', 'counts', 'timing', 'usage', 'fetchCount',
    'classificationCoverage', 'subjectCoverage'
  ]);
  assert.deepEqual(diagnostics[0].counts, {evidenceCount: 3, benchmarkTelemetryCount: 1});
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 300, output_tokens: 80});
  assert.equal(diagnostics[0].fetchCount, 1);
  assert.deepEqual(diagnostics[0].subjectCoverage, {
    eligibleReferenceCount: 0,
    primaryOmittedSubjectCount: 0,
    primarySanitizedEmptySubjectCount: 0
  });
  assert.equal(diagnostics[0].requestSize.classificationInputBytes,
    Buffer.byteLength(JSON.stringify(canonicalClassificationInput(input())), 'utf8'));
  assert.equal(diagnostics[0].requestSize.projectedClassificationInputBytes,
    Buffer.byteLength(buildClaudeEvidenceRoleClassificationRequest(input()).messages[0].content, 'utf8'));
  assert.equal(diagnostics[0].requestSize.projectedClassificationInputBytes
    < diagnostics[0].requestSize.classificationInputBytes, true);
  const serialized = JSON.stringify(diagnostics[0]);
  for (const forbidden of ['Canonical evidence', 'Bounded evidence', 'cnbc.com', 'TOP_SECRET', 'Classify every']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('does not integrate final package construction or provider acquisition', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/claude-evidence-role-classification.js'), 'utf8');
  for (const forbidden of [
    'us-analysis-package-orchestration', 'analysis-package-runtime', 'createClaudeAnalysisInput',
    'cnbc-us-market-news-candidate-acquisition', 'yahoo-recap', 'web_search'
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createThreeSessionSnapshot} = require('../lib/three-session-snapshot');
const {
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_MODEL,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT,
  EVIDENCE_ROLES,
  MAX_CLASSIFICATION_REASON_BYTES,
  buildClaudeEvidenceRoleClassificationRequest,
  canonicalClassificationInput,
  createClaudeEvidenceRoleClassificationOutput,
  validateClaudeEvidenceRoleClassificationOutput,
  invokeClaudeEvidenceRoleClassification
} = require('../lib/claude-evidence-role-classification');

function snapshot(symbol = '^GSPC') {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  return createThreeSessionSnapshot({
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

function input(horizons = ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT'], items) {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: snapshot()}],
    evidence: horizons.map((horizon, index) => ({
      reference: `e${index + 1}`, horizon, item: items?.[index] || evidence(index + 1)
    }))
  };
}

function classifications(overrides = {}) {
  const values = [
    {reference: 'e1', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], reason: 'A material event is supported.'},
    {reference: 'e2', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], reason: 'Supplied evidence and benchmark movement support causality.'},
    {reference: 'e3', materiality: 'LOW', roles: [], reason: 'No supported semantic role.'}
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
    materiality: 'HIGH', roles: ['MATERIAL_EVENT'], reason: 'Material forward-looking development.'
  }});
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(raw, input()).valid, true);
});

test('rejects a subsequent development classified as a principal catalyst', () => {
  const raw = classifications({index: 2, value: {
    roles: ['PRINCIPAL_CATALYST'], reason: 'Claimed causal role.'
  }});
  assert.deepEqual(validateClaudeEvidenceRoleClassificationOutput(raw, input()).errors,
    ['subsequent development cannot be a principal catalyst']);
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

test('requires a bounded canonical reason including for principal catalysts', () => {
  for (const reason of ['', ' ', `x${'é'.repeat(MAX_CLASSIFICATION_REASON_BYTES)}`]) {
    assert.equal(validateClaudeEvidenceRoleClassificationOutput(
      classifications({index: 1, value: {reason}}), input()).valid, false);
  }
  const missing = classifications(); delete missing.classifications[1].reason;
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(missing, input()).valid, false);
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
    reference: 'e51', horizon: 'COMPLETED_SESSION', item: evidence(51)
  });
  assert.throws(() => canonicalClassificationInput(fiftyEvidence), /invalid bounded classification evidence/);
});

test('locks the 500 UTF-8 byte reason boundary', () => {
  const exactlyFiveHundred = 'é'.repeat(250);
  const fiveHundredAndOne = `${exactlyFiveHundred}x`;
  assert.equal(Buffer.byteLength(exactlyFiveHundred, 'utf8'), 500);
  assert.equal(Buffer.byteLength(fiveHundredAndOne, 'utf8'), 501);
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(
    classifications({index: 0, value: {reason: exactlyFiveHundred}}), input()).valid, true);
  assert.equal(validateClaudeEvidenceRoleClassificationOutput(
    classifications({index: 0, value: {reason: fiveHundredAndOne}}), input()).valid, false);
});

test('builds a fixed server-owned request with no tools and no caller override surface', () => {
  const request = buildClaudeEvidenceRoleClassificationRequest(input());
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.model, CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_MODEL);
  assert.equal('tools' in request, false);
  assert.equal(request.messages.length, 1);
  assert.deepEqual(JSON.parse(request.messages[0].content), canonicalClassificationInput(input()));
  assert.equal(request.system, CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_SYSTEM_PROMPT);
  for (const required of [
    'Materiality and causality are distinct judgments',
    'MATERIAL_EVENT means',
    'PRINCIPAL_CATALYST is narrower',
    'SUBSEQUENT_DEVELOPMENT may be MATERIAL_EVENT',
    'must never be PRINCIPAL_CATALYST',
    'Use roles: []',
    'in supplied evidence order',
    'make no provider-specific assumptions'
  ]) assert.equal(request.system.includes(required), true, required);
  assert.equal(request.system.includes('Hard constraint: when an evidence item has horizon SUBSEQUENT_DEVELOPMENT, its roles may be only [] or [MATERIAL_EVENT]; never output PRINCIPAL_CATALYST for it, either alone or together with MATERIAL_EVENT.'), true);
  assert.throws(() => buildClaudeEvidenceRoleClassificationRequest({...input(), prompt: 'override'}));
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
    'model', 'requestId', 'requestSize', 'counts', 'timing', 'usage', 'fetchCount'
  ]);
  assert.deepEqual(diagnostics[0].counts, {evidenceCount: 3, benchmarkTelemetryCount: 1});
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 300, output_tokens: 80});
  assert.equal(diagnostics[0].fetchCount, 1);
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

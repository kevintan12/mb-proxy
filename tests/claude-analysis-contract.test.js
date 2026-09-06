const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  ANALYTICAL_STATUSES,
  CLAUDE_ANALYSIS_INPUT_KEYS,
  CLAUDE_EVIDENCE_REFERENCE_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_KEYS,
  CLAUDE_FINDING_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  createClaudeAnalysisOutput
} = require('../lib/claude-analysis-contract');

function evidenceItem(overrides = {}) {
  return createEvidenceItem({
    sourceId: 'sg.reuters',
    market: 'SG',
    evidenceCategory: 'news',
    title: 'Market update',
    summary: 'A supported market observation.',
    canonicalUrl: 'https://www.reuters.com/markets/example',
    publishedAt: '2026-09-06T08:00:00Z',
    symbols: ['^STI'],
    ...overrides
  });
}

function analysisInput(items = [evidenceItem()]) {
  return createClaudeAnalysisInput({
    evidenceCollection: createEvidenceCollection({market: 'SG', items})
  });
}

function normalOutput(overrides = {}) {
  return {
    status: 'NORMAL',
    findings: [{text: 'The market advanced.', evidenceRefs: ['e1']}],
    gaps: [],
    ...overrides
  };
}

test('derives deterministic evidence references from canonical collection order', () => {
  const input = analysisInput([
    evidenceItem({title: 'First', canonicalUrl: 'https://www.reuters.com/first'}),
    evidenceItem({title: 'Second', canonicalUrl: 'https://www.reuters.com/second'}),
    evidenceItem({title: 'First', canonicalUrl: 'https://www.reuters.com/first'})
  ]);

  assert.deepEqual(Object.keys(input), CLAUDE_ANALYSIS_INPUT_KEYS);
  assert.deepEqual(input.evidence.map(entry => entry.reference), ['e1', 'e2', 'e3']);
  assert.equal(input.evidence[0].item.title, 'First');
  assert.equal(input.evidence[2].item.title, 'First');
  assert.equal(input.symbol, undefined);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.evidence), true);
  assert.equal(input.evidence.every(entry =>
    Object.isFrozen(entry) && Object.keys(entry).join(',') === CLAUDE_EVIDENCE_REFERENCE_KEYS.join(',')), true);
});

test('rejects non-canonical evidence collections and retains no caller-owned references', () => {
  const item = evidenceItem();
  const collection = createEvidenceCollection({market: 'SG', items: [item]});
  const input = createClaudeAnalysisInput({evidenceCollection: collection});
  assert.notEqual(input.evidence[0].item, item);
  assert.notEqual(input.evidence[0].item.symbols, item.symbols);
  assert.notEqual(input.evidence[0].item.provenance, item.provenance);

  const wrongShape = {items: collection.items, market: collection.market};
  assert.throws(() => createClaudeAnalysisInput({evidenceCollection: wrongShape}), /property shape/);

  const spoofedItem = JSON.parse(JSON.stringify(item));
  spoofedItem.provenance.publisher = 'Claude';
  assert.throws(() => createClaudeAnalysisInput({
    evidenceCollection: {market: 'SG', items: [spoofedItem]}
  }), /Invalid evidence collection/);
});

test('accepts canonical NORMAL output and creates a deeply immutable copy', () => {
  const input = analysisInput();
  const supplied = normalOutput();
  const validation = validateClaudeAnalysisOutput(supplied, input);
  const output = createClaudeAnalysisOutput(supplied, input);

  assert.deepEqual(ANALYTICAL_STATUSES, ['NORMAL', 'DEGRADED', 'FAILED']);
  assert.equal(validation.valid, true);
  assert.deepEqual(Object.keys(output), CLAUDE_ANALYSIS_OUTPUT_KEYS);
  assert.deepEqual(Object.keys(output.findings[0]), CLAUDE_FINDING_KEYS);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.findings), true);
  assert.equal(Object.isFrozen(output.findings[0]), true);
  assert.equal(Object.isFrozen(output.findings[0].evidenceRefs), true);
  assert.equal(Object.isFrozen(output.gaps), true);

  supplied.findings[0].text = 'Mutated';
  supplied.findings[0].evidenceRefs.push('e2');
  assert.equal(output.findings[0].text, 'The market advanced.');
  assert.deepEqual(output.findings[0].evidenceRefs, ['e1']);
});

test('accepts DEGRADED with supported findings and unresolved gaps', () => {
  const result = validateClaudeAnalysisOutput({
    status: 'DEGRADED',
    findings: [{text: 'One fact is supported.', evidenceRefs: ['e1']}],
    gaps: ['Primary disclosure was unavailable.']
  }, analysisInput());
  assert.equal(result.valid, true);
});

test('accepts FAILED as evidence insufficiency while keeping contract failure separate', () => {
  const input = analysisInput([]);
  const insufficient = validateClaudeAnalysisOutput({
    status: 'FAILED',
    findings: [],
    gaps: ['No canonical evidence was supplied.']
  }, input);
  const malformed = validateClaudeAnalysisOutput({
    status: 'FAILED',
    findings: 'none',
    gaps: []
  }, input);

  assert.equal(insufficient.valid, true);
  assert.equal(malformed.valid, false);
  assert.throws(() => createClaudeAnalysisOutput({
    status: 'FAILED', findings: 'none', gaps: []
  }, input), /Invalid Claude analysis output/);
});

test('requires every factual finding to reference supplied canonical evidence', () => {
  const input = analysisInput();
  for (const evidenceRefs of [[], ['e2'], [null]]) {
    const result = validateClaudeAnalysisOutput(normalOutput({
      findings: [{text: 'Unsupported finding.', evidenceRefs}]
    }), input);
    assert.equal(result.valid, false);
  }
  assert.equal(validateClaudeAnalysisOutput(normalOutput({
    findings: [{text: 'Supported finding.', evidenceRefs: ['e1']}]
  }), input).valid, true);
});

test('enforces status-specific finding and gap semantics', () => {
  const input = analysisInput();
  const cases = [
    normalOutput({findings: []}),
    normalOutput({gaps: ['Unexpected gap.']}),
    {status: 'DEGRADED', findings: [], gaps: ['Gap.']},
    {status: 'DEGRADED', findings: normalOutput().findings, gaps: []},
    {status: 'FAILED', findings: normalOutput().findings, gaps: ['Failure.']},
    {status: 'FAILED', findings: [], gaps: []},
    {...normalOutput(), status: 'normal'}
  ];
  for (const output of cases) {
    assert.equal(validateClaudeAnalysisOutput(output, input).valid, false);
  }

  const sparseFindings = normalOutput({findings: new Array(1)});
  const sparseReferences = normalOutput({
    findings: [{text: 'Finding.', evidenceRefs: new Array(1)}]
  });
  const sparseGaps = {status: 'FAILED', findings: [], gaps: new Array(1)};
  assert.equal(validateClaudeAnalysisOutput(sparseFindings, input).valid, false);
  assert.equal(validateClaudeAnalysisOutput(sparseReferences, input).valid, false);
  assert.equal(validateClaudeAnalysisOutput(sparseGaps, input).valid, false);
});

test('rejects model-supplied URL, provenance and non-deterministic shapes', () => {
  const input = analysisInput();
  const topLevelUrl = {...normalOutput(), canonicalUrl: 'https://example.com/'};
  const findingProvenance = normalOutput({
    findings: [{
      text: 'Finding.', evidenceRefs: ['e1'], provenance: {publisher: 'Claude'}
    }]
  });
  const reordered = {
    findings: normalOutput().findings,
    status: 'NORMAL',
    gaps: []
  };

  assert.equal(validateClaudeAnalysisOutput(topLevelUrl, input).valid, false);
  assert.equal(validateClaudeAnalysisOutput(findingProvenance, input).valid, false);
  assert.equal(validateClaudeAnalysisOutput(reordered, input).valid, false);
});

test('exports a deeply immutable JSON schema consistent with runtime status rules', () => {
  assert.equal(Object.isFrozen(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA), true);
  assert.equal(Object.isFrozen(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties), true);
  assert.equal(Object.isFrozen(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.status.enum), true);
  assert.deepEqual(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.required, CLAUDE_ANALYSIS_OUTPUT_KEYS);
  assert.deepEqual(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.status.enum, ANALYTICAL_STATUSES);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.findings.items.additionalProperties, false);
  assert.equal(
    CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.findings.items.properties.text.pattern,
    '^\\S(?:[\\s\\S]*\\S)?$'
  );
  assert.equal(
    CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.gaps.items.pattern,
    '^\\S(?:[\\s\\S]*\\S)?$'
  );
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.allOf.length, 3);
});

// Step 9F.4e: the 128-byte subject name limit at its boundary, with
// classifierSubjectSoftDropEnabled on and off, for the labelling step and the subject
// repair. A trimmed name of exactly 128 bytes is kept; 129 bytes still fails the whole
// reply. Bytes, not characters, are counted. Made-up articles and replies only: no real
// article text, no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  MAX_CLASSIFICATION_SUBJECT_NAME_BYTES,
  canonicalizeGroundedEvidenceSubjects,
  completeClaudeEvidenceRoleClassificationOutput,
  createClaudeEvidenceSubjectRepairOutput,
  invokeClaudeEvidenceRoleClassification,
  invokeClaudeEvidenceSubjectRepair
} = require('../lib/claude-evidence-role-classification');

const NAME_128 = 'B'.repeat(128);
const NAME_129 = 'B'.repeat(129);
const WIDE_128 = 'é'.repeat(64);
const WIDE_129 = `${'é'.repeat(64)}B`;
const TITLE = `${NAME_129} and ${WIDE_129} shares moved`;
const SUMMARY = 'Made-up summary for the subject name boundary test.';
const company = name => ({kind: 'COMPANY', name});
const SWITCH_ON = {CLASSIFIER_SUBJECT_SOFT_DROP_ENABLED: 'true', CLASSIFIER_RETRY_COUNT: '0'};
const SWITCH_OFF = {CLASSIFIER_SUBJECT_SOFT_DROP_ENABLED: 'false', CLASSIFIER_RETRY_COUNT: '0'};

function classificationInput() {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98, close: 104, previousClose: 100,
    volume: 1000000, asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  });
  const snapshot = createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: '^GSPC benchmark', instrumentType: 'INDEX', currency: 'USD',
    marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  return JSON.parse(JSON.stringify({
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED', primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot}],
    evidence: [{
      reference: 'e1', horizon: 'COMPLETED_SESSION', requiresBroadMarketSubjects: true,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: TITLE, summary: SUMMARY,
        canonicalUrl: 'https://www.cnbc.com/2026/09/11/subject-name-boundary.html',
        publishedAt: '2026-09-11T19:30:00Z', symbols: []
      })
    }]
  }));
}

const labels = subjects => ({classifications: [{reference: 'e1', materiality: 'HIGH', roles: ['MATERIAL_EVENT'], subjects}]});
const repairInput = () => ({evidence: [{reference: 'e1', title: TITLE, summary: SUMMARY}]});
const repairs = subjects => ({repairs: [{reference: 'e1', subjects}]});

function fakeFetch(body) {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: true, status: 200, headers: {get: () => null},
      async json() {
        return {content: [{type: 'text', text: JSON.stringify(body)}], usage: {input_tokens: 10, output_tokens: 5},
          stop_reason: 'end_turn'};
      }
    };
  };
  return {fetchImpl, calls: () => calls};
}

test('Step 9F.4e: the boundary names are 128 and 129 bytes, wide characters counted in bytes', () => {
  assert.equal(MAX_CLASSIFICATION_SUBJECT_NAME_BYTES, 128);
  assert.equal(Buffer.byteLength(NAME_128, 'utf8'), 128);
  assert.equal(Buffer.byteLength(NAME_129, 'utf8'), 129);
  assert.equal(Buffer.byteLength(WIDE_128, 'utf8'), 128);
  assert.equal(WIDE_128.length, 64);
  assert.equal(Buffer.byteLength(WIDE_129, 'utf8'), 129);
});

test('Step 9F.4e: switch on, a padded name trimmed to 128 bytes is kept and 129 bytes fails', () => {
  const content = {title: TITLE, summary: SUMMARY};
  const on = {softDrop: true};
  assert.deepEqual(canonicalizeGroundedEvidenceSubjects([company(`  ${NAME_128}\t`)], content, on), [company(NAME_128)]);
  assert.deepEqual(canonicalizeGroundedEvidenceSubjects([company(` ${WIDE_128} `)], content, on), [company(WIDE_128)]);
  for (const name of [NAME_129, ` ${NAME_129} `, WIDE_129, `\t${WIDE_129}  `]) {
    assert.throws(() => canonicalizeGroundedEvidenceSubjects([company(name)], content, on), TypeError);
  }
  // A 129-byte name after a valid one still fails the whole list.
  assert.throws(() => canonicalizeGroundedEvidenceSubjects([company(NAME_128), company(NAME_129)], content, on), TypeError);
});

test('Step 9F.4e: switch off, exactly 128 bytes passes and 129 bytes fails, as at ecb44f1', () => {
  const content = {title: TITLE, summary: SUMMARY};
  assert.deepEqual(canonicalizeGroundedEvidenceSubjects([company(NAME_128)], content), [company(NAME_128)]);
  assert.deepEqual(canonicalizeGroundedEvidenceSubjects([company(WIDE_128)], content), [company(WIDE_128)]);
  for (const name of [NAME_129, WIDE_129, ` ${NAME_128} `]) {
    assert.throws(() => canonicalizeGroundedEvidenceSubjects([company(name)], content), TypeError);
  }
});

test('Step 9F.4e: labelling output check: 128 bytes kept, 129 bytes fails, with the switch on', () => {
  const input = classificationInput();
  const options = {subjectSoftDrop: true};
  const kept = completeClaudeEvidenceRoleClassificationOutput(labels([company(` ${NAME_128} `)]), input, options);
  assert.deepEqual(kept.output.classifications[0].subjects, [company(NAME_128)]);
  assert.throws(() => completeClaudeEvidenceRoleClassificationOutput(labels([company(` ${NAME_129} `)]), input, options),
    /subjects/);
  assert.throws(() => completeClaudeEvidenceRoleClassificationOutput(labels([company(WIDE_129)]), input, options),
    /subjects/);
});

test('Step 9F.4e: subject repair output check: 128 bytes kept, 129 bytes fails, with the switch on', () => {
  const options = {subjectSoftDrop: true};
  const kept = createClaudeEvidenceSubjectRepairOutput(repairs([company(` ${WIDE_128} `)]), repairInput(), options);
  assert.deepEqual(kept.repairs[0].subjects, [company(WIDE_128)]);
  assert.throws(() => createClaudeEvidenceSubjectRepairOutput(repairs([company(` ${NAME_129} `)]), repairInput(), options),
    TypeError);
});

test('Step 9F.4e: labelling call, switch on: 128 bytes succeeds with a soft-fix line, 129 bytes is a contract failure', async () => {
  const diagnostics = [];
  const good = fakeFetch(labels([company(` ${NAME_128} `)]));
  const ok = await invokeClaudeEvidenceRoleClassification({
    input: classificationInput(), apiKey: 'test-not-a-key', fetchImpl: good.fetchImpl, env: SWITCH_ON,
    monotonicNow: () => 0, onDiagnostics: entry => diagnostics.push(entry)
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.output.classifications[0].subjects, [company(NAME_128)]);
  const soft = diagnostics.filter(entry => entry.stage === 'classifierSubjectSoftFix');
  assert.equal(soft.length, 1);
  assert.deepEqual(soft[0].fixes, [{category: 'UNTRIMMED_SUBJECT_NAME', references: ['e1']}]);
  assert.ok(!JSON.stringify(soft[0]).includes(NAME_128));

  for (const name of [` ${NAME_129} `, WIDE_129]) {
    const bad = fakeFetch(labels([company(name)]));
    const failed = await invokeClaudeEvidenceRoleClassification({
      input: classificationInput(), apiKey: 'test-not-a-key', fetchImpl: bad.fetchImpl, env: SWITCH_ON,
      monotonicNow: () => 0, onDiagnostics: () => {}
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.type, 'CONTRACT_FAILURE');
    assert.equal(bad.calls(), 1);
  }
});

test('Step 9F.4e: subject repair call, switch on: 128 bytes succeeds, 129 bytes is a contract failure', async () => {
  const good = fakeFetch(repairs([company(`\t${WIDE_128} `)]));
  const ok = await invokeClaudeEvidenceSubjectRepair({
    input: repairInput(), apiKey: 'test-not-a-key', fetchImpl: good.fetchImpl, env: SWITCH_ON,
    monotonicNow: () => 0, onDiagnostics: () => {}
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.output.repairs[0].subjects, [company(WIDE_128)]);

  for (const name of [` ${NAME_129} `, WIDE_129]) {
    const bad = fakeFetch(repairs([company(name)]));
    const failed = await invokeClaudeEvidenceSubjectRepair({
      input: repairInput(), apiKey: 'test-not-a-key', fetchImpl: bad.fetchImpl, env: SWITCH_ON,
      monotonicNow: () => 0, onDiagnostics: () => {}
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.type, 'CONTRACT_FAILURE');
  }
});

test('Step 9F.4e: both calls, switch off: an exact 128-byte name succeeds and a 129-byte name fails', async () => {
  const diagnostics = [];
  const labelOk = await invokeClaudeEvidenceRoleClassification({
    input: classificationInput(), apiKey: 'test-not-a-key', fetchImpl: fakeFetch(labels([company(NAME_128)])).fetchImpl,
    env: SWITCH_OFF, monotonicNow: () => 0, onDiagnostics: entry => diagnostics.push(entry)
  });
  assert.equal(labelOk.ok, true);
  const labelBad = await invokeClaudeEvidenceRoleClassification({
    input: classificationInput(), apiKey: 'test-not-a-key', fetchImpl: fakeFetch(labels([company(NAME_129)])).fetchImpl,
    env: SWITCH_OFF, monotonicNow: () => 0, onDiagnostics: entry => diagnostics.push(entry)
  });
  assert.equal(labelBad.type, 'CONTRACT_FAILURE');
  const repairBad = await invokeClaudeEvidenceSubjectRepair({
    input: repairInput(), apiKey: 'test-not-a-key', fetchImpl: fakeFetch(repairs([company(WIDE_129)])).fetchImpl,
    env: SWITCH_OFF, monotonicNow: () => 0, onDiagnostics: entry => diagnostics.push(entry)
  });
  assert.equal(repairBad.type, 'CONTRACT_FAILURE');
  assert.equal(diagnostics.filter(entry => entry.stage === 'classifierSubjectSoftFix').length, 0);
});

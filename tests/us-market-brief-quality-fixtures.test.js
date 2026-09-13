const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {
  createRuntimeFiveSessionSnapshotRepository
} = require('../lib/runtime-five-session-snapshot-repository');
const {
  fiveSessionSnapshot,
  richCompletedUsWeekInput,
  thinDegradedFiveSessionInput,
  supportedOutput
} = require('./fixtures/us-market-brief-quality');

test('rich fixture carries one canonical five-session week into the final input', () => {
  const input = richCompletedUsWeekInput();
  const market = input.marketPackages[0];
  assert.equal(validateClaudeAnalysisInput(input), true);
  assert.equal(market.telemetry.benchmarkSnapshots[0].snapshot.completedSessions.length, 5);
  assert.equal(market.telemetry.stockSnapshots[0].snapshot.completedSessions.length, 5);
  assert.deepEqual(market.evidenceContext.sessionAssociations, [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(market.evidenceContext.furtherReadings.map(item => item.evidenceRef), ['e1', 'e2']);
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
  for (const index of [6, 7, 8, 9]) assert.deepEqual(output.sections[index].evidenceRefs, ['e2']);
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

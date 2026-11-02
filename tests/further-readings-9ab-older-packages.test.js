// Step 9AB Build 1: an older package (Further Readings entries with only evidenceRef and
// sessionDate, no `kind`) still works end to end through the same call the
// ?claudeAnalysis=1 handler makes (the request body as the page sends it, JSON only).
// Made-up items only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {validateClaudeAnalysisInput} = require('../lib/claude-analysis-contract');
const {MARKET_STATE_CASES, marketStateCase, providerTransport} = require('./fixtures/market-state-cases');

async function invokeAsHandler(input, output) {
  return invokeClaudeAnalysis({
    input: JSON.parse(JSON.stringify(input)), apiKey: 'test-key',
    fetchImpl: async () => ({ok: true, status: 200, async json() {
      return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]};
    }})
  });
}

test('Step 9AB: an older package with no kind on its Further Readings entries works end to end in every state', async () => {
  for (const testCase of MARKET_STATE_CASES) {
    const [marketState] = testCase;
    const {input, output} = marketStateCase(...testCase);
    const live = ['PRE', 'REGULAR', 'POST'].includes(marketState);
    const context = input.marketPackages[0].evidenceContext;
    // Older live packages had an empty list; also try one older two-key entry on live days.
    const variants = live ? [[], [{evidenceRef: 'e1', sessionDate: '2026-09-04'}]] : [context.furtherReadings];
    for (const furtherReadings of variants) {
      const older = structuredClone(input);
      older.marketPackages[0].evidenceContext.furtherReadings = structuredClone(furtherReadings);
      const label = `${marketState} ${JSON.stringify(furtherReadings)}`;
      assert.equal(older.marketPackages[0].evidenceContext.furtherReadings
        .every(entry => Object.keys(entry).join() === 'evidenceRef,sessionDate'), true, label);
      assert.equal(validateClaudeAnalysisInput(older), true, label);
      const result = await invokeAsHandler(older, output);
      assert.equal(result.type, 'SUCCESS', `${label}: ${result.message}`);
      // Completed: cited first (e2 S1, e4 and e5 S3), then the older entries as read (e1).
      // Live: the cited current-session Yahoo article e1.
      assert.deepEqual(result.output.furtherReadings, live ? ['e1'] : ['e2', 'e4', 'e5', 'e1'], label);
    }
  }
});

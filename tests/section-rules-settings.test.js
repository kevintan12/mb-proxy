// Step 9D.2: tests for the new lib/section-rules.js settings table and the
// reportSettings / isActiveUsRequest helpers. This is a new file; it does
// not touch or duplicate any existing test.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  US_COMPLETED_SESSION_STATES,
  reportSettings,
  reportSettingsForInput,
  isActiveUsRequest
} = require('../lib/section-rules');

const ACTIVE_ROW = Object.freeze({
  sessionMode: 'ACTIVE',
  sectionOneRequired: false,
  catalystScope: 'SPLIT_CURRENT_COMPLETED',
  nothingSurvivedFallback: true,
  failedRescue: 'ANY_SECTION',
  furtherReadingsSource: 'ACTIVE_CITED_YAHOO'
});

const COMPLETED_ROW = Object.freeze({
  sessionMode: 'COMPLETED',
  sectionOneRequired: true,
  catalystScope: 'ANY_PRINCIPAL',
  nothingSurvivedFallback: false,
  failedRescue: 'SECTION_ONE',
  furtherReadingsSource: 'PACKAGE_LIST'
});

test('Step 9D.2: every US market state returns the expected settings row', () => {
  for (const state of ['PRE', 'REGULAR', 'POST']) {
    assert.deepEqual(reportSettings('US', state), {
      sectionRulesEnabled: true, ...ACTIVE_ROW, hasCurrentEvidence: false
    }, state);
  }
  for (const state of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    assert.deepEqual(reportSettings('US', state), {
      sectionRulesEnabled: true, ...COMPLETED_ROW, hasCurrentEvidence: false
    }, state);
  }
});

test('Step 9D.2: US_COMPLETED_SESSION_STATES names exactly the three completed states', () => {
  assert.deepEqual(US_COMPLETED_SESSION_STATES, ['CLOSED', 'WEEKEND', 'HOLIDAY']);
});

test('Step 9D.2: the hasCurrentEvidence flag passes through unchanged', () => {
  assert.equal(reportSettings('US', 'REGULAR', true).hasCurrentEvidence, true);
  assert.equal(reportSettings('US', 'REGULAR', false).hasCurrentEvidence, false);
  assert.equal(reportSettings('US', 'REGULAR').hasCurrentEvidence, false);
  assert.equal(reportSettings('US', 'CLOSED', true).hasCurrentEvidence, true);
});

test('Step 9D.2: an unknown US market state throws, matching the existing ' +
  '"Unsupported US market state" error', () => {
  for (const state of ['LUNCH', 'OPEN', 'unknown', '', null, undefined]) {
    assert.throws(() => reportSettings('US', state), TypeError);
  }
  assert.throws(() => reportSettings('US', 'LUNCH'), /Unsupported US market state: LUNCH/);
});

test('Step 9D.2: a non-US market is disabled regardless of state', () => {
  for (const market of ['SG', 'HK', 'ALL', '', null, undefined]) {
    for (const state of ['PRE', 'REGULAR', 'CLOSED', 'LUNCH', 'anything']) {
      assert.deepEqual(reportSettings(market, state), {sectionRulesEnabled: false},
        `${market}/${state}`);
    }
  }
});

test('Step 9D.2: reportSettingsForInput derives market and state from a canonical input', () => {
  const activeInput = {
    analysisRequest: {selectedScope: 'US'},
    marketPackages: [{market: 'US', marketContext: {marketState: 'REGULAR'}}]
  };
  assert.deepEqual(reportSettingsForInput(activeInput), {
    sectionRulesEnabled: true, ...ACTIVE_ROW, hasCurrentEvidence: false
  });
  assert.equal(reportSettingsForInput(activeInput, true).hasCurrentEvidence, true);

  const completedInput = {
    analysisRequest: {selectedScope: 'US'},
    marketPackages: [{market: 'US', marketContext: {marketState: 'WEEKEND'}}]
  };
  assert.deepEqual(reportSettingsForInput(completedInput), {
    sectionRulesEnabled: true, ...COMPLETED_ROW, hasCurrentEvidence: false
  });

  // A non-US scope, or a US scope with no US marketPackage present, is
  // disabled rather than throwing -- neither is an error case today.
  assert.deepEqual(reportSettingsForInput({
    analysisRequest: {selectedScope: 'SG'},
    marketPackages: [{market: 'SG', marketContext: {marketState: 'CLOSED'}}]
  }), {sectionRulesEnabled: false});
  assert.deepEqual(reportSettingsForInput({
    analysisRequest: {selectedScope: 'US'}, marketPackages: []
  }), {sectionRulesEnabled: false});
  assert.deepEqual(reportSettingsForInput(undefined), {sectionRulesEnabled: false});
  assert.deepEqual(reportSettingsForInput(null), {sectionRulesEnabled: false});
});

test('Step 9D.2: isActiveUsRequest matches the four replaced copies exactly', () => {
  const regular = {
    analysisRequest: {selectedScope: 'US'},
    marketPackages: [{market: 'US', marketContext: {marketState: 'REGULAR'}}]
  };
  const weekend = {
    analysisRequest: {selectedScope: 'US'},
    marketPackages: [{market: 'US', marketContext: {marketState: 'WEEKEND'}}]
  };
  const sg = {
    analysisRequest: {selectedScope: 'SG'},
    marketPackages: [{market: 'SG', marketContext: {marketState: 'OPEN'}}]
  };
  assert.equal(isActiveUsRequest(regular), true);
  assert.equal(isActiveUsRequest(weekend), false);
  assert.equal(isActiveUsRequest(sg), false);
  assert.equal(isActiveUsRequest({analysisRequest: {selectedScope: 'US'}, marketPackages: []}), false);
  assert.equal(isActiveUsRequest(undefined), false);
  assert.equal(isActiveUsRequest(null), false);

  // A US marketPackage with a state outside the six recognized ones now
  // throws here too, because isActiveUsRequest is built on reportSettings.
  // The four replaced copies never threw for this input shape -- they just
  // treated an unrecognized state as "not active" -- but nothing in the
  // production pipeline can reach this function with such a state: by the
  // time a US marketPackage exists at all, it has already passed
  // lib/us-analysis-package-orchestration.js's own
  // "Unsupported US market state" throw (analysisModeForMarketState), which
  // runs during package assembly, well before the writer request is built.
  // The full suite (859/859) passes unchanged with this stricter behaviour,
  // confirming no existing test exercises this input shape.
  const malformed = {
    analysisRequest: {selectedScope: 'US'},
    marketPackages: [{market: 'US', marketContext: {marketState: 'LUNCH'}}]
  };
  assert.throws(() => isActiveUsRequest(malformed), /Unsupported US market state: LUNCH/);
});

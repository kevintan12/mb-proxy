// Step 9D.5b: pins the ORDER of the cleanup stage's diagnostic events, in every market state,
// now that the cleanup rules run as one loop over the shared registry's cleanup order
// (lib/section-rules.js, SECTION_RULE_CLEANUP_ORDER, run by runSectionRules).
//
// The Step 9D.1 matrix and the Step 9D.5a extra rows mostly fire one rule at a time; this file
// fires several at once -- across sections and on the same section -- so a reordering of the
// rules shows up as a changed event sequence. Every expectation below was recorded from the
// code before Step 9D.5b (4e26b05) and is unchanged after it.
//
// Each event is written as "section:category:action", where section is the array index (0 =
// Section 1), action is "-" when the section was emptied rather than trimmed, and a bracketed
// list is the last-resort step's extra checker categories (active days only).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SECTION_RULES
} = require('../lib/claude-analysis-contract');
const {
  SECTION_RULE_CLEANUP_ORDER,
  runSectionRules
} = require('../lib/section-rules');
const {
  richCompletedUsWeekInput,
  supportedOutput: supportedCompletedUsOutput
} = require('./fixtures/us-market-brief-quality');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  activeUsInput,
  normalOutput,
  marketStateCase,
  unlinkedStockSnapshot,
  invokeCounted
} = require('./fixtures/market-state-cases');

const CAUSAL = 'The Microsoft outlook drove stocks higher.';

function compactEvents(diagnostics) {
  return diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization')
    .map(event => `${event.sectionIndex}:${event.violationCategory}:${event.action ?? '-'}`
      + (event.validationViolationCategories ? `[${event.validationViolationCategories.join(',')}]` : ''));
}

function completedInput(marketState, generatedAt) {
  const input = structuredClone(richCompletedUsWeekInput());
  input.analysisRequest.generatedAt = generatedAt;
  input.marketPackages[0].marketContext.marketState = marketState;
  for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
    input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
  return input;
}

// An active-day input with an unlinked Apple stock snapshot (t2) and Apple on the Watchlist.
function activeInput([marketState, generatedAt, overlayAsOf, currentPublishedAt], {
  myStocks = [{market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'], upcomingEvents: []}],
  ...extra
} = {}) {
  return activeUsInput({
    marketState, generatedAt, overlayAsOf, currentPublishedAt,
    stockSnapshots: [unlinkedStockSnapshot(marketState)],
    portfolioContext: {
      myStocks,
      watchlist: [{market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []}]
    },
    ...extra
  });
}

function setSection(output, index, content, evidenceRefs, telemetryRefs = []) {
  output.sections[index] = {...output.sections[index], content, evidenceRefs, telemetryRefs, uncertainties: []};
}

async function eventsFor(input, output) {
  const {result, calls, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(calls, 1);
  return {status: result.output.status, events: compactEvents(diagnostics)};
}

test('Step 9D.5b: the cleanup order is the planned one and every entry is a registry cleanup rule', () => {
  assert.deepEqual(SECTION_RULE_CLEANUP_ORDER.map(id => SECTION_RULES[id]?.number),
    [12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 24]);
  for (const id of SECTION_RULE_CLEANUP_ORDER) {
    assert.equal(SECTION_RULES[id].usedBy.includes('cleanup'), true, id);
  }
  assert.equal(Object.isFrozen(SECTION_RULE_CLEANUP_ORDER), true);
});

test('Step 9D.5b: runSectionRules runs every handler once, in the cleanup order, and refuses a mismatch', () => {
  const ran = [];
  const handlers = Object.fromEntries(SECTION_RULE_CLEANUP_ORDER.slice().reverse()
    .map(id => [id, () => ran.push(id)]));
  runSectionRules(handlers);
  assert.deepEqual(ran, SECTION_RULE_CLEANUP_ORDER);

  const {UNGROUNDED_OPPORTUNITY: omitted, ...missingOne} = handlers;
  assert.equal(typeof omitted, 'function');
  assert.throws(() => runSectionRules(missingOne), /missing \[UNGROUNDED_OPPORTUNITY\]/);
  assert.throws(() => runSectionRules({...handlers, REPORT_WORD_CAP: () => {}}),
    /unknown \[REPORT_WORD_CAP\]/);
});

test('Step 9D.5b: every cleanup rule firing at once keeps today\'s event order, in every state', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt] = row;
    const active = ACTIVE_MARKET_STATES.has(marketState);
    // No principal catalysts at all, so every causal claim lacks one.
    const input = active ? activeInput(row, {principalCatalysts: []}) : completedInput(marketState, generatedAt);
    if (!active) input.marketPackages[0].evidenceContext.principalCatalysts = [];
    const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
    const [focusSentence, focusRef, nonFocusRef, initiatingRef, s2Refs] = active
      ? ['Supported Microsoft analysis.', 'e1', 'e2', 'e1', ['e1']]
      : ['Broadcom led semiconductor shares.', 'e4', 'e1', 'e2', ['e2', 'e3']];
    setSection(output, 0, `Current developments lead the analysis. ${CAUSAL}`, [focusRef]);
    setSection(output, 1, 'The market finished higher. Momentum alone pushed stocks higher in the session.',
      s2Refs, ['t1']);
    setSection(output, 2, `${focusSentence} ${CAUSAL} Apple (AAPL) is not part of this list.`,
      [focusRef, nonFocusRef], ['t1', 't2']);
    setSection(output, 3, `Microsoft led the initiating list. ${CAUSAL} Apple (AAPL) is not part of this list.`,
      [initiatingRef, active ? 'e2' : 'e1'], ['t1']);
    output.sections[4] = {...output.sections[4],
      content: `${output.sections[4].content} It examines evidenceContext.broadMarketFocus directly.`};
    setSection(output, 5, 'A cited risk remains material to the outlook. '
      + `${CAUSAL} There is a clear opportunity for investors who act now.`, [focusRef]);
    setSection(output, 6, `Analysts will watch upcoming guidance closely. ${CAUSAL}`, [focusRef, 'e999']);

    const causal = active ? 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST' : 'MISSING_PRINCIPAL_CATALYST';
    const {status, events} = await eventsFor(input, output);
    assert.equal(status, 'DEGRADED', marketState);
    assert.deepEqual(events, [
      '6:UNKNOWN_SECTION_REFERENCE:TRIMMED', // before this stage
      `1:${causal}:TRIMMED`, // Section 2's own rule (15 on active days, 13 on completed days)
      `0:${causal}:TRIMMED`, // rule 16, Sections 1 and 3-7 in index order
      `2:${causal}:TRIMMED`,
      `3:${causal}:TRIMMED`,
      `5:${causal}:TRIMMED`,
      `6:${causal}:TRIMMED`,
      '2:NON_FOCUS_EVIDENCE:TRIMMED', // rule 18
      '2:NON_BENCHMARK_TELEMETRY:TRIMMED', // rule 19
      '2:UNFOCUSED_PORTFOLIO_MENTION:TRIMMED', // rule 20
      '3:NON_INITIATING_EVIDENCE:TRIMMED', // rule 22
      '3:NON_INITIATING_TELEMETRY:TRIMMED',
      '3:NON_INITIATING_MENTION:TRIMMED',
      '5:UNGROUNDED_OPPORTUNITY_SUBJECT:TRIMMED', // rule 24
      '4:OPTIONAL_SECTION_VALIDATION:-' // the last-resort step, after this stage
    ], marketState);
  }
});

test('Step 9D.5b: Section 2\'s rules 14 then 15 on the same section keep today\'s order, in every state', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt, overlayAsOf, currentPublishedAt] = row;
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const input = active
      ? activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, principalCatalysts: []})
      : completedInput(marketState, generatedAt);
    if (!active) input.marketPackages[0].evidenceContext.principalCatalysts = [];
    const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
    output.sections[1] = {...output.sections[1],
      content: 'Microsoft raised its outlook during the U.S. session. '
        + `Microsoft outlook sent stocks lower at Friday's close. ${CAUSAL}`,
      evidenceRefs: active ? ['e1'] : ['e2'], uncertainties: []};
    const {status, events} = await eventsFor(input, output);
    assert.equal(status, 'NORMAL', marketState);
    assert.deepEqual(events, active
      ? ['1:MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST:TRIMMED',
        '1:MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST:TRIMMED']
      : ['1:MISSING_PRINCIPAL_CATALYST:TRIMMED'], marketState);
  }
});

test('Step 9D.5b: rule 12 empties Section 2 before the causal rules can act, on active days only', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt, overlayAsOf, currentPublishedAt] = row;
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    // e2 is a driver in both fixtures but never a current-session one; on completed days it is
    // also a principal catalyst, so no Section 2 rule fires there.
    fixture.output.sections[1] = {...fixture.output.sections[1],
      content: `Supported analysis. ${CAUSAL}`, evidenceRefs: ['e2'], uncertainties: []};
    const {status, events} = await eventsFor(fixture.input, fixture.output);
    if (ACTIVE_MARKET_STATES.has(marketState)) {
      assert.equal(status, 'DEGRADED', marketState);
      assert.deepEqual(events, ['1:MISSING_CURRENT_SESSION_DRIVER:-'], marketState);
    } else {
      assert.equal(status, 'NORMAL', marketState);
      assert.deepEqual(events, [], marketState);
    }
  }
});

test('Step 9D.5b: Section 3\'s rule 19 trim comes before rule 21\'s final-blank events, in every state', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt] = row;
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const input = active ? activeInput(row, {myStocks: []}) : completedInput(marketState, generatedAt);
    const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
    setSection(output, 2, 'Generic index commentary. Apple (AAPL) is not part of this list.',
      [active ? 'e2' : 'e1'], ['t1', 't2']);
    const {status, events} = await eventsFor(input, output);
    assert.equal(status, 'DEGRADED', marketState);
    assert.deepEqual(events, [
      '2:NON_BENCHMARK_TELEMETRY:TRIMMED',
      '2:NON_FOCUS_EVIDENCE:-',
      '2:UNFOCUSED_PORTFOLIO_MENTION:-'
    ], marketState);
  }
});

test('Step 9D.5b: Section 4 is emptied before Section 6, in every state', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt] = row;
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const input = active ? activeInput(row) : completedInput(marketState, generatedAt);
    const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
    setSection(output, 3, 'Apple (AAPL) is not part of this list.', [active ? 'e2' : 'e1'], ['t1']);
    setSection(output, 5, 'There is a clear opportunity for investors who act now.', [active ? 'e1' : 'e2']);
    const {status, events} = await eventsFor(input, output);
    assert.equal(status, 'DEGRADED', marketState);
    assert.deepEqual(events, [
      '3:NON_INITIATING_EVIDENCE:-',
      '3:NON_INITIATING_TELEMETRY:-',
      // Active days cite the focus ref e1 without naming its subject; completed days cite e2,
      // which is not a focus ref.
      active ? '5:UNGROUNDED_OPPORTUNITY_SUBJECT:-' : '5:UNSUPPORTED_OPPORTUNITY_CLAIM:-'
    ], marketState);
  }
});

test('Step 9D.5b: last-resort events follow section order and keep the active-only detail', async () => {
  for (const row of MARKET_STATE_CASES) {
    const [marketState, generatedAt, overlayAsOf, currentPublishedAt] = row;
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    setSection(fixture.output, 2, 'Generic index commentary.', [active ? 'e1' : 'e4']);
    fixture.output.sections[5] = {...fixture.output.sections[5],
      content: `${fixture.output.sections[5].content} It examines evidenceContext.broadMarketFocus directly.`};
    const {status, events} = await eventsFor(fixture.input, fixture.output);
    assert.equal(status, 'DEGRADED', marketState);
    assert.deepEqual(events, active
      ? ['2:OPTIONAL_SECTION_VALIDATION:-[MISSING_VALIDATED_FOCUS_SUBJECT]',
        '5:OPTIONAL_SECTION_VALIDATION:-[INTERNAL_IDENTIFIER_LEAK]']
      : ['2:OPTIONAL_SECTION_VALIDATION:-', '5:OPTIONAL_SECTION_VALIDATION:-'], marketState);
  }
});

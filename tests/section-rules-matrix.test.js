// Step 9D.1: one table-driven test recording today's behaviour of every
// section rule (the Step 9D plan's inventory), run across all six market
// states plus one extra "live day with no current-session news" case.
//
// This step is test-only and changes nothing under lib/ or api/. It is a
// characterization test: it records what the code does today, including a
// known inconsistency (see the dedicated test near the end), so a later
// Step 9D refactor step can be checked against this file instead of against
// memory. Fixing anything found here is explicitly out of scope for 9D.1.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {createEvidenceItem} = require('../lib/evidence-items');
const {
  richCompletedUsWeekInput,
  supportedOutput: supportedCompletedUsOutput
} = require('./fixtures/us-market-brief-quality');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  UNSUPPORTED_CAUSALITY_QUALIFIER,
  activeUsInput,
  normalOutput,
  marketStateCase,
  thinCompletedMarketStateCase,
  unlinkedStockSnapshot,
  invokeCounted,
  invokeWithSectionEvents
} = require('./fixtures/market-state-cases');

function sectionName(index) { return REPORT_SECTION_NAMES[index]; }

function eventCategories(diagnostics, sectionIndex) {
  return diagnostics
    .filter(value => value.stage === 'claudeAnalysisSectionNormalization'
      && value.sectionIndex === sectionIndex)
    .map(value => ({category: value.violationCategory, action: value.action ?? null}));
}

// ---------------------------------------------------------------------------
// The rule table. Each row is one section rule from the Step 9D inventory.
// `build` mutates a fresh per-state {input, output} fixture into the
// breaking case; `expect` asserts what the pipeline does with it today.
// `sessionMode` documents whether the row targets active days, completed
// days, or both (every row is still run in all six states; `expect`
// branches on ACTIVE_MARKET_STATES where today's behaviour itself differs
// by state, which is exactly the thing Step 9D.2+ will move into settings).
// ---------------------------------------------------------------------------
const RULE_CASES = [
  {
    id: 'R4-unknown-ref-blanks-section',
    note: 'Unknown-but-well-formed refs in Section 5 with no valid ref left blank the section.',
    build({output}) {
      output.sections[4].evidenceRefs = ['e999'];
      output.sections[4].telemetryRefs = ['t1', 't999'];
    },
    expect({result, calls, diagnostics}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.status, 'DEGRADED');
      const target = result.output.sections[4];
      assert.equal(target.content, null);
      assert.deepEqual(target.evidenceRefs, []);
      assert.deepEqual(target.telemetryRefs, []);
      assert.deepEqual(target.uncertainties,
        [`Not enough data to write the ${sectionName(4)} section.`]);
      assert.equal(result.output.evidenceGaps.includes(target.uncertainties[0]), true);
      assert.deepEqual(eventCategories(diagnostics, 4),
        [{category: 'UNKNOWN_SECTION_REFERENCE', action: null}]);
    }
  },
  (() => {
    let validEvidenceRefs;
    let validTelemetryRefs;
    return {
      id: 'R4-unknown-ref-trims-beside-valid-ref',
      note: 'An unknown ref beside a valid ref in Section 5 is dropped; the section survives.',
      build({output}) {
        validEvidenceRefs = output.sections[4].evidenceRefs.slice();
        validTelemetryRefs = output.sections[4].telemetryRefs.slice();
        output.sections[4].evidenceRefs = [...validEvidenceRefs, 'e999'];
        output.sections[4].telemetryRefs = [...validTelemetryRefs, 't999'];
      },
      expect({fixture, result, calls, diagnostics}) {
        assert.equal(result.type, 'SUCCESS');
        assert.equal(calls, 1);
        assert.equal(result.output.status, 'NORMAL');
        assert.deepEqual(result.output.sections[4].evidenceRefs, validEvidenceRefs);
        assert.deepEqual(result.output.sections[4].telemetryRefs, validTelemetryRefs);
        assert.equal(result.output.sections[4].content, fixture.output.sections[4].content);
        assert.deepEqual(eventCategories(diagnostics, 4),
          [{category: 'UNKNOWN_SECTION_REFERENCE', action: 'TRIMMED'}]);
      }
    };
  })(),
  {
    id: 'R4-unknown-ref-in-section-1-fails-report',
    note: 'An unknown ref in Section 1 is a hard failure in every state, retried once.',
    build({output}) {
      output.sections[0].evidenceRefs = [...output.sections[0].evidenceRefs, 'e999'];
    },
    expect({result, calls}) {
      assert.equal(result.type, 'CONTRACT_FAILURE');
      assert.match(result.message, /unknown or invalid reference/);
      assert.equal(calls, 2);
    }
  },
  {
    id: 'R5-duplicate-telemetry-and-uncertainties-canonicalized',
    note: 'Duplicate/blank-after-trim telemetryRefs and uncertainties are deduped silently.',
    build({output}) {
      output.sections[4] = {
        ...output.sections[4],
        telemetryRefs: ['t1', 't1'],
        uncertainties: ['Residual note.', 'Residual note.', '  ']
      };
    },
    expect({result, calls}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.status, 'NORMAL');
      assert.deepEqual(result.output.sections[4].telemetryRefs, ['t1']);
      assert.deepEqual(result.output.sections[4].uncertainties, ['Residual note.']);
    }
  },
  {
    id: 'R6-R7-internal-identifier-leak-blanks-section',
    note: 'An internal-identifier leak in Section 5 blanks only that section (OPTIONAL_SECTION_VALIDATION).',
    build({output}) {
      output.sections[4].content =
        `${output.sections[4].content} It examines evidenceContext.broadMarketFocus directly.`;
    },
    expect({result, calls, diagnostics}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.status, 'DEGRADED');
      assert.equal(result.output.sections[4].content, null);
      assert.deepEqual(result.output.sections[4].uncertainties,
        [`Not enough data to write the ${sectionName(4)} section.`]);
      assert.deepEqual(eventCategories(diagnostics, 4),
        [{category: 'OPTIONAL_SECTION_VALIDATION', action: null}]);
    }
  },
  {
    id: 'R8-word-overflow-blanks-longest-section',
    note: 'A report over the 2,500-word cap blanks Section 5 (the section this row makes longest).',
    build({output}) {
      output.sections[4].content = Array(1300).fill('Supported analysis.').join(' ');
    },
    expect({result, calls, diagnostics}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.status, 'DEGRADED');
      assert.equal(result.output.sections[4].content, null);
      assert.deepEqual(eventCategories(diagnostics, 4),
        [{category: 'OPTIONAL_SECTION_VALIDATION', action: null}]);
    }
  },
  {
    id: 'R24-section6-ungrounded-opportunity-trimmed',
    note: 'An ungrounded opportunity sentence in Section 6 is removed; a cited risk sentence survives.',
    build({output}) {
      output.sections[5] = {
        ...output.sections[5],
        content: 'A cited risk remains material to the outlook. '
          + 'There is a clear opportunity for investors who act now.',
        evidenceRefs: ['e1'], telemetryRefs: [], uncertainties: []
      };
    },
    expect({result, calls, diagnostics}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.sections[5].content, 'A cited risk remains material to the outlook.');
      const events = eventCategories(diagnostics, 5);
      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'TRIMMED');
      assert.equal(['GENERIC_OPPORTUNITY_CLAIM', 'UNSUPPORTED_OPPORTUNITY_CLAIM',
        'UNGROUNDED_OPPORTUNITY_SUBJECT'].includes(events[0].category), true);
    }
  },
  {
    id: 'R24-section6-all-opportunity-blanks-section',
    note: 'A Section 6 made only of an ungrounded opportunity claim is blanked, not trimmed to nothing.',
    build({output}) {
      output.sections[5] = {
        ...output.sections[5],
        content: 'There is a clear opportunity for investors who act now.',
        evidenceRefs: ['e1'], telemetryRefs: [], uncertainties: []
      };
    },
    expect({result, calls, diagnostics}) {
      assert.equal(result.type, 'SUCCESS');
      assert.equal(calls, 1);
      assert.equal(result.output.status, 'DEGRADED');
      assert.equal(result.output.sections[5].content, null);
      assert.deepEqual(result.output.sections[5].uncertainties,
        ['Not enough data to point out a clear opportunity.']);
    }
  }
];

test('Step 9D.1: section rule table runs unchanged in PRE, REGULAR, POST, CLOSED, WEEKEND and HOLIDAY', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    for (const ruleCase of RULE_CASES) {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const context = `${ruleCase.id} @ ${marketState}`;
      ruleCase.build(fixture);
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      try {
        ruleCase.expect({marketState, fixture, result, calls, diagnostics});
      } catch (error) {
        error.message = `${context}: ${error.message}`;
        throw error;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Section 2 (Key Market Drivers) causal-claim family. These run only on the
// states where the fixture lets a causal claim be built meaningfully with a
// single evidence ref swap, so each is its own small per-family test rather
// than forced into the generic table above; all six states are still one
// loop per test, not six separate tests.
// ---------------------------------------------------------------------------

test('Step 9D.1: Section 2 causal-claim rules behave the same across every state today', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);

    // R7b/R7e completed-side: a causal claim citing a real principal
    // catalyst survives untouched (no rule fires).
    {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const {result, calls} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', `${marketState}: baseline`);
      assert.equal(calls, 1, `${marketState}: baseline`);
    }

    if (active) {
      // R7d: an active-day causal claim with current evidence but no
      // current-session catalyst is trimmed, keeping the rest of the
      // sentence and the cited ref (so it can still reach Further Readings).
      const input = activeUsInput({
        marketState, generatedAt, overlayAsOf, currentPublishedAt, principalCatalysts: []
      });
      const raw = normalOutput(input);
      raw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
        + 'The Microsoft outlook drove stocks higher. The S&P 500 was 1.9% above the prior close.';
      const {result, events} = await invokeWithSectionEvents(input, raw);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.status, 'NORMAL', marketState);
      assert.deepEqual(result.output.sections[1], {
        ...raw.sections[1],
        content: 'Microsoft raised its outlook during the U.S. session. '
          + 'The S&P 500 was 1.9% above the prior close.',
        uncertainties: [UNSUPPORTED_CAUSALITY_QUALIFIER]
      }, marketState);
      assert.deepEqual(result.output.furtherReadings, ['e1'], marketState);
      assert.deepEqual(events, [{
        stage: 'claudeAnalysisSectionNormalization', sectionIndex: 1,
        violationCategory: 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST', action: 'TRIMMED',
        suppliedReferenceCount: 1, allowedReferenceCount: 0, offendingReferenceCount: 0,
        removedSentenceCount: 1
      }], marketState);

      // R7c: a prior-completed-session causal claim with no completed
      // catalyst is trimmed the same way.
      const priorInput = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
      const priorRaw = normalOutput(priorInput);
      priorRaw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
        + 'Microsoft outlook sent stocks lower at Friday\'s close.';
      const {result: priorResult, events: priorEvents} =
        await invokeWithSectionEvents(priorInput, priorRaw);
      assert.equal(priorResult.type, 'SUCCESS', marketState);
      assert.equal(priorResult.output.sections[1].content,
        'Microsoft raised its outlook during the U.S. session.', marketState);
      assert.deepEqual(priorEvents.map(event => [event.violationCategory, event.action]),
        [['MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST', 'TRIMMED']], marketState);
    } else {
      // R7b: a completed-day causal claim with no principal catalyst at all
      // is trimmed the same way, with the same fixed qualifier.
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      fixture.output.sections[1] = {
        ...fixture.output.sections[1],
        content: 'The market finished higher. Momentum alone pushed stocks higher in the session.',
        evidenceRefs: ['e2', 'e3'], telemetryRefs: ['t1'], uncertainties: []
      };
      fixture.input.marketPackages[0].evidenceContext.principalCatalysts = [];
      const {result, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.sections[1].content, 'The market finished higher.', marketState);
      assert.deepEqual(result.output.sections[1].uncertainties,
        [UNSUPPORTED_CAUSALITY_QUALIFIER], marketState);
      assert.deepEqual(eventCategories(diagnostics, 1),
        [{category: 'MISSING_PRINCIPAL_CATALYST', action: 'TRIMMED'}], marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R18/R19/R20/R21: Section 3 (Stocks & Sectors in Focus). Which evidence,
// telemetry and portfolio refs count as "in focus" differs between the
// active fixture (focus = Microsoft/e1, only a benchmark snapshot exists)
// and the completed fixture (focus = Broadcom/e4, Health-care/e5; a
// MSFT stock snapshot t2 exists and is NOT in focus), so each sub-case
// branches on state rather than forcing one set of refs on both.
// ---------------------------------------------------------------------------

test('Step 9D.1: R18/R19/R20/R21 Section 3 rules behave the same across every state today', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);

    // R18 (Step 8O): an extra non-focus evidence ref is dropped, provided a
    // focus ref remains and the text still names its subject.
    {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const [focusRef, nonFocusRef, content] = active
        ? ['e1', 'e2', 'Supported Microsoft analysis.']
        : ['e4', 'e2', 'Broadcom led semiconductor shares, while health-care stocks also advanced.'];
      fixture.output.sections[2] = {
        ...fixture.output.sections[2], content,
        evidenceRefs: [focusRef, nonFocusRef], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.sections[2].content, content, marketState);
      assert.deepEqual(result.output.sections[2].evidenceRefs, [focusRef], marketState);
      assert.deepEqual(eventCategories(diagnostics, 2),
        [{category: 'NON_FOCUS_EVIDENCE', action: 'TRIMMED'}], marketState);
    }

    // R19 (Step 8R.A): an unlinked stock telemetry ref (its company is not
    // an independent broadMarketFocus subject) is dropped; a linked
    // benchmark ref stays.
    {
      const fixture = active
        ? (() => {
            // The focus company here is Microsoft (e1); Apple has no
            // broadMarketFocus entry of its own, so its stock telemetry
            // (t2) is unlinked.
            const input = activeUsInput({
              marketState, generatedAt, overlayAsOf, currentPublishedAt,
              stockSnapshots: [unlinkedStockSnapshot(marketState)]
            });
            const output = normalOutput(input);
            return {input, output};
          })()
        : marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const [content, focusTelemetry, unlinkedTelemetry] = active
        ? ['Supported Microsoft analysis.', 't1', 't2']
        : ['Broadcom led semiconductor shares, while health-care stocks also advanced.', 't1', 't2'];
      fixture.output.sections[2] = {
        ...fixture.output.sections[2], content,
        telemetryRefs: [focusTelemetry, unlinkedTelemetry], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.sections[2].content, content, marketState);
      assert.deepEqual(result.output.sections[2].telemetryRefs, [focusTelemetry], marketState);
      assert.deepEqual(eventCategories(diagnostics, 2),
        [{category: 'NON_BENCHMARK_TELEMETRY', action: 'TRIMMED'}], marketState);
    }

    // R20 (Step 8U.9): a sentence naming a My Stocks / Watchlist company
    // that is not independently in focus is removed; the focus sentence
    // survives.
    {
      const [input, focusRef, focusSentence] = active
        ? [
            activeUsInput({
              marketState, generatedAt, overlayAsOf, currentPublishedAt,
              portfolioContext: {
                myStocks: [], watchlist: [{
                  market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []
                }]
              }
            }),
            'e1', 'Supported Microsoft analysis.'
          ]
        : [
            structuredClone(richCompletedUsWeekInput()),
            'e4', 'Broadcom led semiconductor shares.'
          ];
      if (!active) {
        input.analysisRequest.generatedAt = generatedAt;
        input.marketPackages[0].marketContext.marketState = marketState;
        for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
          input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
      }
      const content = `${focusSentence} Apple (AAPL) is not part of this list.`;
      const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
      output.sections[2] = {
        ...output.sections[2], content, evidenceRefs: [focusRef], telemetryRefs: [], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(input, output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.sections[2].content, focusSentence, marketState);
      assert.deepEqual(eventCategories(diagnostics, 2),
        [{category: 'UNFOCUSED_PORTFOLIO_MENTION', action: 'TRIMMED'}], marketState);
    }

    // R21: when the trim would leave no focus ref at all, Section 3 is
    // blanked instead (the final localize, not a per-violation trim).
    {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      const nonFocusRef = active ? 'e2' : 'e1';
      fixture.output.sections[2] = {
        ...fixture.output.sections[2], content: 'Generic index commentary.',
        evidenceRefs: [nonFocusRef], telemetryRefs: [], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.status, 'DEGRADED', marketState);
      assert.equal(result.output.sections[2].content, null, marketState);
      assert.deepEqual(result.output.sections[2].uncertainties,
        ['Not enough data to point out specific stocks or sectors.'], marketState);
      assert.deepEqual(eventCategories(diagnostics, 2),
        [{category: 'NON_FOCUS_EVIDENCE', action: null}], marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R16 (Step 8U.8): the same causal-claim-without-catalyst rule also covers
// Sections 1, 4, 6 and 7 (array indices 0, 3, 5, 6), independently of
// Section 2's own rule and of Section 4's initiating-list rule. Each target
// section gets a two-sentence causal claim citing an evidence ref that is
// not a principal catalyst; Section 1 is included to show it is trimmed
// like the others but never blanked by this rule.
// ---------------------------------------------------------------------------

test('Step 9D.1: R16 causal-claim-without-catalyst applies the same way to Sections 1, 4, 6 and 7', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const causalSentence = 'The Microsoft outlook drove stocks higher.';

    let input;
    let nonCatalystRef;
    if (active) {
      // additionalItems gives a third evidence item (e3) that is not in
      // principalCatalysts (which stays the default ['e1', 'e2']), so it
      // lacks a catalyst without touching Section 2's own baseline.
      input = activeUsInput({
        marketState, generatedAt, overlayAsOf, currentPublishedAt,
        additionalItems: [createEvidenceItem({
          sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
          title: 'Extra bounded context', summary: 'Supplies extra bounded context.',
          canonicalUrl: 'https://www.reuters.com/markets/us/extra-context',
          publishedAt: '2026-09-04T20:00:00.000Z', symbols: []
        })],
        portfolioContext: {
          myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e3'],
            upcomingEvents: []}],
          watchlist: []
        }
      });
      nonCatalystRef = 'e3';
    } else {
      input = structuredClone(richCompletedUsWeekInput());
      input.analysisRequest.generatedAt = generatedAt;
      input.marketPackages[0].marketContext.marketState = marketState;
      for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
        input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
      // e1 (the Yahoo recap) is evidence but not a principal catalyst
      // (['e2', 'e3', 'e4']); make it the sole initiating-list ref too, so
      // Section 4's own NON_INITIATING rule does not also fire here.
      input.portfolioContext.myStocks = [{
        market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e1'], upcomingEvents: []
      }];
      nonCatalystRef = 'e1';
    }
    const output = active ? normalOutput(input) : supportedCompletedUsOutput(input);
    const twoSentence = descriptive => `${descriptive} ${causalSentence}`;
    output.sections[0] = {...output.sections[0],
      content: twoSentence('Current developments lead the analysis.'),
      evidenceRefs: [nonCatalystRef], telemetryRefs: [], uncertainties: []};
    output.sections[3] = {...output.sections[3],
      content: twoSentence('Microsoft led the initiating list from the open.'),
      evidenceRefs: [nonCatalystRef], telemetryRefs: [], uncertainties: []};
    output.sections[5] = {...output.sections[5],
      content: twoSentence('A cited risk remains material to the outlook.'),
      evidenceRefs: [nonCatalystRef], telemetryRefs: [], uncertainties: []};
    output.sections[6] = {...output.sections[6],
      content: twoSentence('Analysts will watch upcoming guidance closely.'),
      evidenceRefs: [nonCatalystRef], telemetryRefs: [], uncertainties: []};

    const {result, calls, diagnostics} = await invokeCounted(input, output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    const expectedCategory = active
      ? 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST' : 'MISSING_PRINCIPAL_CATALYST';
    const targets = [
      [0, 'Current developments lead the analysis.'],
      [3, 'Microsoft led the initiating list from the open.'],
      [5, 'A cited risk remains material to the outlook.'],
      [6, 'Analysts will watch upcoming guidance closely.']
    ];
    for (const [index, descriptiveSentence] of targets) {
      assert.equal(result.output.sections[index].content, descriptiveSentence,
        `${marketState}: section ${index + 1}`);
      assert.deepEqual(result.output.sections[index].uncertainties,
        [UNSUPPORTED_CAUSALITY_QUALIFIER], `${marketState}: section ${index + 1}`);
      assert.deepEqual(eventCategories(diagnostics, index),
        [{category: expectedCategory, action: 'TRIMMED'}], `${marketState}: section ${index + 1}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R13's "no current evidence" branch, as its own row. On an active day with
// no current-session evidence, Section 2's own cleanup rule accepts ANY
// cited principal catalyst (not just a current-session one). Framed as a
// prior-completed-session claim, this does not create the Section 2
// inconsistency recorded elsewhere in this file: the validator's
// CURRENT_SESSION-specific rule only applies to a non-prior claim, so a
// prior-framed claim citing any catalyst passes untouched end to end.
// Framed with no catalyst at all, the same branch trims it.
// ---------------------------------------------------------------------------

test('Step 9D.1: R13 Section 2\'s "no current evidence" branch accepts any catalyst on active days too', async () => {
  for (const marketState of ['PRE', 'REGULAR', 'POST']) {
    const [, generatedAt, overlayAsOf] = MARKET_STATE_CASES.find(row => row[0] === marketState);

    // (a) a prior-session claim citing a real (non-current) catalyst
    // passes untouched: R7b's own condition is already satisfied.
    {
      const input = activeUsInput({
        marketState, generatedAt, overlayAsOf, currentPublishedAt: '2026-09-01T00:00:00.000Z'
      });
      const raw = normalOutput(input);
      raw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
        + 'Microsoft outlook sent stocks lower at Friday\'s close.';
      raw.sections[1].evidenceRefs = ['e1', 'e2'];
      const {result, events} = await invokeWithSectionEvents(input, raw);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.status, 'NORMAL', marketState);
      assert.deepEqual(result.output.sections[1].content, raw.sections[1].content, marketState);
      assert.deepEqual(events.filter(event => event.sectionIndex === 1), [], marketState);
    }

    // (b) the same no-current-evidence, prior-framed claim with no catalyst
    // cited at all is trimmed by R7b.
    {
      const input = activeUsInput({
        marketState, generatedAt, overlayAsOf, currentPublishedAt: '2026-09-01T00:00:00.000Z',
        principalCatalysts: []
      });
      const raw = normalOutput(input);
      raw.sections[1].content = 'Microsoft raised its outlook during the U.S. session. '
        + 'Microsoft outlook sent stocks lower at Friday\'s close.';
      const {result, events} = await invokeWithSectionEvents(input, raw);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.sections[1].content,
        'Microsoft raised its outlook during the U.S. session.', marketState);
      assert.deepEqual(result.output.sections[1].uncertainties,
        [UNSUPPORTED_CAUSALITY_QUALIFIER], marketState);
      assert.deepEqual(events.filter(event => event.sectionIndex === 1)
        .map(event => [event.violationCategory, event.action]),
        [['MISSING_PRINCIPAL_CATALYST', 'TRIMMED']], marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R25: "Section 1 must have content" applies only on completed days. On
// active days a null Section 1 is accepted by this rule (other rules, such
// as the Step 8U.2 survival normaliser, may still act on it elsewhere).
// ---------------------------------------------------------------------------

test('Step 9D.1: R25 Section 1 must have content only on completed days', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.status = 'DEGRADED';
    fixture.output.evidenceGaps = ['The supplied evidence did not support this analytical section.'];
    fixture.output.sections[0] = {
      ...fixture.output.sections[0], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['The supplied evidence did not support this analytical section.']
    };
    const {result, calls} = await invokeCounted(fixture.input, fixture.output);
    if (active) {
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.sections[0].content, null, marketState);
    } else {
      assert.equal(result.type, 'CONTRACT_FAILURE', marketState);
      assert.match(result.message, /executive market summary requires supported content/, marketState);
      assert.equal(calls, 2, marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R29: Further Readings is resolved from two different sources depending on
// state. On active days it is the eligible, CITED Yahoo-sourced refs across
// the surviving sections; on completed days it is the package's own
// furtherReadings list, unconditionally, even once nothing in the final
// report cites those refs any more.
// ---------------------------------------------------------------------------

test('Step 9D.1: R29 Further Readings source differs by state exactly as it does today', async () => {
  // Active: an eligible Yahoo ref (e3) that is cited reaches Further
  // Readings; the originally-cited e1 (also eligible) is excluded once it
  // is no longer cited anywhere, because the active path is citation-based.
  for (const marketState of ['PRE', 'REGULAR', 'POST']) {
    const [, generatedAt, overlayAsOf, currentPublishedAt] =
      MARKET_STATE_CASES.find(row => row[0] === marketState);
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf, currentPublishedAt,
      additionalItems: [createEvidenceItem({
        sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
        title: 'Second Yahoo item', summary: 'A second eligible Yahoo item.',
        canonicalUrl: 'https://finance.yahoo.com/news/second-yahoo-item.html',
        // Reuse the same timestamp as the fixture's own "current" item, so
        // this falls inside the active-session evidence window exactly as
        // that one does.
        publishedAt: currentPublishedAt, symbols: [], publisher: 'Yahoo Finance'
      })]
    });
    const output = normalOutput(input);
    // Cite only e3 (the second Yahoo item) everywhere; e1 is eligible but
    // no longer cited by any surviving section.
    for (let index = 0; index < 7; index++) {
      if (index === 3) continue;
      output.sections[index] = {...output.sections[index], evidenceRefs: ['e3']};
    }
    const {result} = await invokeCounted(input, output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.deepEqual(result.output.furtherReadings, ['e3'], marketState);
  }

  // Completed: blank the two sections that cite the focus refs e4/e5, so
  // nothing in the final report cites them any more; Further Readings
  // still equals the package's own furtherReadings list unchanged.
  for (const [marketState, generatedAt] of [['CLOSED', '2026-09-04T22:00:00.000Z'],
    ['WEEKEND', '2026-09-06T10:00:00.000Z'], ['HOLIDAY', '2026-09-07T16:00:00.000Z']]) {
    const fixture = marketStateCase(marketState, generatedAt);
    const packageFurtherReadings = fixture.input.marketPackages[0].evidenceContext.furtherReadings
      .map(entry => entry.evidenceRef);
    assert.deepEqual(packageFurtherReadings, ['e1', 'e2', 'e4', 'e5'], marketState);
    fixture.output.sections[2] = {
      ...fixture.output.sections[2], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['Not enough data to point out specific stocks or sectors.']
    };
    fixture.output.sections[4] = {
      ...fixture.output.sections[4], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['The supplied evidence did not support this analytical section.']
    };
    fixture.output.status = 'DEGRADED';
    const {result} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.deepEqual(result.output.furtherReadings, packageFurtherReadings, marketState);
  }
});

// ---------------------------------------------------------------------------
// R22/R23: Section 4 (My Stocks / Watchlist). Which evidence ref counts as
// "belonging to the initiating list" differs between the active fixture
// (e1) and the completed fixture (e2, from richCompletedUsWeekInput's MSFT
// entry), so this builds its own myStocks/watchlist per state rather than
// forcing the generic table above to know that.
// ---------------------------------------------------------------------------

test('Step 9D.1: R22/R23 Section 4 rules behave the same across every state today', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const initiatingRef = active ? 'e1' : 'e2';

    // R22: a sentence naming a Watchlist stock (outside the initiating
    // list) is removed; the initiating-list text and ref survive.
    {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      fixture.input = structuredClone(fixture.input);
      fixture.input.portfolioContext.myStocks = [{
        market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: [initiatingRef],
        upcomingEvents: []
      }];
      fixture.input.portfolioContext.watchlist = [{
        market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []
      }];
      fixture.output.sections[3] = {
        ...fixture.output.sections[3],
        content: 'Microsoft led the initiating list. Apple (AAPL) is not part of this list.',
        // A non-initiating telemetry ref ('t1' is not among myStocks'
        // telemetryRefs, which are []) is what puts Section 4 into the
        // non-initiating-reference block at all; the mention-removal only
        // runs once that block is already entered.
        evidenceRefs: [initiatingRef], telemetryRefs: ['t1'], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.sections[3].content, 'Microsoft led the initiating list.',
        marketState);
      assert.deepEqual(result.output.sections[3].telemetryRefs, [], marketState);
      const events = eventCategories(diagnostics, 3);
      assert.deepEqual(
        events.find(event => event.category === 'NON_INITIATING_MENTION'),
        {category: 'NON_INITIATING_MENTION', action: 'TRIMMED'}, marketState);
      assert.deepEqual(
        events.find(event => event.category === 'NON_INITIATING_TELEMETRY'),
        {category: 'NON_INITIATING_TELEMETRY', action: 'TRIMMED'}, marketState);
    }

    // R23: an empty initiating list that gets the wrong "no securities"
    // text is rewritten to the exact deterministic text, silently (the
    // last-resort validator step's "OPTIONAL_SECTION_VALIDATION" handling
    // for Section 4 special-cases an empty initiating list and does not
    // add an evidence gap, so this does not degrade the report).
    {
      const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      fixture.input = structuredClone(fixture.input);
      fixture.input.portfolioContext.myStocks = [];
      const baselineStatus = fixture.output.status;
      fixture.output.sections[3] = {
        ...fixture.output.sections[3], content: 'There are no stocks to show.',
        evidenceRefs: [], telemetryRefs: [], uncertainties: []
      };
      const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.status, baselineStatus, marketState);
      assert.equal(result.output.sections[3].content, EMPTY_INITIATING_LIST_CONTENT.myStocks,
        marketState);
      assert.deepEqual(eventCategories(diagnostics, 3),
        [{category: 'OPTIONAL_SECTION_VALIDATION', action: null}], marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R9: the "controlled unavailable" forced blank. When a market package has
// no material events / principal catalysts at all, Section 2 is forced
// blank regardless of what the writer sent; when it has no broad-market
// focus, Section 3 is forced blank the same way. This overrides the
// writer's own content, not just its refs.
// ---------------------------------------------------------------------------

test('Step 9D.1: R9 the controlled-unavailable forced blank fires the same way in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);

    // No drivers anywhere in the package forces Section 2 blank even though
    // the writer's own Section 2 text looked fine.
    {
      const input = active
        ? activeUsInput({
            marketState, generatedAt, overlayAsOf, currentPublishedAt,
            materialEvents: [], principalCatalysts: [], broadMarketFocus: []
          })
        : (() => {
            const base = structuredClone(richCompletedUsWeekInput());
            base.analysisRequest.generatedAt = generatedAt;
            base.marketPackages[0].marketContext.marketState = marketState;
            for (const snapshot of base.marketPackages[0].telemetry.benchmarkSnapshots.concat(
              base.marketPackages[0].telemetry.stockSnapshots)) {
              snapshot.snapshot.marketState = marketState;
            }
            base.marketPackages[0].evidenceContext.materialEvents = [];
            base.marketPackages[0].evidenceContext.principalCatalysts = [];
            // Broad-market focus entries must reference a material-role
            // (materialEvents / principalCatalysts) ref, so clearing both
            // forces broadMarketFocus to clear too -- an input-shape
            // constraint, not part of the behaviour under test here.
            base.marketPackages[0].evidenceContext.broadMarketFocus = [];
            return base;
          })();
      const output = active ? normalOutput(input) : (() => {
        const raw = supportedCompletedUsOutput(input);
        raw.sections[1] = {...raw.sections[1], content: 'Supported analysis.'};
        return raw;
      })();
      const {result} = await invokeCounted(input, output);
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(result.output.status, 'DEGRADED', marketState);
      assert.equal(result.output.sections[1].content, null, marketState);
      assert.deepEqual(result.output.sections[1].uncertainties,
        ['Not enough data to point to a main market driver.'], marketState);
      assert.equal(result.output.evidenceGaps.includes(
        'Not enough data to point to a main market driver.'), true, marketState);
    }

    // No broad-market focus forces Section 3 blank.
    {
      if (active) {
        const input = activeUsInput({
          marketState, generatedAt, overlayAsOf, currentPublishedAt, broadMarketFocus: []
        });
        const output = normalOutput(input);
        const {result} = await invokeCounted(input, output);
        assert.equal(result.type, 'SUCCESS', marketState);
        assert.equal(result.output.status, 'DEGRADED', marketState);
        assert.equal(result.output.sections[2].content, null, marketState);
        assert.deepEqual(result.output.sections[2].uncertainties,
          ['Not enough data to point out specific stocks or sectors.'], marketState);
      } else {
        const fixture = thinCompletedMarketStateCase(marketState, generatedAt);
        const {result} = await invokeCounted(fixture.input, fixture.output);
        assert.equal(result.type, 'SUCCESS', marketState);
        assert.equal(result.output.sections[2].content, null, marketState);
        assert.deepEqual(result.output.sections[2].uncertainties,
          ['Not enough data to point out specific stocks or sectors.'], marketState);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// R10: the FAILED-reply rescue. On active days any one supported section
// rescues a FAILED reply to DEGRADED; on completed days only Section 1
// counts. Both are recorded here exactly as they differ today.
// ---------------------------------------------------------------------------

test('Step 9D.1: R10 the FAILED-reply rescue differs by state exactly as it does today', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.status = 'FAILED';
    for (let index = 0; index < 7; index++) {
      if (active && index === 2) continue; // keep Section 3 supported on active days
      if (!active && index === 0) continue; // keep Section 1 supported on completed days
      fixture.output.sections[index] = {
        ...fixture.output.sections[index], content: null, evidenceRefs: [], telemetryRefs: [],
        uncertainties: ['The supplied evidence did not support this analytical section.']
      };
    }
    const {result} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(result.output.status, 'DEGRADED', `${marketState}: FAILED is rescued to DEGRADED`);
    if (active) {
      assert.notEqual(result.output.sections[2].content, null, marketState);
    } else {
      assert.notEqual(result.output.sections[0].content, null, marketState);
    }
  }
});

// ---------------------------------------------------------------------------
// R28: the "nothing survived" fallback only exists on active days. On
// completed days Section 1 is required, so the same all-sections-null shape
// is not a valid completed FAILED reply to begin with -- recorded here as a
// state difference, not fixed.
// ---------------------------------------------------------------------------

test('Step 9D.1: R28 the nothing-survived FAILED fallback is active-only, as it is today', async () => {
  const activeInput = activeUsInput({marketState: 'REGULAR'});
  const nothingOutput = normalOutput(activeInput, {
    status: 'DEGRADED',
    evidenceGaps: ['Other analytical sections were not supported by the supplied evidence.']
  });
  for (let index = 0; index < 7; index++) {
    nothingOutput.sections[index] = {
      ...nothingOutput.sections[index], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['The supplied evidence did not support this analytical section.']
    };
  }
  const {result} = await invokeCounted(activeInput, nothingOutput);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.output.status, 'FAILED');
  assert.equal(result.output.evidenceGaps.includes(
    'Not enough data to produce an analysis for the current session.'), true);
});

// ---------------------------------------------------------------------------
// The Step 9D review's one recorded inconsistency. On an active day with
// older (non-current-session) evidence but nothing in the current-session
// window, Section 2's cleanup rule (R7b/MISSING_PRINCIPAL_CATALYST) accepts
// any cited principal catalyst, but the final checker and the Step 8U.8
// family (R16) require a CURRENT_SESSION catalyst regardless. Section 2
// survives cleanup, then fails the final checker, and is blanked by the
// last-resort step (R27/OPTIONAL_SECTION_VALIDATION) instead of by its own
// rule. This is recorded AS-IS. It is not a decision and nothing here fixes
// it; see the Step 9D plan, Part A, for the write-up.
// ---------------------------------------------------------------------------

test('Step 9D.1: RECORDED AS-IS, NOT A DECISION -- active day, older evidence, no current-session news', async () => {
  for (const marketState of ['PRE', 'REGULAR', 'POST']) {
    const timing = MARKET_STATE_CASES.find(row => row[0] === marketState);
    const [, generatedAt, overlayAsOf] = timing;
    // Push the "current" item's publishedAt well before the active-session
    // window, so currentSessionEvidenceContext finds nothing current even
    // though the package still has evidence (the no-current-evidence
    // shortcut only fires when there is no evidence at all).
    const input = activeUsInput({
      marketState, generatedAt, overlayAsOf,
      currentPublishedAt: '2026-09-01T00:00:00.000Z'
    });
    const raw = normalOutput(input);
    raw.sections[1].content = 'The Microsoft outlook drove stocks higher.';
    raw.sections[1].evidenceRefs = ['e1'];
    const {result, events} = await invokeWithSectionEvents(input, raw);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    // Section 2 is blanked -- but by the last-resort validator step, not by
    // its own MISSING_*_PRINCIPAL_CATALYST rule, because that rule accepted
    // the (non-current) principal catalyst e1 during cleanup.
    assert.equal(result.output.sections[1].content, null, marketState);
    assert.deepEqual(events.filter(event => event.sectionIndex === 1)
      .map(event => event.violationCategory),
      ['OPTIONAL_SECTION_VALIDATION'], marketState);
  }
});

// ---------------------------------------------------------------------------
// Request-size guard. Step 9D must not change the bytes sent to the writer.
// These are the figures recorded in docs/DECISIONS.md as of Step 8U.10 /
// Step 9B (HEAD df054e1).
// ---------------------------------------------------------------------------

test('Step 9D.1: writer request size on the rich completed fixture is unchanged', () => {
  const input = richCompletedUsWeekInput();
  const request = buildClaudeAnalysisRequest(input);
  assert.equal(Buffer.byteLength(request.system, 'utf8'), 19700);
  assert.equal(Buffer.byteLength(JSON.stringify(request), 'utf8'), 31893);
});

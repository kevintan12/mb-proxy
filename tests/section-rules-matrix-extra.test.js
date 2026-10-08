// Step 9D.5a: the matrix rows the Step 9D.1 matrix (tests/section-rules-matrix.test.js)
// does not have, so that every rule in the shared registry (lib/section-rules.js) has
// at least one row run across all six market states. Like the 9D.1 matrix this is a
// characterization test: it records what the code does today, including where that
// differs by state, and fixes nothing.
//
// Labels here are the inventory's own rule numbers (R1 = rule 1, and so on). The
// 9D.1 matrix uses some older labels (for example its R8 is rule 26, the word cap);
// tests/section-rules-registry.test.js holds the one table mapping both files'
// labels to rule numbers.
//
// Rows that test the final checker directly take the pipeline's own valid final
// output, break one thing, and assert the exact checker message -- those messages
// are read by text by the last-resort step (rule 27), so pinning them here also
// guards the "byte for byte" requirement.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {validateClaudeAnalysisOutput} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {createEvidenceItem} = require('../lib/evidence-items');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  activeUsInput,
  normalOutput,
  providerTransport,
  marketStateCase,
  invokeCounted
} = require('./fixtures/market-state-cases');

function sectionEvents(diagnostics, sectionIndex) {
  return diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'
    && value.sectionIndex === sectionIndex);
}

// The checker's errors for the pipeline's own valid final output after `mutate`.
async function checkerErrorsAfter(input, output, mutate) {
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS');
  const finalOutput = structuredClone(result.output);
  assert.equal(validateClaudeAnalysisOutput(finalOutput, input).valid, true);
  mutate(finalOutput);
  return validateClaudeAnalysisOutput(finalOutput, input).errors;
}

// An active-day input with one extra evidence item (e3) that is neither a material
// event nor a principal catalyst, i.e. not a Section 2 driver.
function activeInputWithNonDriver(marketState, generatedAt, overlayAsOf, currentPublishedAt) {
  return activeUsInput({
    marketState, generatedAt, overlayAsOf, currentPublishedAt,
    additionalItems: [createEvidenceItem({
      sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
      title: 'Extra bounded context', summary: 'Supplies extra bounded context.',
      canonicalUrl: 'https://www.reuters.com/markets/us/extra-context',
      publishedAt: '2026-09-04T20:00:00.000Z', symbols: []
    })]
  });
}

test('Step 9D.5a: R1 Section 8 must arrive empty, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    // Cleanup side: a non-empty s8 transport payload is a hard failure, retried once.
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const transport = {...providerTransport(fixture.output), s8: {content: 'Extra reading.'}};
    let calls = 0;
    const result = await invokeClaudeAnalysis({
      input: fixture.input, apiKey: 'test-key',
      fetchImpl: async () => {
        calls++;
        return {ok: true, status: 200,
          async json() { return {content: [{type: 'text', text: JSON.stringify(transport)}]}; }};
      }
    });
    assert.equal(result.type, 'CONTRACT_FAILURE', marketState);
    assert.equal(calls, 2, marketState);

    // Checker side: Section 8 with content fails with the exact message.
    const errors = await checkerErrorsAfter(fixture.input, fixture.output, output => {
      output.sections[7].content = 'Extra reading.';
    });
    assert.equal(errors.includes('FURTHER READINGS section is resolved by MarketBrief'), true, marketState);
  }
});

test('Step 9D.5a: R2 analyst-desk jargon is rewritten in plain English, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.sections[4] = {...fixture.output.sections[4], content: 'Sector rotation continued.'};
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.equal(result.output.sections[4].content, 'Money moving between sectors continued.', marketState);
    assert.deepEqual(sectionEvents(diagnostics, 4), [], marketState);
  }
});

test('Step 9D.5a: R3 a repeated evidence ref is removed silently, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const original = fixture.output.sections[4].evidenceRefs.slice();
    fixture.output.sections[4] = {...fixture.output.sections[4],
      evidenceRefs: [...original, original[0]]};
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.deepEqual(result.output.sections[4].evidenceRefs, original, marketState);
    assert.deepEqual(sectionEvents(diagnostics, 4), [], marketState);
  }
});

test('Step 9D.5a: R8/R27 content citing no evidence is emptied by the last-resort step, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.sections[4] = {...fixture.output.sections[4], evidenceRefs: [], telemetryRefs: []};
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    assert.deepEqual(result.output.sections[4], {
      name: 'MARKET INTERPRETATION', content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['Not enough data to write the MARKET INTERPRETATION section.']
    }, marketState);
    assert.deepEqual(sectionEvents(diagnostics, 4), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 4,
      violationCategory: 'OPTIONAL_SECTION_VALIDATION', suppliedReferenceCount: 0,
      allowedReferenceCount: 0, offendingReferenceCount: 1
    }], marketState);

    const baseline = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const errors = await checkerErrorsAfter(baseline.input, baseline.output, output => {
      output.sections[4].evidenceRefs = [];
    });
    assert.equal(errors.includes('sections[4]: factual content requires supplied evidence'), true, marketState);
  }
});

test('Step 9D.5a: R11 Section 2 must cite a driver ref, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    let input;
    let output;
    if (active) {
      input = activeInputWithNonDriver(marketState, generatedAt, overlayAsOf, currentPublishedAt);
      output = normalOutput(input);
    } else {
      ({input, output} = marketStateCase(marketState, generatedAt));
      // e1 (the Yahoo recap) stops being a material event, so it is not a driver.
      input.marketPackages[0].evidenceContext.materialEvents =
        input.marketPackages[0].evidenceContext.materialEvents.filter(reference => reference !== 'e1');
    }
    const nonDriverRef = active ? 'e3' : 'e1';
    const raw = structuredClone(output);
    raw.sections[1] = {...raw.sections[1], content: 'Supported analysis.',
      evidenceRefs: [nonDriverRef], uncertainties: []};
    const {result, calls, diagnostics} = await invokeCounted(input, raw);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    assert.equal(result.output.sections[1].content, null, marketState);
    // Active days: the current-session driver rule (rule 12) empties it first, in
    // the cleanup stage. Completed days: no cleanup rule fires, so the checker's
    // rule 11 message reaches the last-resort step.
    assert.deepEqual(sectionEvents(diagnostics, 1).map(event => event.violationCategory),
      [active ? 'MISSING_CURRENT_SESSION_DRIVER' : 'OPTIONAL_SECTION_VALIDATION'], marketState);
    assert.deepEqual(result.output.sections[1].uncertainties, [active
      ? 'Not enough data to say what moved the market.'
      : 'Not enough data to write the KEY MARKET DRIVERS section.'], marketState);

    const errors = await checkerErrorsAfter(input, output, finalOutput => {
      finalOutput.sections[1].evidenceRefs = [nonDriverRef];
    });
    assert.equal(errors.includes(
      'sections[1]: key market drivers require a material event or principal catalyst'), true, marketState);
  }
});

test('Step 9D.5a: R12 Section 2 needs a current-session driver on active days only', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    // e2 is a driver in both fixtures, but never a current-session one.
    fixture.output.sections[1] = {...fixture.output.sections[1], content: 'Supported analysis.',
      evidenceRefs: ['e2'], uncertainties: []};
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    if (active) {
      assert.equal(result.output.status, 'DEGRADED', marketState);
      assert.deepEqual(result.output.sections[1].uncertainties,
        ['Not enough data to say what moved the market.'], marketState);
      assert.deepEqual(sectionEvents(diagnostics, 1), [{
        stage: 'claudeAnalysisSectionNormalization', sectionIndex: 1,
        violationCategory: 'MISSING_CURRENT_SESSION_DRIVER',
        suppliedReferenceCount: 1, allowedReferenceCount: 1, offendingReferenceCount: 1
      }], marketState);
    } else {
      assert.equal(result.output.status, 'NORMAL', marketState);
      assert.equal(result.output.sections[1].content, 'Supported analysis.', marketState);
      assert.deepEqual(sectionEvents(diagnostics, 1), [], marketState);
    }

    const baseline = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const errors = await checkerErrorsAfter(baseline.input, baseline.output, output => {
      output.sections[1].evidenceRefs = ['e2'];
    });
    assert.equal(errors.includes(
      'sections[1]: active key market drivers require CURRENT_SESSION driver evidence'), active, marketState);
  }
});

test('Step 9D.5a: R17 Section 3 must cite a focus ref and name its subject, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const [focusRef, nonFocusDriverRef] = active ? ['e1', 'e2'] : ['e4', 'e2'];
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.sections[2] = {...fixture.output.sections[2], content: 'Generic index commentary.',
      evidenceRefs: [focusRef], telemetryRefs: [], uncertainties: []};
    const {result, calls, diagnostics} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    assert.deepEqual(result.output.sections[2].uncertainties,
      ['Not enough data to write the STOCKS & SECTORS IN FOCUS section.'], marketState);
    // No cleanup rule fires; the last-resort step empties it. Only active days add
    // the checker's category list to the event.
    assert.deepEqual(sectionEvents(diagnostics, 2), [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
      violationCategory: 'OPTIONAL_SECTION_VALIDATION', suppliedReferenceCount: 0,
      allowedReferenceCount: 0, offendingReferenceCount: 1,
      ...(active ? {validationViolationCategories: ['MISSING_VALIDATED_FOCUS_SUBJECT']} : {})
    }], marketState);

    const baseline = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const noSubject = await checkerErrorsAfter(baseline.input, baseline.output, output => {
      output.sections[2].content = 'Generic index commentary.';
    });
    assert.equal(noSubject.includes(
      'sections[2]: stocks and sectors must mention a validated broad-market subject'), true, marketState);
    const again = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const noFocus = await checkerErrorsAfter(again.input, again.output, output => {
      output.sections[2].evidenceRefs = [nonFocusDriverRef];
    });
    assert.equal(noFocus.includes(
      'sections[2]: stocks and sectors require broad-market focus evidence'), true, marketState);
  }
});

test('Step 9D.5a: R28 the nothing-survived fallback, recorded in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const active = ACTIVE_MARKET_STATES.has(marketState);
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    fixture.output.status = 'DEGRADED';
    fixture.output.evidenceGaps = ['Other analytical sections were not supported by the supplied evidence.'];
    for (let index = 0; index < 7; index++) {
      fixture.output.sections[index] = {...fixture.output.sections[index], content: null,
        evidenceRefs: [], telemetryRefs: [],
        uncertainties: ['The supplied evidence did not support this analytical section.']};
    }
    const {result, calls} = await invokeCounted(fixture.input, fixture.output);
    if (active) {
      assert.equal(result.type, 'SUCCESS', marketState);
      assert.equal(calls, 1, marketState);
      assert.equal(result.output.status, 'FAILED', marketState);
      assert.equal(result.output.evidenceGaps.includes(
        'Not enough data to produce an analysis for the current session.'), true, marketState);
    } else {
      // Completed days have no fallback: Section 1 is required, so the reply fails
      // the checker and is retried once.
      assert.equal(result.type, 'CONTRACT_FAILURE', marketState);
      assert.equal(calls, 2, marketState);
      assert.match(result.message, /executive market summary requires supported content/, marketState);
    }
  }
});

test('Step 9D.5a: R30 evidenceReferences follow first-use order, in every state', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const fixture = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const {result, calls} = await invokeCounted(fixture.input, fixture.output);
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(calls, 1, marketState);
    const expected = [];
    for (const section of result.output.sections) {
      for (const reference of section.evidenceRefs) if (!expected.includes(reference)) expected.push(reference);
    }
    assert.deepEqual(result.output.evidenceReferences, expected, marketState);

    const baseline = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const errors = await checkerErrorsAfter(baseline.input, baseline.output, output => {
      // Reversed when there are several refs (completed days); dropped when
      // there is only one (active days).
      output.evidenceReferences = output.evidenceReferences.length > 1
        ? output.evidenceReferences.slice().reverse() : [];
    });
    assert.equal(errors.includes('evidenceReferences must match first-use order'), true, marketState);
  }
});

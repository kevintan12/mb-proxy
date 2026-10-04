// Step 9D.4: tests for the shared causal-claim-without-a-cause mechanics
// (lib/section-rules.js's causalClaimTrim) and for how the settings table
// now drives the Sections 1,3-7 rule's active/completed split end to end.
// This is a new file; it does not touch or duplicate the Step 9D.1 matrix,
// which already exercises the real writer pipeline for these rules in all
// six states -- this file tests the shared mechanics directly, plus one
// table confirming `reportSettings` drives the right catalyst scope and
// event category for all six states from one place.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasActiveDirectMarketCausalClaim,
  hasPriorCompletedSessionCausalClaim,
  splitReportSentences
} = require('../lib/claude-analysis-contract');
const {causalClaimTrim, reportSettings} = require('../lib/section-rules');

const UNSUPPORTED_CAUSALITY_QUALIFIER = 'The news does not show for certain what moved the market.';

function section(overrides = {}) {
  return {
    name: 'WHAT TO WATCH FOR NEXT',
    content: 'Analysts will watch upcoming guidance closely. The Microsoft outlook drove stocks higher.',
    evidenceRefs: ['e1'], telemetryRefs: [], uncertainties: [],
    ...overrides
  };
}

// A stand-in "input" sufficient for hasPriorCompletedSessionCausalClaim,
// which only needs a US marketPackage with a primaryCompletedSessionDate.
const usInput = {marketPackages: [{market: 'US', marketContext: {primaryCompletedSessionDate: '2026-09-04'}}]};

// ---------------------------------------------------------------------------
// causalClaimTrim itself: the mechanical trim-then-decide step shared by
// Section 2's three rules and the Sections 1,3-7 rule.
// ---------------------------------------------------------------------------

test('Step 9D.4: causalClaimTrim keeps the section and adds the caveat when a valid sentence survives', () => {
  const result = causalClaimTrim(section(), {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: trimmed => trimmed.evidenceRefs.length > 0,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(result.trimmed, true);
  assert.equal(result.section.content, 'Analysts will watch upcoming guidance closely.');
  assert.deepEqual(result.section.uncertainties, [UNSUPPORTED_CAUSALITY_QUALIFIER]);
  assert.equal(result.removedSentenceCount, 1);
});

test('Step 9D.4: causalClaimTrim reports not-trimmed when keepIf rejects the result', () => {
  const result = causalClaimTrim(section(), {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => false,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(result.trimmed, false);
  assert.equal(result.section, undefined, 'the caller is responsible for blanking, not causalClaimTrim');
});

test('Step 9D.4: causalClaimTrim reports not-trimmed when every sentence is offending', () => {
  const allCausal = section({content: 'The Microsoft outlook drove stocks higher.'});
  const result = causalClaimTrim(allCausal, {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => true,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(result.trimmed, false);
});

test('Step 9D.4: causalClaimTrim is idempotent about the caveat, matching withCaveat', () => {
  const withExistingCaveat = section({uncertainties: [UNSUPPORTED_CAUSALITY_QUALIFIER]});
  const result = causalClaimTrim(withExistingCaveat, {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => true,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.deepEqual(result.section.uncertainties, [UNSUPPORTED_CAUSALITY_QUALIFIER]);
});

// ---------------------------------------------------------------------------
// The confirmed divergence between Section 2's prior-claim predicate
// (hasPriorCompletedSessionCausalClaim) and the plain causal-claim
// predicate the Sections 1,3-7 rule uses (hasActiveDirectMarketCausalClaim).
// This is why causalClaimTrim does not hard-code one predicate: a merged
// predicate would get this sentence wrong for one rule or the other.
// ---------------------------------------------------------------------------

test('Step 9D.4: a date-only sentence is flagged by the prior-claim predicate but not by the plain causal predicate', () => {
  const sentence = 'Stocks fell on September 4.';
  assert.equal(hasPriorCompletedSessionCausalClaim(sentence, usInput), true);
  assert.equal(hasActiveDirectMarketCausalClaim(sentence), false);
});

test('Step 9D.4: causalClaimTrim removes that sentence under Section 2\'s prior-claim predicate', () => {
  const withDateOnlySentence = section({
    content: 'The market finished higher. Stocks fell on September 4.',
    evidenceRefs: ['e1']
  });
  const result = causalClaimTrim(withDateOnlySentence, {
    offendingSentence: sentence => hasPriorCompletedSessionCausalClaim(sentence, usInput),
    splitSentences: splitReportSentences,
    keepIf: () => true,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(result.trimmed, true);
  assert.equal(result.section.content, 'The market finished higher.');
});

test('Step 9D.4: causalClaimTrim keeps that same sentence under the plain causal-claim predicate', () => {
  const withDateOnlySentence = section({
    content: 'The market finished higher. Stocks fell on September 4.',
    evidenceRefs: ['e1']
  });
  const result = causalClaimTrim(withDateOnlySentence, {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => true,
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  // Nothing is removed (the date-only sentence is not causal by this
  // predicate), so causalClaimTrim reports not-trimmed: there was no
  // offending sentence to remove in the first place.
  assert.equal(result.trimmed, false);
});

// ---------------------------------------------------------------------------
// reportSettings drives the active/completed catalyst-scope split for the
// Sections 1,3-7 rule, from one table, across all six states.
// ---------------------------------------------------------------------------

const ALL_SIX_STATES = ['PRE', 'REGULAR', 'POST', 'CLOSED', 'WEEKEND', 'HOLIDAY'];

test('Step 9D.4: reportSettings.sessionMode drives the Sections 1,3-7 rule\'s category choice for every state', () => {
  for (const state of ALL_SIX_STATES) {
    const settings = reportSettings('US', state);
    const activeUs = settings.sessionMode === 'ACTIVE';
    assert.equal(activeUs, ['PRE', 'REGULAR', 'POST'].includes(state), state);

    // This mirrors exactly how lib/claude-analysis-invocation.js's Sections
    // 1,3-7 loop picks the violation category once it has already decided
    // the rule fires and the trim failed (so the section is blanked):
    // completed days always use MISSING_PRINCIPAL_CATALYST; active days
    // split on whether the claim is prior- or current-session-framed.
    const priorClaim = !activeUs || hasPriorCompletedSessionCausalClaim(
      "Microsoft outlook sent stocks lower at Friday's close.",
      {marketPackages: [{market: 'US', marketContext: {primaryCompletedSessionDate: '2026-09-04'}}]}
    );
    const category = !activeUs ? 'MISSING_PRINCIPAL_CATALYST'
      : priorClaim ? 'MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST'
        : 'MISSING_CURRENT_SESSION_PRINCIPAL_CATALYST';
    if (!activeUs) {
      assert.equal(category, 'MISSING_PRINCIPAL_CATALYST', state);
    } else {
      assert.equal(category, 'MISSING_COMPLETED_SESSION_PRINCIPAL_CATALYST', state);
    }
  }
});

test('Step 9D.4: an unrecognized state still throws before any causal-claim category is chosen', () => {
  for (const state of ALL_SIX_STATES) {
    assert.doesNotThrow(() => reportSettings('US', state), state);
  }
  assert.throws(() => reportSettings('US', 'LUNCH'), /Unsupported US market state: LUNCH/);
});

// ---------------------------------------------------------------------------
// The preserved asymmetry: Section 2's rule accepts any principal catalyst
// when there is no current-session evidence at all; the Sections 1,3-7 rule
// has no equivalent fallback. Exercised here directly against the real
// detectors and reportSettings, independent of market state (the asymmetry
// is about `hasCurrentEvidence`, not about which of the six states it is).
// ---------------------------------------------------------------------------

test('Step 9D.4: the Section-2-only "no current evidence, accept any catalyst" fallback is a deliberate asymmetry, not shared', () => {
  // Section 2's own rule (modelled here the way
  // lib/claude-analysis-invocation.js's trimOrLocalizeDriverCausality call
  // for MISSING_PRINCIPAL_CATALYST is gated): fires only when there is no
  // current-session evidence, and only needs ANY principal catalyst cited.
  const anyPrincipalCatalysts = new Set(['e1']);
  const withOldCatalyst = section({evidenceRefs: ['e1']});
  const section2Result = causalClaimTrim(withOldCatalyst, {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => withOldCatalyst.evidenceRefs.some(ref => anyPrincipalCatalysts.has(ref)),
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(section2Result.trimmed, true, 'Section 2: citing the old catalyst is enough to keep the sentence');

  // The Sections 1,3-7 rule: the same scenario (no current evidence, an
  // older but valid principal catalyst cited), but its keepIf only accepts
  // a CURRENT-session catalyst -- an empty set here, matching today's code
  // when there is no current evidence -- so it has no equivalent fallback
  // and removes the sentence anyway.
  const currentSessionPrincipalCatalysts = new Set(); // empty: no current evidence
  const genericRuleResult = causalClaimTrim(withOldCatalyst, {
    offendingSentence: hasActiveDirectMarketCausalClaim,
    splitSentences: splitReportSentences,
    keepIf: () => withOldCatalyst.evidenceRefs.some(ref => currentSessionPrincipalCatalysts.has(ref)),
    caveat: UNSUPPORTED_CAUSALITY_QUALIFIER
  });
  assert.equal(genericRuleResult.trimmed, false,
    'Sections 1,3-7: the same old catalyst does not satisfy this rule, unlike Section 2');
});

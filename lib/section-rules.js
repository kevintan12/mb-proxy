// Step 9D.2: the shared settings table for the Market Brief section rules,
// and the one "what kind of day is it" helper everything else should call
// instead of recomputing it locally.
//
// This file introduces no new behaviour by itself. `reportSettings` and
// `isActiveUsRequest` below replace four separate copies of the same
// "is this an active US day" check (two in lib/claude-analysis-invocation.js,
// one in lib/claude-analysis-contract.js, one in
// lib/us-analysis-package-orchestration.js's COMPLETED_SESSION_STATES
// literal), with one shared implementation. The settings rows themselves
// (sectionOneRequired, catalystScope, nothingSurvivedFallback, failedRescue,
// furtherReadingsSource) record today's per-state behaviour as data, ready
// for the later Step 9D steps to read instead of re-deriving; nothing reads
// them yet, so adding them changes no observable behaviour. See
// docs/DECISIONS.md, Step 9D.2, for where each value is read today and the
// Step 9D plan (Part B §1/§6) for the full inventory this table is built
// from.
'use strict';

const {US_ACTIVE_SESSION_STATES} = require('./us-active-session-evidence');

// Not defined anywhere else in the codebase today (the Step 9D plan's
// inventory, §1, found the completed-state set existed only as a private
// literal in lib/us-analysis-package-orchestration.js). Exporting it here
// gives that literal one canonical source.
const US_COMPLETED_SESSION_STATES = Object.freeze(['CLOSED', 'WEEKEND', 'HOLIDAY']);

// Settings rows. Field meanings, and where each is read today:
//   sessionMode              'ACTIVE' | 'COMPLETED'. Drives every other field here.
//   sectionOneRequired       Rule 25: a null Section 1 fails the report
//                             (lib/claude-analysis-contract.js, isActiveUsAnalysis gate
//                             on "executive market summary requires supported content";
//                             lib/claude-analysis-invocation.js's firstEligibleIndex and
//                             FAILED-rescue section-0-only check).
//   catalystScope             Which principal catalysts count as a cause for a causal
//                             claim (rules 13-16). 'ANY_PRINCIPAL' on completed days;
//                             'SPLIT_CURRENT_COMPLETED' on active days, where a
//                             current-session claim needs a current-session catalyst
//                             and a prior-session claim needs a completed-session one,
//                             except when there is no current evidence at all, when any
//                             principal catalyst is accepted (the `hasCurrentEvidence`
//                             flag below carries that last distinction; see the Step 9D
//                             plan's recorded Section 2 inconsistency for the one case
//                             where today's code does not yet apply this consistently).
//   nothingSurvivedFallback   Rule 28: a FAILED reply with nothing supported anywhere is
//                             accepted as the deterministic "no supported analysis"
//                             FAILED report, active days only
//                             (lib/claude-analysis-invocation.js, normalizeUsIndependentSections).
//   failedRescue              Rule 10: which section(s) rescue a FAILED reply to DEGRADED
//                             ('ANY_SECTION' active, 'SECTION_ONE' completed)
//                             (lib/claude-analysis-invocation.js, normalizeEvidenceLimitedStatus).
//   furtherReadingsSource     Rule 29: 'ACTIVE_CITED_YAHOO' (citation-based, active) or
//                             'PACKAGE_LIST' (the package's own furtherReadings list,
//                             completed) (lib/claude-analysis-contract.js,
//                             resolvedActiveFurtherReadingReferences / resolveActiveFurtherReadings).
function activeStateRow() {
  return Object.freeze({
    sessionMode: 'ACTIVE',
    sectionOneRequired: false,
    catalystScope: 'SPLIT_CURRENT_COMPLETED',
    nothingSurvivedFallback: true,
    failedRescue: 'ANY_SECTION',
    furtherReadingsSource: 'ACTIVE_CITED_YAHOO'
  });
}

function completedStateRow() {
  return Object.freeze({
    sessionMode: 'COMPLETED',
    sectionOneRequired: true,
    catalystScope: 'ANY_PRINCIPAL',
    nothingSurvivedFallback: false,
    failedRescue: 'SECTION_ONE',
    furtherReadingsSource: 'PACKAGE_LIST'
  });
}

const US_STATE_SETTINGS = Object.freeze(
  Object.fromEntries([
    ...US_ACTIVE_SESSION_STATES.map(state => [state, activeStateRow()]),
    ...US_COMPLETED_SESSION_STATES.map(state => [state, completedStateRow()])
  ])
);

const SECTION_RULES_DISABLED = Object.freeze({sectionRulesEnabled: false});

// Returns the settings row for one market and state. A non-US market
// returns the frozen "disabled" sentinel, exactly as every section rule's
// existing `selectedScope !== 'US'` no-op guard does today. An unrecognized
// US state throws, in the same shape as the existing
// "Unsupported US market state" throw in
// lib/us-analysis-package-orchestration.js's analysisModeForMarketState --
// this is a new, stricter contract for this new helper; nothing calls it
// with a state outside the six today.
function reportSettings(market, state, hasCurrentEvidence = false) {
  if (market !== 'US') return SECTION_RULES_DISABLED;
  const row = US_STATE_SETTINGS[state];
  if (!row) throw new TypeError(`Unsupported US market state: ${state}`);
  return Object.freeze({
    sectionRulesEnabled: true,
    ...row,
    hasCurrentEvidence: Boolean(hasCurrentEvidence)
  });
}

// Finds the US marketPackage a canonical Claude analysis input carries, if
// any. There is at most one in practice (selectedScope 'US' implies exactly
// one US marketPackage), but this uses `.some`/`.find` rather than assuming
// position, matching what the four replaced copies did.
function usMarketPackage(input) {
  if (input?.analysisRequest?.selectedScope !== 'US' || !Array.isArray(input.marketPackages)) {
    return null;
  }
  return input.marketPackages.find(item => item?.market === 'US') ?? null;
}

// The settings row for a canonical Claude analysis input's US marketPackage,
// or the disabled sentinel for anything else (non-US scope, or a US scope
// with no US marketPackage present -- an edge case none of the four
// replaced copies treated as an error, so this does not either).
// `hasCurrentEvidence` is accepted for callers that already know it; call
// sites that only need the active/completed split can omit it.
function reportSettingsForInput(input, hasCurrentEvidence = false) {
  const marketPackage = usMarketPackage(input);
  if (!marketPackage) return SECTION_RULES_DISABLED;
  return reportSettings('US', marketPackage.marketContext?.marketState, hasCurrentEvidence);
}

// The one "is this an active US day" check. Replaces:
//   - lib/claude-analysis-invocation.js: activeUsIndependentSurvival, isActiveUsRequest
//   - lib/claude-analysis-contract.js: isActiveUsAnalysis
//   - lib/claude-analysis-invocation.js: the inline check in emitActiveSessionDiagnostics
function isActiveUsRequest(input) {
  const settings = reportSettingsForInput(input);
  return settings.sectionRulesEnabled === true && settings.sessionMode === 'ACTIVE';
}

module.exports = {
  US_COMPLETED_SESSION_STATES,
  reportSettings,
  reportSettingsForInput,
  isActiveUsRequest
};

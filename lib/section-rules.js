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

// ---------------------------------------------------------------------------
// Step 9D.3: the shared trim ladder.
//
// Every section rule that repairs a writer reply follows the same order:
//   1. remove the bad reference(s)
//   2. remove the bad sentence(s)
//   3. add the caveat (not every rule has one -- see §6 of the Step 9D plan;
//      the Section 6 opportunity rule, for one, adds none, exactly as today)
//   4. blank the section, but only if nothing valid remains
//
// The functions below are each one step of that ladder, kept deliberately
// small and composable rather than one rigid pipeline, because which steps
// a given rule uses, and what "nothing valid remains" means for it, differs
// rule by rule (a Section 3 trim also has to re-check that the surviving
// text still names a cited focus subject; a Section 4 trim has to re-check
// that an initiating-list evidence ref is still cited; neither check is
// generic). Each call site below decides that part for itself and calls
// these primitives for the mechanical, genuinely shared part. This file has
// no dependency on lib/claude-analysis-contract.js or
// lib/claude-analysis-invocation.js (avoiding a require cycle, since the
// former now requires this file): callers pass in whatever contract-level
// data a step needs (a sentence splitter, the empty-initiating-list text).
//
// Moved onto this ladder in this step: rule 4 (unknown references), rules
// 18-21 (Section 3: NON_FOCUS_EVIDENCE trim, NON_BENCHMARK_TELEMETRY trim,
// UNFOCUSED_PORTFOLIO_MENTION trim, and the final blank), rule 22 (Section
// 4's NON_INITIATING_* trim, including all three copies of the
// empty-initiating-list rewrite), and rule 24 (Section 6 opportunity trim).
// See docs/DECISIONS.md, Step 9D.3, for the exact call sites.
// ---------------------------------------------------------------------------

// Step 1: remove the bad reference(s). `keepEvidenceRef`/`keepTelemetryRef`
// are each an "is this reference still allowed" predicate; omit either to
// leave that reference list untouched. Returns the counts a rule's own
// event needs, alongside the filtered section.
function withFilteredReferences(section, {keepEvidenceRef, keepTelemetryRef} = {}) {
  const keptEvidenceRefs = keepEvidenceRef
    ? section.evidenceRefs.filter(keepEvidenceRef) : section.evidenceRefs;
  const keptTelemetryRefs = keepTelemetryRef
    ? section.telemetryRefs.filter(keepTelemetryRef) : section.telemetryRefs;
  return {
    section: {...section, evidenceRefs: keptEvidenceRefs, telemetryRefs: keptTelemetryRefs},
    droppedEvidenceRefCount: section.evidenceRefs.length - keptEvidenceRefs.length,
    droppedTelemetryRefCount: section.telemetryRefs.length - keptTelemetryRefs.length
  };
}

// Step 2: remove the bad sentence(s). `isOffendingSentence` is a predicate
// over one sentence; `splitSentences` is the caller's sentence splitter
// (lib/claude-analysis-contract.js's `splitReportSentences`, injected to
// avoid a require cycle). When nothing is removed, the section is returned
// completely unchanged -- not rejoined from its own sentences -- so a rule
// that removes nothing never alters the writer's exact wording or spacing.
function dropOffendingSentences(section, isOffendingSentence, splitSentences) {
  if (section.content === null) {
    return {section, removedSentenceCount: 0, sentenceCount: 0, keptSentenceCount: 0};
  }
  const sentences = splitSentences(section.content);
  const kept = sentences.filter(sentence => !isOffendingSentence(sentence));
  const removedSentenceCount = sentences.length - kept.length;
  return {
    section: removedSentenceCount > 0 ? {...section, content: kept.join(' ')} : section,
    removedSentenceCount, sentenceCount: sentences.length, keptSentenceCount: kept.length
  };
}

// Step 3: add the caveat, once, if it is not already present. Not every
// rule calls this -- the Section 6 opportunity rule and the Section 4
// initiating-list rule add no caveat, exactly as today.
function withCaveat(section, caveat) {
  return section.uncertainties.includes(caveat) ? section
    : {...section, uncertainties: section.uncertainties.concat(caveat)};
}

// Step 4: blank the section with the given uncertainty message. A rule
// calls this only once it has decided nothing valid remains.
function blankSection(section, message) {
  return {...section, content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: [message]};
}

// The deterministic empty-initiating-list rewrite (rule 22's special case,
// and the one most rules fall back to for Section 4 when the initiating
// list itself is empty). `emptyListContent` is the caller's
// `EMPTY_INITIATING_LIST_CONTENT[initiatingList]` value, passed in rather
// than imported here to avoid a require cycle.
function emptyInitiatingListSection(section, emptyListContent) {
  return {...section, content: emptyListContent, evidenceRefs: [], telemetryRefs: [], uncertainties: []};
}

// The shared "Not enough data to write the ... section." wording, used by
// every rule that blanks a section for lack of valid content (as opposed
// to a section-specific message, such as Section 3's "specific stocks or
// sectors" gap or Section 6's "clear opportunity" gap, which stay as their
// own named constants in lib/claude-analysis-invocation.js).
function sectionUnavailableMessage(sectionName) {
  return `Not enough data to write the ${sectionName} section.`;
}

// Text normalising for a case- and whitespace-insensitive subject-name
// match: NFKC-normalize, collapse whitespace, trim, lowercase. Shared by
// `namesCitedFocusSubject` below and by any rule that needs the same
// comparison directly.
function normalizeSectionText(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

// "Names a cited focus subject": true when `content` names at least one
// subject of a `broadMarketFocusEntries` entry that `evidenceRefs` actually
// cites. Used by the Section 3 rules (a trim is only safe to keep when the
// surviving text still names a subject of a focus ref that is still cited).
function namesCitedFocusSubject(content, evidenceRefs, broadMarketFocusEntries) {
  const normalizedContent = normalizeSectionText(content);
  return broadMarketFocusEntries.some(entry => evidenceRefs.includes(entry.evidenceRef)
    && entry.subjects.some(subject => normalizedContent.includes(normalizeSectionText(subject.name))));
}

module.exports = {
  US_COMPLETED_SESSION_STATES,
  reportSettings,
  reportSettingsForInput,
  isActiveUsRequest,
  withFilteredReferences,
  dropOffendingSentences,
  withCaveat,
  blankSection,
  emptyInitiatingListSection,
  sectionUnavailableMessage,
  normalizeSectionText,
  namesCitedFocusSubject
};

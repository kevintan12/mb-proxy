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
// furtherReadingsSource) record today's per-state behaviour as data. Since
// Step 9D.5a, sectionOneRequired, nothingSurvivedFallback and failedRescue
// are read (through the settings readers further down); catalystScope and
// furtherReadingsSource are still data only. See
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

// Settings rows. Field meanings, and where each was read before Step 9D.5a
// moved rules 10, 25, 27 and 28 onto these fields:
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

const SECTION_RULES_DISABLED = Object.freeze({sectionRulesEnabled: false});

// ---------------------------------------------------------------------------
// Step 9D.6: market-level settings -- not state-dependent -- read by the
// section rules instead of a hard-coded `selectedScope === 'US'` switch.
// `sectionRulesEnabled` is the market-level gate every rule used to spell
// out for itself; `benchmarkNames` is the causal detector's list of index
// names (lib/claude-analysis-contract.js's hasDirectMarketCausalClaim); and
// `locale` is the locale used for the section rules' own case- and
// whitespace-insensitive subject-name matching (this file's
// normalizeSectionText, and lib/claude-analysis-contract.js's
// normalizedSubjectText). The US row's `benchmarkNames` and `locale`
// reproduce today's literals exactly: 's&p 500|nasdaq|dow' and 'en-US'.
// Singapore and Hong Kong are listed with `sectionRulesEnabled: false`, so
// every section rule stays switched off for them exactly as it is today --
// this step does not make them work (that is Step 9M); it only stops the
// rules from being hard-coded to the US market specifically. A market with
// no row here (including the legacy 'ALL' scope) is disabled the same way.
//
// Step 9F.1a: the same table also holds the reading-window defaults and safe
// limits (lib/reading-window.js reads them; the READING_EXTENSION_HOURS and
// ARTICLE_KB environment variables only override the defaults, and are always
// clamped to these limits). Not connected to the live pipeline yet.
const READING_SETTINGS = Object.freeze({
  readingExtensionHours: Object.freeze({default: 24, min: 0, max: 72}),
  articleKb: Object.freeze({default: 16, min: 2, max: 32})
});

const MARKET_SETTINGS = Object.freeze({
  US: Object.freeze({
    sectionRulesEnabled: true,
    activeStates: US_ACTIVE_SESSION_STATES,
    completedStates: US_COMPLETED_SESSION_STATES,
    benchmarkNames: Object.freeze(['s&p 500', 'nasdaq', 'dow']),
    locale: 'en-US',
    ...READING_SETTINGS
  }),
  SG: Object.freeze({sectionRulesEnabled: false, ...READING_SETTINGS}),
  HK: Object.freeze({sectionRulesEnabled: false, ...READING_SETTINGS})
});

// The settings row for one market (not state-dependent): whether section
// rules apply to it at all, and -- only when they do -- the causal
// detector's benchmark names and the matching locale. A market with no row
// (including an empty, null or undefined market) gets the disabled
// sentinel, same shape as `reportSettings`'s own disabled sentinel.
function marketSettings(market) {
  return MARKET_SETTINGS[market] ?? SECTION_RULES_DISABLED;
}

// Returns the settings row for one market and state. A market whose
// settings are disabled (any market with no row above, including a non-US
// market today) returns the frozen "disabled" sentinel, exactly as every
// section rule's existing `selectedScope !== 'US'` no-op guard did before
// this step. An unrecognized state for an enabled market throws, in the
// same shape as the existing "Unsupported US market state" throw in
// lib/us-analysis-package-orchestration.js's analysisModeForMarketState --
// this is a new, stricter contract for this new helper; nothing calls it
// with a state outside the six today.
function reportSettings(market, state, hasCurrentEvidence = false) {
  const settings = marketSettings(market);
  if (!settings.sectionRulesEnabled) return SECTION_RULES_DISABLED;
  const row = settings.activeStates.includes(state) ? activeStateRow()
    : settings.completedStates.includes(state) ? completedStateRow() : null;
  if (!row) throw new TypeError(`Unsupported ${market} market state: ${state}`);
  return Object.freeze({
    sectionRulesEnabled: true,
    ...row,
    hasCurrentEvidence: Boolean(hasCurrentEvidence)
  });
}

// Finds the marketPackage matching a canonical Claude analysis input's own
// selectedScope, if any. There is at most one in practice (a single-market
// selectedScope implies exactly one matching marketPackage; the legacy
// 'ALL' scope matches no single marketPackage's `market`, so it is disabled
// the same way a market with no settings row is), but this uses `.find`
// rather than assuming position, matching what the four replaced copies did
// for 'US' before this step.
function marketPackageForInput(input) {
  const scope = input?.analysisRequest?.selectedScope;
  if (!scope || !Array.isArray(input.marketPackages)) return null;
  return input.marketPackages.find(item => item?.market === scope) ?? null;
}

// The settings row for a canonical Claude analysis input's own market, or
// the disabled sentinel for anything else (a scope with no matching
// marketPackage present -- an edge case none of the four replaced copies
// treated as an error, so this does not either). `hasCurrentEvidence` is
// accepted for callers that already know it; call sites that only need the
// active/completed split can omit it.
function reportSettingsForInput(input, hasCurrentEvidence = false) {
  const marketPackage = marketPackageForInput(input);
  if (!marketPackage) return SECTION_RULES_DISABLED;
  return reportSettings(marketPackage.market, marketPackage.marketContext?.marketState, hasCurrentEvidence);
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
// comparison directly. `locale` defaults to the US market setting (today's
// hard-coded 'en-US'); every call site below omits it and gets that default
// unchanged -- the parameter exists so this is no longer hard-coded to one
// market, not because anything in this codebase picks a different locale
// today (Step 9D.6; see docs/DECISIONS.md for the test proving it works).
function normalizeSectionText(value, locale = marketSettings('US').locale) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase(locale);
}

// "Names a cited focus subject": true when `content` names at least one
// subject of a `broadMarketFocusEntries` entry that `evidenceRefs` actually
// cites. Used by the Section 3 rules (a trim is only safe to keep when the
// surviving text still names a subject of a focus ref that is still cited).
function namesCitedFocusSubject(content, evidenceRefs, broadMarketFocusEntries,
  locale = marketSettings('US').locale) {
  const normalizedContent = normalizeSectionText(content, locale);
  return broadMarketFocusEntries.some(entry => evidenceRefs.includes(entry.evidenceRef)
    && entry.subjects.some(subject => normalizedContent.includes(normalizeSectionText(subject.name, locale))));
}

// ---------------------------------------------------------------------------
// Step 9D.4: the shared mechanical core of every "causal claim without a
// cause" rule -- Section 2's three rules (a claim with no current-session
// evidence at all, a prior-completed-session claim, and a current-session
// claim) and the Sections 1,3-7 rule (Step 8U.8).
//
// This is ONLY the mechanical shape: drop the offending sentences (step 2
// of the trim ladder), decide whether something valid still remains, and
// either add the caveat (step 3) or report that nothing was trimmed so the
// caller can blank the section (step 4). It is deliberately NOT one merged
// "which catalyst counts, which sentence is offending" formula: Section 2's
// three branches and the Sections 1,3-7 loop use genuinely different
// offending-sentence predicates today, and merging them would change
// observable behaviour. Proof: the sentence "Stocks fell on September 4."
// is flagged by `hasPriorCompletedSessionCausalClaim` (Section 2's
// prior-claim predicate) but NOT by `hasActiveDirectMarketCausalClaim`
// (Sections 1,3-7's predicate, and Section 2's own non-prior predicate),
// because the active detector strips the trailing "on <date>" clause before
// testing and the prior-session detector does not. A single shared
// predicate would therefore either miss a sentence Section 2 removes today,
// or remove a sentence Sections 1,3-7 keep today. So each call site still
// supplies its own `offendingSentence` and `keepIf`; what moves here is the
// trim-then-decide mechanics every one of those four call sites repeated.
// See docs/DECISIONS.md, Step 9D.4, for the exact call sites and for one
// further asymmetry found (not fixed) during this unification: Section 2
// falls back to accepting ANY principal catalyst when there is no
// current-session evidence at all; the Sections 1,3-7 rule has no
// equivalent fallback. Preserved exactly as it behaves today.
function causalClaimTrim(section, {offendingSentence, splitSentences, keepIf, caveat}) {
  const {section: trimmed, removedSentenceCount, sentenceCount, keptSentenceCount} =
    dropOffendingSentences(section, offendingSentence, splitSentences);
  if (keptSentenceCount > 0 && keptSentenceCount < sentenceCount && keepIf(trimmed)) {
    return {trimmed: true, section: withCaveat(trimmed, caveat), removedSentenceCount};
  }
  return {trimmed: false};
}

// ---------------------------------------------------------------------------
// Step 9D.5a: the settings readers for the four state-driven report rules
// (rule 10, the FAILED-reply rescue; rule 25, "Section 1 must have content";
// rule 27, the last-resort section emptying; rule 28, the nothing-survived
// fallback). Each one returns exactly what today's "is this an active US
// day" check gave: an active row reads its own field; a completed row reads
// its own field; and the disabled sentinel (any non-US scope, such as
// Singapore or Hong Kong, or a US scope with no US marketPackage) gets the
// completed-day answer, because every non-active report was treated as a
// completed one before this step. That last fallback is what keeps rule 25
// applying to every non-active report, as it does today.
// ---------------------------------------------------------------------------
function failedRescueScope(settings) {
  return settings.sectionRulesEnabled ? settings.failedRescue : 'SECTION_ONE';
}

function sectionOneRequired(settings) {
  return settings.sectionRulesEnabled ? settings.sectionOneRequired : true;
}

function nothingSurvivedFallbackEnabled(settings) {
  return settings.sectionRulesEnabled ? settings.nothingSurvivedFallback : false;
}

// ---------------------------------------------------------------------------
// Step 9D.5a: the one section-rule registry.
//
// Every section rule from the Step 9D plan's inventory (rules 1-30) has one
// entry here. Where both the cleanup stage (lib/claude-analysis-invocation.js)
// and the final checker (lib/claude-analysis-contract.js) test for the same
// thing, they now both call this entry's `detect`, so the two cannot drift
// apart. Only the core test is shared: each side keeps its own preconditions
// (for example, rule 13's cleanup still fires only when there is no
// current-session evidence, while the checker's fires always; rule 14's
// cleanup gates on current-session references, the checker on the
// current-session context; rule 16's checker skips completed-day Section 1).
// The checker's error messages stay in the checker, byte for byte, because
// the last-resort step (rule 27) reads them by text.
//
// The detectors that need contract-level helpers (the causal-claim and
// prose detectors, the Section 3 and Section 6 scope checks, the word cap)
// receive them through `createSectionRules(helpers)`. The registry is built
// once, by lib/claude-analysis-contract.js, from its own functions, and the
// cleanup stage imports that same instance from there -- so this file still
// requires neither of those two files.
//
// Fields: `number` (the inventory's rule number), `id`, `sections` (array
// indices the rule can act on), `usedBy` (which side(s) call `detect`),
// `detect` (null when there is no detector to share), `settingsField` (for
// the state-driven rules), and `notShared` (why a rule has no shared
// detector, or only one side uses it).
// ---------------------------------------------------------------------------
function citesAny(references, allowed) {
  return references.some(reference => allowed.has(reference));
}

// Rule 30: the first-use order of evidence refs across sections. The cleanup
// stage derives `evidenceReferences` with it; the checker rebuilds the same
// list to compare against.
function appendFirstUseReferences(ordered, references) {
  for (const reference of references) if (!ordered.includes(reference)) ordered.push(reference);
  return ordered;
}

const ALL_ANALYSIS_SECTIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

function createSectionRules(helpers) {
  const {
    hasActiveDirectMarketCausalClaim, hasPriorCompletedSessionCausalClaim,
    hasMalformedPlainEnglishProse, hasInternalIdentifierLeak,
    hasOpportunityClaim, sectionSixOpportunityViolations, maximumReportWords
  } = helpers;
  const allowedCausalCatalysts = (content, {activeUs, currentCatalysts, completedCatalysts, input}) =>
    activeUs && !hasPriorCompletedSessionCausalClaim(content, input) ? currentCatalysts : completedCatalysts;
  const entries = [
    {number: 1, id: 'FURTHER_READINGS_SECTION_EMPTY', sections: [7], usedBy: ['checker'],
      // Section 8 must arrive empty; MarketBrief resolves it.
      detect: (section, {validEvidenceRefs, validTelemetryRefs, validUncertainties}) =>
        section.content !== null || !validEvidenceRefs || section.evidenceRefs.length
          || !validTelemetryRefs || section.telemetryRefs.length
          || !validUncertainties || section.uncertainties.length,
      notShared: 'The cleanup side is the transport conversion, which rejects a non-empty s8 payload '
        + 'and then builds an empty Section 8 itself; that is a transport-shape check, not this test.'},
    {number: 2, id: 'PLAIN_ENGLISH_REWRITE', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup'],
      detect: null,
      notShared: 'A rewrite, not a detector; the checker has no counterpart (style residue is diagnostic only, D-001).'},
    {number: 3, id: 'DUPLICATE_EVIDENCE_REFERENCE', sections: ALL_ANALYSIS_SECTIONS, usedBy: [],
      detect: null,
      notShared: 'The checker tests duplicates, unknown refs and blanks in one canonical-array check whose '
        + 'message text rule 27 reads; the cleanup repairs each separately (rules 3, 4, 5).'},
    {number: 4, id: 'UNKNOWN_SECTION_REFERENCE', sections: ALL_ANALYSIS_SECTIONS, usedBy: [],
      detect: null, notShared: 'Same as rule 3.'},
    {number: 5, id: 'DUPLICATE_SECTION_METADATA', sections: ALL_ANALYSIS_SECTIONS, usedBy: [],
      detect: null, notShared: 'Same as rule 3.'},
    {number: 6, id: 'MALFORMED_PLAIN_LANGUAGE', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['checker'],
      detect: text => hasMalformedPlainEnglishProse(text),
      notShared: 'The cleanup side acts on it only through rule 27, which reads the checker message.'},
    {number: 7, id: 'INTERNAL_IDENTIFIER_LEAK', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['checker'],
      detect: text => hasInternalIdentifierLeak(text),
      notShared: 'Same as rule 6.'},
    {number: 8, id: 'CONTENT_NEEDS_EVIDENCE', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['checker'],
      detect: (section, {validEvidenceRefs}) => !validEvidenceRefs || section.evidenceRefs.length === 0,
      notShared: 'Same as rule 6.'},
    {number: 9, id: 'CONTROLLED_UNAVAILABLE', sections: [1, 2], usedBy: ['cleanup'],
      detect: input => ({
        noDrivers: input?.marketPackages?.every(marketPackage =>
          marketPackage.evidenceContext.materialEvents.length === 0
            && marketPackage.evidenceContext.principalCatalysts.length === 0),
        noFocus: input?.marketPackages?.every(marketPackage =>
          marketPackage.evidenceContext.broadMarketFocus.length === 0)
      }),
      notShared: 'Cleanup only; the checker has no counterpart.'},
    {number: 10, id: 'FAILED_REPLY_RESCUE', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup'],
      detect: null, settingsField: 'failedRescue',
      notShared: 'State-driven by settings, not a detector.'},
    {number: 11, id: 'DRIVER_REFERENCE_REQUIRED', sections: [1], usedBy: ['cleanup', 'checker'],
      detect: (evidenceRefs, driverReferences) => !citesAny(evidenceRefs, driverReferences)},
    {number: 12, id: 'CURRENT_SESSION_DRIVER_REQUIRED', sections: [1], usedBy: ['cleanup', 'checker'],
      detect: (evidenceRefs, currentDriverReferences) => !citesAny(evidenceRefs, currentDriverReferences)},
    {number: 13, id: 'PRINCIPAL_CATALYST_REQUIRED', sections: [1], usedBy: ['cleanup', 'checker'],
      detect: (content, evidenceRefs, catalystReferences) =>
        hasActiveDirectMarketCausalClaim(content) && !citesAny(evidenceRefs, catalystReferences)},
    {number: 14, id: 'COMPLETED_SESSION_CATALYST_REQUIRED', sections: [1], usedBy: ['cleanup', 'checker'],
      detect: (content, evidenceRefs, completedCatalysts, input) =>
        hasPriorCompletedSessionCausalClaim(content, input) && !citesAny(evidenceRefs, completedCatalysts)},
    {number: 15, id: 'CURRENT_SESSION_CATALYST_REQUIRED', sections: [1], usedBy: ['cleanup', 'checker'],
      detect: (content, evidenceRefs, currentCatalysts, input) =>
        hasActiveDirectMarketCausalClaim(content) && !hasPriorCompletedSessionCausalClaim(content, input)
          && !citesAny(evidenceRefs, currentCatalysts)},
    {number: 16, id: 'CAUSAL_CLAIM_CATALYST_REQUIRED', sections: [0, 2, 3, 4, 5, 6],
      usedBy: ['cleanup', 'checker'],
      // `context`: {activeUs, currentCatalysts, completedCatalysts, input}.
      allowedCatalysts: allowedCausalCatalysts,
      detect: (content, evidenceRefs, context) => hasActiveDirectMarketCausalClaim(content)
        && !citesAny(evidenceRefs, allowedCausalCatalysts(content, context))},
    {number: 17, id: 'FOCUS_SUBJECT_REQUIRED', sections: [2], usedBy: ['cleanup', 'checker'],
      // null when Section 3 cites a focus ref and names one of its subjects.
      detect: (content, evidenceRefs, broadMarketFocusEntries) => {
        const citedFocus = broadMarketFocusEntries.filter(entry => evidenceRefs.includes(entry.evidenceRef));
        if (citedFocus.length === 0) return 'NO_FOCUS_EVIDENCE';
        return namesCitedFocusSubject(content, evidenceRefs, citedFocus) ? null : 'NO_VALIDATED_SUBJECT';
      }},
    // Rules 18-21 read one result of lib/claude-analysis-contract.js's
    // sectionThreeScopeViolations (already the single Section 3 scope test).
    {number: 18, id: 'NON_FOCUS_EVIDENCE', sections: [2], usedBy: ['cleanup', 'checker'],
      detect: scope => scope.nonFocusEvidenceCount},
    {number: 19, id: 'NON_BENCHMARK_TELEMETRY', sections: [2], usedBy: ['cleanup', 'checker'],
      detect: scope => scope.unlinkedStockTelemetryReferences.size},
    {number: 20, id: 'UNFOCUSED_PORTFOLIO_MENTION', sections: [2], usedBy: ['cleanup', 'checker'],
      detect: scope => scope.unfocusedPortfolioMentionCount},
    {number: 21, id: 'SECTION_THREE_FINAL_BLANK', sections: [2], usedBy: ['cleanup'],
      detect: scope => Boolean(scope.nonFocusEvidenceCount || scope.unlinkedStockTelemetryReferences.size
        || scope.unfocusedPortfolioMentionCount),
      notShared: 'Cleanup only; the checker reports rules 18-20 separately instead.'},
    {number: 22, id: 'NON_INITIATING_REFERENCE', sections: [3], usedBy: ['cleanup', 'checker'],
      // The count of refs outside the initiating list. Called once for
      // evidence refs and once for telemetry refs.
      detect: (references, initiatingReferences) =>
        references.filter(reference => !initiatingReferences.has(reference)).length,
      notShared: 'Its NON_INITIATING_MENTION sentence trim is cleanup only; the checker has no mention check.'},
    {number: 23, id: 'EMPTY_INITIATING_LIST', sections: [3], usedBy: ['cleanup', 'checker'],
      detect: input => input.portfolioContext[input.analysisRequest.initiatingList].length === 0,
      notShared: 'The exact-statement comparison stays in the checker; the cleanup rewrites instead.'},
    {number: 24, id: 'UNGROUNDED_OPPORTUNITY', sections: [5], usedBy: ['cleanup', 'checker'],
      // null when there is no opportunity claim; otherwise the Step 8U.6
      // matcher's result, unchanged.
      detect: (section, input) => hasOpportunityClaim(section.content)
        ? sectionSixOpportunityViolations(section, input) : null},
    {number: 25, id: 'SECTION_ONE_REQUIRED', sections: [0], usedBy: ['cleanup', 'checker'],
      detect: null, settingsField: 'sectionOneRequired',
      notShared: 'State-driven by settings, not a detector.'},
    {number: 26, id: 'REPORT_WORD_CAP', sections: [1, 2, 3, 4, 5, 6], usedBy: ['checker'],
      detect: output => {
        const words = output.sections.flatMap(section => section && typeof section === 'object'
          ? [typeof section.content === 'string' ? section.content : '',
            ...(Array.isArray(section.uncertainties) ? section.uncertainties : [])]
          : [])
          .concat(output.evidenceGaps).join(' ').trim();
        return Boolean(words) && words.split(/\s+/).length > maximumReportWords;
      },
      notShared: 'The cleanup side acts on it only through rule 27, which reads the checker message.'},
    {number: 27, id: 'OPTIONAL_SECTION_VALIDATION', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup'],
      detect: null, settingsField: 'sectionOneRequired',
      notShared: 'Consumes the checker\'s messages by text; state-driven by settings.'},
    {number: 28, id: 'NOTHING_SURVIVED_FALLBACK', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup'],
      detect: null, settingsField: 'nothingSurvivedFallback',
      notShared: 'State-driven by settings, not a detector.'},
    {number: 29, id: 'FURTHER_READINGS_SOURCE', sections: [7], usedBy: [],
      detect: null, settingsField: 'furtherReadingsSource',
      notShared: 'Not rewired in Step 9D.5a; still resolved by resolveActiveFurtherReadings as before.'},
    {number: 30, id: 'EVIDENCE_FIRST_USE_ORDER', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup', 'checker'],
      detect: appendFirstUseReferences}
  ];
  return Object.freeze(Object.fromEntries(entries.map(entry => [entry.id, Object.freeze(entry)])));
}

// ---------------------------------------------------------------------------
// Step 9D.5b: the cleanup stage's rule order, and the one loop that runs it.
//
// The cleanup stage (lib/claude-analysis-invocation.js,
// normalizeDynamicReferenceViolations) repairs a writer reply by running these
// registry rules in exactly this order: Section 2's rules 12-15, then rule 16
// for Sections 1 and 3-7, then Section 3's rules 18-21, then Section 4's rule
// 22, then Section 6's rule 24. The order matters: a rule sees the section as
// earlier rules left it, and the diagnostic events are emitted in this order.
// Rules not listed here act elsewhere (before this stage, in the final
// checker, or through the last-resort step), or only as a shared detector
// inside a listed rule (rule 11 inside Section 2's trim, rule 17 inside the
// Section 3 and rule 16 trims).
// ---------------------------------------------------------------------------
const SECTION_RULE_CLEANUP_ORDER = Object.freeze([
  'CURRENT_SESSION_DRIVER_REQUIRED', // rule 12
  'PRINCIPAL_CATALYST_REQUIRED', // rule 13
  'COMPLETED_SESSION_CATALYST_REQUIRED', // rule 14
  'CURRENT_SESSION_CATALYST_REQUIRED', // rule 15
  'CAUSAL_CLAIM_CATALYST_REQUIRED', // rule 16
  'NON_FOCUS_EVIDENCE', // rule 18
  'NON_BENCHMARK_TELEMETRY', // rule 19
  'UNFOCUSED_PORTFOLIO_MENTION', // rule 20
  'SECTION_THREE_FINAL_BLANK', // rule 21
  'NON_INITIATING_REFERENCE', // rule 22
  'UNGROUNDED_OPPORTUNITY' // rule 24
]);

// Runs one handler per rule, in SECTION_RULE_CLEANUP_ORDER. `handlers` is keyed
// by registry rule id; each handler applies that rule's cleanup to the caller's
// own working state (held in the caller's closure, since the state each rule
// needs differs). A handler for a rule outside the order, or a rule in the
// order with no handler, is a programming error and throws, so a rule cannot
// be silently skipped or run out of order.
function runSectionRules(handlers) {
  const ids = Object.keys(handlers);
  const unknown = ids.filter(id => !SECTION_RULE_CLEANUP_ORDER.includes(id));
  const missing = SECTION_RULE_CLEANUP_ORDER.filter(id => !Object.hasOwn(handlers, id));
  if (unknown.length || missing.length) {
    throw new TypeError(`Section rule handlers do not match the cleanup order: `
      + `unknown [${unknown.join(', ')}], missing [${missing.join(', ')}]`);
  }
  for (const id of SECTION_RULE_CLEANUP_ORDER) handlers[id]();
}

module.exports = {
  READING_SETTINGS,
  US_COMPLETED_SESSION_STATES,
  US_SECTION_RULE_STATES: Object.freeze([...US_ACTIVE_SESSION_STATES, ...US_COMPLETED_SESSION_STATES]),
  marketSettings,
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
  namesCitedFocusSubject,
  causalClaimTrim,
  failedRescueScope,
  sectionOneRequired,
  nothingSurvivedFallbackEnabled,
  appendFirstUseReferences,
  createSectionRules,
  SECTION_RULE_CLEANUP_ORDER,
  runSectionRules
};

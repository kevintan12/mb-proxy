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

const {US_ACTIVE_SESSION_STATES, exchangeDateParts} = require('./us-active-session-evidence');
const {SETTINGS_REGISTRY, settingValue} = require('./settings-registry');

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
// clamped to these limits).
// Step 9F.2a: these rows are now sourced from the one shared settings registry
// (lib/settings-registry.js), so there is a single canonical default/range per
// value; nothing here changed numerically. `readingBudgetSeconds` is kept as a
// bare number (not a {default,min,max} row) since lib/reading-window.js reads
// its live, overridable value through `settingValue('yahooReadingBudgetSeconds', ...)`
// directly, not through this table.
const READING_SETTINGS = Object.freeze({
  readingExtensionHours: Object.freeze({
    default: SETTINGS_REGISTRY.readingExtensionHours.default,
    min: SETTINGS_REGISTRY.readingExtensionHours.min,
    max: SETTINGS_REGISTRY.readingExtensionHours.max
  }),
  articleKb: Object.freeze({
    default: SETTINGS_REGISTRY.articleKb.default,
    min: SETTINGS_REGISTRY.articleKb.min,
    max: SETTINGS_REGISTRY.articleKb.max
  }),
  readingBudgetSeconds: SETTINGS_REGISTRY.yahooReadingBudgetSeconds.default
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

// Rule 9's test: with no drivers (no material event and no principal catalyst --
// also the case when the labelling step failed and no item got a role) Section 2
// is blanked by design; with no broad-market focus, Section 3 is.
function controlledUnavailable(input) {
  return {
    noDrivers: input?.marketPackages?.every(marketPackage =>
      marketPackage.evidenceContext.materialEvents.length === 0
        && marketPackage.evidenceContext.principalCatalysts.length === 0),
    noFocus: input?.marketPackages?.every(marketPackage =>
      marketPackage.evidenceContext.broadMarketFocus.length === 0)
  };
}

// Step 9L: the sections a section retry may rewrite (zero-based: Sections 1, 2, 3,
// 5, 6 and 7). Fixed by Kevin's rule: Section 4 (index 3) and Section 8 (index 7)
// are never retried.
const WRITER_SECTION_RETRY_SECTIONS = Object.freeze([0, 1, 2, 4, 5, 6]);

// Step 9L: the empty sections of a finished report that a section retry may try
// again, in section order. Empty means no text. A section the code blanks by design
// (rule 9: no drivers -> Section 2, no focus -> Section 3) is never offered, and a
// market whose section rules are off gets no retry. The fixed "no current news"
// report never reaches this helper (the writer is not called for it).
function retryEligibleEmptySections(output, input) {
  if (!reportSettingsForInput(input).sectionRulesEnabled || !Array.isArray(output?.sections)) return [];
  const {noDrivers, noFocus} = controlledUnavailable(input);
  return WRITER_SECTION_RETRY_SECTIONS.filter(index => {
    if (index === 1 && noDrivers) return false;
    if (index === 2 && noFocus) return false;
    const section = output.sections[index];
    return Boolean(section) && section.content === null;
  });
}

// ---------------------------------------------------------------------------
// Step 8W: date accuracy (rule 31). One check for every section and all six US
// market states, run by the cleanup stage while dateAccuracyEnabled is on:
//   (i)  a sentence that names a weekday must be supported: the weekday appears in
//        a cited article of that section (by name, or as the weekday of a date the
//        article gives), or it is a cited article's ET publish day, the report's ET
//        day, the completed session's day, or a session day of cited telemetry;
//   (ii) in Section 7 only, a sentence that gives an explicit calendar date before
//        the report's ET date is not upcoming.
// An offending sentence is removed (trim ladder step 2); nothing else is changed.
// Known limit: a past event written with no weekday and no date (the 17 Oct Warsh
// case, "traders will turn their attention to his remarks") cannot be caught here.
// ---------------------------------------------------------------------------
const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const SHORT_WEEKDAYS = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', thur: 'Thursday',
  thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
});
const MONTH_NUMBERS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
});
const FULL_WEEKDAY = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)s?\b/gi;
// A short weekday counts only when a day number follows it ("Thu 15 Oct").
const SHORT_WEEKDAY = /\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\.?,?\s+(?=\d{1,2}\b)/g;
// Month names are matched capitalised only, so "may 5%" is not a date.
const MONTH_NAME = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?'
  + '|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const MONTH_FIRST_DATE = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'g');
const DAY_FIRST_DATE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'g');
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

function weekdaysNamed(text) {
  const names = new Set();
  if (typeof text !== 'string') return names;
  for (const match of text.matchAll(FULL_WEEKDAY)) {
    names.add(WEEKDAY_NAMES.find(name => name.toLowerCase() === match[1].toLowerCase()));
  }
  for (const match of text.matchAll(SHORT_WEEKDAY)) names.add(SHORT_WEEKDAYS[match[1].toLowerCase()]);
  return names;
}

function dateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function weekdayOfDateKey(key) {
  return WEEKDAY_NAMES[new Date(`${key}T12:00:00.000Z`).getUTCDay()];
}

// A date with no year takes the year that puts it closest to `anchorDate`.
function yearlessDateKey(month, day, anchorDate) {
  const anchorYear = Number(anchorDate.slice(0, 4));
  const anchorMs = Date.parse(`${anchorDate}T12:00:00.000Z`);
  return [anchorYear - 1, anchorYear, anchorYear + 1]
    .map(year => dateKey(year, month, day)).filter(Boolean)
    .sort((a, b) => Math.abs(Date.parse(`${a}T12:00:00.000Z`) - anchorMs)
      - Math.abs(Date.parse(`${b}T12:00:00.000Z`) - anchorMs))[0] || null;
}

function explicitDates(text, anchorDate) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate || '')) return [];
  const dates = [];
  const named = (monthName, day, year) => {
    const month = MONTH_NUMBERS[monthName.toLowerCase().slice(0, 3)];
    const dayNumber = Number(day);
    const key = year ? dateKey(Number(year), month, dayNumber) : yearlessDateKey(month, dayNumber, anchorDate);
    if (key) dates.push(key);
  };
  for (const match of text.matchAll(MONTH_FIRST_DATE)) named(match[1], match[2], match[3]);
  for (const match of text.matchAll(DAY_FIRST_DATE)) named(match[2], match[1], match[3]);
  for (const match of text.matchAll(ISO_DATE)) {
    const key = dateKey(Number(match[1]), Number(match[2]), Number(match[3]));
    if (key) dates.push(key);
  }
  for (const match of text.matchAll(SLASH_DATE)) {
    const key = dateKey(Number(match[3]), Number(match[1]), Number(match[2]));
    if (key) dates.push(key);
  }
  return dates;
}

// The facts the check needs for one section: the weekdays its cited evidence
// supports and the report's ET date. Built the same way in every market state.
function dateAccuracyContext(input, section, sectionIndex) {
  const report = exchangeDateParts(input?.analysisRequest?.generatedAt);
  if (!report) return null;
  const allowedWeekdays = new Set([report.weekday]);
  const evidenceByReference = new Map((input.marketPackages || []).flatMap(marketPackage =>
    marketPackage.evidenceContext.evidence.map(entry => [entry.reference, entry.item])));
  const telemetryByReference = new Map((input.marketPackages || []).flatMap(marketPackage =>
    marketPackage.telemetry.benchmarkSnapshots.concat(marketPackage.telemetry.stockSnapshots)
      .map(entry => [entry.reference, entry.snapshot])));
  for (const marketPackage of input.marketPackages || []) {
    const completed = marketPackage.marketContext?.primaryCompletedSessionDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(completed || '')) allowedWeekdays.add(weekdayOfDateKey(completed));
  }
  for (const reference of section.evidenceRefs) {
    const item = evidenceByReference.get(reference);
    if (!item) continue;
    const published = exchangeDateParts(item.publishedAt);
    const text = `${item.title || ''} ${item.summary || ''}`;
    if (published) allowedWeekdays.add(published.weekday);
    for (const name of weekdaysNamed(text)) allowedWeekdays.add(name);
    for (const key of explicitDates(text, published ? published.date : report.date)) {
      allowedWeekdays.add(weekdayOfDateKey(key));
    }
  }
  for (const reference of section.telemetryRefs) {
    const snapshot = telemetryByReference.get(reference);
    for (const record of snapshot?.completedSessions || []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(record?.sessionDate || '')) allowedWeekdays.add(weekdayOfDateKey(record.sessionDate));
    }
  }
  return {allowedWeekdays, reportDate: report.date, pastDateCheck: sectionIndex === 6};
}

// Rule 31's detector: which date rule one sentence breaks, or null.
function dateAccuracyViolation(sentence, {allowedWeekdays, reportDate, pastDateCheck}) {
  if ([...weekdaysNamed(sentence)].some(name => !allowedWeekdays.has(name))) return 'WEEKDAY';
  if (pastDateCheck && explicitDates(sentence, reportDate).some(key => key < reportDate)) return 'PAST_DATE';
  return null;
}

// Removes the offending sentences and counts them per rule. When nothing offends,
// the section is returned unchanged.
function dateAccuracyCut(section, context, splitSentences) {
  const counts = {WEEKDAY: 0, PAST_DATE: 0};
  const {section: trimmed, removedSentenceCount, keptSentenceCount} = dropOffendingSentences(section, sentence => {
    const rule = dateAccuracyViolation(sentence, context);
    if (rule) counts[rule]++;
    return Boolean(rule);
  }, splitSentences);
  return {
    section: removedSentenceCount > 0 && keptSentenceCount === 0 ? {...trimmed, content: null} : trimmed,
    removedSentenceCount, keptSentenceCount, counts
  };
}

// ---------------------------------------------------------------------------
// Step 9V: SINCE_CLOSE_REPEAT. CLOSED, WEEKEND and HOLIDAY only, while
// completedSinceCloseEnabled is on, run by the cleanup stage after the date check.
// Each since-close item has one home section (Section 1 or Section 3). In Sections 1,
// 3 and 7, a sentence outside the item's home is removed when it carries
//   (i)  the item's publish time (as written from its publishedEt label), or
//   (ii) one of the item's validated subjects plus a figure (%, $, points) that the
//        item's home section gives in a sentence carrying its time or naming its subject.
// In Section 2 (closing-only), any sentence carrying an item's publish time is removed.
// A cut that would leave a section with no sentence is not made (the section is kept
// as written and the case is reported), so this never blanks a section. Like Step
// 21D.1's Section 4 cut, it is a cleanup-only sentence trim outside the numbered
// registry. Known limit: a reworded repeat with no shared time and no shared figure is
// not caught.
// ---------------------------------------------------------------------------
const SINCE_CLOSE_CHECKED_SECTIONS = Object.freeze([0, 2, 6]);
const SINCE_CLOSE_CLOSING_ONLY_SECTION = 1;
const SINCE_CLOSE_FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:trillion|billion|million|bn|m)\b)?|\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|points?\b)/gi;

// "Tue 20 Oct, 4:05 pm ET" -> a pattern for "4:05 pm" / "4:05 p.m." / "4:05pm".
function sinceCloseTimePattern(label) {
  const match = /(\d{1,2}):(\d{2})\s*([ap])m\b/i.exec(typeof label === 'string' ? label : '');
  return match ? new RegExp(`(?<![\\d:])${match[1]}:${match[2]}\\s?${match[3]}\\.?\\s?m\\b`, 'i') : null;
}

function sinceCloseFigures(text) {
  return new Set([...String(text || '').matchAll(SINCE_CLOSE_FIGURE)]
    .map(match => match[0].toLowerCase().replace(/[\s,]/g, '').replace('percent', '%')));
}

function namesSubject(sentence, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(name) && new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(sentence);
}

// `items`: [{homeSectionIndex, publishedEt, subjects}]. `sections`: the report's sections.
// Returns the new sections plus counts; sections with nothing removed are returned as is.
function sinceCloseRepeatCut(sections, items, splitSentences) {
  const prepared = items.map(item => ({...item, timePattern: sinceCloseTimePattern(item.publishedEt)}))
    .filter(item => item.timePattern);
  for (const item of prepared) {
    const home = sections[item.homeSectionIndex];
    const homeSentences = typeof home?.content === 'string' ? splitSentences(home.content) : [];
    item.figures = new Set(homeSentences.filter(sentence => item.timePattern.test(sentence)
      || item.subjects.some(name => namesSubject(sentence, name)))
      .flatMap(sentence => [...sinceCloseFigures(sentence)]));
  }
  const repeats = (sentence, index) => prepared.some(item => item.homeSectionIndex !== index
    && (item.timePattern.test(sentence)
      || (item.subjects.some(name => namesSubject(sentence, name))
        && [...sinceCloseFigures(sentence)].some(figure => item.figures.has(figure)))));
  const closingOnly = sentence => prepared.some(item => item.timePattern.test(sentence));
  const result = {sections: sections.slice(), removed: {}, keptToAvoidBlank: []};
  for (const index of [...SINCE_CLOSE_CHECKED_SECTIONS, SINCE_CLOSE_CLOSING_ONLY_SECTION]) {
    const section = sections[index];
    if (!section || typeof section.content !== 'string') continue;
    const offending = index === SINCE_CLOSE_CLOSING_ONLY_SECTION
      ? closingOnly : sentence => repeats(sentence, index);
    const cut = dropOffendingSentences(section, offending, splitSentences);
    if (cut.removedSentenceCount === 0) continue;
    if (cut.keptSentenceCount === 0) {
      result.keptToAvoidBlank.push(index);
      continue;
    }
    result.sections[index] = cut.section;
    result.removed[index] = cut.removedSentenceCount;
  }
  return result;
}

// The fixed no-news sentence (Kevin's wording, Step 9V decision 4). The active since-close
// instruction quotes the same sentence.
function sinceCloseNoNewsSentence(lastCloseEt) {
  return `No new market news has been published since the close on ${lastCloseEt}.`;
}

function mentionsSinceTheClose(content) {
  return typeof content === 'string' && /\bsince the (?:last )?(?:regular )?close\b/i.test(content);
}

// ---------------------------------------------------------------------------
// Step 9V.3: the since-close coverage check. A WARNING ONLY: it reads the finished report and
// never changes it. `items`: [{evidenceRef, homeSectionIndex, publishedEt}] (at least one).
//   Section 1, when any item's home is Section 1: passes when a Section 1 sentence carries the
//     publish time of one of those Section 1 items (TIMED_ITEM), otherwise MISSING.
//   Section 1, when every item's home is Section 3: passes when a Section 1 sentence carries any
//     listed publish time (TIMED_ITEM) or is a pointer sentence (POINTER), otherwise MISSING.
//     A pointer says "after / since / following the close" (also "the last close", "Friday's
//     close") or points to "Stocks & Sectors in Focus".
//   An empty Section 1 is SECTION_EMPTY. MISSING and SECTION_EMPTY warn.
//   Section 3: each Section 3-home item that Section 3 cites must have its publish time in some
//     Section 3 sentence; the ones without are listed (per item, not per sentence).
// ---------------------------------------------------------------------------
const SINCE_CLOSE_POINTER = /\b(?:since|after|following)\s+(?:the\s+)?(?:(?:last|regular|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day['’]s)\s+)*close\b|\bStocks\s+(?:&|and)\s+Sectors\s+in\s+Focus\b/i;

function isSinceClosePointerSentence(sentence) {
  return typeof sentence === 'string' && SINCE_CLOSE_POINTER.test(sentence);
}

function sinceCloseCoverage(sections, items, splitSentences) {
  const prepared = items.map(item => ({...item, timePattern: sinceCloseTimePattern(item.publishedEt)}));
  const carriesTime = (sentences, list) => sentences.some(sentence =>
    list.some(item => item.timePattern && item.timePattern.test(sentence)));
  const sectionOneContent = sections[0]?.content;
  let sectionOne;
  if (typeof sectionOneContent !== 'string' || !sectionOneContent.trim()) {
    sectionOne = 'SECTION_EMPTY';
  } else {
    const sentences = splitSentences(sectionOneContent);
    const sectionOneItems = prepared.filter(item => item.homeSectionIndex === 0);
    if (sectionOneItems.length > 0) {
      sectionOne = carriesTime(sentences, sectionOneItems) ? 'TIMED_ITEM' : 'MISSING';
    } else if (carriesTime(sentences, prepared)) {
      sectionOne = 'TIMED_ITEM';
    } else {
      sectionOne = sentences.some(isSinceClosePointerSentence) ? 'POINTER' : 'MISSING';
    }
  }
  const sectionThree = sections[2];
  const cited = new Set(Array.isArray(sectionThree?.evidenceRefs) ? sectionThree.evidenceRefs : []);
  const sectionThreeSentences = typeof sectionThree?.content === 'string'
    ? splitSentences(sectionThree.content) : [];
  const untimedSectionThreeRefs = prepared
    .filter(item => item.homeSectionIndex === 2 && cited.has(item.evidenceRef) && item.timePattern
      && !carriesTime(sectionThreeSentences, [item]))
    .map(item => item.evidenceRef);
  const paragraphMissing = sectionOne === 'MISSING' || sectionOne === 'SECTION_EMPTY';
  const warnings = [
    ...(paragraphMissing ? ['SINCE_CLOSE_PARAGRAPH_MISSING'] : []),
    ...(untimedSectionThreeRefs.length > 0 ? ['SINCE_CLOSE_TIME_MISSING'] : [])
  ];
  return {
    sectionOne, untimedSectionThreeRefs, warnings,
    warningCount: (paragraphMissing ? 1 : 0) + untimedSectionThreeRefs.length
  };
}

// ---------------------------------------------------------------------------
// Step 9Z: Section 1 length, for the log only (shortExecutiveSummaryEnabled). It reads the
// finished Section 1 and never changes it. `sinceCloseItems`: on CLOSED, WEEKEND and HOLIDAY
// days the since-close items [{publishedEt}] (possibly none); on PRE, REGULAR and POST, null.
//   words: whitespace-split words, as the report word cap counts them.
//   sinceCloseWords: completed days only -- words in sentences outside the length guide: a
//     sentence carrying a since-close item's publish time, a pointer sentence, or the fixed
//     no-news sentence. On active days every sentence is part of the story, so 0.
//   guidedWords: words - sinceCloseWords.
//   indexNamesFound: how many of the S&P 500, the NASDAQ and the Dow are named in a Section 1
//     sentence that also has a figure (0-3).
// ---------------------------------------------------------------------------
const SECTION_ONE_INDEX_NAMES = Object.freeze([/\bS&P\s?500\b/i, /\bNasdaq\b/i, /\bDow\b/i]);
const SINCE_CLOSE_NO_NEWS_START = /^No new market news has been published since the close on /;

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function sectionOneLength(section, sinceCloseItems, splitSentences) {
  const content = typeof section?.content === 'string' ? section.content : '';
  const sentences = content.trim() ? splitSentences(content) : [];
  const timePatterns = Array.isArray(sinceCloseItems)
    ? sinceCloseItems.map(item => sinceCloseTimePattern(item.publishedEt)).filter(Boolean) : null;
  const outsideGuide = sentence => timePatterns !== null && (SINCE_CLOSE_NO_NEWS_START.test(sentence)
    || isSinceClosePointerSentence(sentence) || timePatterns.some(pattern => pattern.test(sentence)));
  const words = wordCount(content);
  const sinceCloseWords = sentences.filter(outsideGuide).reduce((sum, sentence) => sum + wordCount(sentence), 0);
  return {
    words,
    guidedWords: words - sinceCloseWords,
    sinceCloseWords,
    sentences: sentences.length,
    indexNamesFound: SECTION_ONE_INDEX_NAMES.filter(name =>
      sentences.some(sentence => name.test(sentence) && /\d/.test(sentence))).length
  };
}

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
      detect: controlledUnavailable,
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
      detect: input => sectionFourPortfolio(input).length === 0,
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
      detect: appendFirstUseReferences},
    // Step 8W: the date check (see dateAccuracyCut above), behind dateAccuracyEnabled.
    {number: 31, id: 'DATE_ACCURACY', sections: ALL_ANALYSIS_SECTIONS, usedBy: ['cleanup'],
      detect: dateAccuracyViolation,
      notShared: 'Cleanup only: a sentence trim run after the rule loop (like Step 21D.1); the checker has '
        + 'no date check, so a date can never fail a whole report.'}
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

// ---------------------------------------------------------------------------
// Step 21D.1: Section 4 gives a reason for a stock's move only when an
// article linked to THAT stock is cited in Section 4.
//
// A stock is "supported" when Section 4 cites a news item from that
// security's own evidenceRefs (or its upcomingEvents evidenceRefs) in
// portfolioContext -- the same link that decides what Section 4 may cite at
// all. Its own market-data page is not an article and never supports it.
//
// Each Section 4 sentence is matched to the starting-list stocks it names (a
// sentence naming none carries on the previous sentence's stocks, or, with
// none before it, is about the whole list). An upcoming-event reference of the
// stock also supports it (none is supplied today). A
// sentence whose stocks are all supported is kept as written. Any other
// sentence keeps only its opening run of move facts: the cut is made at the
// first word that is NOT a recognised move fact, then taken back to the start
// of that phrase, so whatever the wording of a reason ("as", "amid", "on",
// "tracking", "in line with", "benefiting from", or anything else) it is
// removed. The word table below lists what IS allowed (numbers, prices,
// moves, days and times, index and market names, the list's own stock
// names); nothing in it names a cause, so an unknown word always cuts. The
// kept part must still name a stock (or the list) and a move or a number;
// otherwise the sentence is dropped. Same code in every market state.
// ---------------------------------------------------------------------------
const SECTION_FOUR_MOVE_WORDS = new Set((
  'rose rise rises rising risen gained gain gains gaining climbed climb climbs climbing jumped jump jumps '
  + 'jumping surged surge surges surging soared soar soaring rallied rally rallies rallying advanced advance '
  + 'advances advancing added adding edged edge edges edging ticked ticking inched inching rebounded '
  + 'rebound rebounding recovered recover recovering fell fall falls falling fallen dropped drop drops '
  + 'dropping declined decline declines declining slipped slip slips slipping slid slide slides sliding '
  + 'sank sink sinking tumbled tumble tumbling plunged plunge plunging lost lose losing loss losses shed '
  + 'shedding retreated retreat retreating eased ease easing dipped dip dips dipping slumped slump '
  + 'lower higher up down flat unchanged steady little changed mixed sharply slightly modestly steeply '
  + 'firmly marginally strongly fractionally move moves moved moving movement performance weakness strength '
  + 'selloff sell-off high highs low lows record peak trough closed close closes closing ended end ending '
  + 'finished finish finishing opened open opens opening traded trade trades trading held hold holds holding '
  + 'stood sat extended extending pared paring erased erasing reversed reversing outperformed outperforming '
  + 'outperform underperformed underperforming underperform tracked tracking track mirrored mirroring mirror '
  + 'matched matching reflected reflecting lagged lagging lag beat beating streak worst best biggest largest '
  + 'smallest steepest decrease increase increased'
).split(' '));
const SECTION_FOUR_FACT_WORDS = new Set((
  // days, times and sessions
  'monday tuesday wednesday thursday friday saturday sunday today yesterday tonight session sessions day days '
  + 'week weeks weekly month months monthly year years intraday premarket pre-market after-hours afterhours '
  + 'overnight morning afternoon evening prior previous earlier last this that so far since through '
  + 'year-to-date ytd et a.m. p.m. am pm january february march april may june july august september '
  + 'october november december jan feb mar apr jun jul aug sep sept oct nov dec all-time '
  // numbers in words and units
  + 'one two three four five six seven eight nine ten first second third fourth fifth sixth seventh eighth '
  + 'ninth tenth straight consecutive row % $ point points pts percent percentage cents dollar dollars per '
  + 'share price prices level levels '
  // the market and the indexes (a comparison with the index move is allowed)
  + 'market markets broad broader broad-market overall wider whole index indexes indices benchmark benchmarks '
  + 's&p 500 nasdaq composite dow jones industrial average russell 2000 wall street u.s. us '
  // the list itself
  + 'stocks stock shares share names holdings holding list portfolio my your watchlist etf fund'
).split(' '));
// Allowed, but a kept part may not end on one of these.
const SECTION_FOUR_LINK_WORDS = new Set((
  'the a an of to from at by and or but while with as than more less about around roughly nearly almost '
  + 'near just over under above below for in on after following before both each also its it their which '
  + 'compared versus vs against despite amid amidst alongside like line respectively then again still '
  + 'further another all most mostly much many some other others into toward towards back was were is are '
  + 'be been being has had have did reached reaching hit hitting set setting marked marking within '
  + 'among across conversely meanwhile elsewhere however separately similarly likewise additionally '
  + 'finally overall showed show shows posted posting saw'
).split(' '));
// A phrase starts at one of these words (or after , ; : or a dash).
const SECTION_FOUR_PHRASE_STARTS = new Set((
  'as amid amidst after following despite while on with tracking mirroring reflecting outperforming '
  + 'underperforming alongside because due thanks like given since from to at by in and but which'
).split(' '));
const SECTION_FOUR_LIST_SUBJECTS = new Set(['stocks', 'shares', 'names', 'holdings', 'list', 'portfolio', 'watchlist']);
const SECTION_FOUR_NAME_SUFFIX = /(?:,?\s+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|a\/s|ag|sa|nv|n\.v|se|spa|s\.a))\.?$/i;
const SECTION_FOUR_GENERIC_NAME_WORDS = new Set([
  'group', 'holdings', 'holding', 'systems', 'platforms', 'technologies', 'technology', 'international',
  'industries', 'enterprises', 'the', '&', 'and'
]);
const SECTION_FOUR_NUMBER = /^(?:[-+]?\$?\d[\d,]*(?:\.\d+)?%?|\d+(?:st|nd|rd|th)|\d+-(?:day|week|month|year|session)s?|(?:one|two|three|four|five|six|seven|eight|nine|ten)-(?:day|week|month|year|session)s?)$/;

function sectionFourTokenKey(token) {
  return token.toLowerCase().replace(/['’]s$/, '').replace(/['’]$/, '').replace(/\.$/, (dot, offset, value) =>
    /^(?:u\.s|a\.m|p\.m|n\.v|s\.a)$/.test(value.slice(0, -1)) ? dot : '');
}

// The names a sentence may use for one starting-list stock: the instrument
// name, without its legal suffix (Inc., Corporation, Limited, A/S ...), then
// without trailing generic words (Group, Holdings, Systems, Platforms ...),
// so "UnitedHealth Group Incorporated" is also "UnitedHealth" and
// "Novo Nordisk A/S" is also "Novo Nordisk". A name of 3 letters or fewer is
// not used on its own. Lowercased.
function sectionFourNameVariants(instrumentName) {
  if (typeof instrumentName !== 'string' || !instrumentName.trim()) return [];
  const variants = [];
  let name = instrumentName.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  variants.push(name);
  for (;;) {
    const stripped = name.replace(SECTION_FOUR_NAME_SUFFIX, '').replace(/,$/, '').trim();
    if (!stripped || stripped === name) break;
    name = stripped;
    variants.push(name);
  }
  let words = name.split(' ');
  while (words.length > 1 && SECTION_FOUR_GENERIC_NAME_WORDS.has(words[words.length - 1])) {
    words = words.slice(0, -1);
    variants.push(words.join(' '));
  }
  return [...new Set(variants)].filter(variant => variant.replace(/[^\p{L}\p{N}]/gu, '').length > 3
    || variant.includes(' '));
}

function sectionFourNamesStock(text, stock) {
  const lower = text.normalize('NFKC').toLowerCase();
  const symbolPattern = stock.symbol.length >= 2
    ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${stock.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u')
    : new RegExp(`\\(${stock.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
  if (symbolPattern.test(text.normalize('NFKC'))) return true;
  return stock.names.some(name => new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'u'
  ).test(lower));
}

// The starting-list stocks for the cut: symbol, name variants, and whether a
// linked news article is cited in Section 4. `evidenceCategoryOf(ref)` gives
// the evidence item's category ('news', 'market-data', ...).
function sectionFourStocks(initiatingPortfolio, instrumentNameOf, citedEvidenceRefs, evidenceCategoryOf) {
  const cited = new Set(citedEvidenceRefs);
  return initiatingPortfolio.map(security => {
    const eventRefs = security.upcomingEvents.flatMap(event => event.evidenceRefs);
    return {
      symbol: security.symbol,
      names: sectionFourNameVariants(instrumentNameOf(security)),
      supported: security.evidenceRefs.some(reference => cited.has(reference)
        && evidenceCategoryOf(reference) === 'news')
        || eventRefs.some(reference => cited.has(reference))
    };
  });
}

// Tokens with their positions, and where phrases start (punctuation or a
// phrase-start word).
function sectionFourTokens(sentence) {
  const tokens = [];
  const pattern = /[\p{L}\p{N}$%&'’.\-/+]+/gu;
  let match;
  let previousEnd = 0;
  while ((match = pattern.exec(sentence)) !== null) {
    let raw = match[0];
    let start = match.index;
    while (raw && /^['’.\-]/.test(raw)) { raw = raw.slice(1); start += 1; }
    while (raw && /['’\-]$/.test(raw)) raw = raw.slice(0, -1);
    if (!raw || !/[\p{L}\p{N}$%]/u.test(raw)) continue;
    const between = sentence.slice(previousEnd, start);
    tokens.push({raw, start, end: start + raw.length, key: sectionFourTokenKey(raw),
      punctuationBefore: /[,;:—–]|--|\s-\s/.test(between)});
    previousEnd = start + raw.length;
  }
  return tokens;
}

// Shortens one unsupported sentence to its opening move facts. Returns the
// sentence unchanged when every word is a move fact, the shortened sentence,
// or null when nothing usable is left.
function sectionFourMoveFactsOnly(sentence, stocks) {
  const tokens = sectionFourTokens(sentence);
  const nameWords = new Set(stocks.flatMap(stock => [stock.symbol.toLowerCase()]
    .concat(stock.names.flatMap(name => name.split(' ').map(sectionFourTokenKey)))));
  const allowed = token => SECTION_FOUR_NUMBER.test(token.key) || SECTION_FOUR_MOVE_WORDS.has(token.key)
    || SECTION_FOUR_FACT_WORDS.has(token.key) || SECTION_FOUR_LINK_WORDS.has(token.key)
    || nameWords.has(token.key);
  const firstUnknown = tokens.findIndex(token => !allowed(token));
  if (firstUnknown === -1) return sentence;
  let cut = firstUnknown;
  while (cut > 0 && !tokens[cut].punctuationBefore && !SECTION_FOUR_PHRASE_STARTS.has(tokens[cut].key)) cut -= 1;
  const trimTrailing = from => {
    let end = from;
    while (end > 0 && (SECTION_FOUR_LINK_WORDS.has(tokens[end - 1].key)
        || SECTION_FOUR_PHRASE_STARTS.has(tokens[end - 1].key)
        || /^(?:tracking|mirroring|reflecting|outperforming|underperforming|tracked|mirrored|reflected|outperformed|underperformed)$/.test(tokens[end - 1].key))) {
      end -= 1;
    }
    return end;
  };
  let end = trimTrailing(cut);
  // A lone word left after a comma (", recovering.") is dropped too, unless it is a number.
  if (end >= 2 && tokens[end - 1].punctuationBefore && !SECTION_FOUR_NUMBER.test(tokens[end - 1].key)) {
    end = trimTrailing(end - 1);
  }
  const kept = tokens.slice(0, end);
  const namesSubject = kept.length > 0 && (stocks.some(stock =>
    sectionFourNamesStock(sentence.slice(0, kept[kept.length - 1].end), stock))
    || kept.some(token => SECTION_FOUR_LIST_SUBJECTS.has(token.key)));
  const hasMove = kept.some(token => SECTION_FOUR_MOVE_WORDS.has(token.key) || SECTION_FOUR_NUMBER.test(token.key));
  if (!namesSubject || !hasMove) return null;
  return `${sentence.slice(0, kept[kept.length - 1].end).replace(/[.]+$/, '')}.`;
}

// The whole Section 4 cut. `splitSentences` is the caller's sentence
// splitter (lib/claude-analysis-contract.js's splitReportSentences, injected
// to avoid a require cycle). Returns the section unchanged (same object) when
// nothing is cut.
function sectionFourCauseCut(section, stocks, splitSentences) {
  const result = {section, shortenedSentenceCount: 0, removedSentenceCount: 0, sentenceCount: 0};
  if (section.content === null) return result;
  const sentences = splitSentences(section.content);
  result.sentenceCount = sentences.length;
  const kept = [];
  let carried = [];
  for (const sentence of sentences) {
    const named = stocks.filter(stock => sectionFourNamesStock(sentence, stock));
    // A sentence naming no stock carries on the previous sentence's stocks; with none
    // before it, it is about the whole list, so every stock must be supported.
    const subjects = named.length > 0 ? named : carried.length > 0 ? carried : stocks;
    carried = named.length > 0 ? named : carried;
    if (subjects.length > 0 && subjects.every(stock => stock.supported)) {
      kept.push(sentence);
      continue;
    }
    const shortened = sectionFourMoveFactsOnly(sentence, stocks);
    if (shortened === sentence) kept.push(sentence);
    else if (shortened === null) result.removedSentenceCount += 1;
    else {
      kept.push(shortened);
      result.shortenedSentenceCount += 1;
    }
  }
  if (result.shortenedSentenceCount + result.removedSentenceCount > 0) {
    result.section = {...section, content: kept.length > 0 ? kept.join(' ') : null};
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 21D.2: Section 4 covers both lists. While sectionFourBothListsEnabled is
// on (default), the Section 4 stocks are every My Stocks security, then every
// Watchlist security, each in its saved order (a security in both lists counts
// once, in My Stocks), whichever list started the brief. Everything that
// decides Section 4's scope -- the writer's allowed references, the cleanup,
// the final check, the Step 21D.1 reason check and the empty-list wording --
// reads it from here, in every market state. Off: the starting list only,
// exactly as before.
// ---------------------------------------------------------------------------
const SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT = 'No securities are configured in My Stocks or the Watchlist.';
const SECTION_FOUR_BOTH_LISTS_NO_DATA = 'Not enough data to comment on your stocks.';

function sectionFourBothListsOn({env = process.env} = {}) {
  return settingValue('sectionFourBothListsEnabled', {env}) === true;
}

function sectionFourPortfolio(input, options) {
  if (!sectionFourBothListsOn(options)) return input.portfolioContext[input.analysisRequest.initiatingList];
  const seen = new Set();
  return input.portfolioContext.myStocks.concat(input.portfolioContext.watchlist).filter(security => {
    const key = `${security.market}:${security.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// `startingListContent` is the caller's per-list "No securities are configured
// in ..." table (lib/claude-analysis-contract.js, passed in to avoid a cycle).
function sectionFourEmptyContent(input, startingListContent) {
  return sectionFourBothListsOn()
    ? SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT
    : startingListContent[input.analysisRequest.initiatingList];
}

// The words used when Section 4 is emptied for lack of data.
function sectionFourNoDataMessage(startingListMessage) {
  return sectionFourBothListsOn() ? SECTION_FOUR_BOTH_LISTS_NO_DATA : startingListMessage;
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
  dateAccuracyContext,
  dateAccuracyViolation,
  dateAccuracyCut,
  weekdaysNamed,
  explicitDates,
  sinceCloseTimePattern,
  sinceCloseFigures,
  sinceCloseRepeatCut,
  sinceCloseNoNewsSentence,
  mentionsSinceTheClose,
  isSinceClosePointerSentence,
  sinceCloseCoverage,
  sectionOneLength,
  SECTION_RULE_CLEANUP_ORDER,
  runSectionRules,
  sectionFourNameVariants,
  sectionFourNamesStock,
  sectionFourStocks,
  sectionFourMoveFactsOnly,
  sectionFourCauseCut,
  SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT,
  SECTION_FOUR_BOTH_LISTS_NO_DATA,
  sectionFourBothListsOn,
  sectionFourPortfolio,
  sectionFourEmptyContent,
  sectionFourNoDataMessage,
  controlledUnavailable,
  WRITER_SECTION_RETRY_SECTIONS,
  retryEligibleEmptySections
};

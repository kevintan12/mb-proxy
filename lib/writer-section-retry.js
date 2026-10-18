'use strict';

// Step 9L (Kevin, 18 Oct 2026): the writer retry for an empty section, and the
// guided whole-report retry (decision 3). One shared module for every market state;
// nothing here is per state. The section rules decide which sections are eligible
// (lib/section-rules.js retryEligibleEmptySections); the writer call itself stays in
// lib/claude-analysis-invocation.js, which passes it in as `runRound`.
//
// Nothing written to the logs or into a retry instruction contains report prose or
// article text: only section names, rule categories and counts.

const {
  REPORT_SECTION_NAMES,
  splitReportSentences,
  hasInternalIdentifierLeak,
  hasMalformedPlainEnglishProse
} = require('./claude-analysis-contract');
const {retryEligibleEmptySections} = require('./section-rules');

const PROVIDER_SECTION_FIELD_KEYS = Object.freeze(['content', 'evidenceRefs', 'telemetryRefs', 'uncertainties']);

// Plain wording for each rule category, used in retry instructions. Fixed text.
const CATEGORY_GUIDANCE = Object.freeze({
  WRITER_LEFT_EMPTY: 'you left it empty',
  INTERNAL_IDENTIFIER_LEAK: 'it contained an internal field name, code name or reference code (such as a '
    + 'camelCase or dotted name); write plain English only',
  PLAIN_LANGUAGE_VALIDATION: 'it contained a broken, spliced phrase; write complete plain sentences',
  CONTENT_NEEDS_EVIDENCE: 'it had text but cited no supplied evidence reference; cite the evidence '
    + 'references that support each statement',
  SECTION_ONE_REQUIRED: 'the Executive Market Summary was empty; it must have supported content',
  CAUSAL_CLAIM_CATALYST_REQUIRED: 'it said what caused a move without citing a principal catalyst of '
    + 'the right session; give the move without a cause, or cite the principal catalyst that states it',
  DRIVER_REFERENCE_REQUIRED: 'it cited no material event or principal catalyst',
  SECTION_THREE_SCOPE: 'it cited or named something outside the broad-market focus list',
  SECTION_FOUR_SCOPE: 'it cited a reference outside the allowed My Stocks and Watchlist references',
  UNGROUNDED_OPPORTUNITY: 'an opportunity did not name a subject of a cited broad-market focus entry',
  REPORT_WORD_CAP: 'the report was over the word limit; write shorter sections',
  UNKNOWN_REFERENCE: 'it cited a reference that is not in the supplied package',
  MALFORMED_REPLY: 'the reply did not follow the required structured format',
  REPORT_STATUS: 'the status and evidence gaps did not match the sections',
  REPORT_SHAPE: 'part of the report had an invalid shape',
  // Step 8W: a section emptied by the date check.
  DATE_ACCURACY: 'it named a weekday the cited articles do not support, or gave an event dated before the '
    + 'report as upcoming; count day words from each article\'s publishedEt and leave past events out of '
    + 'What to Watch',
  OTHER_CHECK: "it failed one of MarketBrief's checks"
});

// Each final-check or writer error message (our own fixed wording, never report
// text) maps to one category and the field it concerns.
const ERROR_CATEGORY_PATTERNS = Object.freeze([
  [/internal identifier leak in uncertainties/, 'INTERNAL_IDENTIFIER_LEAK', 'uncertainties'],
  [/evidence gaps contain an internal identifier leak/, 'INTERNAL_IDENTIFIER_LEAK', 'evidenceGaps'],
  [/internal identifier leak/, 'INTERNAL_IDENTIFIER_LEAK', 'content'],
  [/malformed plain-language prose in uncertainties/, 'PLAIN_LANGUAGE_VALIDATION', 'uncertainties'],
  [/evidence gaps contain malformed plain-language prose/, 'PLAIN_LANGUAGE_VALIDATION', 'evidenceGaps'],
  [/malformed plain-language prose/, 'PLAIN_LANGUAGE_VALIDATION', 'content'],
  [/factual content requires supplied evidence/, 'CONTENT_NEEDS_EVIDENCE', 'evidenceRefs'],
  [/executive market summary requires supported content/, 'SECTION_ONE_REQUIRED', 'content'],
  [/drivers require/, 'DRIVER_REFERENCE_REQUIRED', 'evidenceRefs'],
  [/causality|catalyst/, 'CAUSAL_CLAIM_CATALYST_REQUIRED', 'content'],
  [/broad-market focus|broad-market subject|benchmark telemetry/, 'SECTION_THREE_SCOPE', 'evidenceRefs'],
  [/initiating list|no-securities/, 'SECTION_FOUR_SCOPE', 'evidenceRefs'],
  [/opportunity/, 'UNGROUNDED_OPPORTUNITY', 'content'],
  [/word allowance/, 'REPORT_WORD_CAP', 'content'],
  [/unknown or invalid reference/, 'UNKNOWN_REFERENCE', 'evidenceRefs'],
  [/structured result|section payload|transport shape/, 'MALFORMED_REPLY', 'reply'],
  [/invalid evidence references/, 'REPORT_SHAPE', 'evidenceRefs'],
  [/invalid telemetry references/, 'REPORT_SHAPE', 'telemetryRefs'],
  [/invalid uncertainties|requires uncertainty/, 'REPORT_SHAPE', 'uncertainties'],
  [/invalid content/, 'REPORT_SHAPE', 'content'],
  [/NORMAL|DEGRADED|FAILED|analytical status|evidence gaps/, 'REPORT_STATUS', 'status'],
  [/invalid|order|Further Readings|FURTHER READINGS|report context/, 'REPORT_SHAPE', 'report']
]);

// Cleanup-stage event categories (lib/claude-analysis-invocation.js) mapped to the
// same plain categories, by keyword.
function cleanupCategory(code) {
  if (/DATE_ACCURACY/.test(code)) return 'DATE_ACCURACY';
  if (/IDENTIFIER/.test(code)) return 'INTERNAL_IDENTIFIER_LEAK';
  if (/PLAIN_LANGUAGE/.test(code)) return 'PLAIN_LANGUAGE_VALIDATION';
  if (/CATALYST/.test(code)) return 'CAUSAL_CLAIM_CATALYST_REQUIRED';
  if (/DRIVER/.test(code)) return 'DRIVER_REFERENCE_REQUIRED';
  if (/OPPORTUNITY/.test(code)) return 'UNGROUNDED_OPPORTUNITY';
  if (/NON_INITIATING|INITIATING/.test(code)) return 'SECTION_FOUR_SCOPE';
  if (/FOCUS|BENCHMARK|PORTFOLIO_MENTION|SECTION_THREE/.test(code)) return 'SECTION_THREE_SCOPE';
  if (/UNKNOWN/.test(code)) return 'UNKNOWN_REFERENCE';
  if (/INVALID/.test(code)) return 'REPORT_SHAPE';
  return 'OTHER_CHECK';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function emit(onDiagnostics, event) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(deepFreeze(event)); } catch (error) {
    // Observability must not affect analysis behavior.
  }
}

function sectionLabel(index) {
  return Number.isInteger(index) && REPORT_SECTION_NAMES[index] ? REPORT_SECTION_NAMES[index] : null;
}

// Decision 3: the section, field and rule category of a whole-report failure,
// read from our own error message. Never returns any part of the message itself.
function contractFailureCategories(message) {
  if (typeof message !== 'string') return Object.freeze([]);
  const parts = message.replace(/^Invalid Claude analysis output:\s*/, '').split('; ');
  const seen = new Set();
  const categories = [];
  for (const part of parts) {
    const match = /^sections\[(\d)\]:\s*(.*)$/.exec(part);
    const sectionIndex = match ? Number(match[1]) : null;
    const text = match ? match[2] : part;
    const found = ERROR_CATEGORY_PATTERNS.find(([pattern]) => pattern.test(text));
    const [category, field] = found ? [found[1], found[2]] : ['OTHER_CHECK', 'report'];
    const key = `${sectionIndex}|${field}|${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    categories.push({sectionIndex, sectionName: sectionLabel(sectionIndex), field, category});
  }
  return deepFreeze(categories);
}

// Decision 3: the sentence added to the whole-report retry request.
function retryGuidanceInstruction(categories) {
  const items = (categories.length ? categories : [{sectionIndex: null, category: 'OTHER_CHECK'}])
    .map(entry => `${entry.sectionName ? entry.sectionName : 'the report as a whole'}: `
      + `${CATEGORY_GUIDANCE[entry.category] || CATEGORY_GUIDANCE.OTHER_CHECK}`);
  return 'RETRY: your previous answer to this same request was rejected by MarketBrief\'s checks for '
    + `these reasons: ${items.join('; ')}. Answer the whole request again, following every rule above `
    + 'and fixing these problems. The checks are the same. Never invent facts, numbers, dates or events '
    + 'to fill a section; leave a section empty (content null with one plain uncertainty) when the '
    + 'supplied evidence does not support it, except where the rules above require content.';
}

// Why each empty section is empty: the writer left it empty, or a cleanup rule
// blanked it (categories from that attempt's own cleanup events).
function emptyReasons(rawTransport, cleanupEvents, index) {
  const slot = rawTransport?.[`s${index + 1}`];
  if (slot && slot.content === null) return ['WRITER_LEFT_EMPTY'];
  const reasons = [];
  const add = category => { if (!reasons.includes(category)) reasons.push(category); };
  for (const event of cleanupEvents) {
    if (event.sectionIndex !== index || event.action === 'TRIMMED') continue;
    const codes = Array.isArray(event.validationViolationCategories) && event.validationViolationCategories.length
      ? event.validationViolationCategories : [event.violationCategory];
    for (const code of codes) {
      if (code !== 'OPTIONAL_SECTION_VALIDATION') add(cleanupCategory(String(code || '')));
    }
  }
  // The last-resort step does not always say which check failed; the same detectors
  // the final check uses tell it from the raw section (categories only).
  if (reasons.length === 0 && slot && typeof slot.content === 'string') {
    const uncertainties = typeof slot.uncertainties === 'string' ? slot.uncertainties : '';
    if (hasInternalIdentifierLeak(slot.content) || hasInternalIdentifierLeak(uncertainties)) {
      add('INTERNAL_IDENTIFIER_LEAK');
    }
    if (hasMalformedPlainEnglishProse(slot.content) || hasMalformedPlainEnglishProse(uncertainties)) {
      add('PLAIN_LANGUAGE_VALIDATION');
    }
    if (slot.evidenceRefs === '') add('CONTENT_NEEDS_EVIDENCE');
  }
  return reasons.length ? reasons : ['OTHER_CHECK'];
}

function evidenceRefsOf(entries) {
  return [...new Set((entries || []).map(entry => typeof entry === 'string' ? entry : entry?.evidenceRef)
    .filter(reference => typeof reference === 'string'))];
}

function allowedRefsInstruction(index, input) {
  const contexts = (input?.marketPackages || []).map(item => item.evidenceContext || {});
  if (index === 1) {
    const refs = evidenceRefsOf(contexts.flatMap(context =>
      [...(context.materialEvents || []), ...(context.principalCatalysts || [])]));
    return `cite only these evidence refs: ${refs.join(', ') || 'none'}`;
  }
  if (index === 2) {
    const refs = evidenceRefsOf(contexts.flatMap(context => context.broadMarketFocus || []));
    return `cite only these broad-market focus evidence refs: ${refs.join(', ') || 'none'}`;
  }
  return 'cite only supplied evidence refs that the rules above allow in this section';
}

// Round 1: rewrite under every rule, empty if unsupported. Round 2 and later add
// the stricter limits (refs the section may use, a sentence cap, no cause unless a
// principal catalyst is cited).
function sectionRetryInstruction({round, rounds, targets, input, maxSentences}) {
  const list = targets.map(target => `${REPORT_SECTION_NAMES[target.index]} (`
    + `${target.reasons.map(reason => CATEGORY_GUIDANCE[reason] || CATEGORY_GUIDANCE.OTHER_CHECK).join('; ')})`);
  const lines = [
    `SECTION RETRY, round ${round} of ${rounds}. In your previous answer to this same request these `
      + `sections ended up empty: ${list.join('; ')}.`,
    'Write only these sections again from the supplied evidence, following every rule above; '
      + 'MarketBrief applies exactly the same checks.',
    'For every other section slot return content null and empty strings for evidenceRefs, telemetryRefs '
      + 'and uncertainties: MarketBrief keeps its own copy of those sections and ignores anything there.',
    'If the supplied evidence does not support a section, return its content as null with one plain '
      + 'uncertainty: a blank section is better than one the cited evidence does not support. Never invent '
      + 'facts, numbers, dates or events.'
  ];
  if (round >= 2) {
    const catalysts = evidenceRefsOf((input?.marketPackages || [])
      .flatMap(item => item.evidenceContext?.principalCatalysts || []));
    lines.push(`This is a stricter round. Use at most ${maxSentences} sentences in each of these sections. `
      + targets.map(target => `In ${REPORT_SECTION_NAMES[target.index]}, `
        + `${allowedRefsInstruction(target.index, input)}.`).join(' ')
      + ' Do not say what caused any move unless the same section cites one of these principal catalyst '
      + `refs: ${catalysts.join(', ') || 'none, so state no cause'}.`);
  }
  return lines.join(' ');
}

function usableRetrySlot(slot, maxSentences) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
  const keys = Object.keys(slot);
  if (keys.length !== PROVIDER_SECTION_FIELD_KEYS.length
      || !PROVIDER_SECTION_FIELD_KEYS.every(key => keys.includes(key))) return false;
  if (typeof slot.content !== 'string' || !slot.content.trim()) return false;
  if (!['evidenceRefs', 'telemetryRefs', 'uncertainties'].every(key => typeof slot[key] === 'string')) {
    return false;
  }
  return !(maxSentences && splitReportSentences(slot.content).length > maxSentences);
}

// The retried raw sections replace the empty ones in the previous raw reply; every
// other slot, the status and the evidence gaps stay exactly as they were. Throws when
// the retry gave no usable section (the round then keeps the previous report).
function mergeSectionRetryTransport(previousRaw, retryRaw, targetIndexes, {maxSentences = null} = {}) {
  if (!retryRaw || typeof retryRaw !== 'object' || Array.isArray(retryRaw)) {
    throw new TypeError('section retry reply has no usable section');
  }
  const merged = {...previousRaw};
  let used = 0;
  for (const index of targetIndexes) {
    const key = `s${index + 1}`;
    const slot = retryRaw[key];
    if (!usableRetrySlot(slot, maxSentences)) continue;
    merged[key] = {
      content: slot.content, evidenceRefs: slot.evidenceRefs,
      telemetryRefs: slot.telemetryRefs, uncertainties: slot.uncertainties
    };
    used++;
  }
  if (used === 0) throw new TypeError('section retry reply has no usable section');
  return merged;
}

// Decision 6: accepted only when every section that already had text comes out
// byte-identical and at least one retried section now has text.
function sectionRetryVerdict(previousOutput, nextOutput, targetIndexes) {
  for (let index = 0; index < REPORT_SECTION_NAMES.length - 1; index++) {
    const before = previousOutput.sections[index];
    if (!before || before.content === null) continue;
    if (JSON.stringify(nextOutput.sections[index]) !== JSON.stringify(before)) {
      return {accepted: false, outcome: 'REJECTED_CHANGED_SECTION', filled: []};
    }
  }
  const filled = targetIndexes.filter(index => nextOutput.sections[index]?.content !== null);
  return filled.length
    ? {accepted: true, outcome: 'ACCEPTED', filled}
    : {accepted: false, outcome: 'REJECTED_NO_TEXT', filled: []};
}

// The section-retry loop. `result` is the finished writer result; `context` holds the
// raw reply and canonical input it came from (null when the writer was not called).
// `runRound(systemSuffix, transformTransport)` makes one writer call and resolves to
// {result, context, cleanupEvents, usage}. Any failure keeps the previous report.
async function runWriterSectionRetry(result, {
  context, cleanupEvents = [], runRound, rounds, maxCallsPerRun, callsUsed,
  started, monotonicNow, maxElapsedMs, maxSentences, onDiagnostics
}) {
  if (!result || result.ok !== true || !context || !(rounds > 0)) return result;
  let current = {result, context, cleanupEvents};
  let used = callsUsed;
  for (let round = 1; round <= rounds; round++) {
    const targetIndexes = retryEligibleEmptySections(current.result.output, current.context.canonicalInput);
    if (targetIndexes.length === 0) break;
    const targets = targetIndexes.map(index => ({
      index, reasons: emptyReasons(current.context.rawTransport, current.cleanupEvents, index)
    }));
    const sections = targets.map(target => ({
      sectionIndex: target.index, sectionName: REPORT_SECTION_NAMES[target.index], reasonCategories: target.reasons
    }));
    const base = {stage: 'writerSectionRetry', round, sections, writerCallsUsed: used};
    if (used >= maxCallsPerRun) {
      emit(onDiagnostics, {...base, outcome: 'SKIPPED_CALL_CAP', filledSections: []});
      break;
    }
    if (monotonicNow() - started > maxElapsedMs) {
      emit(onDiagnostics, {...base, outcome: 'SKIPPED_TIME_LIMIT', filledSections: []});
      break;
    }
    const roundStarted = monotonicNow();
    const strictSentences = round >= 2 ? maxSentences : null;
    const instruction = sectionRetryInstruction({
      round, rounds, targets, input: current.context.canonicalInput, maxSentences
    });
    const previousRaw = current.context.rawTransport;
    let roundResult;
    let noUsableSection = false;
    try {
      roundResult = await runRound(instruction, raw => {
        try {
          return mergeSectionRetryTransport(previousRaw, raw, targetIndexes, {maxSentences: strictSentences});
        } catch (error) {
          noUsableSection = true;
          throw error;
        }
      });
    } catch (error) {
      roundResult = {result: {ok: false, type: 'UNAVAILABLE'}, context: null, cleanupEvents: [], usage: {}};
    }
    used++;
    const elapsedMs = Math.round(Math.max(0, monotonicNow() - roundStarted));
    const next = roundResult.result;
    let verdict;
    if (noUsableSection) {
      verdict = {accepted: false, outcome: 'REJECTED_NO_TEXT', filled: []};
    } else if (!next || next.ok !== true || !roundResult.context) {
      verdict = {accepted: false, outcome: 'FAILED', filled: [], failureType: next?.type ?? 'UNAVAILABLE'};
    } else {
      verdict = sectionRetryVerdict(current.result.output, next.output, targetIndexes);
    }
    emit(onDiagnostics, {
      ...base, writerCallsUsed: used, outcome: verdict.outcome,
      ...(verdict.failureType ? {failureType: verdict.failureType} : {}),
      filledSections: verdict.filled, elapsedMs, usage: roundResult.usage || {}
    });
    if (verdict.accepted) {
      current = {result: next, context: roundResult.context, cleanupEvents: roundResult.cleanupEvents || []};
    }
  }
  return current.result;
}

module.exports = {
  CATEGORY_GUIDANCE,
  contractFailureCategories,
  retryGuidanceInstruction,
  sectionRetryInstruction,
  mergeSectionRetryTransport,
  sectionRetryVerdict,
  emptyReasons,
  runWriterSectionRetry
};

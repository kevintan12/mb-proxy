// Step 9D.3: unit tests for the shared trim ladder in lib/section-rules.js
// (withFilteredReferences, dropOffendingSentences, withCaveat, blankSection,
// emptyInitiatingListSection, sectionUnavailableMessage,
// normalizeSectionText, namesCitedFocusSubject). These test the ladder's
// primitives directly, in isolation from any particular section rule --
// the rules that now call them are covered end to end by the unedited
// Step 9D.1 matrix (tests/section-rules-matrix.test.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withFilteredReferences,
  dropOffendingSentences,
  withCaveat,
  blankSection,
  emptyInitiatingListSection,
  sectionUnavailableMessage,
  normalizeSectionText,
  namesCitedFocusSubject
} = require('../lib/section-rules');

function section(overrides = {}) {
  return {
    name: 'MARKET INTERPRETATION',
    content: 'First sentence. Second sentence.',
    evidenceRefs: ['e1', 'e2'],
    telemetryRefs: ['t1', 't2'],
    uncertainties: [],
    ...overrides
  };
}

// A minimal, dependency-free sentence splitter standing in for
// lib/claude-analysis-contract.js's splitReportSentences, since this file
// tests the ladder in isolation from the contract module.
function splitOnPeriods(content) {
  if (typeof content !== 'string') return [];
  return content.split(/(?<=\.)\s+/).filter(Boolean);
}

test('Step 9D.3: withFilteredReferences drops only the refs the predicate rejects, for each list independently', () => {
  const result = withFilteredReferences(section(), {
    keepEvidenceRef: ref => ref === 'e1',
    keepTelemetryRef: ref => ref === 't2'
  });
  assert.deepEqual(result.section.evidenceRefs, ['e1']);
  assert.deepEqual(result.section.telemetryRefs, ['t2']);
  assert.equal(result.droppedEvidenceRefCount, 1);
  assert.equal(result.droppedTelemetryRefCount, 1);
  // content and uncertainties are untouched by this step.
  assert.equal(result.section.content, 'First sentence. Second sentence.');
  assert.deepEqual(result.section.uncertainties, []);
});

test('Step 9D.3: withFilteredReferences leaves a reference list untouched when no predicate is given for it', () => {
  const result = withFilteredReferences(section(), {keepEvidenceRef: () => false});
  assert.deepEqual(result.section.evidenceRefs, []);
  assert.deepEqual(result.section.telemetryRefs, ['t1', 't2']);
  assert.equal(result.droppedEvidenceRefCount, 2);
  assert.equal(result.droppedTelemetryRefCount, 0);
});

test('Step 9D.3: withFilteredReferences with no predicates at all drops nothing', () => {
  const result = withFilteredReferences(section());
  assert.deepEqual(result.section.evidenceRefs, ['e1', 'e2']);
  assert.deepEqual(result.section.telemetryRefs, ['t1', 't2']);
  assert.equal(result.droppedEvidenceRefCount, 0);
  assert.equal(result.droppedTelemetryRefCount, 0);
});

test('Step 9D.3: dropOffendingSentences removes only the offending sentences, in order', () => {
  const withThree = section({content: 'Good one. Bad one. Good two.'});
  const result = dropOffendingSentences(withThree, sentence => sentence.startsWith('Bad'), splitOnPeriods);
  assert.equal(result.section.content, 'Good one. Good two.');
  assert.equal(result.removedSentenceCount, 1);
  assert.equal(result.sentenceCount, 3);
  assert.equal(result.keptSentenceCount, 2);
  // Nothing else on the section changes.
  assert.deepEqual(result.section.evidenceRefs, withThree.evidenceRefs);
});

test('Step 9D.3: dropOffendingSentences removing nothing returns the section completely unchanged, not rejoined', () => {
  const original = section({content: 'One sentence.  Two sentence.'}); // double space on purpose
  const result = dropOffendingSentences(original, () => false, splitOnPeriods);
  assert.equal(result.section, original, 'same object, not a rebuilt copy');
  assert.equal(result.section.content, 'One sentence.  Two sentence.',
    'exact original wording and spacing preserved when nothing is removed');
  assert.equal(result.removedSentenceCount, 0);
});

test('Step 9D.3: dropOffendingSentences removing everything leaves empty content and the correct counts', () => {
  const result = dropOffendingSentences(section({content: 'Bad one. Bad two.'}), () => true, splitOnPeriods);
  assert.equal(result.section.content, '');
  assert.equal(result.removedSentenceCount, 2);
  assert.equal(result.keptSentenceCount, 0);
});

test('Step 9D.3: dropOffendingSentences on null content is a no-op, matching a real sentence splitter on null', () => {
  const nullSection = section({content: null, evidenceRefs: [], telemetryRefs: []});
  const result = dropOffendingSentences(nullSection, () => true, splitOnPeriods);
  assert.equal(result.section, nullSection);
  assert.deepEqual(result, {section: nullSection, removedSentenceCount: 0, sentenceCount: 0, keptSentenceCount: 0});
});

test('Step 9D.3: withCaveat appends the caveat once and is idempotent on a second call', () => {
  const once = withCaveat(section(), 'A caveat.');
  assert.deepEqual(once.uncertainties, ['A caveat.']);
  const twice = withCaveat(once, 'A caveat.');
  assert.deepEqual(twice.uncertainties, ['A caveat.'], 'not appended twice');
  assert.equal(twice, once, 'same object returned when already present');
});

test('Step 9D.3: withCaveat preserves any existing uncertainties alongside the new one', () => {
  const withExisting = section({uncertainties: ['Existing note.']});
  const result = withCaveat(withExisting, 'New caveat.');
  assert.deepEqual(result.uncertainties, ['Existing note.', 'New caveat.']);
});

test('Step 9D.3: blankSection clears content and both reference lists and sets exactly one uncertainty', () => {
  const result = blankSection(section(), 'Not enough data to write the X section.');
  assert.equal(result.content, null);
  assert.deepEqual(result.evidenceRefs, []);
  assert.deepEqual(result.telemetryRefs, []);
  assert.deepEqual(result.uncertainties, ['Not enough data to write the X section.']);
  assert.equal(result.name, 'MARKET INTERPRETATION', 'name and other fields are preserved');
});

test('Step 9D.3: emptyInitiatingListSection sets the given content with empty refs and no uncertainty', () => {
  const result = emptyInitiatingListSection(section(), 'No securities to show.');
  assert.equal(result.content, 'No securities to show.');
  assert.deepEqual(result.evidenceRefs, []);
  assert.deepEqual(result.telemetryRefs, []);
  assert.deepEqual(result.uncertainties, [], 'unlike blankSection, no uncertainty message is added');
});

test('Step 9D.3: sectionUnavailableMessage matches the shared wording exactly', () => {
  assert.equal(sectionUnavailableMessage('MARKET INTERPRETATION'),
    'Not enough data to write the MARKET INTERPRETATION section.');
  assert.equal(sectionUnavailableMessage('KEY RISKS & OPPORTUNITIES'),
    'Not enough data to write the KEY RISKS & OPPORTUNITIES section.');
});

test('Step 9D.3: normalizeSectionText collapses whitespace, trims, and lowercases', () => {
  assert.equal(normalizeSectionText('  Microsoft   Corp.\n'), 'microsoft corp.');
  assert.equal(normalizeSectionText('ALREADY lower'), 'already lower');
});

test('Step 9D.3: normalizeSectionText NFKC-normalizes so visually equal names compare equal', () => {
  // U+00C5 (Å, precomposed) vs 'A' + U+030A (combining ring above).
  assert.equal(normalizeSectionText('Å'), normalizeSectionText('Å'));
});

test('Step 9D.3: namesCitedFocusSubject is true only when a cited ref\'s subject is actually named', () => {
  const focus = [
    {evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
    {evidenceRef: 'e2', subjects: [{kind: 'SECTOR', name: 'Health-care'}]}
  ];
  assert.equal(namesCitedFocusSubject('Supported Microsoft analysis.', ['e1'], focus), true);
  // The subject's ref must actually be cited, not merely named.
  assert.equal(namesCitedFocusSubject('Supported Microsoft analysis.', ['e2'], focus), false);
  // The ref must be cited AND the exact subject named -- citing e1 while
  // naming a different company's subject is not enough.
  assert.equal(namesCitedFocusSubject('Generic index commentary.', ['e1'], focus), false);
  // Case- and whitespace-insensitive via normalizeSectionText.
  assert.equal(namesCitedFocusSubject('Supported   MICROSOFT  analysis.', ['e1'], focus), true);
});

test('Step 9D.3: namesCitedFocusSubject is false with no focus entries or no cited refs', () => {
  assert.equal(namesCitedFocusSubject('Supported Microsoft analysis.', ['e1'], []), false);
  assert.equal(namesCitedFocusSubject('Supported Microsoft analysis.', [],
    [{evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]}]), false);
});

// ---------------------------------------------------------------------------
// The ladder's order and its "blank only if nothing valid remains" rule,
// composed the way a real section rule composes them: drop refs, drop
// sentences, add the caveat, and only blank if the result still has no
// valid content or reference.
// ---------------------------------------------------------------------------

test('Step 9D.3: composed ladder keeps a section when something valid survives, in the documented order', () => {
  const original = section({
    content: 'A supported sentence. An unsupported causal sentence.',
    evidenceRefs: ['e1', 'e999'], telemetryRefs: ['t1', 't999']
  });
  const {section: refFiltered} = withFilteredReferences(original, {
    keepEvidenceRef: ref => ref !== 'e999', keepTelemetryRef: ref => ref !== 't999'
  });
  const {section: sentenceFiltered, removedSentenceCount} = dropOffendingSentences(
    refFiltered, sentence => sentence.includes('unsupported'), splitOnPeriods
  );
  const keepsValidContent = sentenceFiltered.content.length > 0 && sentenceFiltered.evidenceRefs.length > 0;
  assert.equal(keepsValidContent, true, 'ladder stops before blanking once something valid survives');
  const final = withCaveat(sentenceFiltered, 'A caveat.');
  assert.equal(final.content, 'A supported sentence.');
  assert.deepEqual(final.evidenceRefs, ['e1']);
  assert.deepEqual(final.telemetryRefs, ['t1']);
  assert.deepEqual(final.uncertainties, ['A caveat.']);
  assert.equal(removedSentenceCount, 1);
});

test('Step 9D.3: composed ladder blanks the section only once nothing valid remains', () => {
  const original = section({
    content: 'An unsupported causal sentence.', evidenceRefs: ['e999'], telemetryRefs: []
  });
  const {section: refFiltered} = withFilteredReferences(original, {keepEvidenceRef: ref => ref !== 'e999'});
  const {section: sentenceFiltered} = dropOffendingSentences(
    refFiltered, sentence => sentence.includes('unsupported'), splitOnPeriods
  );
  const keepsValidContent = sentenceFiltered.content.length > 0 && sentenceFiltered.evidenceRefs.length > 0;
  assert.equal(keepsValidContent, false, 'nothing valid survives, so the ladder must blank, not keep');
  const blanked = blankSection(original, sectionUnavailableMessage(original.name));
  assert.equal(blanked.content, null);
  assert.deepEqual(blanked.uncertainties, ['Not enough data to write the MARKET INTERPRETATION section.']);
});

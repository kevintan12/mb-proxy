// 9AV Build 1: the pure source-name, close-marker and same-event-day functions
// (lib/report-accuracy-source.js). Made-up text only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reorderCloseMarker, findSourceMentions, sourceCarried, sourcePhraseFor, dropSourcePhrase,
  checkSourceCarrier, findEventDayClaims, sameEventDayConflicts, resolveDay
} = require('../lib/report-accuracy-source');
const {TIME_CLAIM_SOURCES} = require('../lib/report-accuracy-time');

function drop(sentence) {
  const mention = findSourceMentions(sentence)[0];
  const phrase = sourcePhraseFor(sentence, mention);
  return phrase ? dropSourcePhrase(sentence, phrase).sentence : null;
}

test('9AV: the source list is the 9AT list, unchanged (12 names)', () => {
  assert.equal(TIME_CLAIM_SOURCES.length, 12);
});

test('9AV C: the close marker moves after the source credit, no word added or removed', () => {
  const cases = [
    ['At the close on Tuesday, Reuters reported that stocks fell across the board.',
      'Reuters reported that at the close on Tuesday, stocks fell across the board.'],
    ['At the close on Tuesday, Reuters also reported that bonds rallied.',
      'Reuters also reported that at the close on Tuesday, bonds rallied.'],
    ['At the close on Friday, Oct 23, the Financial Times reported that oil slipped.',
      'The Financial Times reported that at the close on Friday, Oct 23, oil slipped.']
  ];
  for (const [before, after] of cases) {
    const result = reorderCloseMarker(before);
    assert.equal(result.changed, true, before);
    assert.equal(result.sentence, after);
    const words = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).sort();
    assert.deepEqual(words(result.sentence), words(before), 'same words');
  }
});

test('9AV C: any other wording is left exactly as written', () => {
  for (const sentence of [
    'At the close on Tuesday, stocks fell across the board.',
    'At the close on Tuesday, Simply Wall St reported that Microsoft rose.',
    'At the close on Tuesday, Reuters said that stocks fell.',
    'Reuters reported that at the close on Tuesday, stocks fell.',
    'At the close, Reuters reported that stocks fell.',
    'At the close on Tuesday, Reuters reported stocks fell.'
  ]) {
    assert.deepEqual(reorderCloseMarker(sentence), {sentence, changed: false}, sentence);
  }
});

test('9AV A1: each removable form drops only the source phrase', () => {
  const cases = [
    ['Reuters reported that Microsoft announced a new AI initiative.', 'Microsoft announced a new AI initiative.'],
    ['Reuters also reported that Microsoft rose.', 'Microsoft rose.'],
    ['Bloomberg said that rates held.', 'Rates held.'],
    ['The Wall Street Journal reported that rates held.', 'Rates held.'],
    ['According to CNBC, stocks rose.', 'Stocks rose.'],
    ['Stocks rose 1%, according to CNBC.', 'Stocks rose 1%.'],
    ['Stocks rose 1%, as reported by Barchart.', 'Stocks rose 1%.'],
    ["That reading, from CNBC's market recap, did not move bonds.", 'That reading did not move bonds.'],
    ['Reuters reported that at the close on Tuesday, stocks fell.', 'At the close on Tuesday, stocks fell.']
  ];
  for (const [before, after] of cases) assert.equal(drop(before), after, before);
});

test('9AV A1: forms not on the list are not removable (kept and counted by the cleanup)', () => {
  for (const sentence of [
    "Reuters' report said Microsoft rose.",
    'A Reuters article said Microsoft rose.',
    'Reuters quoted an analyst who expects more gains.',
    'Reuters and Bloomberg reported that Microsoft rose.',
    'Stocks fell, Reuters reported that Microsoft rose.',
    'Reuters reported at 6:49 am ET that Microsoft rose.',
    'Shares of Thomson Reuters rose 2%.'
  ]) {
    assert.equal(drop(sentence), null, sentence);
  }
});

test('9AV A1: a source counts as carried when any cited article names it (publisher, title or summary)', () => {
  const simplyWallSt = {publisher: 'Yahoo! Finance', title: 'Microsoft launches AI initiative',
    summary: 'Simply Wall St looks at the Microsoft AI Transparency Initiative.'};
  const reutersWire = {publisher: 'Yahoo! Finance', title: 'Stocks fall', summary: '(Reuters) - Stocks fell.'};
  assert.equal(sourceCarried('Reuters', [simplyWallSt]), false);
  assert.equal(sourceCarried('Reuters', [simplyWallSt, reutersWire]), true);
  assert.equal(sourceCarried('Yahoo Finance', [simplyWallSt]), true);
  assert.equal(sourceCarried('WSJ', [{publisher: 'X', title: 'T', summary: 'The Wall Street Journal said so.'}]), true);
  assert.equal(sourceCarried('CNBC', []), false);
});

test('9AV A2: the carrier check finds the article holding the figures and names', () => {
  // R-52 shape: the figures are only in a Yahoo article that does not mention CNBC.
  const yahoo = {publisher: 'Yahoo Finance', title: 'Wholesale prices', summary: 'Prices rose 0.3% after 0.4%.'};
  const cnbc = {publisher: 'CNBC', title: 'Stocks close mixed', summary: 'Stocks closed mixed.'};
  assert.deepEqual(checkSourceCarrier('Wholesale prices rose 0.3% after 0.4%, according to CNBC.', 'CNBC', [yahoo, cnbc]),
    {verdict: 'mismatch', reason: 'carrierLacksSource'});
  // R-51 shape: the carrier is a Reuters wire story whose own sentence credits the Financial Times.
  const wire = {publisher: 'Yahoo Finance', title: 'Chip board talks',
    summary: '(Reuters) - The Financial Times reported that the board approached Jane Roe about the role.'};
  assert.deepEqual(checkSourceCarrier('Reuters reported that the board approached Jane Roe.', 'Reuters', [wire]),
    {verdict: 'mismatch', reason: 'creditsOtherSource'});
  // A real Reuters fact passes.
  const own = {publisher: 'Yahoo Finance', title: 'Board talks', summary: '(Reuters) - The board approached Jane Roe.'};
  assert.equal(checkSourceCarrier('Reuters reported that the board approached Jane Roe.', 'Reuters', [own]).verdict, 'pass');
  // Nothing to anchor on, or no article holds the anchors: skipped, never a mismatch.
  assert.equal(checkSourceCarrier('Reuters reported that stocks fell.', 'Reuters', [own]).verdict, 'skipped');
  assert.equal(checkSourceCarrier('Reuters reported that John Doe left.', 'Reuters', [own]).verdict, 'skipped');
});

test('9AV B: written days resolve to ET dates against the report date (Wednesday 18 Nov 2026)', () => {
  const reportDate = '2026-11-18';
  assert.equal(resolveDay('Wednesday', reportDate), '2026-11-18');
  assert.equal(resolveDay('Thursday', reportDate), '2026-11-19');
  assert.equal(resolveDay('Tuesday', reportDate), '2026-11-17');
  assert.equal(resolveDay('Sat', reportDate), '2026-11-21');
  assert.equal(resolveDay('Sunday', reportDate), '2026-11-15');
  assert.equal(resolveDay('tomorrow', reportDate), '2026-11-19');
  assert.equal(resolveDay('today', reportDate), '2026-11-18');
  assert.equal(resolveDay('20 Nov', reportDate), '2026-11-20');
  assert.equal(resolveDay('Dec 1', reportDate), '2026-12-01');
});

test('9AV B: the 18 Nov debut shape: Section 1 Wednesday against Section 7 Thursday is one conflict', () => {
  const options = {subjects: ['Acme AI'], reportDate: '2026-11-18'};
  const s1 = findEventDayClaims("Acme AI's stock market debut, due later on Wednesday, is in focus.", options)
    .map(claim => ({...claim, sectionIndex: 0}));
  const s7 = findEventDayClaims("Watch Acme AI's IPO, with pricing set for Wednesday and a trading debut on Thursday.", options)
    .map(claim => ({...claim, sectionIndex: 6}));
  assert.deepEqual(s1.map(claim => [claim.eventClass, claim.date]), [['debut', '2026-11-18']]);
  assert.deepEqual(s7.map(claim => [claim.eventClass, claim.date]).sort(),
    [['debut', '2026-11-19'], ['ipo', '2026-11-18'], ['pricing', '2026-11-18']]);
  // Section 7 alone (pricing Wednesday, debut Thursday) is no conflict.
  assert.deepEqual(sameEventDayConflicts(s7), []);
  assert.deepEqual(sameEventDayConflicts([...s1, ...s7]), [{eventClass: 'debut', sectionIndexes: [0, 6]}]);
});

test('9AV B: macro events, unknown subjects and different subjects', () => {
  const options = {subjects: ['Acme AI', 'Beta Corp'], reportDate: '2026-11-18'};
  assert.deepEqual(findEventDayClaims('The CPI report is due Thursday and the Fed minutes come out on Wednesday.', options)
    .map(claim => [claim.subject, claim.eventClass, claim.date]),
  [['MACRO:CPI', 'release', '2026-11-19'], ['MACRO:FOMC', 'minutes', '2026-11-18']]);
  // The Fed with no class word is not an event.
  assert.deepEqual(findEventDayClaims('Fed officials spoke on Tuesday.', options), []);
  // A pronoun or unknown company is not a subject.
  assert.deepEqual(findEventDayClaims('The company debuts on Thursday.', options), []);
  // Two subjects with different days are not a conflict.
  const claims = [
    ...findEventDayClaims('Acme AI reports results on Thursday.', options).map(c => ({...c, sectionIndex: 1})),
    ...findEventDayClaims('Beta Corp reports results on Friday.', options).map(c => ({...c, sectionIndex: 6}))
  ];
  assert.equal(claims.length, 2);
  assert.deepEqual(sameEventDayConflicts(claims), []);
  // Bad input: nothing.
  assert.deepEqual(findEventDayClaims('Acme AI debuts Thursday.', {subjects: ['Acme AI'], reportDate: null}), []);
  assert.deepEqual(findEventDayClaims(null, options), []);
});

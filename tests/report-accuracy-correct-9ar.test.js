'use strict';

// Step 9AR Build 2: made-up data only. Not connected to the pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildFactLookup, findFigureClaims} = require('../lib/report-accuracy-facts');
const {correctDirectionWords, SKIP_REASONS} = require('../lib/report-accuracy-correct');

const DATES = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];

function snapshot(symbol, instrumentName, changes) {
  return {
    reference: `T:${symbol}`,
    snapshot: {
      symbol,
      instrumentName,
      completedSessions: changes.map(([absoluteChange, percentChange], i) => ({
        sessionDate: DATES[i], close: 1000 + i, absoluteChange, percentChange
      }))
    }
  };
}

function fixture() {
  return {
    marketPackages: [{
      telemetry: {
        benchmarkSnapshots: [
          snapshot('^GSPC', 'S&P 500', [[10.1, 0.11], [-5.2, -0.12], [14.4, 0.31], [-3.3, -0.07], [8.8, 0.18]]),
          snapshot('^IXIC', 'NASDAQ Composite', [[50.5, 0.21], [-60.6, -0.25], [30.3, 0.14], [-40.4, -0.52], [70.7, 0.33]]),
          snapshot('^DJI', 'Dow Jones Industrial Average', [[100.1, 0.22], [-90.9, -0.19], [237.33, 0.55], [-20.2, -0.04], [60.6, 0.13]]),
          snapshot('^RUT', 'Russell 2000', [[1.1, 0.06], [-2.2, -0.09], [3.3, 0.15], [-4.4, -0.21], [5.5, 0.27]])
        ],
        stockSnapshots: [
          snapshot('CPRT', 'Copart, Inc.', [[0.5, 1.1], [0.77, 1.4], [-0.09, -0.19], [0.2, 0.4], [-0.3, -0.6]]),
          snapshot('ACME', 'Acme Widgets Corporation', [[1.01, 2.1], [-1.02, -2.2], [0.88, 1.7], [-0.45, -0.9], [0.62, 1.3]]),
          snapshot('ZZZ', 'Zeta Zone Holdings', [[0.4, 0.45], [-0.4, -0.45], [0.1, 0.12], [0.2, 0.22], [0.3, 0.33]])
        ]
      }
    }]
  };
}

const lookup = buildFactLookup(fixture());
const fix = sentence => correctDirectionWords(sentence, lookup);

function assertUnchanged(sentence, expectedClaims = 0) {
  const result = fix(sentence);
  assert.equal(result.sentence, sentence, sentence);
  assert.equal(result.record.corrected.length, 0, sentence);
  assert.equal(result.record.claims, expectedClaims, sentence);
  return result;
}

function assertSkipped(sentence, reason) {
  const result = assertUnchanged(sentence, 1);
  assert.equal(result.record.skipped.length, 1, sentence);
  assert.equal(result.record.skipped[0].reason, reason, sentence);
}

test('Build 1 claims now carry word, window and segment positions', () => {
  const sentence = 'Copart gained $0.09 on Wednesday.';
  const [claim] = findFigureClaims(sentence, lookup);
  assert.equal(sentence.slice(claim.wordStart, claim.wordEnd), 'gained');
  assert.equal(sentence.slice(claim.windowStart, claim.windowEnd), ' gained ');
  assert.equal(sentence.slice(claim.segmentStart, claim.segmentEnd), ' gained $0.09 on Wednesday.');
});

test('Copart "gained $0.09" when it fell becomes "fell $0.09"', () => {
  const result = fix('Copart gained $0.09 on Wednesday.');
  assert.equal(result.sentence, 'Copart fell $0.09 on Wednesday.');
  assert.deepEqual(result.record, {
    claims: 1,
    agreed: 0,
    corrected: [{subject: 'Copart, Inc.', symbol: 'CPRT', sessionDate: '2026-10-28', oldWord: 'gained', newWord: 'fell'}],
    skipped: []
  });
});

test('name and ticker in brackets stay untouched', () => {
  assert.equal(fix('Copart, Inc. (CPRT) gained $0.09.').sentence, 'Copart, Inc. (CPRT) fell $0.09.');
});

test('three-index sentence with one wrong word: only that word changes', () => {
  const result = fix('The S&P 500 rose 0.31%, the Nasdaq fell 0.14% and the Dow gained 237.33 points.');
  assert.equal(result.sentence, 'The S&P 500 rose 0.31%, the Nasdaq rose 0.14% and the Dow gained 237.33 points.');
  assert.equal(result.record.claims, 3);
  assert.equal(result.record.agreed, 2);
  assert.equal(result.record.corrected.length, 1);
  assert.equal(result.record.corrected[0].symbol, '^IXIC');
  assert.equal(result.record.corrected[0].oldWord, 'fell');
  assert.equal(result.record.corrected[0].newWord, 'rose');
});

test('a correct sentence stays byte-identical', () => {
  const sentence = 'The Russell 2000 slipped 0.21%.';
  const result = fix(sentence);
  assert.equal(result.sentence, sentence);
  assert.equal(result.record.agreed, 1);
  assert.deepEqual(result.record.skipped, []);
});

test('the same word twice: only the wrong one is swapped', () => {
  assert.equal(fix('The S&P 500 rose 0.31% and Copart rose $0.09.').sentence,
    'The S&P 500 rose 0.31% and Copart dropped $0.09.');
});

test('two wrong claims in one sentence are both corrected', () => {
  const result = fix('The Nasdaq fell 0.14% while Copart rose $0.09.');
  assert.equal(result.sentence, 'The Nasdaq rose 0.14% while Copart dropped $0.09.');
  assert.equal(result.record.corrected.length, 2);
  // First swap changes the length ("rose" to "dropped"), second comes after it.
  assert.equal(fix('Copart rose $0.09 while the Nasdaq fell 0.14%.').sentence,
    'Copart dropped $0.09 while the Nasdaq rose 0.14%.');
});

test('one wrong claim corrected while another wrong claim is skipped', () => {
  const result = fix('The Nasdaq fell 0.14% and Copart picked up $0.09.');
  assert.equal(result.sentence, 'The Nasdaq rose 0.14% and Copart picked up $0.09.');
  assert.equal(result.record.corrected.length, 1);
  assert.equal(result.record.skipped[0].reason, 'upDownPhraseNotSafe');
});

test('each word in the swap table', () => {
  const pairs = [
    ['rose', 'dropped'], ['gained', 'fell'], ['added', 'fell'], ['climbed', 'fell'], ['rebounded', 'fell'],
    ['rising', 'falling'], ['gaining', 'losing'], ['adding', 'losing'], ['climbing', 'falling'], ['rebounding', 'falling']
  ];
  for (const [oldWord, newWord] of pairs) {
    assert.equal(fix(`Copart ${oldWord} $0.09.`).sentence, `Copart ${newWord} $0.09.`, oldWord);
  }
  const reverse = [
    ['fell', 'rose'], ['dropped', 'rose'], ['lost', 'gained'], ['declined', 'rose'], ['slipped', 'climbed'],
    ['falling', 'rising'], ['dropping', 'rising'], ['losing', 'gaining'], ['declining', 'rising'], ['slipping', 'climbing']
  ];
  for (const [oldWord, newWord] of reverse) {
    assert.equal(fix(`Copart ${oldWord} $0.77.`).sentence, `Copart ${newWord} $0.77.`, oldWord);
  }
  assert.equal(fix('Copart was up $0.09.').sentence, 'Copart was down $0.09.');
  assert.equal(fix('Copart was down $0.77.').sentence, 'Copart was up $0.77.');
  assert.equal(fix('Copart, up $0.09, led losers.').sentence, 'Copart, down $0.09, led losers.');
});

test('capitals are kept: First capital and ALL CAPS', () => {
  assert.equal(fix('Copart: Gained $0.09.').sentence, 'Copart: Fell $0.09.');
  assert.equal(fix('COPART GAINED $0.09.').sentence, 'COPART FELL $0.09.');
});

test('skip and count: base and -s forms (noun or verb)', () => {
  assertSkipped('Copart posted a gain of $0.09.', 'nounOrBaseForm');
  assertSkipped('Copart saw a rise of $0.09.', 'nounOrBaseForm');
  assertSkipped('Acme gains 2.2% on the day.', 'nounOrBaseForm');
  assertSkipped('Acme had a drop of 1.7%.', 'nounOrBaseForm');
});

test('skip and count: -ing word after a determiner', () => {
  assertSkipped('Copart, the rising $0.09 aside, was flat.', 'determinerBefore');
});

test('skip and count: up or down after an unlisted word', () => {
  assertSkipped('Copart picked up $0.09.', 'upDownPhraseNotSafe');
  assertSkipped('Copart shot up $0.09.', 'upDownPhraseNotSafe');
});

test('skip and count: word joined by a hyphen or apostrophe', () => {
  assertSkipped('Copart rose-up $0.09.', 'joinedWord');
});

test('skip and count: unusual capitals', () => {
  assertSkipped('Copart GaInEd $0.09.', 'unusualCapitals');
});

test('skip and count: two direction words in the same window', () => {
  assertSkipped('Copart rebounded, adding $0.09.', 'severalDirectionWords');
});

test('skip and count: text Build 1 read differently before the word', () => {
  assertSkipped('Copart … gained $0.09.', 'textMismatch');
});

test('a non-breaking space keeps its place and the word is still corrected', () => {
  assert.equal(fix('Copart gained $0.09.').sentence, 'Copart fell $0.09.');
});

test('skip and count: the swap would make the sentence contradict itself', () => {
  assertSkipped('Copart gained $0.09, its first gain in a week.', 'wouldReadOddly');
  assertSkipped('Copart gained $0.09 as shares rallied.', 'wouldReadOddly');
});

test('every Build 1 skip case leaves the sentence byte-identical with no claim', () => {
  const cases = [
    'Acme added 11% over the week.', 'Acme added 2% on Monday.',
    'Acme fell about 2.2%.', 'Acme fell nearly 2.2%.', 'Acme fell just over 2.2%.',
    'Acme fell more than 2.2%.', 'Acme fell roughly 2.2%.', 'Acme fell almost 2.2%.',
    'The S&P 500 rose to 5,432.10.', 'The Dow fell at 237.33 points.', 'Copart closed at $0.09.',
    'Copart rose to $0.77.', 'Acme closed at $1.01.',
    'Zeta Zone Holdings rose 0.45%.',
    'Acme rose 3.77% in pre-market trading.', 'Acme fell $9.99 in Frankfurt.',
    'The Nasdaq and the S&P 500 rose 0.31%.', 'The Dow, Nasdaq and S&P 500 fell 0.14%.',
    'The S&P 500 0.31% on the day.', 'Gold rose 0.31%.'
  ];
  for (const sentence of cases) assertUnchanged(sentence);
  assert.equal(fix('').sentence, '');
  assert.equal(fix(null).sentence, null);
  assert.equal(fix(undefined).record.claims, 0);
  const empty = correctDirectionWords('The S&P 500 rose 0.31%.', buildFactLookup({}));
  assert.equal(empty.sentence, 'The S&P 500 rose 0.31%.');
  assert.equal(empty.record.claims, 0);
});

test('records hold counts and labels only, never sentence text', () => {
  const result = fix('The Nasdaq fell 0.14% and Copart picked up $0.09.');
  for (const item of result.record.corrected) {
    assert.deepEqual(Object.keys(item).sort(), ['newWord', 'oldWord', 'sessionDate', 'subject', 'symbol']);
  }
  for (const item of result.record.skipped) {
    assert.deepEqual(Object.keys(item).sort(), ['oldWord', 'reason', 'sessionDate', 'subject', 'symbol']);
    assert.ok(SKIP_REASONS.includes(item.reason));
  }
});

test('the function never changes its inputs', () => {
  const pkg = fixture();
  const before = JSON.stringify(pkg);
  const local = buildFactLookup(pkg);
  const lookupBefore = JSON.stringify(local.subjects);
  correctDirectionWords('Copart gained $0.09 and the Nasdaq fell 0.14%.', local);
  assert.equal(JSON.stringify(pkg), before);
  assert.equal(JSON.stringify(local.subjects), lookupBefore);
});

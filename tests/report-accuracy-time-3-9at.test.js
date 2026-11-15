// Step 9AT Build 3: the time check also reads EST/EDT, labelled 24-hour times and no-comma phrases, skips
// the market open/close times, and leaves touching phrases alone. Free tests only: made-up articles and
// sentences, no fetch, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {findTimeClaims, checkTimeClaim, dropTimePhrase} = require('../lib/report-accuracy-time');

const ARTICLES = Object.freeze([
  {reference: 'a1', publishedEt: 'Fri 13 Nov, 1:45 am ET', publisher: 'Yahoo! Finance',
    title: 'Global shares slip', summary: 'SINGAPORE, Nov 13 (Reuters) - Global shares gave up early gains.'},
  {reference: 'a2', publishedEt: 'Wed 11 Nov, 9:56 pm ET', publisher: 'Yahoo! Finance',
    title: 'Chip rivals rise', summary: '(Bloomberg) -- Rival chipmakers gained after hours.'},
  {reference: 'a3', publishedEt: 'Thu 12 Nov, 2:07 pm ET', publisher: 'Yahoo! Finance',
    title: 'Stocks settle lower', summary: 'Barchart - The S&P 500 closed lower. By 07:08 ET (12:08 GMT) futures slipped.'}
]);

const only = sentence => {
  const claims = findTimeClaims(sentence);
  assert.equal(claims.length, 1, `one claim in: ${sentence}`);
  return claims[0];
};
const drop = sentence => dropTimePhrase(sentence, only(sentence));

test('Build 3: EST and EDT are read like ET (one label, no offset check)', () => {
  for (const label of ['ET', 'EST', 'EDT']) {
    const sentence = `At 9:06 am ${label} on Thursday, Bloomberg reported that the board met.`;
    const claim = only(sentence);
    assert.deepEqual([claim.time.hour, claim.time.minute, claim.time.period], [9, 6, 'am'], label);
    assert.equal(checkTimeClaim(claim, ARTICLES).reason, 'timeMismatch', label);
    assert.equal(drop(sentence).sentence, 'Bloomberg reported that the board met.', label);
  }
  // A right time passes under any label, whatever the season.
  assert.equal(checkTimeClaim(only('At 1:45 am EDT on Friday, Reuters reported that shares slipped.'), ARTICLES).verdict, 'pass');
  assert.equal(checkTimeClaim(only('At 1:45 am EST on Friday, Reuters reported that shares slipped.'), ARTICLES).verdict, 'pass');
});

test('Build 3: 24-hour times convert (00:xx and 13 to 23 included)', () => {
  const cases = [
    ['00:05 ET', 12, 5, 'am'], ['01:45 ET', 1, 45, 'am'], ['09:06 ET', 9, 6, 'am'], ['11:59 EST', 11, 59, 'am'],
    ['12:00 ET', 12, 0, 'pm'], ['12:30 EDT', 12, 30, 'pm'], ['13:07 ET', 1, 7, 'pm'], ['14:07 ET', 2, 7, 'pm'],
    ['21:56 ET', 9, 56, 'pm'], ['23:59 ET', 11, 59, 'pm']
  ];
  for (const [text, hour, minute, period] of cases) {
    const claim = only(`At ${text}, Reuters reported that shares slipped.`);
    assert.deepEqual([claim.time.hour, claim.time.minute, claim.time.period], [hour, minute, period], text);
  }
  // 14:07 ET is the 2:07 pm ET Barchart article; 02:07 ET is not.
  assert.equal(checkTimeClaim(only('At 14:07 ET on Thursday, Barchart said the S&P 500 closed lower.'), ARTICLES).verdict, 'pass');
  assert.equal(checkTimeClaim(only('At 02:07 ET on Thursday, Barchart said the S&P 500 closed lower.'), ARTICLES).verdict, 'fail');
  assert.equal(drop('At 14:07 EST, Reuters reported that shares slipped.').sentence, 'Reuters reported that shares slipped.');
});

test('Build 3: a labelled 24-hour event time written in the cited article passes', () => {
  const result = checkTimeClaim(only('Barchart noted futures slipped by 07:08 ET.'), ARTICLES);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reason, 'eventTime');
  // "12:08 GMT" in the same article is not an ET time.
  assert.notEqual(checkTimeClaim(only('At 12:08 ET, Barchart said futures slipped.'), ARTICLES).verdict, 'pass');
});

test('Build 3: guards - ratios, seconds, no am/pm, other labels and no label are never claims', () => {
  for (const sentence of [
    'Reuters said the vote was 2:1 in favour.',
    'Reuters said the score was 3:2 ET fans cheered.',
    'Reuters said the trade was for 1,000 contracts at 12:02:08 ET.',
    'Reuters said the move came at 02:08:15 ET.',
    'At 9:06 ET, Reuters reported that shares slipped.',
    'At 9:06 GMT, Reuters reported that shares slipped.',
    'At 9:06 am GMT, Reuters reported that shares slipped.',
    'At 14:07 UTC, Reuters reported that shares slipped.',
    'At 14:07 SGT, Reuters reported that shares slipped.',
    'At 9:06 am HKT, Reuters reported that shares slipped.',
    'At 14:07, Reuters reported that shares slipped.',
    'At 9:06 am, Reuters reported that shares slipped.',
    'Reuters said ETFs rose at 14:07 ETF time.',
    'At 24:07 ET, Reuters reported that shares slipped.',
    'At 14:61 ET, Reuters reported that shares slipped.'
  ]) {
    assert.deepEqual(findTimeClaims(sentence), [], sentence);
  }
});

test('Build 3: a month word after ET is not read as the day', () => {
  const sentence = 'At 9:06 am ET May Reuters reported that the board met.';
  const claim = only(sentence);
  assert.equal(claim.day, null);
  assert.equal(drop(sentence).sentence, 'May Reuters reported that the board met.');
});

test('Build 3: no comma - the phrase goes and the next word takes a capital', () => {
  const cases = [
    ['At 9:06 am ET Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['At 9:06 am EDT Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['At 9:06 am ET on Thursday Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['At 9:06 am ET Thursday Nov 12 Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['At 14:07 ET the shares of the chip giant fell, Reuters reported.', 'The shares of the chip giant fell, Reuters reported.'],
    ['At 9:06 am ET stocks fell, Reuters reported.', 'Stocks fell, Reuters reported.'],
    ['On Friday Oct 23 at 5:39 pm ET Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['On Friday at 17:39 EST Reuters reported that the board met.', 'Reuters reported that the board met.'],
    // With the comma, as before.
    ['At 9:06 am ET, Reuters reported that the board met.', 'Reuters reported that the board met.'],
    ['  At 9:06 am ET Reuters reported that the board met.', '  Reuters reported that the board met.']
  ];
  for (const [sentence, expected] of cases) {
    const result = drop(sentence);
    assert.equal(result.changed, true, sentence);
    assert.equal(result.sentence, expected, sentence);
  }
});

test('Build 3: no comma needs whitespace and a word after the phrase; C and D keep their commas', () => {
  for (const sentence of [
    'At 9:06 am ET.',
    'At 9:06 am ET',
    'At 9:06 am ET - Reuters reported that the board met.',
    'Since the close at 9:06 am ET on Friday Bloomberg reported that the board met.'
  ]) {
    const claim = only(sentence);
    assert.equal(claim.phrase, null, sentence);
    assert.deepEqual(dropTimePhrase(sentence, claim), {sentence, changed: false, reason: 'unrecognisedForm'}, sentence);
  }
  // C and D with the new labels, commas as before.
  assert.equal(drop('Bloomberg reported at 14:07 EST that the board met.').sentence, 'Bloomberg reported that the board met.');
  assert.equal(drop('Since the close, at 23:36 EDT on Friday, Bloomberg reported it.').sentence, 'Since the close, Bloomberg reported it.');
});

test('Build 3: forms still not removable are counted by the caller and left unchanged (By 07:08 ET)', () => {
  const sentence = 'By 07:08 ET (12:08 GMT), Reuters said Nasdaq futures slipped.';
  const claim = only(sentence);
  assert.equal(claim.phrase, null);
  assert.deepEqual(dropTimePhrase(sentence, claim), {sentence, changed: false, reason: 'unrecognisedForm'});
});

test('Build 3: the market open and close are skipped, in both spellings, 12-hour and 24-hour', () => {
  for (const text of ['9:30 am ET', '09:30 ET', '09:30 EST', '9:30 a.m. EDT', '4:00 pm ET', '16:00 ET', '04:00 pm ET', '4:00 PM EST']) {
    const sentence = `At ${text}, Reuters reported that shares slipped.`;
    const claim = only(sentence);
    assert.deepEqual(checkTimeClaim(claim, ARTICLES), {verdict: 'skipped', reason: 'bellTime'}, text);
  }
  // Only those exact times: 9:30 pm, 4:00 am, 9:31 am, 4:01 pm are checked as usual.
  for (const text of ['9:30 pm ET', '4:00 am ET', '9:31 am ET', '4:01 pm ET', '21:30 ET', '04:00 ET']) {
    const claim = only(`At ${text}, Reuters reported that shares slipped.`);
    assert.equal(checkTimeClaim(claim, ARTICLES).verdict, 'fail', text);
  }
});

test('Build 3: two removable phrases that touch or overlap are both left alone', () => {
  const touching = 'At 9:06 am ET, at 9:10 am ET, Reuters reported that the board met.';
  const claims = findTimeClaims(touching);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map(claim => claim.phrase), [null, null]);
  for (const claim of claims) {
    assert.deepEqual(dropTimePhrase(touching, claim), {sentence: touching, changed: false, reason: 'unrecognisedForm'});
  }
  // Phrases that do not touch keep their own phrase.
  const apart = 'At 1:45 am ET on Friday, Reuters reported that shares fell, after Bloomberg reported at 9:06 am ET that the board met.';
  assert.ok(findTimeClaims(apart).every(claim => claim.phrase));
});

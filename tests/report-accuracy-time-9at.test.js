// Step 9AT Build 1 (proposed): a time next to a source name must belong to an article that source
// published. Pure functions only (lib/report-accuracy-time.js), not connected to the pipeline.
// Free tests only: made-up articles and sentences, no fetch, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIME_CLAIM_SOURCES, findTimeClaims, checkTimeClaim, dropTimePhrase, parsePublishedEt
} = require('../lib/report-accuracy-time');

// Made-up articles shaped like the 13 Nov 17:08 Section 2 evidence.
const ARTICLES = Object.freeze([
  {reference: 'a1', publishedEt: 'Fri 13 Nov, 1:45 am ET', publisher: 'Yahoo! Finance',
    title: 'Global shares slip after a turbulent week',
    summary: 'By A. Writer SINGAPORE, Nov 13 (Reuters) - Global shares gave up early gains on Friday.'},
  {reference: 'a2', publishedEt: 'Wed 11 Nov, 9:56 pm ET', publisher: 'Yahoo! Finance',
    title: 'Chip rivals rise on bets for business gains',
    summary: '(Bloomberg) -- Rival chipmakers gained after hours as the chip giant sank 9% on board reports.'},
  {reference: 'a3', publishedEt: 'Thu 12 Nov, 4:42 pm ET', publisher: 'Yahoo! Finance',
    title: 'Stocks settle lower on chip rout and higher bond yields',
    summary: 'Barchart - The S&P 500 closed lower on Thursday as Treasury yields rose.'},
  {reference: 'a4', publishedEt: 'Thu 12 Nov, 9:06 am ET', publisher: 'Yahoo! Finance',
    title: '3 momentum stocks to buy amid rate hike fears',
    summary: 'The broader equity markets have had a topsy-turvy week. Zacks Rank #1 stocks are listed here.'},
  {reference: 'a5', publishedEt: 'Thu 12 Nov, 6:10 am ET', publisher: 'Yahoo! Finance',
    title: 'Futures edge lower before inflation data',
    summary: 'NEW YORK (Reuters) - Futures slipped ahead of the consumer price report due at 8:30 a.m. ET.'}
]);

const only = sentence => {
  const claims = findTimeClaims(sentence);
  assert.equal(claims.length, 1, `one claim in: ${sentence}`);
  return claims[0];
};

const WRONG = 'At 9:06 am ET on Thursday, Bloomberg reported that the board was preparing to oust the chief '
  + 'executive, and the shares fell about 9% after hours.';

test('9AT: the source list is a fixed constant', () => {
  assert.ok(Object.isFrozen(TIME_CLAIM_SOURCES));
  for (const name of ['Reuters', 'Bloomberg', 'CNBC', 'Barchart', 'Yahoo Finance', 'Financial Times', 'WSJ',
    'Wall Street Journal', 'Zacks', 'MarketWatch', 'Associated Press', 'AP']) {
    assert.ok(TIME_CLAIM_SOURCES.includes(name), name);
  }
});

test('9AT: the 17:08 case (one article\'s time on another\'s facts) fails and only the phrase goes', () => {
  const claim = only(WRONG);
  assert.deepEqual(claim.time, {hour: 9, minute: 6, period: 'am', text: '9:06 am ET'});
  assert.equal(claim.day.weekday, 'Thursday');
  assert.equal(claim.source, 'Bloomberg');
  assert.equal(claim.phrase.text, 'At 9:06 am ET on Thursday, ');
  const result = checkTimeClaim(claim, ARTICLES);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.reason, 'sourceMismatch');
  assert.deepEqual(result.references, ['a4']);
  const dropped = dropTimePhrase(WRONG, claim);
  assert.equal(dropped.changed, true);
  assert.equal(dropped.sentence, 'Bloomberg reported that the board was preparing to oust the chief executive, '
    + 'and the shares fell about 9% after hours.');
});

test('9AT: right times (Reuters 1:45 am Fri, Barchart 4:42 pm Thu) pass and are left alone', () => {
  for (const [sentence, reference] of [
    ['At 1:45 am ET on Friday, Reuters reported that global shares gave up early gains.', 'a1'],
    ['At 4:42 pm ET on Thursday, Barchart reported that Treasury yields rose.', 'a3'],
    ['At 9:56 pm ET on Wednesday 11 Nov, Bloomberg reported that rival chipmakers gained.', 'a2']
  ]) {
    const result = checkTimeClaim(only(sentence), ARTICLES);
    assert.equal(result.verdict, 'pass', sentence);
    assert.equal(result.reason, 'publishedTime');
    assert.equal(result.reference, reference);
  }
});

test('9AT: a time with no source, or a source not on the list, is skipped', () => {
  const noSource = only('At 9:06 am ET on Thursday, the shares fell about 9% after hours.');
  assert.equal(noSource.source, null);
  assert.deepEqual(checkTimeClaim(noSource, ARTICLES), {verdict: 'skipped', reason: 'noSource'});
  const unlisted = only('At 9:06 am ET on Thursday, The Information reported that the board met.');
  assert.deepEqual(checkTimeClaim(unlisted, ARTICLES), {verdict: 'skipped', reason: 'noSource'});
  const bareYahoo = only('At 9:06 am ET on Thursday, Yahoo reported that the board met.');
  assert.equal(checkTimeClaim(bareYahoo, ARTICLES).verdict, 'skipped');
});

test('9AT: an event time written in the cited article\'s text passes', () => {
  const claim = only('Reuters said the consumer price report was due at 8:30 am ET on Thursday.');
  const result = checkTimeClaim(claim, ARTICLES);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reason, 'eventTime');
  assert.equal(result.reference, 'a5');
});

test('9AT: a day that does not match the publish day fails', () => {
  const claim = only('At 1:45 am ET on Thursday, Reuters reported that global shares gave up early gains.');
  assert.deepEqual(checkTimeClaim(claim, ARTICLES), {verdict: 'fail', reason: 'timeMismatch'});
  const date = only('At 1:45 am ET on Fri 12 Nov, Reuters reported that global shares gave up early gains.');
  assert.equal(checkTimeClaim(date, ARTICLES).verdict, 'fail');
});

test('9AT: am/pm confusion fails', () => {
  const claim = only('At 1:45 pm ET on Friday, Reuters reported that global shares gave up early gains.');
  assert.deepEqual(checkTimeClaim(claim, ARTICLES), {verdict: 'fail', reason: 'timeMismatch'});
});

test('9AT: "9:06 a.m. ET", "9:06 AM ET" and "09:06am ET" are read the same way', () => {
  for (const spelling of ['9:06 a.m. ET', '9:06 AM ET', '09:06am ET', '9:06 A.M. ET']) {
    const sentence = `At ${spelling} on Thursday, Bloomberg reported that the board met.`;
    const claim = only(sentence);
    assert.deepEqual([claim.time.hour, claim.time.minute, claim.time.period], [9, 6, 'am'], spelling);
    assert.equal(checkTimeClaim(claim, ARTICLES).reason, 'sourceMismatch', spelling);
    assert.equal(dropTimePhrase(sentence, claim).sentence, 'Bloomberg reported that the board met.', spelling);
  }
  const zacks = only('At 9:06 a.m. ET on Thursday, Zacks listed three momentum stocks.');
  assert.equal(checkTimeClaim(zacks, ARTICLES).verdict, 'pass');
});

test('9AT: a time that matches nothing cited fails as timeMismatch', () => {
  const claim = only('At 7:15 am ET on Thursday, Reuters reported that futures slipped.');
  assert.deepEqual(checkTimeClaim(claim, ARTICLES), {verdict: 'fail', reason: 'timeMismatch'});
  assert.deepEqual(checkTimeClaim(claim, []), {verdict: 'fail', reason: 'timeMismatch'});
});

test('9AT: the recognised phrase forms are removed exactly, nothing else changes', () => {
  const cases = [
    ['On Thursday Nov 12 at 9:06 am ET, Bloomberg reported that the board met.',
      'Bloomberg reported that the board met.'],
    ['At 9:06 am ET Thursday Nov 12, Bloomberg reported that the board met.',
      'Bloomberg reported that the board met.'],
    ['At 9:06 am ET the same day, Bloomberg reported that the board met.',
      'Bloomberg reported that the board met.'],
    ['Bloomberg reported at 9:06 am ET that the board met, and the shares fell 9.2%.',
      'Bloomberg reported that the board met, and the shares fell 9.2%.'],
    ['Bloomberg reported, at about 9:06 am ET, that the board met.',
      'Bloomberg reported that the board met.'],
    ['Since the close, at 9:06 am ET on Thursday, Bloomberg reported that the board met.',
      'Since the close, Bloomberg reported that the board met.'],
    ['At 9:06 am ET on Thursday, the Financial Times reported that the board met.',
      'The Financial Times reported that the board met.']
  ];
  for (const [sentence, expected] of cases) {
    const result = dropTimePhrase(sentence, only(sentence));
    assert.equal(result.changed, true, sentence);
    assert.equal(result.sentence, expected);
  }
});

test('9AT: a time phrase in a form not recognised is left unchanged and says so', () => {
  const sentence = 'Bloomberg, whose report landed around 9:06 am ET, said the board met.';
  const claim = only(sentence);
  assert.equal(claim.source, 'Bloomberg');
  assert.equal(claim.phrase, null);
  assert.deepEqual(dropTimePhrase(sentence, claim), {sentence, changed: false, reason: 'unrecognisedForm'});
  assert.deepEqual(dropTimePhrase(sentence, null), {sentence, changed: false, reason: 'unrecognisedForm'});
});

test('9AT: two times in one sentence are two claims, each with its own source and phrase', () => {
  const sentence = 'At 1:45 am ET on Friday, Reuters reported that shares fell, after Bloomberg reported at '
    + '9:06 am ET that the board met.';
  const claims = findTimeClaims(sentence);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].source, 'Reuters');
  assert.equal(checkTimeClaim(claims[0], ARTICLES).verdict, 'pass');
  assert.equal(claims[1].source, 'Bloomberg');
  assert.equal(claims[1].phrase.form, 'C');
  assert.equal(checkTimeClaim(claims[1], ARTICLES).reason, 'sourceMismatch');
  assert.equal(dropTimePhrase(sentence, claims[1]).sentence,
    'At 1:45 am ET on Friday, Reuters reported that shares fell, after Bloomberg reported that the board met.');
});

test('9AT: a right time with a source no cited article names is log only (the 24 Oct Financial Times case)', () => {
  const sentence = 'At 6:10 am ET on Thursday, the Financial Times reported that futures slipped.';
  const claim = only(sentence);
  assert.equal(claim.source, 'Financial Times');
  assert.deepEqual(checkTimeClaim(claim, ARTICLES), {verdict: 'logOnly', reason: 'sourceUnsupported', references: ['a5']});
  // The same for an event time that appears in a cited article's text.
  const event = only('The Financial Times said the price report was due at 8:30 am ET on Thursday.');
  assert.equal(checkTimeClaim(event, ARTICLES).verdict, 'logOnly');
  // A time that matches nothing still fails, whatever the source.
  const nothing = only('At 7:15 am ET on Thursday, the Financial Times reported that futures slipped.');
  assert.deepEqual(checkTimeClaim(nothing, ARTICLES), {verdict: 'fail', reason: 'timeMismatch'});
  // The 17:08 case is still a fail: another cited article (a2) does name Bloomberg.
  assert.equal(checkTimeClaim(only(WRONG), ARTICLES).verdict, 'fail');
});

test('9AT: WSJ / Wall Street Journal and AP / Associated Press are the same source', () => {
  const articles = [
    {reference: 'w1', publishedEt: 'Wed 11 Nov, 5:30 pm ET', publisher: 'Yahoo! Finance',
      title: 'Board preparing to remove chief, WSJ says', summary: 'The board is preparing to remove him.'},
    {reference: 'p1', publishedEt: 'Thu 12 Nov, 7:00 am ET', publisher: 'Associated Press',
      title: 'Markets wobble', summary: 'Markets wobbled early on Thursday.'}
  ];
  assert.equal(checkTimeClaim(only('At 5:30 pm ET on Wednesday, the Wall Street Journal reported that the board met.'),
    articles).verdict, 'pass');
  assert.equal(checkTimeClaim(only('At 7:00 am ET on Thursday, AP reported that markets wobbled.'),
    articles).verdict, 'pass');
});

test('9AT: the source name is found anywhere in the summary (Barchart names itself deep in the text)', () => {
  const late = [{reference: 'z1', publishedEt: 'Thu 12 Nov, 4:42 pm ET', publisher: 'Yahoo! Finance',
    title: 'Stocks settle lower', summary: `${'The S&P 500 closed lower. '.repeat(40)}More news from Barchart.`}];
  const claim = only('At 4:42 pm ET on Thursday, Barchart reported that Treasury yields rose.');
  assert.deepEqual(checkTimeClaim(claim, late), {verdict: 'pass', reason: 'publishedTime', reference: 'z1'});
  // The 17:08 case still fails: the article with the 9:06 am time never names Bloomberg.
  assert.equal(checkTimeClaim(only(WRONG), ARTICLES).reason, 'sourceMismatch');
});

test('9AT: the readable ET label is parsed as exchangeTimeLabel writes it', () => {
  assert.deepEqual(parsePublishedEt('Wed 11 Nov, 9:56 pm ET'),
    {weekday: 'Wednesday', day: 11, month: 11, hour: 9, minute: 56, period: 'pm'});
  assert.equal(parsePublishedEt('2026-11-12T02:56:15.000Z'), null);
  assert.equal(parsePublishedEt(undefined), null);
});

test('9AT: figures, names and text outside the phrase are never touched', () => {
  const sentence = 'At 9:06 am ET on Thursday, Bloomberg reported that Nvidia fell 9.2% to $158.76 after hours.';
  const result = dropTimePhrase(sentence, only(sentence));
  assert.equal(result.sentence, 'Bloomberg reported that Nvidia fell 9.2% to $158.76 after hours.');
  assert.ok(sentence.endsWith(result.sentence));
});

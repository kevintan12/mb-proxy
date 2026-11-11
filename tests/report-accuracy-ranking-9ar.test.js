'use strict';

// Step 9AR Build 4: the ranking-claim detector (lib/report-accuracy-ranking.js), on made-up packages.
// The prices are the 2 to 6 Nov 2026 closes from the 8 Nov Weekend report's package (percent changes
// only). Pure functions: no network, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');

const {buildRankingFacts, checkRankingSentence, SKIP_REASONS} = require('../lib/report-accuracy-ranking');

const WEEK = {
  '^DJI': [0.41, -0.38, 3.03, -3.44, -0.46],
  '^IXIC': [-1.07, 0.83, 1.44, -5.52, 1.09],
  '^GSPC': [-0.51, 0.36, 1.58, -4.36, 0.31],
  '^RUT': [-0.21, 0.23, 1.58, -4.45, 0.89]
};
const DATES = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const NAMES = {'^DJI': 'Dow Jones Industrial Average', '^IXIC': 'NASDAQ Composite', '^GSPC': 'S&P 500', '^RUT': 'Russell 2000'};

function pkg({week = WEEK, dates = DATES, state = 'WEEKEND', generatedAt = '2026-11-08T13:57:56.131Z',
  principal = '2026-11-06', overlays = null} = {}) {
  return {
    analysisRequest: {generatedAt},
    marketPackages: [{
      marketContext: {marketState: state, primaryCompletedSessionDate: principal},
      telemetry: {
        stockSnapshots: [],
        benchmarkSnapshots: Object.entries(week).map(([symbol, values]) => ({
          reference: symbol,
          snapshot: {
            symbol, instrumentName: NAMES[symbol],
            completedSessions: values.map((percentChange, index) => (percentChange === null ? null
              : {sessionDate: dates[index], close: 100, absoluteChange: percentChange, percentChange})).filter(Boolean),
            currentOverlay: overlays && overlays[symbol] !== undefined
              ? {validationState: 'VALIDATED', percentChange: overlays[symbol]} : null
          }
        }))
      }
    }]
  };
}

const facts = buildRankingFacts(pkg());
const check = (sentence, options) => checkRankingSentence(sentence, facts, options);
const only = (sentence, options, local = facts) => {
  const {claims} = checkRankingSentence(sentence, local, options);
  assert.equal(claims.length, 1, `${sentence}: ${JSON.stringify(claims)}`);
  return claims[0];
};

test('Step 9AR Build 4: the 8 Nov sentence is false on Friday (the Dow fell most) and is judged false', () => {
  const claim = only('The Russell 2000 was the weakest major index on Friday.');
  assert.deepEqual([claim.form, claim.symbol, claim.polarity, claim.verdict], ['indexRank', '^RUT', 'BOTTOM', 'false']);
  // With no day: Friday is the principal session; still false.
  assert.equal(only('The Russell 2000 was the weakest of the major indexes.').verdict, 'false');
});

test('Step 9AR Build 4: a true ranking is kept (true), whatever the form', () => {
  for (const sentence of [
    'The Dow was the weakest of the major indexes on Friday.',
    'The Nasdaq was the weakest major index on Thursday.',
    'The Nasdaq was the strongest of the four major indexes on Friday.',
    'Among the major indexes, the Nasdaq was the best performer on Friday.',
    'On Friday, the weakest of the major indexes was the Dow.',
    'The Nasdaq led gains on Friday.',
    'The Nasdaq led the decline on Thursday.',
    'The Dow lagged the other major indexes on Friday.',
    'The Nasdaq outperformed the other major averages on Friday.',
    'The Dow, the worst-performing of the major indexes on Friday, slipped.'
  ]) {
    assert.equal(only(sentence).verdict, 'true', sentence);
  }
});

test('Step 9AR Build 4: a false ranking is judged false in every form', () => {
  for (const sentence of [
    'On Friday, the weakest of the four major indexes was the Russell 2000.',
    'Among the major indexes, the Russell 2000 was the weakest on Friday.',
    'The Russell 2000, the weakest of the major indexes, rose 0.89% on Friday.',
    'The Dow led gains on Friday.',
    'The Russell 2000 led the decline on Thursday.',
    'The Russell 2000 lagged the other major indexes on Friday.',
    'The Dow outperformed its peers on Friday.',
    'The S&P 500 was the biggest gainer of the major indexes on Friday.',
    'The Dow led the major indexes higher on Friday.'
  ]) {
    assert.equal(only(sentence).verdict, 'false', sentence);
  }
});

test('Step 9AR Build 4: a claim is false only when false on every day it could mean (previous sentence)', () => {
  // No day: Friday (principal) plus Thursday from the previous sentence. Nasdaq weakest on Thursday.
  assert.equal(only('The Nasdaq was the weakest of the major indexes.',
    {previousSentence: 'On Thursday, stocks sank.'}).verdict, 'true');
  assert.equal(only('The Nasdaq was the weakest of the major indexes.').verdict, 'false');
  // False on both Friday and Thursday.
  assert.equal(only('The Russell 2000 was the weakest of the major indexes.',
    {previousSentence: 'On Thursday, stocks sank.'}).verdict, 'false');
  // Two days named in the sentence: true on one of them, kept.
  assert.equal(only('The Nasdaq was the weakest of the major indexes on Thursday and Friday.').verdict, 'true');
  // A date instead of a weekday.
  assert.equal(only('The Russell 2000 was the weakest of the major indexes on Nov. 6.').verdict, 'false');
  assert.equal(only('The Nasdaq was the weakest of the major indexes on Nov. 5.').verdict, 'true');
});

test('Step 9AR Build 4: the index set: "three" means Dow, S&P and Nasdaq; unnumbered checks both sets', () => {
  // Russell named with "three": not in the set, nothing done.
  const russell = only('The Russell 2000 was the weakest of the three major indexes.');
  assert.deepEqual([russell.verdict, russell.reason], ['skip', 'unclearIndexSet']);
  // Thursday: among four the Nasdaq is weakest (true either way).
  assert.equal(only('The Nasdaq was the weakest of the three major indexes on Thursday.').verdict, 'true');
  // A set where only the four-index reading is false: S&P strongest of three but not of four.
  const local = buildRankingFacts(pkg({week: {...WEEK, '^RUT': [0, 0, 0, 0, 2.5]}}));
  assert.equal(only('The Nasdaq was the strongest of the major indexes.', undefined, local).verdict, 'true');
  assert.equal(only('The Nasdaq was the strongest of the four major indexes.', undefined, local).verdict, 'false');
  assert.equal(only('The Nasdaq was the strongest of the three major indexes.', undefined, local).verdict, 'true');
});

test('Step 9AR Build 4: a tie for the claimed place is kept (tie)', () => {
  const local = buildRankingFacts(pkg({week: {...WEEK, '^RUT': [0, 0, 0, 0, -0.46]}}));
  assert.equal(only('The Russell 2000 was the weakest of the major indexes on Friday.', undefined, local).verdict, 'tie');
  assert.equal(only('The Dow was the weakest of the four major indexes on Friday.', undefined, local).verdict, 'tie');
  // Unnumbered: tied among the four but weakest outright among the three, so true (kept either way).
  assert.equal(only('The Dow was the weakest of the major indexes on Friday.', undefined, local).verdict, 'true');
});

test('Step 9AR Build 4: missing data is never judged false (missingData)', () => {
  const local = buildRankingFacts(pkg({week: {...WEEK, '^DJI': [0.41, -0.38, 3.03, -3.44, null]}}));
  const claim = only('The Russell 2000 was the weakest of the major indexes on Friday.', undefined, local);
  assert.deepEqual([claim.verdict, claim.reason], ['skip', 'missingData']);
  // A weekday with no stored session (Saturday) and no index of the four in the package.
  assert.equal(only('The Russell 2000 was the weakest of the major indexes on Saturday.').reason, 'missingData');
  const three = buildRankingFacts(pkg({week: {'^DJI': WEEK['^DJI'], '^IXIC': WEEK['^IXIC'], '^RUT': WEEK['^RUT']}}));
  assert.equal(only('The Russell 2000 was the weakest of the major indexes.', undefined, three).reason, 'missingData');
});

test('Step 9AR Build 4: period claims, other indexes and unclear wording are skipped with a reason', () => {
  assert.equal(only('The Russell 2000 was the weakest of the major indexes this week.').reason, 'periodClaimNotChecked');
  assert.equal(only('The Russell 2000 was the weakest of the major indexes year to date.').reason, 'periodClaimNotChecked');
  assert.equal(only('The Nasdaq 100 was the weakest of the major indexes on Friday.').reason, 'otherIndex');
  assert.equal(only('The Russell 1000 was the weakest of the major indexes on Friday.').reason, 'otherIndex');
  assert.equal(only('The Nasdaq led the major indexes on Friday.').reason, 'unclearDirection');
  assert.equal(only('The Russell 2000 was the weakest of the major indexes yesterday.').reason, 'unclearDay');
  for (const reason of ['otherIndex', 'periodClaimNotChecked', 'unclearDirection', 'unclearDay', 'missingData']) {
    assert.ok(SKIP_REASONS.includes(reason), reason);
  }
});

test('Step 9AR Build 4: sentences that are not ranking claims about the four indexes give no claim', () => {
  for (const sentence of [
    'Energy was the strongest sector, with the S&P 500 energy sector up 2%.',
    'Technology stocks led last week\'s selloff, with the Nasdaq Composite down 4%.',
    'The Nasdaq fell 5.5% on Thursday, its worst day since June.',
    'Microsoft led the initiating list from the open.',
    'The Russell 2000 was the weakest.',
    'The S&P 500 was the best index fund to own.',
    'Thursday was the worst day in weeks for the Nasdaq.',
    'The Russell 2000 posted its worst week since March.'
  ]) {
    assert.deepEqual(check(sentence).claims, [], sentence);
  }
});

test('Step 9AR Build 4: comparisons are counted, never judged', () => {
  const one = check('The Nasdaq fell more sharply than the S&P 500 on Thursday.');
  assert.deepEqual([one.claims.length, one.comparisonCount], [0, 1]);
  assert.equal(check('The Russell 2000 trailed the S&P 500.').comparisonCount, 1);
  assert.equal(check('The Dow posted a smaller drop than the Nasdaq.').comparisonCount, 1);
  assert.equal(check('The S&P 500 rose 0.31%.').comparisonCount, 0);
});

test('Step 9AR Build 4: the day-of-the-week form, for a named index or all four', () => {
  // Week of 2 to 6 Nov: every index had its worst day on Thursday and best on Wednesday (Dow) or other days.
  assert.equal(only('Thursday was the worst day of the week for the Nasdaq.').verdict, 'true');
  assert.equal(only('Wednesday was the worst day of the week for the Nasdaq.').verdict, 'false');
  assert.equal(only('Thursday was the worst day of the week.').verdict, 'true');
  assert.equal(only('Friday was the worst session of the week.').verdict, 'false');
  assert.equal(only('The worst day of the week came on Monday.').verdict, 'false');
  assert.equal(only('Wednesday was the week\'s best day for the Dow.').verdict, 'true');
  const claim = only('Thursday was the best day of the week for the S&P 500.');
  assert.deepEqual([claim.form, claim.symbol, claim.polarity, claim.verdict], ['dayOfWeek', '^GSPC', 'TOP', 'false']);
  // Best day: Wednesday for the S&P 500 (1.58) but the Nasdaq's best was Wednesday too (1.44) - both true.
  assert.equal(only('Wednesday was the best day of the week.').verdict, 'true');
});

test('Step 9AR Build 4: a week with a missing session is never judged (missingData)', () => {
  const local = buildRankingFacts(pkg({week: {...WEEK, '^IXIC': [-1.07, null, 1.44, -5.52, 1.09]}}));
  const claim = only('Wednesday was the worst day of the week for the Nasdaq.', undefined, local);
  assert.deepEqual([claim.verdict, claim.reason], ['skip', 'missingData']);
});

test('Step 9AR Build 4: Trading (REGULAR) adds the live day for an undated claim; PRE and POST do not', () => {
  const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const base = {dates, principal: '2026-11-06', generatedAt: '2026-11-09T16:00:00.000Z'};
  // Live (Monday 9 Nov): the Russell 2000 is weakest.
  const overlays = {'^DJI': 0.5, '^IXIC': 0.7, '^GSPC': 0.6, '^RUT': -0.9};
  const regular = buildRankingFacts(pkg({...base, state: 'REGULAR', overlays}));
  assert.equal(only('The Russell 2000 was the weakest of the major indexes.', undefined, regular).verdict, 'true');
  assert.equal(only('The Russell 2000 was the weakest of the major indexes today.', undefined, regular).verdict, 'true');
  assert.equal(only('The Nasdaq was the weakest of the major indexes.', undefined, regular).verdict, 'false');
  for (const state of ['PRE', 'POST']) {
    const local = buildRankingFacts(pkg({...base, state, overlays}));
    assert.equal(only('The Russell 2000 was the weakest of the major indexes.', undefined, local).verdict, 'false', state);
  }
  // A missing live value: never judged.
  const partial = buildRankingFacts(pkg({...base, state: 'REGULAR', overlays: {'^DJI': 0.5, '^IXIC': 0.7, '^GSPC': 0.6}}));
  const claim = only('The Nasdaq was the weakest of the major indexes.', undefined, partial);
  assert.deepEqual([claim.verdict, claim.reason], ['skip', 'liveDayUnknown']);
});

test('Step 9AR Build 4: bad input gives no claim and never throws', () => {
  assert.deepEqual(checkRankingSentence('', facts), {claims: [], comparisonCount: 0});
  assert.deepEqual(checkRankingSentence(null, facts), {claims: [], comparisonCount: 0});
  assert.deepEqual(checkRankingSentence('The Russell 2000 was the weakest of the major indexes.', buildRankingFacts({})).claims, []);
});

test('Step 9AR Build 4: a rank phrase later in the same clause is read for that index only', () => {
  assert.equal(only('The Russell 2000 rose 0.89% on Friday, the weakest of the major indexes.').verdict, 'false');
  assert.equal(only('The Dow fell 0.46% on Friday, making it the weakest of the major indexes.').verdict, 'true');
  assert.equal(only('The Russell 2000 rose 0.89% and was the weakest of the major indexes on Friday.').verdict, 'false');
  // Three correct clauses and one wrong ranking: the claim belongs to the Russell 2000 only.
  const claim = only('The Dow fell 0.46%, the S&P 500 rose 0.31%, the Nasdaq added 1.09% and the Russell 2000, '
    + 'the weakest of the four, gained 0.89%.');
  assert.deepEqual([claim.symbol, claim.verdict], ['^RUT', 'false']);
  // A phrase after the next index name is not read for the first name.
  assert.equal(only('The Dow fell 0.46% while the Nasdaq rose 1.09%, the strongest of the major indexes.').symbol, '^IXIC');
});

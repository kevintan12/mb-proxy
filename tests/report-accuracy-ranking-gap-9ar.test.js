'use strict';

// Step 9AR Build 4 fix: ranking claims with words between the index name and the verb, and comparisons
// against a group of indexes. Made-up package with the 8 Nov 2026 Weekend index moves (Friday: Russell
// +0.89%, Dow -0.46%, S&P +0.31%, Nasdaq +1.09%; Thursday: Nasdaq -5.52%, Russell -4.45%, S&P -4.36%,
// Dow -3.44%). Pure functions plus the cleanup step; no network, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');

const {buildRankingFacts, checkRankingSentence} = require('../lib/report-accuracy-ranking');
const {rankingClaimCleanup} = require('../lib/claude-analysis-invocation');
const {REPORT_SECTION_NAMES} = require('../lib/claude-analysis-contract');

const WEEK = {
  '^DJI': [0.41, -0.38, 3.03, -3.44, -0.46],
  '^IXIC': [-1.07, 0.83, 1.44, -5.52, 1.09],
  '^GSPC': [-0.51, 0.36, 1.58, -4.36, 0.31],
  '^RUT': [-0.21, 0.23, 1.58, -4.45, 0.89]
};
const DATES = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const NAMES = {'^DJI': 'Dow Jones Industrial Average', '^IXIC': 'NASDAQ Composite', '^GSPC': 'S&P 500', '^RUT': 'Russell 2000'};

function pkg() {
  return {
    analysisRequest: {generatedAt: '2026-11-08T13:57:56.131Z'},
    marketPackages: [{
      marketContext: {marketState: 'WEEKEND', primaryCompletedSessionDate: '2026-11-06'},
      telemetry: {
        stockSnapshots: [],
        benchmarkSnapshots: Object.entries(WEEK).map(([symbol, values]) => ({
          reference: symbol,
          snapshot: {
            symbol, instrumentName: NAMES[symbol],
            completedSessions: values.map((percentChange, index) => ({
              sessionDate: DATES[index], close: 100, absoluteChange: percentChange, percentChange
            })),
            currentOverlay: null
          }
        }))
      }
    }]
  };
}

const input = pkg();
const facts = buildRankingFacts(input);
const only = (sentence, options) => {
  const {claims} = checkRankingSentence(sentence, facts, options);
  assert.equal(claims.length, 1, `${sentence}: ${JSON.stringify(claims)}`);
  return claims[0];
};
const none = (sentence, options) => {
  const {claims} = checkRankingSentence(sentence, facts, options);
  assert.deepEqual(claims, [], sentence);
};

const S1_BAD = 'Money also moved toward safer parts of the market, and Russell 2000 small companies were the weakest of the major indexes on the day.';
const S5_COMPARE = 'The Russell 2000 small-company index also moved more sharply than the large-company indexes, showing that smaller firms were not immune to the sell-off.';
const THURSDAY = "Thursday's losses were heavy.";

test('Step 9AR Build 4 fix: the real 8 Nov Section 1 sentence is found and judged false', () => {
  const claim = only(S1_BAD, {previousSentence: THURSDAY});
  assert.deepEqual([claim.form, claim.symbol, claim.polarity, claim.verdict], ['indexRank', '^RUT', 'BOTTOM', 'false']);
});

test('Step 9AR Build 4 fix: gap forms are found (small companies, index of small companies, comma phrase)', () => {
  assert.equal(only('Russell 2000 small companies were the weakest of the major indexes on Friday.').verdict, 'false');
  assert.equal(only('The Russell 2000 index of small companies was the weakest of the major indexes.').verdict, 'false');
  const comma = only('On Friday, the Russell 2000, home to small companies, was the weakest of the major indexes.');
  assert.deepEqual([comma.symbol, comma.verdict], ['^RUT', 'false']);
  // The Nasdaq example from the decision: false on Friday (Dow weakest), true on Thursday.
  assert.equal(only('On Friday, the Nasdaq, home to big tech, was the weakest of the major indexes.').verdict, 'false');
  assert.equal(only('On Thursday, the Nasdaq, home to big tech, was the weakest of the major indexes.').verdict, 'true');
});

test('Step 9AR Build 4 fix: a true gap-form claim is kept', () => {
  assert.equal(only('The Dow, home to old-line industrial names, was the weakest of the major indexes on Friday.').verdict, 'true');
  assert.equal(only('Nasdaq technology shares were the strongest of the major indexes on Friday.').verdict, 'true');
  assert.equal(only('Nasdaq tech companies were the weakest of the major indexes on Thursday.').verdict, 'true');
});

test('Step 9AR Build 4 fix: the gap is limited to 6 words', () => {
  // 6 words between name and verb: found. 7 words: not found.
  assert.equal(only('The Russell 2000 of small firms across the country was the weakest of the major indexes on Friday.').verdict, 'false');
  none('The Russell 2000 of small firms across the whole country was the weakest of the major indexes on Friday.');
});

test('Step 9AR Build 4 fix: a sentence break, another index name or a clause word in the gap stops the match', () => {
  none('The Russell 2000 is small. Companies were the weakest of the major indexes on Friday.');
  // Another index name after the first: only the Nasdaq (directly before the verb) is judged.
  const claims = checkRankingSentence('The Russell 2000 and the Nasdaq were the weakest of the major indexes on Friday.', facts).claims;
  assert.deepEqual(claims.map(claim => claim.symbol), ['^IXIC']);
  none('The Russell 2000 rose while energy companies were the weakest of the major indexes on Friday.');
  none('The Russell 2000 rose 0.89% and small caps were the weakest of the major indexes on Friday.');
});

test('Step 9AR Build 4 fix: a sector or stock sentence with no index name does nothing', () => {
  none('Energy companies were the strongest of the sectors.');
  none('Energy companies were the strongest of the major sectors on Friday.');
  none('Small companies were the weakest of the major indexes on Friday.');
});

test('Step 9AR Build 4 fix: a gap-form claim with a period or missing day is skipped, not cut', () => {
  assert.equal(only('Russell 2000 small companies were the weakest of the major indexes this week.').reason, 'periodClaimNotChecked');
  assert.equal(only('Russell 2000 small companies were the weakest of the major indexes on Saturday.').reason, 'missingData');
});

test('Step 9AR Build 4 fix: comparisons against a group of indexes are counted, never judged', () => {
  const group = checkRankingSentence(S5_COMPARE, facts);
  assert.deepEqual(group.claims, []);
  assert.equal(group.comparisonCount, 1);
  assert.equal(checkRankingSentence('The Nasdaq fell more than the other major indexes on Thursday.', facts).comparisonCount, 1);
  assert.equal(checkRankingSentence('The Dow moved less sharply than the large-company indexes.', facts).comparisonCount, 1);
  // Not a comparison against indexes: nothing counted.
  assert.equal(checkRankingSentence('The Nasdaq fell more than 5% on Thursday.', facts).comparisonCount, 0);
  assert.equal(checkRankingSentence('Energy stocks fell more sharply than the large-company indexes.', facts).comparisonCount, 0);
  // Two named indexes: still one.
  assert.equal(checkRankingSentence('The Nasdaq fell more sharply than the S&P 500 on Thursday.', facts).comparisonCount, 1);
});

test('Step 9AR Build 4 fix: the cleanup removes the Section 1 sentence and keeps Section 5', () => {
  const section1 = `The US market had a rough week. ${THURSDAY} ${S1_BAD} Looking ahead, traders watch the inflation report.`;
  const section5 = `The mood is cautious. ${S5_COMPARE} The pattern suggests a pause.`;
  const sections = Array.from({length: 8}, (_, index) => ({
    name: REPORT_SECTION_NAMES[index], content: index === 0 ? section1 : index === 4 ? section5 : `Placeholder ${index + 1}.`,
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
  sections[7] = {...sections[7], content: null};
  const events = rankingClaimCleanup(sections, input, {output: {status: 'COMPLETE', sections, evidenceGaps: []}, evidenceGaps: []});
  assert.equal(sections[0].content,
    `The US market had a rough week. ${THURSDAY} Looking ahead, traders watch the inflation report.`);
  assert.equal(sections[4].content, section5);
  const byIndex = Object.fromEntries(events.map(event => [event.sectionIndex, event]));
  assert.equal(byIndex[0].removedSentenceCount, 1, JSON.stringify(events));
  assert.equal(byIndex[4].comparisonCount, 1, JSON.stringify(events));
  assert.equal(byIndex[4].removedSentenceCount, 0, JSON.stringify(events));
});

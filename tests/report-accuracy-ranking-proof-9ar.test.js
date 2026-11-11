'use strict';

// Step 9AR Build 4, tests added after the Group C strict proof (11 Nov 2026): two planted mistakes passed
// the whole suite before these tests existed - ranking by points instead of percent, and a gap that runs
// across another index name. Made-up package with the 8 Nov 2026 Weekend index moves and index levels that
// differ, as real ones do (Dow near 47,000, Nasdaq near 23,000, S&P near 6,700, Russell near 2,400), so
// ranking by points gives a different order from ranking by percent. Pure functions plus the cleanup step;
// no network, no paid call.

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
const LEVEL = {'^DJI': 47000, '^IXIC': 23000, '^GSPC': 6700, '^RUT': 2400};
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
              sessionDate: DATES[index], close: LEVEL[symbol],
              absoluteChange: Math.round(LEVEL[symbol] * percentChange) / 100, percentChange
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
const only = sentence => {
  const {claims} = checkRankingSentence(sentence, facts);
  assert.equal(claims.length, 1, `${sentence}: ${JSON.stringify(claims)}`);
  return claims[0];
};
const sectionsWith = content => {
  const sections = Array.from({length: 8}, (_, index) => ({
    name: REPORT_SECTION_NAMES[index], content: index === 4 ? content : `Placeholder ${index + 1}.`,
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
  sections[7] = {...sections[7], content: null};
  return sections;
};

test('Step 9AR Build 4 proof: ranking uses percent change, not points', () => {
  // Thursday: Nasdaq -5.52% (about -1,270 points) is the weakest by percent; the Dow -3.44% (about -1,617
  // points) would be the weakest by points.
  assert.equal(only('On Thursday, the Nasdaq was the weakest of the major indexes.').verdict, 'true');
  assert.equal(only('On Thursday, the Dow was the weakest of the major indexes.').verdict, 'false');
  // Friday: the Nasdaq +1.09% is the strongest by percent and by points (a control: the same either way).
  assert.equal(only('On Friday, the Nasdaq was the strongest of the major indexes.').verdict, 'true');

  const kept = 'On Thursday, the Nasdaq was the weakest of the major indexes.';
  const content = `The week ended mixed. ${kept} Traders watch the inflation report.`;
  const sections = sectionsWith(content);
  const events = rankingClaimCleanup(sections, input, {output: {status: 'COMPLETE', sections, evidenceGaps: []}, evidenceGaps: []});
  assert.equal(sections[4].content, content);
  const event = events.find(item => item.sectionIndex === 4);
  assert.equal(event.trueClaimCount, 1, JSON.stringify(events));
  assert.equal(event.removedSentenceCount, 0, JSON.stringify(events));
});

test('Step 9AR Build 4 proof: a gap that holds another index name is never read as a claim', () => {
  // Friday: the Russell (+0.89%) was not the strongest (the Nasdaq +1.09% was), but the words between
  // "Russell 2000" and "was" name the Nasdaq, so the Russell claim is not read and nothing is judged false.
  const sentence = 'On Friday, the Russell 2000, unlike the Nasdaq, was the strongest of the major indexes.';
  const {claims} = checkRankingSentence(sentence, facts);
  assert.equal(claims.filter(claim => claim.symbol === '^RUT').length, 0, JSON.stringify(claims));
  assert.equal(claims.filter(claim => claim.verdict === 'false').length, 0, JSON.stringify(claims));

  const content = `Small companies kept pace. ${sentence} Traders watch the inflation report.`;
  const sections = sectionsWith(content);
  const events = rankingClaimCleanup(sections, input, {output: {status: 'COMPLETE', sections, evidenceGaps: []}, evidenceGaps: []});
  assert.equal(sections[4].content, content);
  assert.equal(events.filter(event => event.removedSentenceCount > 0).length, 0, JSON.stringify(events));
});

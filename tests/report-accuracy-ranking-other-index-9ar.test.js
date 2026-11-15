'use strict';

// Step 9AR Build 4 fix after the re-proof: words that describe one of the four indexes itself
// ("the Russell 2000 small-company index", "the S&P 500 benchmark index") keep the name as that index,
// so a false ranking claim is judged; real other indexes ("S&P 500 energy sector", "Nasdaq biotech index",
// "Russell 2000 Value index") are still never judged. Made-up package with the 8 Nov 2026 Weekend index
// moves (Friday: Russell +0.89%, Dow -0.46%, S&P +0.31%, Nasdaq +1.09%; Thursday: Nasdaq -5.52%,
// Russell -4.45%, S&P -4.36%, Dow -3.44%). Pure functions plus the cleanup step; no network, no paid call.

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
const only = sentence => {
  const {claims} = checkRankingSentence(sentence, facts);
  assert.equal(claims.length, 1, `${sentence}: ${JSON.stringify(claims)}`);
  return claims[0];
};
const verdict = sentence => {
  const claim = only(sentence);
  return claim.verdict === 'skip' ? `skip:${claim.reason}` : claim.verdict;
};

test('Step 9AR Build 4 re-proof fix: Russell 2000 size words describe the Russell 2000 itself', () => {
  for (const words of ['small-cap index', 'small-company index', 'smaller-company index', 'small-cap benchmark index',
    'small-cap']) {
    const claim = only(`The Russell 2000 ${words} was the weakest of the major indexes on Friday.`);
    assert.deepEqual([claim.symbol, claim.polarity, claim.verdict], ['^RUT', 'BOTTOM', 'false'], words);
  }
  // Thursday: the Dow (-3.44%) was the strongest, so false; a true claim beside the phrase stays true.
  assert.equal(verdict('The Russell 2000 small-cap index was the strongest of the major indexes on Thursday.'), 'false');
  assert.equal(verdict('The Russell 2000 small-company index was not far behind; the Dow was the weakest of the major indexes on Friday.'), 'true');
});

test('Step 9AR Build 4 re-proof fix: describing words before "index" keep the named index (true and false)', () => {
  assert.equal(verdict('The Russell 2000 benchmark index was the weakest of the major indexes on Friday.'), 'false');
  assert.equal(verdict('The S&P 500 benchmark index was the weakest of the major indexes on Friday.'), 'false');
  assert.equal(verdict('The S&P 500 broad-market index was the strongest of the major indexes on Friday.'), 'false');
  assert.equal(verdict('The Nasdaq tech-heavy index was the strongest of the major indexes on Friday.'), 'true');
  assert.equal(verdict('The Nasdaq tech-heavy index was the weakest of the major indexes on Friday.'), 'false');
  assert.equal(verdict('The Dow blue-chip index was the weakest of the major indexes on Friday.'), 'true');
  assert.equal(verdict('The Dow blue-chip index was the strongest of the major indexes on Friday.'), 'false');
  // Later in the same clause, after the describing phrase.
  assert.equal(verdict('The Russell 2000 small-company index rose 0.89% on Friday, the weakest of the major indexes.'), 'false');
});

test('Step 9AR Build 4 re-proof fix: real other indexes and unclear size wording are still never judged', () => {
  for (const name of ['S&P 500 energy sector', 'S&P 500 technology index', 'Nasdaq biotech index', 'Nasdaq 100',
    'S&P 500 small-cap index', 'S&P 500 mid-cap index', 'Nasdaq small-cap index', 'Dow small-cap index',
    'Russell 2000 Value index', 'Russell 2000 growth index', 'Dow Jones Transportation Average', 'S&P 500 equal-weight index']) {
    const {claims} = checkRankingSentence(`The ${name} was the weakest of the major indexes on Friday.`, facts);
    assert.ok(claims.every(claim => claim.verdict === 'skip' && claim.reason === 'otherIndex'), `${name}: ${JSON.stringify(claims)}`);
    assert.ok(claims.length <= 1, name);
  }
  // A describing word followed by a sector noun is still another index.
  const sector = checkRankingSentence('The S&P 500 benchmark sector was the weakest of the major indexes on Friday.', facts);
  assert.ok(sector.claims.every(claim => claim.reason === 'otherIndex'), JSON.stringify(sector.claims));
});

test('Step 9AR Build 4 re-proof fix: the cleanup removes a false "small-cap index" sentence, never empties, keeps a comparison', () => {
  const bad = 'The Russell 2000 small-cap index was the weakest of the major indexes on Friday.';
  const compare = 'The Russell 2000 small-company index also moved more sharply than the large-company indexes, showing that smaller firms were not immune to the sell-off.';
  const section1 = `The US market ended the week with a small rebound. ${bad} Looking ahead, traders watch the inflation report.`;
  const section2 = bad;
  const section5 = `The mood is cautious. ${compare} The pattern suggests a pause.`;
  const sections = Array.from({length: 8}, (_, index) => ({
    name: REPORT_SECTION_NAMES[index],
    content: index === 0 ? section1 : index === 1 ? section2 : index === 4 ? section5 : `Placeholder ${index + 1}.`,
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
  sections[7] = {...sections[7], content: null};
  const events = rankingClaimCleanup(sections, input, {output: {status: 'COMPLETE', sections, evidenceGaps: []}, evidenceGaps: []});
  assert.equal(sections[0].content, 'The US market ended the week with a small rebound. Looking ahead, traders watch the inflation report.');
  assert.equal(sections[1].content, section2, 'a section is never emptied');
  assert.equal(sections[4].content, section5);
  assert.equal(sections[7].content, null);
  const byIndex = Object.fromEntries(events.map(event => [event.sectionIndex, event]));
  assert.equal(byIndex[0].removedSentenceCount, 1, JSON.stringify(events));
  assert.equal(byIndex[1].removedSentenceCount, 0, JSON.stringify(events));
  assert.equal(byIndex[1].skipReasons.wouldEmptySection, 1, JSON.stringify(events));
  assert.equal(byIndex[4].comparisonCount, 1, JSON.stringify(events));
  assert.equal(byIndex[4].removedSentenceCount, 0, JSON.stringify(events));
  for (const event of events) assert.equal(event.action, 'TRIMMED');
});

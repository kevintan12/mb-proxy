// Step 9AQ (follow-up to the Group C proof): a table stock that Section 4 already explains never gets a
// Section 4 focus pointer, even when a focus entry that the finished Section 3 cites names it. The only
// stock that gets a pointer is the one left unexplained. Free tests only: made-up data, no network, no
// paid call. No existing test is edited and no product code is changed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createClaudeAnalysisInput, splitReportSentences} = require('../lib/claude-analysis-contract');
const {sectionFourFocusPointers} = require('../lib/section-rules');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');

const NAMES = {MSFT: 'Microsoft Corporation', AVGO: 'Broadcom Inc.'};

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function stockSnapshot(symbol, name) {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: name, instrumentType: 'EQUITY', currency: 'USD', marketState: 'CLOSED',
    currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2, close, previousClose,
        volume: 1000 + index, asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance',
        validationState: 'VALIDATED'
      }))
  });
}

// A completed-day input with Microsoft (My Stocks) and Broadcom (Watchlist). Two company focus entries:
// Broadcom (e4) and Microsoft (e5). No stock has a linked news article.
function twoStockInput() {
  const symbols = ['MSFT', 'AVGO'];
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html', '2026-09-04T21:00:00Z', ['^GSPC']),
    item('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html', '2026-09-04T19:30:00Z'),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', [], 'monetary-policy'),
    item('us.cnbc', 'Broadcom leads semiconductor shares after a major company development',
      'https://www.cnbc.com/2026/09/04/broadcom-semiconductor-leadership.html', '2026-09-04T19:00:00Z'),
    item('us.cnbc', 'Microsoft draws investor attention on cloud demand',
      'https://www.cnbc.com/2026/09/04/microsoft-cloud-demand.html', '2026-09-04T19:15:00Z')
  ];
  const marketDataRef = {};
  for (const symbol of symbols) {
    evidence.push(item('us.yahoo-finance', `${NAMES[symbol]} quote`,
      `https://finance.yahoo.com/quote/${symbol}/`, '2026-09-04T20:00:00Z', [symbol], 'market-data'));
    marketDataRef[symbol] = `e${evidence.length}`;
  }
  const telemetryRef = Object.fromEntries(symbols.map((symbol, index) => [symbol, `t${index + 2}`]));
  const security = symbol => ({
    market: 'US', symbol, telemetryRefs: [telemetryRef[symbol]], evidenceRefs: [marketDataRef[symbol]],
    upcomingEvents: []
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks', generatedAt: '2026-09-06T10:00:00.000Z',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {
        benchmarkSnapshots: [stockSnapshot('^GSPC', 'S&P 500')],
        stockSnapshots: symbols.map(symbol => stockSnapshot(symbol, NAMES[symbol]))
      },
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'], supportingEvidence: ['e2', 'e3', 'e4', 'e5'],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          {evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]}
        ],
        unresolvedGaps: [],
        furtherReadings: ['e1', 'e2', 'e4', 'e5'].map(evidenceRef => ({evidenceRef, sessionDate: '2026-09-04'}))
      }
    }],
    portfolioContext: {myStocks: [security('MSFT')], watchlist: [security('AVGO')]}
  });
}

const TABLE = 'Stock | Ticker | Last Price | Change\nMy Stocks\nMicrosoft | MSFT | $105.00 | ↑ 3.00 (2.94%)\n'
  + 'Watchlist\nBroadcom | AVGO | $105.00 | ↑ 3.00 (2.94%)\nPrices at the close on Fri 4 Sep.';
const CLOSING_OTHER = 'No material news for the other stock.';
const CLOSING_ALL = 'No material news for all stocks.';
const MSFT_EXPLANATION = 'Microsoft shares rose as investors weighed fresh commentary on cloud demand.';
const AVGO_EXPLANATION = 'Broadcom shares rose as investors weighed fresh commentary on chip demand.';
const POINTER_MSFT = 'Microsoft: see Stocks & Sectors in Focus.';
const POINTER_AVGO = 'Broadcom: see Stocks & Sectors in Focus.';
// Section 3 cites BOTH company focus entries.
const SECTION_THREE_BOTH = {
  content: 'Broadcom led semiconductor shares and Microsoft drew attention on cloud demand.',
  evidenceRefs: ['e4', 'e5']
};
const stock = (symbol, names, supported) => ({symbol, names, supported});
const MSFT = supported => stock('MSFT', ['microsoft', 'microsoft corporation'], supported);
const AVGO = supported => stock('AVGO', ['broadcom', 'broadcom inc'], supported);

function sectionFour(middle, closing) {
  return {content: [TABLE, middle, closing].filter(Boolean).join('\n\n'), evidenceRefs: [], telemetryRefs: []};
}

test('Step 9AQ: a stock Section 4 already explains gets no pointer, although a cited focus entry names it; the other stock still does', () => {
  const input = twoStockInput();
  const result = sectionFourFocusPointers(sectionFour(MSFT_EXPLANATION, CLOSING_OTHER), SECTION_THREE_BOTH,
    input, [MSFT(true), AVGO(false)], splitReportSentences);
  assert.ok(result, 'the unexplained stock should get a pointer');
  const parts = result.content.split('\n\n');
  assert.deepEqual(parts.slice(1), [`${MSFT_EXPLANATION}\n${POINTER_AVGO}`]);
  assert.equal(result.pointerCount, 1);
  assert.equal(result.coveredStocks, 2);
  assert.equal(result.content.includes(POINTER_MSFT), false);
  assert.equal(result.content.includes('No material news'), false);
  assert.equal(result.content.split(MSFT_EXPLANATION).length - 1, 1);
});

test('Step 9AQ: the same the other way round -- the explained stock is Broadcom, the pointer is for Microsoft', () => {
  const input = twoStockInput();
  const result = sectionFourFocusPointers(sectionFour(AVGO_EXPLANATION, CLOSING_OTHER), SECTION_THREE_BOTH,
    input, [MSFT(false), AVGO(true)], splitReportSentences);
  assert.ok(result);
  const parts = result.content.split('\n\n');
  assert.deepEqual(parts.slice(1), [`${AVGO_EXPLANATION}\n${POINTER_MSFT}`]);
  assert.equal(result.pointerCount, 1);
  assert.equal(result.coveredStocks, 2);
  assert.equal(result.content.includes(POINTER_AVGO), false);
});

test('Step 9AQ: both stocks explained -- no pointer at all, and the section is left as the writer made it', () => {
  const input = twoStockInput();
  const section = sectionFour(`${MSFT_EXPLANATION}\n${AVGO_EXPLANATION}`, null);
  const result = sectionFourFocusPointers(section, SECTION_THREE_BOTH, input,
    [MSFT(true), AVGO(true)], splitReportSentences);
  assert.equal(result, null);
});

test('Step 9AQ: control -- with neither stock explained, both cited focus entries give a pointer each, in table order', () => {
  const input = twoStockInput();
  const result = sectionFourFocusPointers(sectionFour(null, CLOSING_ALL), SECTION_THREE_BOTH, input,
    [MSFT(false), AVGO(false)], splitReportSentences);
  assert.ok(result);
  assert.deepEqual(result.content.split('\n\n').slice(1), [`${POINTER_MSFT}\n${POINTER_AVGO}`]);
  assert.equal(result.pointerCount, 2);
  assert.equal(result.coveredStocks, 2);
});

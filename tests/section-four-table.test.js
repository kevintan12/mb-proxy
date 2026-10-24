// Step 9AA Build 1: Section 4 is a price table built by code (Stock | Price | Change; My Stocks,
// then the Watchlist), with news explanations below it only for stocks whose own linked article
// gives a reason, and one closing line for the rest. The writer never writes a table figure. Same
// code in all six US market states (lib/section-rules.js composeSectionFour). Behind the Admin
// switch sectionFourTableEnabled (default on, and only while sectionFourBothListsEnabled is on).
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  REPORT_SECTION_NAMES,
  SECTION_RULES
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');
const {settingValue} = require('../lib/settings-registry');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {
  sectionFourRowPrice,
  formatSectionFourPrice,
  formatSectionFourChange,
  sectionFourShortName,
  sectionFourTableText,
  sectionFourTableWordCount,
  sectionFourTableOn,
  SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT
} = require('../lib/section-rules');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {invokeCounted, activeUsInput, normalOutput, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');
const {withSectionFourSwitch} = require('./fixtures/section-four-switch');
const {withSectionFourTableSwitch} = require('./fixtures/section-four-table-switch');

// Each test sets both switches itself (on unless it says otherwise), so a whole-suite run with
// either switch off still checks the table behaviour.
const test = (name, fn) => nodeTest(name, () =>
  withSectionFourSwitch('on', () => withSectionFourTableSwitch('on', fn)));

const NAMES = {
  NVDA: 'NVIDIA Corporation', MSFT: 'Microsoft Corporation', CPRI: 'Capri Holdings Limited',
  NVO: 'Novo Nordisk A/S', AAPL: 'Apple Inc.', AMD: 'Advanced Micro Devices, Inc.',
  META: 'Meta Platforms, Inc.', V: 'Visa Inc.'
};

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

// One stock's snapshot: five completed sessions ending 2026-09-04 (close `close`, previous
// close `previousClose`), and in REGULAR an optional live overlay.
function stockSnapshot(symbol, marketState, {close = 105, previousClose = 102, overlay = null,
  currency = 'USD', name = NAMES[symbol]} = {}) {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', previousClose, 99], ['2026-09-04', close, previousClose]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: name, instrumentType: 'EQUITY', currency, marketState,
    currentOverlay: overlay ? createCurrentSessionOverlay({
      market: 'US', marketState, sessionDate: '2026-09-08', asOf: overlay.asOf,
      lastPrice: overlay.lastPrice, referenceClose: close, volume: 5000,
      sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    }) : null,
    completedSessions: facts.map(([sessionDate, sessionClose, sessionPrevious], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: sessionClose - 1, high: sessionClose + 2, low: sessionClose - 2,
        close: sessionClose, previousClose: sessionPrevious, volume: 1000 + index,
        asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
      }))
  });
}

// A completed-day input (rich fixture shape) with My Stocks, a Watchlist, a market-data item per
// stock and a linked Yahoo article for each symbol in `linked`. `prices` overrides a stock's
// snapshot options; a symbol in `missing` has no snapshot (failed price data).
function tableInput({myStocks = [], watchlist = [], linked = [], marketState = 'CLOSED', prices = {},
  missing = []} = {}) {
  const symbols = [...new Set(myStocks.concat(watchlist))];
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
    item('us.cnbc', 'Health-care shares advance on constructive industry developments',
      'https://www.cnbc.com/2026/09/04/health-care-sector-advances.html', '2026-09-04T19:15:00Z')
  ];
  const marketDataRef = {};
  const newsRef = {};
  for (const symbol of symbols) {
    evidence.push(item('us.yahoo-finance', `${NAMES[symbol]} quote`,
      `https://finance.yahoo.com/quote/${symbol}/`, '2026-09-04T20:00:00Z', [symbol], 'market-data'));
    marketDataRef[symbol] = `e${evidence.length}`;
  }
  for (const symbol of linked) {
    evidence.push(item('us.yahoo-finance', `${NAMES[symbol]} shares move after company news`,
      `https://finance.yahoo.com/news/${symbol.toLowerCase()}-company-news-120000000.html`,
      '2026-09-04T20:30:00Z', [symbol]));
    newsRef[symbol] = `e${evidence.length}`;
  }
  const priced = symbols.filter(symbol => !missing.includes(symbol));
  const telemetryRef = Object.fromEntries(priced.map((symbol, index) => [symbol, `t${index + 2}`]));
  const security = symbol => ({
    market: 'US', symbol, telemetryRefs: telemetryRef[symbol] ? [telemetryRef[symbol]] : [],
    evidenceRefs: (missing.includes(symbol) ? [] : [marketDataRef[symbol]])
      .concat(newsRef[symbol] ? [newsRef[symbol]] : []),
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
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {
        benchmarkSnapshots: [stockSnapshot('^GSPC', marketState, {name: 'S&P 500'})],
        stockSnapshots: priced.map(symbol => stockSnapshot(symbol, marketState, prices[symbol]))
      },
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'],
        supportingEvidence: ['e2', 'e3', 'e4', 'e5', ...linked.map(symbol => newsRef[symbol])],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          {evidenceRef: 'e5', subjects: [{kind: 'SECTOR', name: 'Health-care'}]}
        ],
        unresolvedGaps: [],
        furtherReadings: ['e1', 'e2', 'e4', 'e5'].map(evidenceRef => ({evidenceRef, sessionDate: '2026-09-04'}))
      }
    }],
    portfolioContext: {myStocks: myStocks.map(security), watchlist: watchlist.map(security)}
  });
}

function refsOf(input, symbol) {
  const security = input.portfolioContext.myStocks.concat(input.portfolioContext.watchlist)
    .find(entry => entry.symbol === symbol);
  return {evidenceRefs: security.evidenceRefs, telemetryRefs: security.telemetryRefs};
}

function outputWithSectionFour(input, content, symbols, extra = {}) {
  const output = supportedOutput(input);
  const evidenceRefs = [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).evidenceRefs))];
  const telemetryRefs = [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).telemetryRefs))];
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content, evidenceRefs, telemetryRefs,
    uncertainties: [], ...extra};
  return output;
}

const tableLines = content => content.split('\n\n')[0].split('\n');

// For the table helpers alone (they read plain package data): a copy of a completed-day input in
// another market state, with optional live overlays ({symbol: {asOf, lastPrice}}).
function inState(input, marketState, overlays = {}) {
  const copy = structuredClone(input);
  copy.marketPackages[0].marketContext.marketState = marketState;
  for (const entry of copy.marketPackages[0].telemetry.stockSnapshots) {
    const overlay = overlays[entry.snapshot.symbol];
    const close = entry.snapshot.completedSessions.at(-1).close;
    entry.snapshot.currentOverlay = overlay ? {marketState, sessionDate: '2026-09-08', asOf: overlay.asOf,
      lastPrice: overlay.lastPrice, referenceClose: close, absoluteChange: overlay.lastPrice - close,
      percentChange: (overlay.lastPrice - close) / close * 100, volume: 5000, isFinal: false,
      sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'} : null;
  }
  return copy;
}

test('Step 9AA: the switch is one Admin setting, default on, and needs the both-lists switch', async () => {
  assert.equal(settingValue('sectionFourTableEnabled', {env: {}}), true);
  assert.equal(settingValue('sectionFourTableEnabled', {env: {SECTION_FOUR_TABLE_ENABLED: 'false'}}), false);
  assert.equal(sectionFourTableOn({env: {}}), true);
  assert.equal(sectionFourTableOn({env: {SECTION_FOUR_TABLE_ENABLED: 'off'}}), false);
  assert.equal(sectionFourTableOn({env: {SECTION_FOUR_BOTH_LISTS_ENABLED: 'off'}}), false);
});

test('Step 9AA: price and change use the report header format (arrow, 2 decimals, grouping)', () => {
  assert.equal(formatSectionFourPrice(15.869999885559082, 'USD'), '$15.87');
  assert.equal(formatSectionFourPrice(15.935, 'USD'), '$15.94');
  assert.equal(formatSectionFourPrice(1234.5, 'USD'), '$1,234.50');
  assert.equal(formatSectionFourPrice(88.1, 'EUR'), 'EUR 88.10');
  assert.equal(formatSectionFourPrice(10, null), '$10.00');
  assert.equal(formatSectionFourChange(-0.49, -2.99), '↓ 0.49 (2.99%)');
  assert.equal(formatSectionFourChange(0.195, 0.67), '↑ 0.20 (0.67%)');
  assert.equal(formatSectionFourChange(1234.567, 12.3456), '↑ 1,234.57 (12.35%)');
  assert.equal(formatSectionFourChange(0, 0), '— 0.00 (0.00%)');
  for (const text of [formatSectionFourChange(-4.51, -0.69), formatSectionFourPrice(644.335, 'USD')]) {
    assert.doesNotMatch(text, /points|-\d|\d\.\d{3}/);
  }
});

test('Step 9AA: the stock name drops only the legal suffix; the ticker alone when Yahoo gave no name', () => {
  assert.equal(sectionFourShortName('Capri Holdings Limited'), 'Capri Holdings');
  assert.equal(sectionFourShortName('Novo Nordisk A/S'), 'Novo Nordisk');
  assert.equal(sectionFourShortName('Advanced Micro Devices, Inc.'), 'Advanced Micro Devices');
  assert.equal(sectionFourShortName('State Street SPDR Portfolio S&P 500 ETF'), 'State Street SPDR Portfolio S&P 500 ETF');
  assert.equal(sectionFourShortName(''), null);
  const input = inState(tableInput({myStocks: ['CPRI'], watchlist: ['AAPL']}), 'CLOSED');
  input.marketPackages[0].telemetry.stockSnapshots[1].snapshot.instrumentName = '';
  assert.deepEqual(tableLines(sectionFourTableText(input)), [
    'Stock | Price | Change', 'My Stocks', 'Capri Holdings (CPRI) | $105.00 | ↑ 3.00 (2.94%)',
    'Watchlist', 'AAPL | $105.00 | ↑ 3.00 (2.94%)', 'Prices at the close on Fri 4 Sep.']);
});

test('Step 9AA: in every completed and pre/after-hours state the table shows the latest completed close', () => {
  for (const marketState of ['PRE', 'POST', 'CLOSED', 'WEEKEND', 'HOLIDAY']) {
    const input = inState(tableInput({myStocks: ['NVDA'], watchlist: ['AAPL'],
      prices: {AAPL: {close: 99.5, previousClose: 100}}}), marketState);
    assert.deepEqual(tableLines(sectionFourTableText(input)), [
      'Stock | Price | Change', 'My Stocks', 'NVIDIA (NVDA) | $105.00 | ↑ 3.00 (2.94%)',
      'Watchlist', 'Apple (AAPL) | $99.50 | ↓ 0.50 (0.50%)', 'Prices at the close on Fri 4 Sep.'], marketState);
  }
});

test('Step 9AA: Trading uses the live price, else the last close marked *, with the live time in the note', () => {
  const input = inState(tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL']}), 'REGULAR', {
    NVDA: {asOf: '2026-09-08T16:58:00.000Z', lastPrice: 107},
    AAPL: {asOf: '2026-09-08T16:57:00.000Z', lastPrice: 104.5}});
  assert.deepEqual(tableLines(sectionFourTableText(input)), [
    'Stock | Price | Change', 'My Stocks', 'NVIDIA (NVDA) | $107.00 | ↑ 2.00 (1.90%)',
    'Microsoft (MSFT) | $105.00* | ↑ 3.00 (2.94%)', 'Watchlist', 'Apple (AAPL) | $104.50 | ↓ 0.50 (0.48%)',
    'Live prices at 12:58 pm ET; * last close.']);
  // With every stock live there is no marker and no "* last close".
  const allLive = inState(tableInput({myStocks: ['NVDA']}), 'REGULAR',
    {NVDA: {asOf: '2026-09-08T16:58:00.000Z', lastPrice: 105}});
  assert.deepEqual(tableLines(sectionFourTableText(allLive)).slice(-2),
    ['NVIDIA (NVDA) | $105.00 | — 0.00 (0.00%)', 'Live prices at 12:58 pm ET.']);
  // An overlay outside REGULAR is never used (that is Step 21F.2).
  assert.equal(sectionFourRowPrice(input.marketPackages[0].telemetry.stockSnapshots[0].snapshot, 'POST').basis, 'CLOSE');
});

test('Step 9AA: a stock with no usable price keeps its row as Not available; an empty group is left out', () => {
  const input = tableInput({myStocks: ['NVDA', 'CPRI'], watchlist: [], missing: ['CPRI']});
  assert.deepEqual(tableLines(sectionFourTableText(input)), [
    'Stock | Price | Change', 'My Stocks', 'NVIDIA (NVDA) | $105.00 | ↑ 3.00 (2.94%)',
    'CPRI | Not available | Not available', 'Prices at the close on Fri 4 Sep.']);
  const watchOnly = tableInput({myStocks: [], watchlist: ['AAPL']});
  assert.deepEqual(tableLines(sectionFourTableText(watchOnly)).slice(0, 2), ['Stock | Price | Change', 'Watchlist']);
});

test('Step 9AA: the writer is told the table exists and to explain only the stocks with articles', () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL'], linked: ['NVDA', 'AAPL']});
  const allowlist = projectClaudeAnalysisInput(input).sectionFourReferenceAllowlist;
  assert.deepEqual(allowlist.newsStocks, ['NVDA', 'AAPL']);
  const request = buildClaudeAnalysisRequest(input);
  assert.match(request.system, /MarketBrief adds the price table itself/);
  assert.match(request.system, /Do not restate the stock's price, change or percent; the table has them\./);
  assert.match(request.system, /Stocks with a linked news article \(explain only these, in this order\): \["NVDA","AAPL"\]\./);
  assert.doesNotMatch(request.system, /On your Watchlist,/);
  assert.doesNotMatch(request.system, /Cover the stocks in this order/);
  assert.doesNotMatch(request.system, /never leave Section 4 empty because articles are missing/);
  const modelInput = JSON.parse(request.messages[0].content);
  assert.match(modelInput.outputRequirements.sections[3].purpose, /MarketBrief adds a price table/);
  // The canonical outputRequirements (checked by the page) are unchanged.
  assert.doesNotMatch(input.outputRequirements.sections[3].purpose, /price table/);
});

test('Step 9AA: no stock with news gives the table and "No material news for all stocks."', async () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL']});
  const output = outputWithSectionFour(input,
    'NVIDIA gained $3.00 (2.9%) to $105.00. Microsoft gained $3.00 (2.9%) to $105.00. On your Watchlist, Apple gained $3.00 (2.9%) to $105.00.',
    ['NVDA', 'MSFT', 'AAPL']);
  const {result, calls, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(calls, 1);
  assert.equal(result.output.status, 'NORMAL');
  const content = result.output.sections[3].content;
  assert.deepEqual(content.split('\n\n').slice(1), ['No material news for all stocks.']);
  assert.equal(tableLines(content).length, 7);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  const line = diagnostics.find(value => value.stage === 'sectionFourTable');
  assert.deepEqual(line, {stage: 'sectionFourTable', marketState: 'CLOSED', rows: 3, myStocksRows: 2,
    watchlistRows: 1, notAvailableRows: 0, closeFallbackRows: 0, newsStocks: 0, explainedStocks: 0,
    closingLine: 'ALL'});
});

test('Step 9AA: some stocks with news keep their reason; an AI price sentence and a reason without its own article go', async () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL', 'META'], linked: ['NVDA', 'AAPL']});
  const content = 'NVIDIA gained $3.00 (2.9%) to $105.00 after its chip deal with a cloud firm, Yahoo Finance reported. '
    + 'Microsoft gained $9.99 (9.9%) to $999.99 as software rallied. '
    + 'Apple gained $3.00 (2.9%) to $105.00. '
    + 'Meta Platforms rose on hopes for its new glasses.';
  const output = outputWithSectionFour(input, content, ['NVDA', 'MSFT', 'AAPL', 'META']);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  const parts = result.output.sections[3].content.split('\n\n');
  assert.equal(parts.length, 3);
  assert.equal(parts[1], 'NVIDIA gained $3.00 (2.9%) to $105.00 after its chip deal with a cloud firm, Yahoo Finance reported.');
  assert.equal(parts[2], 'No material news for the other stocks.');
  // The table figures come from the data, not from the writer's $9.99 / $999.99.
  assert.ok(tableLines(parts[0]).includes('Microsoft (MSFT) | $105.00 | ↑ 3.00 (2.94%)'));
  assert.doesNotMatch(result.output.sections[3].content, /999/);
  // Refs: the writer's cited refs as cited (21D.1), then the rows' own refs.
  assert.deepEqual(result.output.sections[3].evidenceRefs.slice(0, output.sections[3].evidenceRefs.length),
    output.sections[3].evidenceRefs);
  const line = diagnostics.find(value => value.stage === 'sectionFourTable');
  assert.equal(line.newsStocks, 2);
  assert.equal(line.explainedStocks, 1);
  assert.equal(line.closingLine, 'OTHERS');
});

test('Step 9AA: every stock explained gives no closing line; a two-stock sentence and a carried-on sentence stay together', async () => {
  const input = tableInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA', 'AMD']});
  const content = 'NVIDIA and Advanced Micro Devices both rose after a joint chip order, Yahoo Finance reported. '
    + 'The order runs for three years.';
  const output = outputWithSectionFour(input, content, ['NVDA', 'AMD']);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  const parts = result.output.sections[3].content.split('\n\n');
  assert.deepEqual(parts.slice(1), [content]);
  assert.equal(diagnostics.find(value => value.stage === 'sectionFourTable').closingLine, 'NONE');
});

test('Step 9AA: a writer Section 4 left null (as told) still gets the table and no gap', async () => {
  const input = tableInput({myStocks: ['NVDA'], watchlist: ['AAPL']});
  const output = outputWithSectionFour(input, null, [], {evidenceRefs: [], telemetryRefs: []});
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  assert.deepEqual(result.output.evidenceGaps, []);
  assert.match(result.output.sections[3].content, /No material news for all stocks\.$/);
  assert.deepEqual(result.output.sections[3].uncertainties, []);
});

test('Step 9AA: a Section 4 the cleanup empties keeps the table, and its gap is taken back', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AAPL']});
  const output = outputWithSectionFour(input, 'Investors rotated into healthcare.', ['MSFT', 'AAPL']);
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  assert.ok(!result.output.evidenceGaps.includes('Not enough data to comment on your stocks.'));
  assert.match(result.output.sections[3].content, /^Stock \| Price \| Change\n/);
  assert.match(result.output.sections[3].content, /\n\nNo material news for all stocks\.$/);
});

test('Step 9AA: a bad explanation loses the explanations, never the table', async () => {
  const input = tableInput({myStocks: ['NVDA'], watchlist: ['AAPL'], linked: ['NVDA']});
  const output = outputWithSectionFour(input,
    'NVIDIA rose after evidenceContext.broadMarketFocus showed a chip deal, Yahoo Finance reported.', ['NVDA']);
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  const content = result.output.sections[3].content;
  assert.match(content, /^Stock \| Price \| Change\n/);
  assert.doesNotMatch(content, /evidenceContext/);
  assert.match(content, /\n\nNo material news for all stocks\.$/);
});

test('Step 9AA: the table and its note are not counted toward the report word cap', () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL']});
  const table = sectionFourTableText(input);
  const words = table.split(/\s+/).length;
  assert.equal(sectionFourTableWordCount(`${table}\n\nNo material news for all stocks.`), words);
  assert.equal(sectionFourTableWordCount('NVIDIA rose.'), 0);
  const output = supportedOutput(input);
  output.sections[3] = {...output.sections[3], content: `${table}\n\nNo material news for all stocks.`};
  const others = output.sections.flatMap(section => [section.content || '', ...section.uncertainties])
    .concat(output.evidenceGaps).join(' ').trim().split(/\s+/).length - words;
  // Pad Section 5 so the report is exactly at the cap without the table, and over it with the table.
  const pad = 2500 - others;
  output.sections[4] = {...output.sections[4], content: `${output.sections[4].content} ${'word '.repeat(pad).trim()}`};
  assert.equal(SECTION_RULES.REPORT_WORD_CAP.detect(output), false);
  return withSectionFourTableSwitch('off', () => assert.equal(SECTION_RULES.REPORT_WORD_CAP.detect(output), true));
});

test('Step 9AA: both lists empty keeps the exact statement and no table', async () => {
  const input = tableInput({});
  const output = outputWithSectionFour(input, SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT, []);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.sections[3].content, 'No securities are configured in My Stocks or the Watchlist.');
  assert.equal(diagnostics.some(value => value.stage === 'sectionFourTable'), false);
});

test('Step 9AA: the same table code runs in all six market states', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    let input;
    let output;
    if (overlayAsOf) {
      const quote = createEvidenceItem({sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
        title: 'Microsoft quote', summary: 'Microsoft quote.', canonicalUrl: 'https://finance.yahoo.com/quote/MSFT/',
        publishedAt: '2026-09-08T11:00:00.000Z', symbols: ['MSFT']});
      input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, additionalItems: [quote],
        stockSnapshots: [stockSnapshot('MSFT', marketState, marketState === 'REGULAR'
          ? {overlay: {asOf: overlayAsOf, lastPrice: 106}} : {})],
        portfolioContext: {myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'],
          evidenceRefs: ['e1', 'e3'], upcomingEvents: []}], watchlist: []}});
      output = normalOutput(input, {furtherReadings: ['e1']});
      output.sections[3] = {...output.sections[3],
        content: 'Microsoft rose after it raised its outlook, Yahoo Finance reported.',
        evidenceRefs: ['e1', 'e3'], telemetryRefs: ['t2'], uncertainties: []};
    } else {
      input = tableInput({myStocks: ['MSFT'], linked: ['MSFT'], marketState});
      output = outputWithSectionFour(input, 'Microsoft rose after its company news, Yahoo Finance reported.', ['MSFT']);
    }
    const {result, diagnostics} = await invokeCounted(input, output);
    assert.equal(result.type, 'SUCCESS', `${marketState} ${result.message}`);
    const lines = tableLines(result.output.sections[3].content);
    const live = marketState === 'REGULAR';
    assert.deepEqual(lines.slice(0, 3), ['Stock | Price | Change', 'My Stocks',
      `Microsoft (MSFT) | $${live ? '106.00' : '105.00'} | ↑ ${live ? '1.00 (0.95%)' : '3.00 (2.94%)'}`], marketState);
    assert.equal(lines[3], live ? 'Live prices at 10:55 am ET.' : 'Prices at the close on Fri 4 Sep.', marketState);
    assert.equal(result.output.sections[3].content.split('\n\n').length, 2, marketState);
    assert.equal(diagnostics.filter(value => value.stage === 'sectionFourTable').length, 1, marketState);
  }
});

// Step 9AA Build 1 fix (independent proof): the three "no price data" shapes, through the real
// pipeline. SOME and NONE missing already match Decisions 5 and 11. ALL missing (and no stock has
// a surviving news citation either) still loses the table today: composeSectionFour's table has no
// evidenceRef of its own to offer, and lib/claude-analysis-contract.js CONTENT_NEEDS_EVIDENCE (rule
// 8) requires evidenceRefs.length > 0 for ANY non-null section content, with no carve-out for a
// code-built table grounded in telemetryRefs instead. That file is out of scope for this step and
// no reference may be invented, so this one case is left as today's fallback (Section 4 emptied,
// the pre-9AA gap message) and reported to Kevin rather than silently patched around.
test('Step 9AA Build 1 fix: some stocks missing a price keep their row as Not available; the table survives', async () => {
  const input = tableInput({myStocks: ['NVDA', 'CPRI'], watchlist: [], missing: ['CPRI']});
  const output = outputWithSectionFour(input, null, [], {evidenceRefs: [], telemetryRefs: []});
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(tableLines(result.output.sections[3].content), [
    'Stock | Price | Change', 'My Stocks', 'NVIDIA (NVDA) | $105.00 | ↑ 3.00 (2.94%)',
    'CPRI | Not available | Not available', 'Prices at the close on Fri 4 Sep.']);
  const line = diagnostics.find(value => value.stage === 'sectionFourTable');
  assert.equal(line.notAvailableRows, 1);
  assert.equal(line.rows, 2);
});

test('Step 9AA Build 1 fix: no stock missing a price keeps every row priced; the table survives', async () => {
  const input = tableInput({myStocks: ['NVDA', 'CPRI'], watchlist: []});
  const output = outputWithSectionFour(input, null, [], {evidenceRefs: [], telemetryRefs: []});
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(tableLines(result.output.sections[3].content), [
    'Stock | Price | Change', 'My Stocks', 'NVIDIA (NVDA) | $105.00 | ↑ 3.00 (2.94%)',
    'Capri Holdings (CPRI) | $105.00 | ↑ 3.00 (2.94%)', 'Prices at the close on Fri 4 Sep.']);
  assert.equal(diagnostics.find(value => value.stage === 'sectionFourTable').notAvailableRows, 0);
});

test('Step 9AA Build 1 fix: KNOWN GAP (reported to Kevin, not patched) - every stock missing a '
  + 'price with no surviving citation still loses the table', async () => {
  const input = tableInput({myStocks: ['NVDA', 'CPRI'], watchlist: [], missing: ['NVDA', 'CPRI']});
  const output = outputWithSectionFour(input, null, [], {evidenceRefs: [], telemetryRefs: []});
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  // Today's fallback: Section 4 stays empty and the report is DEGRADED by the gap message.
  // Decision 5/11 are not met here; lib/claude-analysis-contract.js CONTENT_NEEDS_EVIDENCE blocks
  // the only alternative (non-null content with zero evidenceRefs) and is out of scope to change.
  assert.equal(result.output.sections[3].content, null);
  assert.equal(diagnostics.some(value => value.stage === 'sectionFourTable'), false);
  assert.ok(result.output.evidenceGaps.length > 0);
});

test('Step 9AA Build 1 fix: a report over the word cap from ONE long section still keeps the '
  + 'table, and the table and note stay out of the word count', async () => {
  const input = tableInput({myStocks: ['NVDA'], watchlist: []});
  const output = outputWithSectionFour(input, null, [], {evidenceRefs: [], telemetryRefs: []});
  output.sections[4] = {...output.sections[4],
    content: `${output.sections[4].content} ${'word '.repeat(2600).trim()}`};
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.match(result.output.sections[3].content, /^Stock \| Price \| Change\n/);
  assert.equal(SECTION_RULES.REPORT_WORD_CAP.detect(result.output), false);
});

test('Step 9AA: switch off (or the both-lists switch off) leaves Section 4 as the writer and cleanup left it', async () => {
  for (const [envVar, run] of [['table', withSectionFourTableSwitch], ['both lists', withSectionFourSwitch]]) {
    await run('off', async () => {
      const input = tableInput({myStocks: ['NVDA'], watchlist: ['AAPL'], linked: ['NVDA']});
      const content = 'NVIDIA gained $3.00 (2.9%) to $105.00 after its company news. Apple gained $3.00 (2.9%) to $105.00.';
      const output = outputWithSectionFour(input, content, ['NVDA', 'AAPL']);
      const {result, diagnostics} = await invokeCounted(input, output);
      assert.equal(result.type, 'SUCCESS', result.message);
      assert.equal(result.output.sections[3].content.includes('Stock | Price | Change'), false, envVar);
      assert.equal(diagnostics.some(value => value.stage === 'sectionFourTable'), false, envVar);
      assert.equal(buildClaudeAnalysisRequest(input).system.includes('MarketBrief adds the price table itself'), false);
    });
  }
});

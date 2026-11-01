// Step 9AA.3: the Section 4 table reads Stock | Ticker | Last Price | Change (the short name
// alone, "Not available" when Yahoo gave no name), and in Trading with no live price yet the
// note says "* No live prices yet; last close on <date>." No switch. Also the gaps left from the
// 9AA Build 1 + 9AA.2 proof: closing lines (singular and plural, down to one ticker), the note
// date, rounding and group order. Every rule is checked with one ticker as well as several.
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  REPORT_SECTION_NAMES,
  SECTION_RULES
} = require('../lib/claude-analysis-contract');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {
  formatSectionFourPrice,
  formatSectionFourChange,
  sectionFourTableText,
  sectionFourTableWordCount,
  isSectionFourTableOnly,
  SECTION_FOUR_TABLE_HEADER
} = require('../lib/section-rules');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {invokeCounted, activeUsInput, normalOutput, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');
const {withEnv} = require('./fixtures/step-8w-switches');

// Each test sets the three Section 4 switches itself (on unless it says otherwise).
const test = (name, fn) => nodeTest(name, () => withEnv('SECTION_FOUR_BOTH_LISTS_ENABLED', 'on', () =>
  withEnv('SECTION_FOUR_TABLE_ENABLED', 'on', () => withEnv('SECTION_FOUR_PRICE_RECORD_ENABLED', 'on', fn))));

const HEADER = 'Stock | Ticker | Last Price | Change';
const NAMES = {
  NVDA: 'NVIDIA Corporation', MSFT: 'Microsoft Corporation', CPRI: 'Capri Holdings Limited',
  AAPL: 'Apple Inc.', AMD: 'Advanced Micro Devices, Inc.', META: 'Meta Platforms, Inc.', NVO: 'Novo Nordisk A/S'
};
const SAME_MOVE = '$105.00 | ↑ 3.00 (2.94%)';

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function stockSnapshot(symbol, marketState, {close = 105, previousClose = 102, currency = 'USD',
  name = NAMES[symbol], overlay = null} = {}) {
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

// A completed-day input (close Fri 4 Sep) with a quote line per priced stock, a linked Yahoo
// article for each symbol in `linked`, and no snapshot for a symbol in `missing` (its row is
// Not available; it keeps a market-data item so the table has a ref to cite).
function tableInput({myStocks = [], watchlist = [], linked = [], marketState = 'CLOSED', prices = {},
  missing = [], initiatingList = 'myStocks'} = {}) {
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
    evidence.push(item('us.yahoo-finance', `${NAMES[symbol] || symbol} quote`,
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
    evidenceRefs: [marketDataRef[symbol]].concat(newsRef[symbol] ? [newsRef[symbol]] : []),
    upcomingEvents: []
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList, generatedAt: '2026-09-06T10:00:00.000Z',
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

function outputWithSectionFour(input, content) {
  const output = supportedOutput(input);
  const all = input.portfolioContext.myStocks.concat(input.portfolioContext.watchlist);
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content,
    evidenceRefs: content === null ? [] : [...new Set(all.flatMap(security => security.evidenceRefs))],
    telemetryRefs: content === null ? [] : [...new Set(all.flatMap(security => security.telemetryRefs))],
    uncertainties: []};
  return output;
}

const tableLines = content => content.split('\n\n')[0].split('\n');

// A copy of a completed-day input in another market state (and package date), with optional
// live overlays ({symbol: {asOf, lastPrice, validationState}}), for the table helpers alone.
function inState(input, marketState, overlays = {}, {packageDate} = {}) {
  const copy = structuredClone(input);
  copy.marketPackages[0].marketContext.marketState = marketState;
  if (packageDate !== undefined) copy.marketPackages[0].marketContext.primaryCompletedSessionDate = packageDate;
  for (const entry of copy.marketPackages[0].telemetry.stockSnapshots) {
    const overlay = overlays[entry.snapshot.symbol];
    const close = entry.snapshot.completedSessions.at(-1).close;
    entry.snapshot.currentOverlay = overlay ? {marketState, sessionDate: '2026-09-08', asOf: overlay.asOf,
      lastPrice: overlay.lastPrice, referenceClose: close, absoluteChange: overlay.lastPrice - close,
      percentChange: (overlay.lastPrice - close) / close * 100, volume: 5000, isFinal: false,
      sourceId: 'us.yahoo-finance', validationState: overlay.validationState || 'VALIDATED'} : null;
  }
  return copy;
}

async function run(input, content = null) {
  const {result, diagnostics} = await invokeCounted(input, outputWithSectionFour(input, content));
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  const section = result.output.sections[3];
  return {result, section, parts: section.content.split('\n\n'),
    line: diagnostics.find(value => value.stage === 'sectionFourTable')};
}

// An active-day input (PRE, REGULAR, POST) with one stock, MSFT, and its quote line; in REGULAR a
// validated live overlay when `live`.
function activeMsftInput(marketState, generatedAt, overlayAsOf, currentPublishedAt, live) {
  const quote = createEvidenceItem({sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
    title: 'Microsoft quote', summary: 'Microsoft quote.', canonicalUrl: 'https://finance.yahoo.com/quote/MSFT/',
    publishedAt: '2026-09-08T11:00:00.000Z', symbols: ['MSFT']});
  return activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, additionalItems: [quote],
    stockSnapshots: [stockSnapshot('MSFT', marketState, live ? {overlay: {asOf: overlayAsOf, lastPrice: 106}} : {})],
    portfolioContext: {myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'],
      evidenceRefs: ['e3'], upcomingEvents: []}], watchlist: []}});
}

const reason = symbol => `${NAMES[symbol].replace(/,? (Corporation|Inc\.|Limited)$/, '')} rose after its company news, Yahoo Finance reported.`;

// --- 1. Columns ---------------------------------------------------------------------------

test('Step 9AA.3: the header is Stock | Ticker | Last Price | Change; the name and the ticker have their own cells', () => {
  assert.equal(SECTION_FOUR_TABLE_HEADER, HEADER);
  const input = tableInput({myStocks: ['NVDA', 'CPRI'], watchlist: ['NVO'],
    prices: {NVO: {currency: 'EUR', close: 88.1, previousClose: 90}}});
  assert.deepEqual(tableLines(sectionFourTableText(input)), [HEADER, 'My Stocks',
    `NVIDIA | NVDA | ${SAME_MOVE}`, `Capri Holdings | CPRI | ${SAME_MOVE}`, 'Watchlist',
    'Novo Nordisk | NVO | EUR 88.10 | ↓ 1.90 (2.11%)', 'Prices at the close on Fri 4 Sep.']);
  assert.doesNotMatch(sectionFourTableText(input), /\([A-Z]{1,5}\)/);
  for (const row of tableLines(sectionFourTableText(input)).filter(text => text.includes(' | '))) {
    assert.equal(row.split(' | ').length, 4, row);
  }
});

test('Step 9AA.3: no company name reads Not available in the Stock cell; the ticker cell keeps the ticker', () => {
  const noName = inState(tableInput({myStocks: ['AAPL']}), 'CLOSED');
  noName.marketPackages[0].telemetry.stockSnapshots[0].snapshot.instrumentName = '';
  assert.deepEqual(tableLines(sectionFourTableText(noName)).slice(0, 3),
    [HEADER, 'My Stocks', `Not available | AAPL | ${SAME_MOVE}`]);
  const blank = tableInput({myStocks: ['NVDA'], missing: ['NVDA']});
  assert.deepEqual(tableLines(sectionFourTableText(blank)),
    [HEADER, 'My Stocks', 'Not available | NVDA | Not available | Not available', 'Prices not available.']);
});

// --- 2. One ticker in each of the six states ----------------------------------------------

test('Step 9AA.3: one ticker in all six market states gives four columns, its note, one closing line and the log line', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    for (const liveOverlay of marketState === 'REGULAR' ? [true, false] : [Boolean(overlayAsOf)]) {
      const input = overlayAsOf
        ? activeMsftInput(marketState, generatedAt, overlayAsOf, currentPublishedAt, marketState === 'REGULAR' && liveOverlay)
        : tableInput({myStocks: ['MSFT'], marketState});
      const output = overlayAsOf ? normalOutput(input, {furtherReadings: ['e1']}) : outputWithSectionFour(input, null);
      output.sections[3] = {...output.sections[3], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []};
      const {result, diagnostics} = await invokeCounted(input, output);
      const label = `${marketState}${liveOverlay ? ' live' : ''}`;
      assert.equal(result.type, 'SUCCESS', `${label} ${result.message}`);
      const parts = result.output.sections[3].content.split('\n\n');
      const lines = parts[0].split('\n');
      assert.deepEqual(lines.slice(0, 2), [HEADER, 'My Stocks'], label);
      assert.equal(lines.length, 4, label);
      assert.match(lines[2], /^Microsoft \| MSFT \| \$\d+\.\d\d\*? \| [↑↓—] \d+\.\d\d \(\d+\.\d\d%\)$/, label);
      if (marketState === 'REGULAR' && liveOverlay) {
        assert.equal(lines[2], 'Microsoft | MSFT | $106.00 | ↑ 1.00 (0.95%)', label);
        assert.match(lines[3], /^Live prices at \d{1,2}:\d\d [ap]m ET\.$/, label);
      } else if (marketState === 'REGULAR') {
        assert.ok(lines[2].includes('$105.00*'), label);
        assert.match(lines[3], /^\* No live prices yet; last close on \w{3} \d{1,2} \w{3}\.$/, label);
      } else {
        assert.equal(lines[2], `Microsoft | MSFT | ${SAME_MOVE}`, label);
        assert.match(lines[3], /^Prices at the close on \w{3} \d{1,2} \w{3}\.$/, label);
      }
      assert.deepEqual(parts.slice(1), ['No material news for this stock.'], label);
      const line = diagnostics.find(value => value.stage === 'sectionFourTable');
      assert.equal(line.rows, 1, label);
      assert.equal(line.closingLine, 'THIS', label);
      assert.equal(line.closeFallbackRows, marketState === 'REGULAR' && !liveOverlay ? 1 : 0, label);
    }
  }
});

// --- 3. Closing lines ---------------------------------------------------------------------

test('Step 9AA.3: closing lines from one ticker to three, singular and plural', async () => {
  const cases = [
    // [stocks, explained, closing line, log value]
    [['NVDA'], [], 'No material news for this stock.', 'THIS'],
    [['NVDA'], ['NVDA'], null, 'NONE'],
    [['NVDA', 'AMD'], ['NVDA'], 'No material news for the other stock.', 'OTHER'],
    [['NVDA', 'AMD'], [], 'No material news for all stocks.', 'ALL'],
    [['NVDA', 'AMD', 'MSFT'], ['NVDA'], 'No material news for the other stocks.', 'OTHERS'],
    [['NVDA', 'AMD', 'MSFT'], ['NVDA', 'MSFT'], 'No material news for the other stock.', 'OTHER'],
    [['NVDA', 'AMD', 'MSFT'], ['NVDA', 'AMD', 'MSFT'], null, 'NONE']
  ];
  for (const [stocks, explained, closing, value] of cases) {
    const label = `${stocks.length} stocks, ${explained.length} explained`;
    const input = tableInput({myStocks: stocks.slice(0, 1), watchlist: stocks.slice(1), linked: explained});
    const content = explained.length ? explained.map(reason).join(' ') : null;
    const {parts, line} = await run(input, content);
    assert.equal(parts[0].split('\n')[0], HEADER, label);
    assert.equal(parts.at(-1), closing ?? parts.at(-1), label);
    if (closing === null) assert.ok(!parts.at(-1).startsWith('No material news'), label);
    assert.equal(parts.length, 1 + (explained.length ? 1 : 0) + (closing ? 1 : 0), label);
    assert.equal(line.closingLine, value, label);
    assert.equal(line.explainedStocks, explained.length, label);
  }
});

test('Step 9AA.3: with price records off one ticker keeps the plural "all stocks" line', async () => {
  await withEnv('SECTION_FOUR_PRICE_RECORD_ENABLED', 'off', async () => {
    const {parts, line} = await run(tableInput({myStocks: ['NVDA']}));
    assert.equal(parts[0].split('\n')[0], HEADER);
    assert.equal(parts.at(-1), 'No material news for all stocks.');
    assert.equal(line.closingLine, 'ALL');
  });
});

// --- 4. Note date -------------------------------------------------------------------------

test('Step 9AA.3: the close note names the package date (single and double digits, month and year ends)', () => {
  const input = tableInput({myStocks: ['NVDA']});
  for (const [packageDate, note] of [
    ['2026-10-02', 'Prices at the close on Fri 2 Oct.'],
    ['2026-10-23', 'Prices at the close on Fri 23 Oct.'],
    ['2026-09-30', 'Prices at the close on Wed 30 Sep.'],
    ['2026-12-31', 'Prices at the close on Thu 31 Dec.'],
    ['2027-01-04', 'Prices at the close on Mon 4 Jan.'],
    ['2026-9-4', 'Prices at the latest close.'],
    ['', 'Prices at the latest close.'],
    [null, 'Prices at the latest close.']
  ]) {
    assert.equal(tableLines(sectionFourTableText(inState(input, 'CLOSED', {}, {packageDate}))).at(-1), note, String(packageDate));
  }
  // Weekend and Holiday (Labor Day, Mon 7 Sep 2026) show the last completed session, Fri 4 Sep.
  for (const marketState of ['WEEKEND', 'HOLIDAY', 'PRE', 'POST']) {
    assert.equal(tableLines(sectionFourTableText(inState(input, marketState))).at(-1),
      'Prices at the close on Fri 4 Sep.', marketState);
  }
});

test('Step 9AA.3: the live note gives the newest live time in ET (am, noon, pm)', () => {
  const input = tableInput({myStocks: ['NVDA'], watchlist: ['MSFT']});
  for (const [asOf, time] of [['2026-09-08T13:35:00.000Z', '9:35 am'], ['2026-09-08T16:00:00.000Z', '12:00 pm'],
    ['2026-09-08T19:59:00.000Z', '3:59 pm']]) {
    const live = inState(input, 'REGULAR', {NVDA: {asOf, lastPrice: 105}, MSFT: {asOf, lastPrice: 105}});
    assert.equal(tableLines(sectionFourTableText(live)).at(-1), `Live prices at ${time} ET.`);
  }
  const mixed = inState(input, 'REGULAR', {NVDA: {asOf: '2026-09-08T14:00:00.000Z', lastPrice: 105},
    MSFT: {asOf: '2026-09-08T15:10:00.000Z', lastPrice: 105}});
  assert.equal(tableLines(sectionFourTableText(mixed)).at(-1), 'Live prices at 11:10 am ET.');
});

// --- 5. Trading with no live price --------------------------------------------------------

test('Step 9AA.3: Trading with no live price marks every price * and the note says why (one and three tickers)', () => {
  const one = inState(tableInput({myStocks: ['NVDA']}), 'REGULAR');
  assert.deepEqual(tableLines(sectionFourTableText(one)), [HEADER, 'My Stocks',
    'NVIDIA | NVDA | $105.00* | ↑ 3.00 (2.94%)', '* No live prices yet; last close on Fri 4 Sep.']);
  const three = inState(tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL']}), 'REGULAR');
  assert.deepEqual(tableLines(sectionFourTableText(three)), [HEADER, 'My Stocks',
    'NVIDIA | NVDA | $105.00* | ↑ 3.00 (2.94%)', 'Microsoft | MSFT | $105.00* | ↑ 3.00 (2.94%)', 'Watchlist',
    'Apple | AAPL | $105.00* | ↑ 3.00 (2.94%)', '* No live prices yet; last close on Fri 4 Sep.']);
  // A blank row has no * and does not change the note.
  const withBlank = inState(tableInput({myStocks: ['NVDA', 'CPRI'], missing: ['CPRI']}), 'REGULAR');
  assert.deepEqual(tableLines(sectionFourTableText(withBlank)).slice(2), ['NVIDIA | NVDA | $105.00* | ↑ 3.00 (2.94%)',
    'Not available | CPRI | Not available | Not available', '* No live prices yet; last close on Fri 4 Sep.']);
  // No valid package date: the note never invents one.
  assert.equal(tableLines(sectionFourTableText(inState(tableInput({myStocks: ['NVDA']}), 'REGULAR', {},
    {packageDate: 'not a date'}))).at(-1), '* No live prices yet; last close.');
});

test('Step 9AA.3: an unvalidated overlay is not a live price; some live keeps the live note', () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT']});
  const pending = inState(input, 'REGULAR', {NVDA: {asOf: '2026-09-08T16:58:00.000Z', lastPrice: 107,
    validationState: 'PENDING'}});
  assert.equal(tableLines(sectionFourTableText(pending)).at(-1), '* No live prices yet; last close on Fri 4 Sep.');
  const some = inState(input, 'REGULAR', {NVDA: {asOf: '2026-09-08T16:58:00.000Z', lastPrice: 107}});
  assert.deepEqual(tableLines(sectionFourTableText(some)).slice(2), ['NVIDIA | NVDA | $107.00 | ↑ 2.00 (1.90%)',
    'Microsoft | MSFT | $105.00* | ↑ 3.00 (2.94%)', 'Live prices at 12:58 pm ET; * last close.']);
});

test('Step 9AA.3: Trading with every row blank keeps "Prices not available." (records on) or the close note (records off)', () => {
  const input = inState(tableInput({myStocks: ['NVDA', 'MSFT'], missing: ['NVDA', 'MSFT']}), 'REGULAR');
  assert.equal(tableLines(sectionFourTableText(input)).at(-1), 'Prices not available.');
  withEnv('SECTION_FOUR_PRICE_RECORD_ENABLED', 'off', () => {
    const lines = tableLines(sectionFourTableText(input));
    assert.equal(lines.at(-1), 'Prices at the close on Fri 4 Sep.');
    assert.ok(!lines.some(text => text.includes('*')));
  });
});

// --- 6. Rounding --------------------------------------------------------------------------

test('Step 9AA.3: rounding to 2 decimals with grouping, as in the report header', () => {
  assert.equal(formatSectionFourPrice(15.935, 'USD'), '$15.94');
  assert.equal(formatSectionFourPrice(999.995, 'USD'), '$1,000.00');
  assert.equal(formatSectionFourPrice(1234567.891, 'USD'), '$1,234,567.89');
  assert.equal(formatSectionFourPrice(0.004, 'USD'), '$0.00');
  assert.equal(formatSectionFourChange(1.005, 1.005), '↑ 1.01 (1.01%)');
  assert.equal(formatSectionFourChange(0.195, 0.195), '↑ 0.20 (0.20%)');
  assert.equal(formatSectionFourChange(-1234.567, -12.3456), '↓ 1,234.57 (12.35%)');
  // The arrow follows the unrounded change, as the report header does.
  assert.equal(formatSectionFourChange(-0.004, -0.003), '↓ 0.00 (0.00%)');
  assert.equal(formatSectionFourChange(0, 0), '— 0.00 (0.00%)');
  for (const text of [formatSectionFourChange(-0.49, -2.99), formatSectionFourChange(-0.004, -0.003),
    formatSectionFourPrice(644.335, 'USD')]) {
    assert.doesNotMatch(text, /-|\d\.\d{3}/);
  }
  const input = tableInput({myStocks: ['NVDA'], prices: {NVDA: {close: 15.869999885559082, previousClose: 16.36}}});
  assert.equal(tableLines(sectionFourTableText(input))[2], 'NVIDIA | NVDA | $15.87 | ↓ 0.49 (3.00%)');
});

// --- 7. Group order -----------------------------------------------------------------------

test('Step 9AA.3: My Stocks comes before the Watchlist, in saved order, even when the brief starts from the Watchlist', () => {
  const input = tableInput({myStocks: ['MSFT', 'AMD'], watchlist: ['META', 'AAPL'], initiatingList: 'watchlist'});
  assert.deepEqual(tableLines(sectionFourTableText(input)), [HEADER, 'My Stocks',
    `Microsoft | MSFT | ${SAME_MOVE}`, `Advanced Micro Devices | AMD | ${SAME_MOVE}`, 'Watchlist',
    `Meta Platforms | META | ${SAME_MOVE}`, `Apple | AAPL | ${SAME_MOVE}`, 'Prices at the close on Fri 4 Sep.']);
});

test('Step 9AA.3: a stock in both lists shows once under My Stocks; one list with one ticker shows only that group', () => {
  const both = tableInput({myStocks: ['NVDA'], watchlist: ['NVDA', 'AAPL']});
  assert.deepEqual(tableLines(sectionFourTableText(both)), [HEADER, 'My Stocks', `NVIDIA | NVDA | ${SAME_MOVE}`,
    'Watchlist', `Apple | AAPL | ${SAME_MOVE}`, 'Prices at the close on Fri 4 Sep.']);
  const watchOnly = tableInput({watchlist: ['AAPL'], initiatingList: 'watchlist'});
  assert.deepEqual(tableLines(sectionFourTableText(watchOnly)), [HEADER, 'Watchlist', `Apple | AAPL | ${SAME_MOVE}`,
    'Prices at the close on Fri 4 Sep.']);
  const myOnly = tableInput({myStocks: ['AAPL']});
  assert.deepEqual(tableLines(sectionFourTableText(myOnly)).slice(0, 2), [HEADER, 'My Stocks']);
});

// --- 8. Word cap and readers --------------------------------------------------------------

test('Step 9AA.3: the new table and the no-live note stay out of the word cap and are read back', () => {
  for (const input of [tableInput({myStocks: ['NVDA']}), inState(tableInput({myStocks: ['NVDA', 'MSFT']}), 'REGULAR')]) {
    const table = sectionFourTableText(input);
    const words = table.split(/\s+/).length;
    assert.equal(sectionFourTableWordCount(`${table}\n\nNo material news for this stock.`), words);
    assert.equal(isSectionFourTableOnly(`${table}\n\nNo material news for this stock.`), true);
    assert.equal(isSectionFourTableOnly(`${table}\n\nNo material news for all stocks.`), true);
    assert.equal(isSectionFourTableOnly(`${table}\n\nNVIDIA rose.\n\nNo material news for all stocks.`), false);
  }
  // The old header is no longer a table.
  assert.equal(sectionFourTableWordCount('Stock | Price | Change\nMy Stocks\nNVIDIA (NVDA) | $1.00 | ↑ 1.00 (1.00%)\n'
    + 'Prices at the close on Fri 4 Sep.'), 0);
});

test('Step 9AA.3: a Trading report over the cap from one long section keeps the table with the no-live note', async () => {
  const [, generatedAt, overlayAsOf, currentPublishedAt] = MARKET_STATE_CASES.find(([state]) => state === 'REGULAR');
  const input = activeMsftInput('REGULAR', generatedAt, overlayAsOf, currentPublishedAt, false);
  const output = normalOutput(input, {furtherReadings: ['e1']});
  output.sections[3] = {...output.sections[3], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []};
  output.sections[4] = {...output.sections[4], content: `${output.sections[4].content} ${'word '.repeat(2600).trim()}`};
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  const lines = tableLines(result.output.sections[3].content);
  assert.equal(lines[0], HEADER);
  assert.equal(lines.at(-1), '* No live prices yet; last close on Fri 4 Sep.');
  assert.equal(SECTION_RULES.REPORT_WORD_CAP.detect(result.output), false);
  assert.equal(diagnostics.find(value => value.stage === 'sectionFourTable').closeFallbackRows, 1);
});

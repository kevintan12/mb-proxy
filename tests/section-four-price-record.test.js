// Step 9AA.2: every My Stocks / Watchlist stock with no Yahoo quote line has a price record in
// the package (the price its Section 4 row shows, or "no price available"), so the code-built
// table always has a real reference to cite, with one ticker as with seventeen. The writer never
// sees a record. Singular closing lines, and "Prices not available." when every row is blank.
// Behind the Admin switch sectionFourPriceRecordEnabled (default on, and only while
// sectionFourTableEnabled is on). The package side is tested in
// tests/us-analysis-package-orchestration.test.js ("Step 9AA.2: ...").
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  REPORT_SECTION_NAMES
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
  sectionFourPriceRecordOn,
  sectionFourPriceRecordFields,
  isSectionFourPriceRecord,
  SECTION_FOUR_PRICE_RECORD_TAG,
  SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT
} = require('../lib/section-rules');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {invokeCounted, activeUsInput, normalOutput, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');
const {withEnv} = require('./fixtures/step-8w-switches');
const {withSectionFourPriceRecordSwitch} = require('./fixtures/section-four-price-record-switch');

// Each test sets all three switches itself (on unless it says otherwise).
const test = (name, fn) => nodeTest(name, () => withEnv('SECTION_FOUR_BOTH_LISTS_ENABLED', 'on', () =>
  withEnv('SECTION_FOUR_TABLE_ENABLED', 'on', () => withSectionFourPriceRecordSwitch('on', fn))));

const CHECKED_AT = '2026-09-06T09:59:00.000Z';
const NAMES = {
  NVDA: 'NVIDIA Corporation', MSFT: 'Microsoft Corporation', CPRI: 'Capri Holdings Limited',
  AAPL: 'Apple Inc.', AMD: 'Advanced Micro Devices, Inc.', META: 'Meta Platforms, Inc.'
};
const MANY = ['NVDA', 'MSFT', 'CPRI', 'AAPL', 'AMD', 'META', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06',
  'S07', 'S08', 'S09', 'S10', 'S11'];

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function stockSnapshot(symbol, marketState, {close = 105, previousClose = 102, overlay = null} = {}) {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', previousClose, 99], ['2026-09-04', close, previousClose]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: NAMES[symbol] || `${symbol} Inc.`, instrumentType: 'EQUITY',
    currency: 'USD', marketState,
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

// A completed-day input shaped as the package builds it: a quote line for each stock except
// those in `noQuote` (and `blank`, which also have no price snapshot), whose price record comes
// last, built by the real record code; a linked Yahoo article for each symbol in `linked`.
function recordInput({myStocks = [], watchlist = [], linked = [], marketState = 'CLOSED', noQuote = [],
  blank = []} = {}) {
  const symbols = [...new Set(myStocks.concat(watchlist))];
  const withoutQuote = new Set(noQuote.concat(blank));
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
  const ownRef = {};
  const newsRef = {};
  for (const symbol of symbols.filter(value => !withoutQuote.has(value))) {
    evidence.push(item('us.yahoo-finance', `${symbol} market data`,
      `https://finance.yahoo.com/quote/${symbol}/`, '2026-09-04T20:00:00Z', [symbol], 'market-data'));
    ownRef[symbol] = `e${evidence.length}`;
  }
  for (const symbol of linked) {
    evidence.push(item('us.yahoo-finance', `${NAMES[symbol] || symbol} shares move after company news`,
      `https://finance.yahoo.com/news/${symbol.toLowerCase()}-company-news-120000000.html`,
      '2026-09-04T20:30:00Z', [symbol]));
    newsRef[symbol] = `e${evidence.length}`;
  }
  const priced = symbols.filter(symbol => !blank.includes(symbol));
  const snapshots = Object.fromEntries(priced.map(symbol => [symbol, stockSnapshot(symbol, marketState)]));
  for (const symbol of symbols.filter(value => withoutQuote.has(value))) {
    const fields = sectionFourPriceRecordFields(symbol, snapshots[symbol] || null, marketState, CHECKED_AT);
    evidence.push(createEvidenceItem({sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
      ...fields, symbols: [symbol]}));
    ownRef[symbol] = `e${evidence.length}`;
  }
  const telemetryRef = Object.fromEntries(priced.map((symbol, index) => [symbol, `t${index + 2}`]));
  const security = symbol => ({
    market: 'US', symbol, telemetryRefs: telemetryRef[symbol] ? [telemetryRef[symbol]] : [],
    evidenceRefs: [ownRef[symbol]].concat(newsRef[symbol] ? [newsRef[symbol]] : []), upcomingEvents: []
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: myStocks.length ? 'myStocks' : 'watchlist',
      generatedAt: '2026-09-06T10:00:00.000Z', userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {
        benchmarkSnapshots: [stockSnapshot('^GSPC', marketState)],
        stockSnapshots: priced.map(symbol => snapshots[symbol])
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

const recordRefsOf = input => input.marketPackages[0].evidenceContext.evidence
  .filter(entry => isSectionFourPriceRecord(entry.item)).map(entry => entry.reference);

function outputWith(input, content, refs = []) {
  const output = supportedOutput(input);
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content, evidenceRefs: refs, telemetryRefs: [], uncertainties: []};
  return output;
}

async function run(input, output = outputWith(input, null)) {
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  const section = result.output.sections[3];
  return {result, section, parts: section.content.split('\n\n'),
    line: diagnostics.find(value => value.stage === 'sectionFourTable')};
}

test('Step 9AA.2: the switch is one Admin setting, default on, and needs the table switch', () => {
  assert.equal(settingValue('sectionFourPriceRecordEnabled', {env: {}}), true);
  assert.equal(sectionFourPriceRecordOn({env: {}}), true);
  assert.equal(sectionFourPriceRecordOn({env: {SECTION_FOUR_PRICE_RECORD_ENABLED: 'false'}}), false);
  assert.equal(sectionFourPriceRecordOn({env: {SECTION_FOUR_TABLE_ENABLED: 'off'}}), false);
  assert.equal(sectionFourPriceRecordOn({env: {SECTION_FOUR_BOTH_LISTS_ENABLED: 'off'}}), false);
});

test('Step 9AA.2: the record states what the row shows: the close, the live price, or no price', () => {
  assert.deepEqual(sectionFourPriceRecordFields('CPRI', stockSnapshot('CPRI', 'CLOSED'), 'CLOSED', CHECKED_AT), {
    title: 'Capri Holdings (CPRI) price',
    summary: `Capri Holdings (CPRI): $105.00, ↑ 3.00 (2.94%), at the close on Fri 4 Sep. ${SECTION_FOUR_PRICE_RECORD_TAG}`,
    canonicalUrl: 'https://finance.yahoo.com/quote/CPRI/', publishedAt: '2026-09-04T20:00:00.000Z'});
  const live = stockSnapshot('CPRI', 'REGULAR', {overlay: {asOf: '2026-09-08T16:58:00.000Z', lastPrice: 104.51}});
  assert.equal(sectionFourPriceRecordFields('CPRI', live, 'REGULAR', CHECKED_AT).summary,
    `Capri Holdings (CPRI): $104.51, ↓ 0.49 (0.47%), live price at 12:58 pm ET. ${SECTION_FOUR_PRICE_RECORD_TAG}`);
  assert.equal(sectionFourPriceRecordFields('CPRI', live, 'REGULAR', CHECKED_AT).publishedAt, '2026-09-08T16:58:00.000Z');
  assert.deepEqual(sectionFourPriceRecordFields('CPRI', null, 'CLOSED', CHECKED_AT), {
    title: 'CPRI price not available',
    summary: `No price available for CPRI in this report. ${SECTION_FOUR_PRICE_RECORD_TAG}`,
    canonicalUrl: 'https://finance.yahoo.com/quote/CPRI/', publishedAt: CHECKED_AT});
  // A Yahoo quote line, a spotlight line or a news item is never taken for a record.
  const input = recordInput({myStocks: ['NVDA'], watchlist: ['CPRI'], noQuote: ['CPRI']});
  assert.deepEqual(input.marketPackages[0].evidenceContext.evidence
    .filter(entry => isSectionFourPriceRecord(entry.item)).map(entry => entry.item.symbols[0]), ['CPRI']);
});

test('Step 9AA.2: the writer never sees a record (evidence list, security refs, allowlist, request)', () => {
  const input = recordInput({myStocks: ['NVDA', 'CPRI'], watchlist: ['AAPL'], linked: ['NVDA'],
    noQuote: ['NVDA'], blank: ['CPRI']});
  const records = recordRefsOf(input);
  assert.equal(records.length, 2);
  const projected = projectClaudeAnalysisInput(input);
  const writerEvidence = projected.marketPackages[0].evidenceContext.evidence.map(entry => entry.reference);
  assert.equal(writerEvidence.some(reference => records.includes(reference)), false);
  for (const security of projected.portfolioContext.myStocks.concat(projected.portfolioContext.watchlist)) {
    assert.equal(security.evidenceRefs.some(reference => records.includes(reference)), false, security.symbol);
  }
  assert.equal(projected.sectionFourReferenceAllowlist.evidenceRefs.some(reference => records.includes(reference)), false);
  assert.deepEqual(projected.sectionFourReferenceAllowlist.newsStocks, ['NVDA']);
  const request = buildClaudeAnalysisRequest(input);
  const text = JSON.stringify(request);
  assert.doesNotMatch(text, /Price record made by MarketBrief/);
  assert.doesNotMatch(text, /price not available/);
  for (const reference of records) assert.equal(text.includes(`"${reference}"`), false, reference);
  // A package with no records projects exactly as with the switch off.
  const plain = recordInput({myStocks: ['NVDA'], watchlist: ['AAPL']});
  return withSectionFourPriceRecordSwitch('off', () => {
    const off = JSON.stringify(projectClaudeAnalysisInput(plain));
    return withSectionFourPriceRecordSwitch('on', () =>
      assert.equal(JSON.stringify(projectClaudeAnalysisInput(plain)), off));
  });
});

test('Step 9AA.2: one stock in My Stocks, empty Watchlist, no quote line: the table cites its record', async () => {
  const input = recordInput({myStocks: ['CPRI'], noQuote: ['CPRI']});
  const {section, parts, line} = await run(input);
  assert.deepEqual(parts, ['Stock | Ticker | Last Price | Change\nMy Stocks\nCapri Holdings | CPRI | $105.00 | ↑ 3.00 (2.94%)\n'
    + 'Prices at the close on Fri 4 Sep.', 'No material news for this stock.']);
  assert.deepEqual(section.evidenceRefs, recordRefsOf(input));
  assert.equal(line.closingLine, 'THIS');
});

test('Step 9AA.2: one stock only in the Watchlist with no price: the row reads Not available and the table survives', async () => {
  const input = recordInput({watchlist: ['CPRI'], blank: ['CPRI']});
  const {result, section, parts, line} = await run(input);
  assert.deepEqual(parts, ['Stock | Ticker | Last Price | Change\nWatchlist\nNot available | CPRI | Not available | Not available\n'
    + 'Prices not available.', 'No material news for this stock.']);
  assert.deepEqual(section.evidenceRefs, recordRefsOf(input));
  assert.deepEqual(result.output.evidenceGaps, []);
  assert.equal(line.notAvailableRows, 1);
});

test('Step 9AA.2: one stock in My Stocks with no price (the old all-blank gap) keeps the table', async () => {
  const input = recordInput({myStocks: ['NVDA'], blank: ['NVDA']});
  const {parts} = await run(input);
  assert.deepEqual(parts, ['Stock | Ticker | Last Price | Change\nMy Stocks\nNot available | NVDA | Not available | Not available\n'
    + 'Prices not available.', 'No material news for this stock.']);
});

test('Step 9AA.2: two stocks give "all stocks", "the other stock" or no line', async () => {
  const none = await run(recordInput({myStocks: ['NVDA'], watchlist: ['AMD'], blank: ['NVDA', 'AMD']}));
  assert.equal(none.parts.at(-1), 'No material news for all stocks.');
  assert.equal(none.parts[0].split('\n').at(-1), 'Prices not available.');
  const oneInput = recordInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA'], noQuote: ['NVDA', 'AMD']});
  const newsRef = oneInput.portfolioContext.myStocks[0].evidenceRefs[1];
  const one = await run(oneInput, outputWith(oneInput,
    'NVIDIA rose after its chip deal with a cloud firm, Yahoo Finance reported.', [newsRef]));
  assert.deepEqual(one.parts.slice(1), ['NVIDIA rose after its chip deal with a cloud firm, Yahoo Finance reported.',
    'No material news for the other stock.']);
  assert.equal(one.line.closingLine, 'OTHER');
  assert.deepEqual(one.section.evidenceRefs, [newsRef, ...recordRefsOf(oneInput)]);
  // (A stock with no price data has no name, so a sentence cannot be matched to it: the 9AA
  // limit. AMD here has its price but no quote line.)
  const bothInput = recordInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA', 'AMD'], noQuote: ['AMD']});
  const both = await run(bothInput, outputWith(bothInput,
    'NVIDIA and Advanced Micro Devices both rose after a joint chip order, Yahoo Finance reported.',
    [bothInput.portfolioContext.myStocks[0].evidenceRefs[1], bothInput.portfolioContext.watchlist[0].evidenceRefs[1]]));
  assert.equal(both.parts.length, 2);
  assert.equal(both.line.closingLine, 'NONE');
  assert.ok(both.section.evidenceRefs.includes(recordRefsOf(bothInput)[0]));
});

test('Step 9AA.2: seventeen stocks with some blank keep every row; blanks read Not available', async () => {
  const input = recordInput({myStocks: MANY.slice(0, 10), watchlist: MANY.slice(10),
    blank: ['CPRI', 'S04', 'S09'], noQuote: ['S01', 'S11']});
  const {section, parts, line} = await run(input);
  const rows = parts[0].split('\n').filter(text => text.includes(' | ') && !text.startsWith('Stock |'));
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.filter(text => text.endsWith('Not available | Not available')), ['Not available | CPRI | Not available | Not available',
    'Not available | S04 | Not available | Not available', 'Not available | S09 | Not available | Not available']);
  assert.equal(parts[0].split('\n').at(-1), 'Prices at the close on Fri 4 Sep.');
  assert.equal(parts.at(-1), 'No material news for all stocks.');
  for (const reference of recordRefsOf(input)) assert.ok(section.evidenceRefs.includes(reference), reference);
  assert.equal(line.rows, 17);
});

test('Step 9AA.2: both lists empty keeps the exact statement, no table and no records', async () => {
  const input = recordInput({});
  assert.deepEqual(recordRefsOf(input), []);
  const {section, line} = await run(input, outputWith(input, SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT));
  assert.equal(section.content, 'No securities are configured in My Stocks or the Watchlist.');
  assert.equal(line, undefined);
});

test('Step 9AA.2: a record cited by the writer never supports a reason and never reaches another section', async () => {
  const input = recordInput({myStocks: ['CPRI'], watchlist: ['NVDA'], blank: ['CPRI'], noQuote: ['NVDA']});
  const [cpriRecord, nvdaRecord] = recordRefsOf(input);
  const output = outputWith(input, 'Capri Holdings fell after weak handbag sales, Yahoo Finance reported.', [cpriRecord]);
  output.sections[4] = {...output.sections[4],
    content: `${output.sections[4].content} NVIDIA had no price in this report.`,
    evidenceRefs: output.sections[4].evidenceRefs.concat(nvdaRecord)};
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  const section = result.output.sections[3];
  assert.doesNotMatch(section.content, /handbag/);
  assert.match(section.content, /\n\nNo material news for all stocks\.$/);
  for (const [index, other] of result.output.sections.entries()) {
    if (index === 3) continue;
    assert.equal(other.evidenceRefs.some(reference => [cpriRecord, nvdaRecord].includes(reference)), false, `section ${index + 1}`);
  }
  assert.equal(result.output.furtherReadings.some(reference => [cpriRecord, nvdaRecord].includes(reference)), false);
});

test('Step 9AA.2: the same record and table code runs in all six market states', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    let input;
    let output;
    if (overlayAsOf) {
      const fields = sectionFourPriceRecordFields('MSFT', null, marketState, generatedAt);
      const record = createEvidenceItem({sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
        ...fields, symbols: ['MSFT']});
      input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, additionalItems: [record],
        portfolioContext: {myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e3'],
          upcomingEvents: []}], watchlist: []}});
      output = normalOutput(input, {furtherReadings: ['e1']});
      output.sections[3] = {...output.sections[3], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []};
    } else {
      input = recordInput({myStocks: ['MSFT'], blank: ['MSFT'], marketState});
      output = outputWith(input, null);
    }
    const {result} = await invokeCounted(input, output);
    assert.equal(result.type, 'SUCCESS', `${marketState} ${result.message}`);
    assert.equal(result.output.sections[3].content, 'Stock | Ticker | Last Price | Change\nMy Stocks\nNot available | MSFT | Not available | Not available\n'
      + 'Prices not available.\n\nNo material news for this stock.', marketState);
    assert.deepEqual(result.output.sections[3].evidenceRefs, recordRefsOf(input), marketState);
  }
});

test('Step 9AA.2: switch off gives the 3722898 lines (plural, the close note) on the same input', async () => {
  const input = recordInput({myStocks: ['CPRI'], blank: ['CPRI']});
  await withSectionFourPriceRecordSwitch('off', async () => {
    const {parts, line} = await run(input);
    assert.deepEqual(parts, ['Stock | Ticker | Last Price | Change\nMy Stocks\nNot available | CPRI | Not available | Not available\n'
      + 'Prices at the close on Fri 4 Sep.', 'No material news for all stocks.']);
    assert.equal(line.closingLine, 'ALL');
  });
  const twoInput = recordInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA']});
  const newsRef = twoInput.portfolioContext.myStocks[0].evidenceRefs[1];
  await withSectionFourPriceRecordSwitch('off', async () => {
    const {parts} = await run(twoInput, outputWith(twoInput,
      'NVIDIA rose after its chip deal with a cloud firm, Yahoo Finance reported.', [newsRef]));
    assert.equal(parts.at(-1), 'No material news for the other stocks.');
  });
});

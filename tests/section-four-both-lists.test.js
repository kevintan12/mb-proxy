// Step 21D.2: Section 4 covers My Stocks and the Watchlist together, whichever list started the
// brief: My Stocks first, then the Watchlist, each in its saved order, as one section. The writer's
// allowed references, the cleanup, the final check, the Step 21D.1 reason check and the empty-list
// wording all use both lists, from one shared place (lib/section-rules.js sectionFourPortfolio).
// Behind the Admin switch sectionFourBothListsEnabled (default on); off gives the ad61dd6 behaviour.
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  EMPTY_INITIATING_LIST_CONTENT,
  REPORT_SECTION_NAMES
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');
const {settingValue} = require('../lib/settings-registry');
const {
  sectionFourPortfolio,
  SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT,
  SECTION_FOUR_BOTH_LISTS_NO_DATA
} = require('../lib/section-rules');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {fiveSessionSnapshot, supportedOutput} = require('./fixtures/us-market-brief-quality');
const {invokeCounted} = require('./fixtures/market-state-cases');
const {withSectionFourSwitch} = require('./fixtures/section-four-switch');

// Each test sets the switch itself (on unless it says otherwise), so a whole-suite run with
// SECTION_FOUR_BOTH_LISTS_ENABLED=off still checks the both-lists behaviour.
const bothListsTest = (name, fn) => nodeTest(name, () => withSectionFourSwitch('on', fn));
// Step 9AA Build 1: these pin the 5409b44 Section 4 text, writer lines or allowlist keys, so they
// run with sectionFourTableEnabled off.
const test = require('./fixtures/section-four-table-switch').sectionFourTableOffTests(bothListsTest, [
  "Step 21D.2: the Section 4 stocks are My Stocks then the Watchlist in saved order, whichever list started",
  "Step 21D.2: the writer is told to cover both lists, with no starting-list wording left",
  "Step 21D.2: a My Stocks brief keeps a Watchlist stock and its refs in Section 4",
  "Step 21D.2: the 21D.1 reason check runs across both lists",
  "Step 21D.2: a stock with no article shows its move only and Section 4 is never blanked for it",
  "Step 21D.2: with one list empty, Section 4 covers the other list in either brief",
  "Step 21D.2: when nothing is left, Section 4 is emptied with the both-lists wording",
  "Step 21D.2: a stock in neither list is still trimmed from Section 4",
  "Step 21D.2: 16 stocks (8 + 8) are all covered, in order, with a small request size increase"
]);

const NAMES = {
  MSFT: 'Microsoft Corporation', NVDA: 'NVIDIA Corporation', UNH: 'UnitedHealth Group Incorporated',
  CPRT: 'Copart, Inc.', VEEV: 'Veeva Systems Inc.', CPRI: 'Capri Holdings Limited',
  NVO: 'Novo Nordisk A/S', SPYM: 'State Street SPDR Portfolio S&P 500 ETF',
  AMD: 'Advanced Micro Devices, Inc.', META: 'Meta Platforms, Inc.', AAPL: 'Apple Inc.',
  CRM: 'Salesforce, Inc.', MA: 'Mastercard Incorporated', V: 'Visa Inc.',
  VRSK: 'Verisk Analytics, Inc.', WM: 'Waste Management, Inc.'
};
// How the writer names each stock in prose (a one-letter ticker such as V is only recognised by
// its name or as "(V)", as in Step 21D.1).
const SHORT = {
  CPRI: 'Capri', UNH: 'UnitedHealth', NVO: 'Novo Nordisk', CPRT: 'Copart', NVDA: 'NVIDIA',
  MSFT: 'Microsoft', VEEV: 'Veeva', SPYM: 'SPYM', AMD: 'AMD', META: 'Meta', AAPL: 'Apple',
  CRM: 'Salesforce', MA: 'Mastercard', V: 'Visa', VRSK: 'Verisk Analytics', WM: 'Waste Management'
};
const SAVED_MY_STOCKS = ['CPRI', 'UNH', 'NVO', 'CPRT', 'NVDA', 'MSFT', 'VEEV', 'SPYM'];
const SAVED_WATCHLIST = ['AMD', 'META', 'AAPL', 'CRM', 'MA', 'V', 'VRSK', 'WM'];

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news'
      ? {publisher: 'Yahoo Finance'} : {})
  });
}

// The rich completed fixture (e1-e5, t1 the S&P 500) plus, for every stock, a market-data item
// and stock telemetry, and a linked Yahoo news article for each symbol in `linked`.
function bothListsInput({myStocks = [], watchlist = [], linked = [], initiatingList = 'myStocks'} = {}) {
  const symbols = [...new Set(myStocks.concat(watchlist))];
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
      '2026-09-04T21:00:00Z', ['^GSPC']),
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
  const telemetryRef = Object.fromEntries(symbols.map((symbol, index) => [symbol, `t${index + 2}`]));
  const security = symbol => ({
    market: 'US', symbol, telemetryRefs: [telemetryRef[symbol]],
    evidenceRefs: [marketDataRef[symbol]].concat(newsRef[symbol] ? [newsRef[symbol]] : []),
    upcomingEvents: []
  });
  const stockRefs = symbols.map(symbol => marketDataRef[symbol]);
  const newsRefs = linked.map(symbol => newsRef[symbol]);
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList, generatedAt: '2026-09-06T10:00:00.000Z',
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
        benchmarkSnapshots: [fiveSessionSnapshot('^GSPC')],
        stockSnapshots: symbols.map(symbol => fiveSessionSnapshot(symbol, 'EQUITY', NAMES[symbol]))
      },
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3', ...stockRefs],
        principalCatalysts: ['e2', 'e3', 'e4'],
        supportingEvidence: ['e2', 'e3', 'e4', 'e5', ...newsRefs],
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

// The fixture's supported report with Section 4 replaced.
function outputWithSectionFour(input, content, symbols) {
  const output = supportedOutput(input);
  const evidenceRefs = [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).evidenceRefs))];
  const telemetryRefs = [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).telemetryRefs))];
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content, evidenceRefs, telemetryRefs, uncertainties: []};
  return output;
}

function sectionFourEvents(diagnostics) {
  return diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'
    && value.sectionIndex === 3);
}

test('Step 21D.2: the switch is one Admin setting, default on', () => {
  assert.equal(settingValue('sectionFourBothListsEnabled', {env: {}}), true);
  assert.equal(settingValue('sectionFourBothListsEnabled',
    {env: {SECTION_FOUR_BOTH_LISTS_ENABLED: 'off'}}), false);
});

test('Step 21D.2: the Section 4 stocks are My Stocks then the Watchlist in saved order, whichever list started', () => {
  for (const initiatingList of ['myStocks', 'watchlist']) {
    const input = bothListsInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AMD', 'AAPL'], initiatingList});
    assert.deepEqual(sectionFourPortfolio(input).map(entry => entry.symbol), ['NVDA', 'MSFT', 'AMD', 'AAPL']);
    const allowlist = projectClaudeAnalysisInput(input).sectionFourReferenceAllowlist;
    assert.deepEqual(Object.keys(allowlist), ['lists', 'stockOrder', 'evidenceRefs', 'telemetryRefs']);
    assert.deepEqual(allowlist.stockOrder, ['NVDA', 'MSFT', 'AMD', 'AAPL']);
    assert.deepEqual(allowlist.telemetryRefs, ['t2', 't3', 't4', 't5']);
    assert.deepEqual(allowlist.evidenceRefs, ['e6', 'e7', 'e8', 'e9']);
  }
});

test('Step 21D.2: the writer is told to cover both lists, with no starting-list wording left', () => {
  for (const initiatingList of ['myStocks', 'watchlist']) {
    const input = bothListsInput({myStocks: ['NVDA'], watchlist: ['AMD'], initiatingList});
    const request = buildClaudeAnalysisRequest(input);
    assert.match(request.system, /cover every security in portfolioContext\.myStocks and then every security in portfolioContext\.watchlist as one section with no headings or subsections/);
    assert.match(request.system, /"On your Watchlist,"/);
    assert.match(request.system, /No securities are configured in My Stocks or the Watchlist\./);
    assert.match(request.system, /Request-specific Section 4 reference allowlist for My Stocks and the Watchlist: /);
    assert.match(request.system, /Cover the stocks in this order: \["NVDA","AMD"\]\./);
    assert.match(request.system, /SECTION 4 REASONS/);
    assert.doesNotMatch(request.system, /initiating list|initiating-list|non-initiating/i);
    const modelInput = JSON.parse(request.messages[0].content);
    assert.match(modelInput.outputRequirements.sections[3].purpose, /every security in My Stocks and the Watchlist/);
  }
});

test('Step 21D.2: a My Stocks brief keeps a Watchlist stock and its refs in Section 4', async () => {
  const input = bothListsInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA', 'AMD']});
  const content = 'NVIDIA gained $2.10 (1.0%) to $214.13 after its company news. '
    + 'On your Watchlist, Advanced Micro Devices fell $1.20 (0.8%) to $160.40 after its company news.';
  const output = outputWithSectionFour(input, content, ['NVDA', 'AMD']);
  const {result, calls, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(calls, 1);
  assert.equal(result.output.status, 'NORMAL');
  assert.equal(result.output.sections[3].content, content);
  assert.deepEqual(result.output.sections[3].evidenceRefs, output.sections[3].evidenceRefs);
  assert.deepEqual(sectionFourEvents(diagnostics), []);
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
});

test('Step 21D.2: the 21D.1 reason check runs across both lists', async () => {
  const input = bothListsInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AMD', 'AAPL'],
    linked: ['NVDA', 'AMD'], initiatingList: 'watchlist'});
  const content = 'NVIDIA gained $2.10 (1.0%) to $214.13 after its company news. '
    + 'Microsoft fell $5.00 (1.0%) to $529.05, tracking technology sector weakness. '
    + 'On your Watchlist, Advanced Micro Devices fell $1.20 (0.8%) to $160.40 after its company news. '
    + 'Apple rose $1.00 (0.4%) to $230.00 amid hopes for new phones.';
  const output = outputWithSectionFour(input, content, ['NVDA', 'MSFT', 'AMD', 'AAPL']);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  assert.equal(result.output.sections[3].content,
    'NVIDIA gained $2.10 (1.0%) to $214.13 after its company news. '
    + 'Microsoft fell $5.00 (1.0%) to $529.05. '
    + 'On your Watchlist, Advanced Micro Devices fell $1.20 (0.8%) to $160.40 after its company news. '
    + 'Apple rose $1.00 (0.4%) to $230.00.');
  const events = sectionFourEvents(diagnostics);
  assert.equal(events.length, 1);
  assert.equal(events[0].violationCategory, 'UNSUPPORTED_STOCK_CAUSE');
  assert.equal(events[0].action, 'TRIMMED');
  assert.equal(events[0].allowedReferenceCount, 2);
  assert.equal(events[0].shortenedSentenceCount, 2);
});

test('Step 21D.2: a stock with no article shows its move only and Section 4 is never blanked for it', async () => {
  const input = bothListsInput({myStocks: ['MSFT'], watchlist: ['AAPL']});
  const content = 'Microsoft fell $5.00 (1.0%) to $529.05. On your Watchlist, Apple rose $1.00 (0.4%) to $230.00.';
  const output = outputWithSectionFour(input, content, ['MSFT', 'AAPL']);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.output.status, 'NORMAL');
  assert.equal(result.output.sections[3].content, content);
  assert.deepEqual(sectionFourEvents(diagnostics), []);
});

test('Step 21D.2: with one list empty, Section 4 covers the other list in either brief', async () => {
  for (const [myStocks, watchlist, symbol, content] of [
    [[], ['AAPL'], 'AAPL', 'Apple rose $1.00 (0.4%) to $230.00.'],
    [['MSFT'], [], 'MSFT', 'Microsoft fell $5.00 (1.0%) to $529.05.']
  ]) {
    for (const initiatingList of ['myStocks', 'watchlist']) {
      const input = bothListsInput({myStocks, watchlist, initiatingList});
      const output = outputWithSectionFour(input, content, [symbol]);
      const {result} = await invokeCounted(input, output);
      assert.equal(result.type, 'SUCCESS', result.message);
      assert.equal(result.output.status, 'NORMAL', `${initiatingList} ${symbol}`);
      assert.equal(result.output.sections[3].content, content);
      // The old "No securities are configured in ..." text is not accepted for a non-empty pair.
      const stale = structuredClone(result.output);
      stale.sections[3] = {...stale.sections[3], content: EMPTY_INITIATING_LIST_CONTENT[initiatingList],
        evidenceRefs: [], telemetryRefs: []};
      assert.equal(validateClaudeAnalysisOutput(stale, input).valid, false);
    }
  }
});

test('Step 21D.2: with both lists empty, Section 4 is exactly the both-lists statement', async () => {
  const input = bothListsInput({});
  const output = outputWithSectionFour(input, SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT, []);
  const {result} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  assert.equal(result.output.sections[3].content, 'No securities are configured in My Stocks or the Watchlist.');
  assert.equal(validateClaudeAnalysisOutput(result.output, input).valid, true);
  const old = structuredClone(result.output);
  old.sections[3] = {...old.sections[3], content: EMPTY_INITIATING_LIST_CONTENT.myStocks};
  assert.equal(validateClaudeAnalysisOutput(old, input).valid, false);
  // A writer that ignores the rule gets the exact text back (Step 8U.5 path: a made-up ref).
  const madeUp = outputWithSectionFour(input, 'Stocks were quiet.', []);
  madeUp.sections[3].evidenceRefs = ['e999'];
  const repaired = await invokeCounted(input, madeUp);
  assert.equal(repaired.result.output.sections[3].content, SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT);
});

test('Step 21D.2: when nothing is left, Section 4 is emptied with the both-lists wording', async () => {
  const input = bothListsInput({myStocks: ['MSFT'], watchlist: ['AAPL']});
  const output = outputWithSectionFour(input, 'Investors rotated into healthcare.', ['MSFT', 'AAPL']);
  const {result} = await invokeCounted(input, output);
  assert.equal(result.output.status, 'DEGRADED');
  assert.equal(result.output.sections[3].content, null);
  assert.deepEqual(result.output.sections[3].uncertainties, [SECTION_FOUR_BOTH_LISTS_NO_DATA]);
  assert.ok(result.output.evidenceGaps.includes('Not enough data to comment on your stocks.'));
});

test('Step 21D.2: a stock in neither list is still trimmed from Section 4', async () => {
  const input = bothListsInput({myStocks: ['MSFT'], watchlist: ['AAPL']});
  const content = 'Microsoft fell $5.00 (1.0%) to $529.05. On your Watchlist, Apple rose $1.00 (0.4%) to $230.00.';
  const output = outputWithSectionFour(input, `${content} Broadcom rose 3%.`, ['MSFT', 'AAPL']);
  output.sections[3].evidenceRefs = output.sections[3].evidenceRefs.concat(['e4']);
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.output.status, 'NORMAL');
  assert.equal(result.output.sections[3].content, content);
  assert.equal(result.output.sections[3].evidenceRefs.includes('e4'), false);
  assert.deepEqual(sectionFourEvents(diagnostics).map(event => event.violationCategory),
    ['NON_INITIATING_EVIDENCE', 'UNSUPPORTED_STOCK_CAUSE']);
});

test('Step 21D.2: 16 stocks (8 + 8) are all covered, in order, with a small request size increase', async () => {
  const linked = ['NVDA', 'MSFT', 'AMD', 'META'];
  const input = bothListsInput({myStocks: SAVED_MY_STOCKS, watchlist: SAVED_WATCHLIST, linked});
  const allowlist = projectClaudeAnalysisInput(input).sectionFourReferenceAllowlist;
  assert.deepEqual(allowlist.stockOrder, SAVED_MY_STOCKS.concat(SAVED_WATCHLIST));
  assert.equal(allowlist.telemetryRefs.length, 16);
  assert.equal(allowlist.evidenceRefs.length, 20);
  const onBytes = Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input)));
  const offBytes = await withSectionFourSwitch('off', () =>
    Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input))));
  // Both lists' prices and articles already go to the writer; only the allowlist, order and
  // instruction text grow.
  assert.ok(onBytes - offBytes > 0 && onBytes - offBytes < 2048, `${onBytes - offBytes} bytes`);

  const sentences = SAVED_MY_STOCKS.concat(SAVED_WATCHLIST).map((symbol, index) => {
    const lead = index === 8 ? 'On your Watchlist, ' : '';
    return `${lead}${SHORT[symbol]} rose $1.00 (0.5%) to $100.00${linked.includes(symbol)
      ? ' after its company news' : ' on sector rotation'}.`;
  });
  const output = outputWithSectionFour(input, sentences.join(' '), SAVED_MY_STOCKS.concat(SAVED_WATCHLIST));
  const {result, diagnostics} = await invokeCounted(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'NORMAL');
  const kept = result.output.sections[3].content;
  let position = -1;
  for (const symbol of SAVED_MY_STOCKS.concat(SAVED_WATCHLIST)) {
    const next = kept.search(new RegExp(`(?:^|[.,] )${SHORT[symbol]} rose`));
    assert.ok(next > position, symbol);
    position = next;
  }
  assert.equal((kept.match(/after its company news/g) || []).length, 4);
  assert.equal(kept.includes('rotation'), false);
  assert.equal(sectionFourEvents(diagnostics)[0].shortenedSentenceCount, 12);
});

test('Step 21D.2: switch off restores the starting-list Section 4 exactly', async () => {
  await withSectionFourSwitch('off', async () => {
    const input = bothListsInput({myStocks: ['NVDA'], watchlist: ['AMD'], linked: ['NVDA', 'AMD']});
    assert.deepEqual(sectionFourPortfolio(input).map(entry => entry.symbol), ['NVDA']);
    const modelInput = projectClaudeAnalysisInput(input);
    assert.deepEqual(modelInput.sectionFourReferenceAllowlist,
      {initiatingList: 'myStocks', evidenceRefs: ['e6', 'e8'], telemetryRefs: ['t2']});
    assert.equal(modelInput.outputRequirements.sections[3].purpose, input.outputRequirements.sections[3].purpose);
    const request = buildClaudeAnalysisRequest(input);
    assert.match(request.system, /determine the initiating list from analysisRequest\.initiatingList/);
    assert.doesNotMatch(request.system, /My Stocks or the Watchlist|stockOrder|"On your Watchlist,"/);

    // The Watchlist stock and its ref are trimmed from a My Stocks brief, as before.
    const content = 'NVIDIA gained $2.10 (1.0%) to $214.13 after its company news.';
    const output = outputWithSectionFour(input, `${content} AMD fell 1%.`, ['NVDA', 'AMD']);
    const {result, diagnostics} = await invokeCounted(input, output);
    assert.equal(result.output.sections[3].content, content);
    assert.deepEqual(result.output.sections[3].evidenceRefs, ['e6', 'e8']);
    assert.ok(sectionFourEvents(diagnostics).some(event => event.violationCategory === 'NON_INITIATING_EVIDENCE'));

    // Empty starting list: the old per-list statement.
    const empty = bothListsInput({myStocks: [], watchlist: ['AMD']});
    const emptyOutput = outputWithSectionFour(empty, EMPTY_INITIATING_LIST_CONTENT.myStocks, []);
    const emptyRun = await invokeCounted(empty, emptyOutput);
    assert.equal(emptyRun.result.output.sections[3].content, 'No securities are configured in My Stocks.');

    // Nothing left: the old wording.
    const unlinked = bothListsInput({myStocks: ['NVDA'], watchlist: ['AMD']});
    const blank = outputWithSectionFour(unlinked, 'Investors rotated into chips.', ['NVDA']);
    const blankRun = await invokeCounted(unlinked, blank);
    assert.deepEqual(blankRun.result.output.sections[3].uncertainties,
      ['Not enough data to comment on the stocks in this list.']);
  });
});

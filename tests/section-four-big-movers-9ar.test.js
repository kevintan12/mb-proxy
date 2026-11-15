// Step 9AR Build 6: the Section 4 closing line names the big moves (option C). While
// sectionFourBigMoversEnabled is on, a table stock with no explanation and no pointer line whose shown
// move is at least sectionFourBigMoverPercent (default 3) is named in the closing line, biggest first,
// at most five, with "up" / "down" from the table arrow and the percent copied from the table cell.
// Off: the closing line is exactly as before. Free tests only: made-up data, no network, no paid call.
// No existing test is edited.
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput, validateClaudeAnalysisOutput, REPORT_SECTION_NAMES, splitReportSentences,
  hasMalformedPlainEnglishProse, hasActiveDirectMarketCausalClaim, hasInternalIdentifierLeak
} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  sectionFourTableRows, sectionFourClosingText, sectionFourClosingKind, isSectionFourClosingLine,
  composeSectionFour, sectionFourFocusPointers, isSectionFourTableOnly, sectionFourTableSummary,
  sectionFourExplanations, sectionFourStocks, sectionFourPortfolio, sectionFourWithFixedClosing, SECTION_FOUR_NO_NEWS_ALL,
  SECTION_FOUR_NO_NEWS_OTHERS, SECTION_FOUR_NO_NEWS_THIS, SECTION_FOUR_NO_NEWS_OTHER
} = require('../lib/section-rules');
const {
  createCompletedRegularSession, createCurrentSessionOverlay, createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {MARKET_STATE_CASES, activeUsInput, normalOutput, anthropicResponse} = require('./fixtures/market-state-cases');

const ON_ENV = 'SECTION_FOUR_BIG_MOVERS_ENABLED';
const PCT_ENV = 'SECTION_FOUR_BIG_MOVER_PERCENT';
const ENV_NAMES = [ON_ENV, PCT_ENV, 'SECTION_FOUR_TABLE_ENABLED', 'SECTION_FOUR_BOTH_LISTS_ENABLED',
  'SECTION_FOUR_PRICE_RECORD_ENABLED', 'CLAUDE_MODEL'];

// Each test runs with the table switches on and the big-move settings at their defaults unless it says
// otherwise, so a whole-suite run with any of them set still checks this build.
async function withEnvs(values, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, {SECTION_FOUR_TABLE_ENABLED: 'on', SECTION_FOUR_BOTH_LISTS_ENABLED: 'on'}, values);
  try {
    return await fn();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
const test = (name, fn) => nodeTest(name, () => withEnvs({}, fn));

const NAMES = {
  NVDA: 'NVIDIA Corporation', MSFT: 'Microsoft Corporation', AAPL: 'Apple Inc.',
  AMD: 'Advanced Micro Devices, Inc.', CRM: 'Salesforce, Inc.', PLTR: 'Palantir Technologies Inc.',
  VRSK: 'Verisk Analytics, Inc.', META: 'Meta Platforms, Inc.', V: 'Visa Inc.', MA: 'Mastercard Incorporated'
};

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

// Five completed sessions ending 2026-09-04: the last one closes at `close` from `previousClose`.
function stockSnapshot(symbol, marketState, {close = 105, previousClose = 102, overlay = null,
  name = NAMES[symbol]} = {}) {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', previousClose, 99], ['2026-09-04', close, previousClose]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: name, instrumentType: 'EQUITY', currency: 'USD', marketState,
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

// A completed-day input with My Stocks, a Watchlist, a market-data item per stock and a linked Yahoo
// article per symbol in `linked`. `moves` sets a stock's last move in percent (from a close of 100);
// a symbol in `missing` has no price; `focus` lists COMPANY names in the cited Section 3 focus entry.
function tableInput({myStocks = [], watchlist = [], linked = [], marketState = 'CLOSED', moves = {},
  missing = [], focus = ['Broadcom'], closes = {}} = {}) {
  const symbols = [...new Set(myStocks.concat(watchlist))];
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html', '2026-09-04T21:00:00Z', ['^GSPC']),
    item('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html', '2026-09-04T19:30:00Z'),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', [], 'monetary-policy'),
    item('us.cnbc', `${focus.join(', ')} lead semiconductor shares after a major company development`,
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
  // `closes` sets an exact close (from a previous close of 100) with no rounding, for a move whose
  // unrounded percent differs from the 2-decimal value the table shows (strict proof Group C).
  const priceOf = symbol => closes[symbol] !== undefined ? {previousClose: 100, close: closes[symbol]}
    : moves[symbol] === undefined ? {}
      : {previousClose: 100, close: Math.round((100 + moves[symbol]) * 100) / 100};
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
        stockSnapshots: priced.map(symbol => stockSnapshot(symbol, marketState, priceOf(symbol)))
      },
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'],
        supportingEvidence: ['e2', 'e3', 'e4', 'e5', ...linked.map(symbol => newsRef[symbol])],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: focus.map(name => ({kind: 'COMPANY', name}))},
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

function outputWithSectionFour(input, content, symbols) {
  const output = supportedOutput(input);
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content,
    evidenceRefs: [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).evidenceRefs))],
    telemetryRefs: [...new Set(symbols.flatMap(symbol => refsOf(input, symbol).telemetryRefs))],
    uncertainties: []};
  return output;
}

async function invoke(input, output, env = {}) {
  const diagnostics = [];
  const result = await withEnvs(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  }));
  return {result, diagnostics, table: diagnostics.find(value => value.stage === 'sectionFourTable')};
}

const closingOf = content => content.split('\n\n').at(-1);

// The Section 4 stocks as the cleanup builds them (supported = a cited news ref of its own).
function stocksFor(input, section) {
  const categories = new Map(input.marketPackages[0].evidenceContext.evidence
    .map(entry => [entry.reference, entry.item?.evidenceCategory]));
  const names = new Map(input.marketPackages[0].telemetry.stockSnapshots
    .map(entry => [entry.snapshot.symbol, entry.snapshot.instrumentName]));
  return sectionFourStocks(sectionFourPortfolio(input), security => names.get(security.symbol) ?? '',
    section.evidenceRefs, reference => categories.get(reference));
}

function compose(input, content, cited, options) {
  const section = {name: REPORT_SECTION_NAMES[3], content,
    evidenceRefs: [...new Set(cited.flatMap(symbol => refsOf(input, symbol).evidenceRefs))],
    telemetryRefs: [], uncertainties: []};
  return composeSectionFour(section, input, stocksFor(input, section), splitReportSentences, options);
}

// ------------------------------------------------------------------------------------------- settings

test('Step 9AR Build 6: the two settings are Admin, defaults on and 3, range 1 to 10', () => {
  const on = SETTINGS_REGISTRY.sectionFourBigMoversEnabled;
  assert.deepEqual([on.default, on.admin, on.envVar, on.wired, on.boolean], [true, 'Admin', ON_ENV, true, true]);
  const pct = SETTINGS_REGISTRY.sectionFourBigMoverPercent;
  assert.deepEqual([pct.default, pct.min, pct.max, pct.admin, pct.envVar, pct.wired], [3, 1, 10, 'Admin', PCT_ENV, true]);
  assert.equal(settingValue('sectionFourBigMoversEnabled', {env: {}}), true);
  assert.equal(settingValue('sectionFourBigMoversEnabled', {env: {[ON_ENV]: 'off'}}), false);
  assert.equal(settingValue('sectionFourBigMoverPercent', {env: {[PCT_ENV]: '2.5'}}), 2.5);
  assert.equal(settingValue('sectionFourBigMoverPercent', {env: {[PCT_ENV]: '0'}}), 1);
  assert.equal(settingValue('sectionFourBigMoverPercent', {env: {[PCT_ENV]: '25'}}), 10);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.length, 141);
  assert.equal(names.indexOf('sectionFourBigMoversEnabled'), names.indexOf('reportAccuracyRankingEnabled') + 1);
  assert.equal(names.indexOf('sectionFourBigMoverPercent'), names.indexOf('sectionFourBigMoversEnabled') + 1);
});

test('Step 9AR Build 6: both descriptions are short plain English (the Step 9AD.1 rules)', () => {
  for (const name of ['sectionFourBigMoversEnabled', 'sectionFourBigMoverPercent']) {
    const text = SETTINGS_REGISTRY[name].description;
    assert.ok(text.includes('When on') && text.includes('When off'), name);
    const sentences = text.replace(/"[^"]*"/g, 'QUOTED').split(/[.!?](?:\s+|$)/).filter(part => part.trim());
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${name}: ${sentences.length} sentences`);
    assert.ok(!/[0-9a-f]{7,}/i.test(text), name);
    assert.ok(!/\bStep\b/i.test(text), name);
    assert.ok(!/\b9[A-Z]{1,2}(\.\d+)?\b/.test(text), name);
    assert.ok(text.length <= 450, `${name}: ${text.length} characters`);
  }
});

// ------------------------------------------------------------------------------------- the line itself

const NINE_NOV = {
  myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL', 'AMD', 'CRM', 'PLTR', 'VRSK', 'META'],
  moves: {NVDA: 2.78, MSFT: -0.99, AAPL: -0.52, AMD: 11.04, CRM: -3.94, PLTR: 3.48, VRSK: -3.25, META: 0.84}
};

test('Step 9AR Build 6: the 9 Nov shape names every unexplained stock at 3% or more, biggest first', () => {
  const input = tableInput({...NINE_NOV, linked: ['NVDA']});
  const composed = compose(input, 'NVIDIA rose after its company news, Yahoo Finance reported.', ['NVDA']);
  assert.equal(closingOf(composed.section.content), 'No news found for the other stocks, including the biggest '
    + 'moves: Advanced Micro Devices up 11.04%, Salesforce down 3.94%, Palantir Technologies up 3.48%, '
    + 'Verisk Analytics down 3.25%.');
  assert.equal(composed.counts.closingLine, 'OTHERS');
});

test('Step 9AR Build 6: nothing at the threshold, or the switch off, keeps today\'s exact line', async () => {
  const input = tableInput({...NINE_NOV, moves: {...NINE_NOV.moves, AMD: 2.99, CRM: -2.5, PLTR: 1, VRSK: -2}});
  assert.equal(closingOf(compose(input, null, []).section.content), SECTION_FOUR_NO_NEWS_ALL);
  const big = tableInput(NINE_NOV);
  await withEnvs({[ON_ENV]: 'off'}, () => {
    assert.equal(closingOf(compose(big, null, []).section.content), SECTION_FOUR_NO_NEWS_ALL);
  });
});

test('Step 9AR Build 6: the threshold reads the shown 2-decimal value and either direction', async () => {
  const input = tableInput({myStocks: ['AMD', 'CRM', 'PLTR'], moves: {AMD: 2.995, CRM: -3, PLTR: 2.99}});
  const line = closingOf(compose(input, null, []).section.content);
  assert.equal(line, 'No news found for any stock, including the biggest moves: Advanced Micro Devices up 3.00%, '
    + 'Salesforce down 3.00%.');
  await withEnvs({[PCT_ENV]: '2.5'}, () => {
    assert.equal(closingOf(compose(input, null, []).section.content), 'No news found for any stock: Advanced Micro '
      + 'Devices up 3.00%, Salesforce down 3.00%, Palantir Technologies up 2.99%.');
  });
  await withEnvs({[PCT_ENV]: '10'}, () => {
    assert.equal(closingOf(compose(input, null, []).section.content), SECTION_FOUR_NO_NEWS_ALL);
  });
});

// Strict proof Group C: the test above rounds each close to 2 decimals, so its moves are already the shown
// values. Here the unrounded move is below 3 while the table shows 3.00%: the shown value decides.
test('Step 9AR Build 6: an unrounded move just under 3% that the table shows as 3.00% is named', () => {
  const input = tableInput({myStocks: ['AMD', 'CRM', 'PLTR'], closes: {AMD: 102.996, CRM: 97.0049, PLTR: 102.994}});
  const rows = sectionFourTableRows(input);
  for (const symbol of ['AMD', 'CRM']) {
    const row = rows.find(entry => entry.symbol === symbol);
    assert.ok(Math.abs(row.price.percent) < 3, `${symbol} unrounded ${row.price.percent}`);
    assert.match(row.changeCell, /\(3\.00%\)$/);
  }
  assert.match(rows.find(entry => entry.symbol === 'PLTR').changeCell, /\(2\.99%\)$/);
  assert.equal(closingOf(compose(input, null, []).section.content), 'No news found for any stock, including the '
    + 'biggest moves: Advanced Micro Devices up 3.00%, Salesforce down 3.00%.');
});

// Strict proof Group C: an out-of-range percent setting acts as 1 or 10 in the closing line itself.
test('Step 9AR Build 6: an out-of-range percent setting is clamped to 1 or 10 in the closing line', async () => {
  const low = tableInput({myStocks: ['AMD', 'CRM', 'PLTR'], moves: {AMD: 0.99, CRM: -1, PLTR: 2}});
  for (const value of ['0.5', '0', '-4']) {
    await withEnvs({[PCT_ENV]: value}, () => {
      assert.equal(closingOf(compose(low, null, []).section.content), 'No news found for any stock, including the '
        + 'biggest moves: Palantir Technologies up 2.00%, Salesforce down 1.00%.', value);
    });
  }
  const high = tableInput({myStocks: ['AMD', 'CRM', 'PLTR'], moves: {AMD: 10, CRM: -12, PLTR: 9.99}});
  for (const value of ['15', '25']) {
    await withEnvs({[PCT_ENV]: value}, () => {
      assert.equal(closingOf(compose(high, null, []).section.content), 'No news found for any stock, including the '
        + 'biggest moves: Salesforce down 12.00%, Advanced Micro Devices up 10.00%.', value);
    });
  }
});

test('Step 9AR Build 6: ties keep table order; at most five named, then "and N others"', () => {
  const moves = {NVDA: 4, MSFT: -4, AAPL: 9, AMD: 8, CRM: 7, PLTR: 6, VRSK: 5, META: 3.5};
  const input = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL', 'AMD', 'CRM', 'PLTR', 'VRSK', 'META'], moves});
  assert.equal(closingOf(compose(input, null, []).section.content), 'No news found for any stock, including the '
    + 'biggest moves: Apple up 9.00%, Advanced Micro Devices up 8.00%, Salesforce up 7.00%, Palantir Technologies '
    + 'up 6.00%, Verisk Analytics up 5.00%, and 3 others.');
  const six = tableInput({myStocks: ['NVDA', 'MSFT'], watchlist: ['AAPL', 'AMD', 'CRM', 'PLTR'],
    moves: {NVDA: 4, MSFT: -4, AAPL: 9, AMD: 8, CRM: 7, PLTR: 6}});
  assert.match(closingOf(compose(six, null, []).section.content),
    /Palantir Technologies up 6\.00%, NVIDIA up 4\.00%, and 1 other\.$/);
  const tie = tableInput({myStocks: ['NVDA', 'MSFT'], moves: {NVDA: 4, MSFT: -4}});
  assert.equal(closingOf(compose(tie, null, []).section.content), 'No news found for any stock: NVIDIA up 4.00%, '
    + 'Microsoft down 4.00%.');
});

test('Step 9AR Build 6: one named among several uses "move"; every uncovered stock named drops "including"', () => {
  const input = tableInput({myStocks: ['NVDA', 'MSFT', 'AAPL'], linked: ['NVDA'], moves: {MSFT: -5, AAPL: 1}});
  const composed = compose(input, 'NVIDIA rose after its company news, Yahoo Finance reported.', ['NVDA']);
  assert.equal(closingOf(composed.section.content),
    'No news found for the other stocks, including the biggest move: Microsoft down 5.00%.');
  const all = tableInput({myStocks: ['NVDA', 'MSFT', 'AAPL'], linked: ['NVDA'], moves: {MSFT: -5, AAPL: 4}});
  assert.equal(closingOf(compose(all, 'NVIDIA rose after its company news, Yahoo Finance reported.', ['NVDA'])
    .section.content), 'No news found for the other stocks: Microsoft down 5.00%, Apple up 4.00%.');
});

test('Step 9AR Build 6: singular forms (price records on), and the OTHERS form with records off', async () => {
  const one = tableInput({myStocks: ['PLTR'], moves: {PLTR: 3.48}});
  assert.equal(closingOf(compose(one, null, []).section.content), 'No news found for this stock: Palantir Technologies up 3.48%.');
  const two = tableInput({myStocks: ['NVDA', 'PLTR'], linked: ['NVDA'], moves: {PLTR: 3.48}});
  const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
  assert.equal(closingOf(compose(two, reason, ['NVDA']).section.content),
    'No news found for the other stock: Palantir Technologies up 3.48%.');
  await withEnvs({SECTION_FOUR_PRICE_RECORD_ENABLED: 'off'}, () => {
    assert.equal(closingOf(compose(one, null, []).section.content),
      'No news found for any stock: Palantir Technologies up 3.48%.');
    assert.equal(closingOf(compose(two, reason, ['NVDA']).section.content),
      'No news found for the other stocks: Palantir Technologies up 3.48%.');
  });
});

test('Step 9AR Build 6: no-price rows and Trading "*" rows are never named; a missing name uses the ticker', () => {
  const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM'], missing: ['NVDA'], moves: {AMD: 5, CRM: -6}});
  assert.equal(closingOf(compose(input, null, []).section.content), 'No news found for any stock, including the '
    + 'biggest moves: Salesforce down 6.00%, Advanced Micro Devices up 5.00%.');
  const rows = sectionFourTableRows(input);
  const star = rows.map(row => row.symbol === 'CRM' ? {...row, closeFallback: true} : row);
  assert.equal(sectionFourClosingText('ALL', star),
    'No news found for any stock, including the biggest move: Advanced Micro Devices up 5.00%.');
  const nameless = rows.map(row => row.symbol === 'AMD' ? {...row, nameCell: 'Not available'} : row);
  assert.match(sectionFourClosingText('ALL', nameless), /AMD up 5\.00%\.$/);
  const flat = rows.map(row => ({...row, price: {...row.price, change: 0}}));
  assert.equal(sectionFourClosingText('ALL', flat), SECTION_FOUR_NO_NEWS_ALL);
});

test('Step 9AR Build 6: the direction is the table arrow (sign of the change), the figure the bracket', () => {
  const input = tableInput({myStocks: ['AMD'], moves: {AMD: -7.5}});
  const table = compose(input, null, []).section.content.split('\n\n')[0];
  assert.match(table, /Advanced Micro Devices \| AMD \| \$92\.50 \| ↓ 7\.50 \(7\.50%\)/);
  assert.match(closingOf(compose(input, null, []).section.content), /Advanced Micro Devices down 7\.50%\.$/);
});

test('Step 9AR Build 6: every big-move form passes the report wording, cause and leak checks', () => {
  const lines = [
    'No news found for the other stocks, including the biggest moves: Advanced Micro Devices up 11.04%, Salesforce down 3.94%.',
    'No news found for any stock, including the biggest move: Palantir Technologies up 3.48%.',
    'No news found for the other stock: Palantir Technologies up 3.48%.',
    'No news found for this stock: Palantir Technologies up 3.48%.',
    'No news found for the other stocks: A up 9.00%, B down 8.00%, C up 7.00%, D down 6.00%, E up 5.00%, and 2 others.'
  ];
  for (const line of lines) {
    assert.equal(hasMalformedPlainEnglishProse(line), false, line);
    assert.equal(hasActiveDirectMarketCausalClaim(line), false, line);
    assert.equal(hasInternalIdentifierLeak(line), false, line);
    assert.equal(splitReportSentences(line).length, 1, line);
    assert.ok(isSectionFourClosingLine(line), line);
  }
});

test('Step 9AR Build 6: the shared check knows each kind; big-move forms only while the switch is on', async () => {
  assert.equal(sectionFourClosingKind('No news found for the other stocks: X up 3.00%.'), 'OTHERS');
  assert.equal(sectionFourClosingKind('No news found for the other stock: X up 3.00%.'), 'OTHER');
  assert.equal(sectionFourClosingKind('No news found for any stock, including the biggest moves: X up 3.00%, Y up 3.10%.'), 'ALL');
  assert.equal(sectionFourClosingKind('No news found for this stock: X up 3.00%.'), 'THIS');
  assert.equal(sectionFourClosingKind('No news found for the other stocks.'), null);
  assert.equal(sectionFourClosingKind('Microsoft rose after its company news.'), null);
  for (const fixed of [SECTION_FOUR_NO_NEWS_ALL, SECTION_FOUR_NO_NEWS_OTHERS, SECTION_FOUR_NO_NEWS_THIS, SECTION_FOUR_NO_NEWS_OTHER]) {
    assert.ok(isSectionFourClosingLine(fixed));
  }
  await withEnvs({[ON_ENV]: 'off'}, () => {
    assert.equal(sectionFourClosingKind('No news found for the other stocks: X up 3.00%.'), null);
    assert.equal(sectionFourClosingKind(SECTION_FOUR_NO_NEWS_OTHERS), 'OTHERS');
  });
});

test('Step 9AR Build 6: a table-only Section 4 with a big-move line is still table-only', async () => {
  const input = tableInput({myStocks: ['AMD', 'CRM'], moves: {AMD: 5, CRM: 1}});
  const content = compose(input, null, []).section.content;
  assert.match(closingOf(content), /^No news found for any stock, including the biggest move: /);
  assert.equal(isSectionFourTableOnly(content), true);
  const one = compose(tableInput({myStocks: ['AMD'], moves: {AMD: 5}}), null, []).section.content;
  assert.equal(isSectionFourTableOnly(one), true);
  await withEnvs({SECTION_FOUR_PRICE_RECORD_ENABLED: 'off'}, () => {
    assert.equal(isSectionFourTableOnly(compose(tableInput({myStocks: ['AMD'], moves: {AMD: 5}}), null, []).section.content), true);
  });
});

// ---------------------------------------------------------------------------- 9AQ pointer and log line

test('Step 9AR Build 6: a pointed stock is covered and drops out; the pointer reads the new line, never doubles it', () => {
  const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM'], linked: ['NVDA'], moves: {AMD: 11.04, CRM: -3.94},
    focus: ['Advanced Micro Devices']});
  const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
  const section = compose(input, reason, ['NVDA']).section;
  assert.match(closingOf(section.content), /Advanced Micro Devices up 11\.04%, Salesforce down 3\.94%\.$/);
  const sectionThree = {content: 'Advanced Micro Devices led chip shares.', evidenceRefs: ['e4']};
  const stocks = stocksFor(input, section);
  const result = sectionFourFocusPointers(section, sectionThree, input, stocks, splitReportSentences);
  const parts = result.content.split('\n\n');
  assert.deepEqual(parts.slice(1), [`${reason}\nAdvanced Micro Devices: see Stocks & Sectors in Focus.`,
    'No news found for the other stock: Salesforce down 3.94%.']);
  assert.equal(result.pointerCount, 1);
  const again = sectionFourFocusPointers({...section, content: result.content}, sectionThree, input, stocks,
    splitReportSentences);
  assert.equal(again, null);
  const summary = sectionFourTableSummary(result.content, input, stocks, splitReportSentences);
  assert.equal(summary.closingLine, 'OTHER');
  assert.equal(summary.explainedStocks, 1);
  assert.deepEqual([summary.bigMoverCount, summary.bigMoverNamed, summary.bigMoverSkipped], [1, 1, undefined]);
});

test('Step 9AR Build 6: under the word cap the pointer keeps priority and the closing line falls back', () => {
  const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM', 'PLTR'], linked: ['NVDA'],
    moves: {AMD: 11.04, CRM: -3.94, PLTR: 3.48}, focus: ['Advanced Micro Devices']});
  const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
  const section = compose(input, reason, ['NVDA']).section;
  const sectionThree = {content: 'Advanced Micro Devices led chip shares.', evidenceRefs: ['e4']};
  const stocks = stocksFor(input, section);
  const fits = text => !closingOf(text).startsWith('No news found');
  const result = sectionFourFocusPointers(section, sectionThree, input, stocks, splitReportSentences, fits);
  assert.equal(result.pointerCount, 1);
  assert.equal(closingOf(result.content), SECTION_FOUR_NO_NEWS_OTHERS);
  const summary = sectionFourTableSummary(result.content, input, stocks, splitReportSentences);
  assert.deepEqual([summary.closingLine, summary.bigMoverCount, summary.bigMoverNamed, summary.bigMoverSkipped],
    ['OTHERS', 2, 0, 'WORD_CAP']);
});

test('Step 9AR Build 6: switch off, the pointer and the log line are exactly as before (no new log field)', async () => {
  await withEnvs({[ON_ENV]: 'off'}, () => {
    const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM'], linked: ['NVDA'], moves: {AMD: 11.04, CRM: -3.94},
      focus: ['Advanced Micro Devices']});
    const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
    const section = compose(input, reason, ['NVDA']).section;
    assert.equal(closingOf(section.content), SECTION_FOUR_NO_NEWS_OTHERS);
    const stocks = stocksFor(input, section);
    const result = sectionFourFocusPointers(section, {content: 'AMD led.', evidenceRefs: ['e4']}, input, stocks,
      splitReportSentences);
    assert.equal(closingOf(result.content), SECTION_FOUR_NO_NEWS_OTHER);
    const summary = sectionFourTableSummary(result.content, input, stocks, splitReportSentences);
    assert.deepEqual(Object.keys(summary), ['rows', 'myStocksRows', 'watchlistRows', 'notAvailableRows',
      'closeFallbackRows', 'newsStocks', 'explainedStocks', 'closingLine']);
  });
});

// ------------------------------------------------------------------------------- through the pipeline

for (const model of ['haiku-4.5', 'haiku-5.5']) {
  nodeTest(`Step 9AR Build 6: ${model}, all six states: the closing line names the big move; off is today's line`, async () => {
    for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
      let input;
      let output;
      let expected;
      if (overlayAsOf) {
        const quote = createEvidenceItem({sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
          title: 'Salesforce quote', summary: 'Salesforce quote.', canonicalUrl: 'https://finance.yahoo.com/quote/CRM/',
          publishedAt: '2026-09-08T11:00:00.000Z', symbols: ['CRM']});
        input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, additionalItems: [quote],
          stockSnapshots: [stockSnapshot('CRM', marketState, marketState === 'REGULAR'
            ? {close: 100, previousClose: 99, overlay: {asOf: overlayAsOf, lastPrice: 104.25}}
            : {close: 95.5, previousClose: 100})],
          portfolioContext: {myStocks: [{market: 'US', symbol: 'CRM', telemetryRefs: ['t2'],
            evidenceRefs: ['e3'], upcomingEvents: []}], watchlist: []}});
        output = normalOutput(input, {furtherReadings: ['e1']});
        output.sections[3] = {...output.sections[3], content: null, evidenceRefs: [], telemetryRefs: [],
          uncertainties: []};
        expected = marketState === 'REGULAR' ? 'No news found for this stock: Salesforce up 4.25%.'
          : 'No news found for this stock: Salesforce down 4.50%.';
      } else {
        input = tableInput({myStocks: ['NVDA', 'MSFT'], linked: ['NVDA'], marketState, moves: {MSFT: -4.5}});
        output = outputWithSectionFour(input, 'NVIDIA rose after its company news, Yahoo Finance reported.', ['NVDA']);
        expected = 'No news found for the other stock: Microsoft down 4.50%.';
      }
      const on = await invoke(input, output, {CLAUDE_MODEL: model});
      assert.equal(on.result.type, 'SUCCESS', `${marketState} ${on.result.message}`);
      assert.equal(closingOf(on.result.output.sections[3].content), expected, marketState);
      assert.equal(validateClaudeAnalysisOutput(on.result.output, input).valid, true, marketState);
      assert.deepEqual([on.table.bigMoverCount, on.table.bigMoverNamed, on.table.bigMoverSkipped], [1, 1, undefined],
        marketState);
      const off = await invoke(input, output, {CLAUDE_MODEL: model, [ON_ENV]: 'off'});
      assert.equal(off.result.type, 'SUCCESS', `${marketState} off ${off.result.message}`);
      const fixed = overlayAsOf ? SECTION_FOUR_NO_NEWS_THIS : SECTION_FOUR_NO_NEWS_OTHER;
      assert.equal(closingOf(off.result.output.sections[3].content), fixed, marketState);
      assert.equal(off.result.output.sections[3].content.replace(/\n\n[^\n]*$/, ''),
        on.result.output.sections[3].content.replace(/\n\n[^\n]*$/, ''), marketState);
      assert.equal('bigMoverCount' in off.table, false, marketState);
      const strip = value => JSON.stringify(value.filter(entry => entry.stage !== 'sectionFourTable'),
        (key, inner) => /Ms$/.test(key) ? undefined : inner);
      assert.equal(strip(off.diagnostics), strip(on.diagnostics), marketState);
    }
  });
}

test('Step 9AR Build 6: a big-move line that would break the word cap falls back to the fixed line', async () => {
  const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM', 'PLTR'], linked: ['NVDA'],
    moves: {AMD: 11.04, CRM: -3.94, PLTR: 3.48}});
  const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
  const base = outputWithSectionFour(input, reason, ['NVDA']);
  const unit = 'Prices held near there.';
  const run = async count => {
    const padded = structuredClone(base);
    if (count > 0) padded.sections[4].content = `${padded.sections[4].content} ${Array(count).fill(unit).join(' ')}`;
    return invoke(input, padded);
  };
  const isBig = outcome => typeof outcome.result.output?.sections?.[3]?.content === 'string'
    && closingOf(outcome.result.output.sections[3].content).startsWith('No news found');
  // Pad Section 5 with a repeated 4-word sentence and find the first padding where the big-move line no
  // longer fits: there the report keeps today's line, Section 5 stays whole and the report is valid.
  assert.ok(isBig(await run(0)));
  let low = 0;
  let high = 700;
  assert.equal(isBig(await run(high)), false);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (isBig(await run(middle))) low = middle; else high = middle;
  }
  const fallback = await run(high);
  assert.equal(fallback.result.type, 'SUCCESS', fallback.result.message);
  assert.equal(closingOf(fallback.result.output.sections[3].content), SECTION_FOUR_NO_NEWS_OTHERS);
  assert.ok(fallback.result.output.sections[4].content.endsWith(unit), 'Section 5 is not blanked');
  assert.equal(fallback.result.output.status, 'NORMAL');
  assert.equal(validateClaudeAnalysisOutput(fallback.result.output, input).valid, true);
  assert.deepEqual([fallback.table.bigMoverCount, fallback.table.bigMoverNamed, fallback.table.bigMoverSkipped],
    [3, 0, 'WORD_CAP']);
  // The big-move line is about 12 words longer than today's line, so it falls back within that range.
  const kept = await run(low);
  assert.match(closingOf(kept.result.output.sections[3].content), /Palantir Technologies up 3.48%.$/);
  assert.equal(validateClaudeAnalysisOutput(kept.result.output, input).valid, true);
});

// Step 9AR Build 6 word-cap fix (strict proof Group B): on a completed day the Section 1 since-close line is
// added after the Section 4 table. Near the cap the big-move line must never take its room: when both do not
// fit, Section 4 falls back to today's line and the since-close line stays, exactly as with the switch off.
for (const marketState of ['CLOSED', 'WEEKEND']) {
  test(`Step 9AR Build 6: near the word cap the since-close line keeps priority over the big-move line (${marketState})`, async () => {
    const input = tableInput({myStocks: ['NVDA', 'AMD', 'CRM', 'PLTR', 'VRSK'], linked: ['NVDA'], marketState,
      moves: {AMD: 11.04, CRM: -3.94, PLTR: 3.48, VRSK: -3.25}});
    const reason = 'NVIDIA rose after its company news, Yahoo Finance reported.';
    const base = outputWithSectionFour(input, reason, ['NVDA']);
    const unit = 'Prices held near there.';
    const sinceClose = 'No new market news has been published since the close';
    const run = async (count, env = {}) => {
      const padded = structuredClone(base);
      if (count > 0) padded.sections[4].content = `${padded.sections[4].content} ${Array(count).fill(unit).join(' ')}`;
      return invoke(input, padded, env);
    };
    const isBig = outcome => closingOf(outcome.result.output.sections[3].content).startsWith('No news found');
    const off = {[ON_ENV]: 'off'};
    assert.ok((await run(0, off)).result.output.sections[0].content.startsWith(sinceClose), 'the fixture adds the since-close line');
    assert.ok(isBig(await run(0)));
    let low = 0;
    let high = 700;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (isBig(await run(middle))) low = middle; else high = middle;
    }
    // Around the switch-over, every section but Section 4 matches the switch off, the report stays valid,
    // and the since-close line is present whenever the switch-off report has it.
    let fellBackWithLine = false;
    for (let count = Math.max(0, high - 8); count <= high + 2; count++) {
      const on = await run(count);
      const plain = await run(count, off);
      assert.equal(on.result.type, 'SUCCESS', on.result.message);
      for (let index = 0; index < 8; index++) {
        if (index !== 3) assert.deepEqual(on.result.output.sections[index], plain.result.output.sections[index], `padding ${count} section ${index + 1}`);
      }
      assert.equal(on.result.output.status, plain.result.output.status);
      assert.equal(validateClaudeAnalysisOutput(on.result.output, input).valid, true);
      if (!isBig(on)) {
        assert.equal(on.result.output.sections[3].content, plain.result.output.sections[3].content);
        assert.equal(on.table.bigMoverSkipped, 'WORD_CAP');
        if (on.result.output.sections[0].content.startsWith(sinceClose)) fellBackWithLine = true;
      }
    }
    assert.ok(fellBackWithLine, 'a padding exists where Section 4 falls back and the since-close line stays');
  });
}

test('Step 9AR Build 6: the fixed-closing helper swaps only a big-move closing line', () => {
  const input = tableInput({myStocks: ['AMD', 'CRM'], moves: {AMD: 5}});
  const content = compose(input, null, []).section.content;
  assert.equal(closingOf(sectionFourWithFixedClosing(content)), SECTION_FOUR_NO_NEWS_ALL);
  assert.equal(sectionFourWithFixedClosing(content).split('\n\n').slice(0, -1).join('\n\n'),
    content.split('\n\n').slice(0, -1).join('\n\n'));
  const plain = compose(tableInput({myStocks: ['AMD', 'CRM'], moves: {AMD: 1}}), null, []).section.content;
  assert.equal(sectionFourWithFixedClosing(plain), null);
  assert.equal(sectionFourWithFixedClosing(null), null);
  assert.equal(sectionFourWithFixedClosing(content, {env: {[ON_ENV]: 'off'}}), null);
});

test('Step 9AR Build 6: a Section 4 that breaks a rule keeps the table and gets the big-move line', async () => {
  const input = tableInput({myStocks: ['NVDA', 'AMD'], linked: ['NVDA'], moves: {AMD: 6}});
  const output = outputWithSectionFour(input,
    'NVIDIA rose after its company news in broadMarketFocus, Yahoo Finance reported.', ['NVDA']);
  const {result} = await invoke(input, output);
  assert.equal(result.type, 'SUCCESS', result.message);
  const content = result.output.sections[3].content;
  assert.ok(typeof content === 'string');
  assert.equal(closingOf(content), 'No news found for any stock, including the biggest move: Advanced Micro Devices up 6.00%.');
  assert.equal(isSectionFourTableOnly(content), true);
});

test('Step 9AR Build 6: the explanations helper is unchanged by the new line (it is never an explanation)', () => {
  const input = tableInput({myStocks: ['AMD', 'CRM'], moves: {AMD: 5}});
  const content = compose(input, null, []).section.content;
  const stocks = stocksFor(input, {evidenceRefs: []});
  assert.deepEqual(sectionFourExplanations(closingOf(content), stocks, splitReportSentences).explainedSymbols, []);
});

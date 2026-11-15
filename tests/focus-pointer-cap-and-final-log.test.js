// Step 9AQ.1: two small fixes found by the 9AQ Group B proof.
// 1. Each Section 4 focus pointer is judged against the report word cap on its own, in order: one that
//    fits is added, one that would break the cap is skipped, later ones are still tried. The report never
//    goes over the cap and the closing line follows the stocks actually covered.
// 2. The counts-only wording log is written once, on the finished report after any section retry.
// No new setting. Free tests only: made-up data, no network, no paid call. No existing test is edited.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  REPORT_SECTION_NAMES,
  splitReportSentences
} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {sectionFourFocusPointers, sectionFourPriceRecordOn} = require('../lib/section-rules');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {MARKET_STATE_CASES, marketStateCase, anthropicResponse} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED', 'SECTION_FOUR_BOTH_LISTS_ENABLED',
  'READER_WORDING_ENABLED', 'SECTION_FOUR_FOCUS_POINTER_ENABLED', 'SECTION_THREE_NO_REPEAT_ENABLED',
  'WRITER_SECTION_RETRY_ENABLED', 'WRITER_RETRY_GUIDANCE_ENABLED'];
const H55 = {CLAUDE_MODEL: 'haiku-5.5'};
const CAP = 2500;

async function withEnvs(values, callback) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

async function runWriter(input, replies, env = H55) {
  const diagnostics = [];
  let calls = 0;
  const result = await withEnvs(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => {
      const next = replies[Math.min(calls, replies.length - 1)];
      calls++;
      return anthropicResponse(next);
    }
  }));
  return {result, diagnostics, calls,
    pointerEvents: diagnostics.filter(value => value.stage === 'sectionFourFocusPointer'),
    wordingEvents: diagnostics.filter(value => value.stage === 'readerWordingResidue')};
}

// ---------------------------------------------------------------- fixture: four stocks, three named in focus

const NAMES = {MSFT: 'Microsoft Corporation', AAPL: 'Apple Inc.', AVGO: 'Broadcom Inc.', NVDA: 'NVIDIA Corporation'};
const FOCUS_COMPANIES = ['Microsoft', 'Apple', 'Broadcom'];

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' && evidenceCategory === 'news' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function stockSnapshot(symbol, marketState, name) {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: name, instrumentType: 'EQUITY', currency: 'USD', marketState,
    currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2, close, previousClose,
        volume: 1000 + index, asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance',
        validationState: 'VALIDATED'
      }))
  });
}

function fourStockInput() {
  const marketState = 'CLOSED';
  const myStocks = ['MSFT', 'AAPL'];
  const watchlist = ['AVGO', 'NVDA'];
  const symbols = myStocks.concat(watchlist);
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html', '2026-09-04T21:00:00Z', ['^GSPC']),
    item('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html', '2026-09-04T19:30:00Z'),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', [], 'monetary-policy'),
    item('us.cnbc', 'Microsoft, Apple and Broadcom lead technology shares after major company developments',
      'https://www.cnbc.com/2026/09/04/large-technology-leadership.html', '2026-09-04T19:00:00Z'),
    item('us.cnbc', 'Health-care shares advance on constructive industry developments',
      'https://www.cnbc.com/2026/09/04/health-care-sector-advances.html', '2026-09-04T19:15:00Z')
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
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {
        benchmarkSnapshots: [stockSnapshot('^GSPC', marketState, 'S&P 500')],
        stockSnapshots: symbols.map(symbol => stockSnapshot(symbol, marketState, NAMES[symbol]))
      },
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'], supportingEvidence: ['e2', 'e3', 'e4', 'e5'],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: FOCUS_COMPANIES.map(name => ({kind: 'COMPANY', name}))},
          {evidenceRef: 'e5', subjects: [{kind: 'SECTOR', name: 'Health-care'}]}
        ],
        unresolvedGaps: [],
        furtherReadings: ['e1', 'e2', 'e4', 'e5'].map(evidenceRef => ({evidenceRef, sessionDate: '2026-09-04'}))
      }
    }],
    portfolioContext: {myStocks: myStocks.map(security), watchlist: watchlist.map(security)}
  });
}

function replyFor(input, evidenceGap = '') {
  const output = supportedOutput(input);
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: []};
  if (evidenceGap) output.evidenceGaps = [...output.evidenceGaps, evidenceGap];
  return output;
}

// Words the cap counts, worked out here on its own: every section's text and uncertainties plus the
// report gaps, minus the Section 4 price table (the first paragraph of Section 4).
function capWords(output) {
  const parts = output.sections.flatMap(section => [typeof section.content === 'string' ? section.content : '',
    ...(Array.isArray(section.uncertainties) ? section.uncertainties : [])]).concat(output.evidenceGaps);
  const words = text => text.trim().split(/\s+/).filter(Boolean).length;
  const table = String(output.sections[3].content || '').split('\n\n')[0];
  return words(parts.join(' ')) - words(table);
}
const pad = count => (count <= 0 ? '' : `${'word '.repeat(count).trim()}.`);
const wordCount = text => text.trim().split(/\s+/).filter(Boolean).length;

// Four table stocks: with k pointers added, 4 - k are left, so the closing line is singular only for one left.
const OTHERS = left => (sectionFourPriceRecordOn() && left === 1 ? 'No material news for the other stock.' : 'No material news for the other stocks.');

// The pointer lines of a finished Section 4, and its closing line.
function pointerLines(output) {
  const parts = output.sections[3].content.split('\n\n').slice(1);
  return parts.join('\n').split('\n').filter(line => line.endsWith(': see Stocks & Sectors in Focus.'));
}
function closingLine(output) {
  const parts = output.sections[3].content.split('\n\n');
  const last = parts[parts.length - 1];
  return /^No material news /.test(last) ? last : null;
}

// ---------------------------------------------------------------- the word cap, one pointer at a time

test('Step 9AQ.1: no new setting; the two fixes sit behind the existing switches', () => {
  assert.equal(SETTINGS_REGISTRY.sectionFourFocusPointerEnabled.envVar, 'SECTION_FOUR_FOCUS_POINTER_ENABLED');
  assert.equal(SETTINGS_REGISTRY.readerWordingEnabled.envVar, 'READER_WORDING_ENABLED');
  assert.equal(Object.keys(SETTINGS_REGISTRY).filter(name => /^(9aq1|pointerCap|wordingLogFinal)/i.test(name)).length, 0);
});

// The cap is judged by the product on the whole report. For each room (words left under the cap before
// any pointer), run the real writer path and check what happened.
async function runWithRoom(room) {
  const input = fourStockInput();
  const baseline = await runWriter(input, [replyFor(input)], {...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'});
  assert.equal(baseline.result.type, 'SUCCESS', baseline.result.message);
  const base = capWords(baseline.result.output);
  // `room` is measured against the report as it stands with every pointer off (closing "all stocks").
  const gap = pad(CAP - base - room);
  const reply = replyFor(input, gap);
  const off = await runWriter(input, [reply], {...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'});
  const on = await runWriter(input, [reply]);
  assert.equal(off.result.type, 'SUCCESS', off.result.message);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  assert.equal(capWords(off.result.output), CAP - room);
  return {input, off, on};
}

test('Step 9AQ.1: with all three pointers wanted, a report with plenty of room gets all three and the "other stock" closing line', async () => {
  const {input, on} = await runWithRoom(60);
  const lines = pointerLines(on.result.output);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => line.split(':')[0]).length, 3);
  assert.equal(closingLine(on.result.output), OTHERS(1));
  assert.equal(on.pointerEvents[0].action, 'ADDED');
  assert.equal(on.pointerEvents[0].pointerCount, 3);
  assert.equal(on.pointerEvents[0].skippedForWordCap, undefined);
  assert.ok(capWords(on.result.output) <= CAP);
  assert.equal(validateClaudeAnalysisOutput(on.result.output, input).valid, true);
});

test('Step 9AQ.1: the pointers cost what the test says; each is judged on its own against the cap', async () => {
  // Work out each pointer\'s cost from a roomy run, then drive the real cap with exact rooms.
  const {on} = await runWithRoom(60);
  const lines = pointerLines(on.result.output);
  const costs = lines.map(wordCount);
  const closingWords = wordCount(closingLine(on.result.output));
  const allStocksWords = wordCount('No material news for all stocks.');
  // Words added over the pointer-off report by the first k pointers (the closing line changes too).
  const extra = k => costs.slice(0, k).reduce((a, b) => a + b, 0) + closingWords - allStocksWords;
  const rooms = {zero: extra(1) - 1, one: extra(1), two: extra(2), three: extra(3)};

  const expected = {zero: 0, one: 1, two: 2, three: 3};
  for (const [label, room] of Object.entries(rooms)) {
    const run = await runWithRoom(room);
    const added = pointerLines(run.on.result.output);
    assert.equal(added.length, expected[label], `room for ${label} pointers (${room} words)`);
    assert.deepEqual(added, lines.slice(0, expected[label]), `${label}: first ones kept, in order`);
    assert.ok(capWords(run.on.result.output) <= CAP, `${label}: never over the cap`);
    assert.equal(validateClaudeAnalysisOutput(run.on.result.output, run.input).valid, true);
    if (expected[label] === 0) {
      // None fit: the report is the pointer-off report, old closing line kept.
      assert.deepEqual(run.on.result.output.sections[3], run.off.result.output.sections[3]);
      assert.equal(run.on.pointerEvents[0].action, 'SKIPPED_WORD_CAP');
      assert.equal(closingLine(run.on.result.output), 'No material news for all stocks.');
    } else {
      assert.equal(run.on.pointerEvents[0].action, 'ADDED');
      assert.equal(run.on.pointerEvents[0].pointerCount, expected[label]);
      assert.equal(closingLine(run.on.result.output), OTHERS(4 - expected[label]));
      if (expected[label] < 3) assert.equal(run.on.pointerEvents[0].skippedForWordCap, 3 - expected[label]);
    }
  }
});

test('Step 9AQ.1: exactly at the cap is allowed; one word over the room skips that pointer', async () => {
  const {on} = await runWithRoom(60);
  const costs = pointerLines(on.result.output).map(wordCount);
  const closingWords = wordCount(closingLine(on.result.output));
  const delta = closingWords - wordCount('No material news for all stocks.');
  const exactTwo = costs[0] + costs[1] + delta;
  const atCap = await runWithRoom(exactTwo);
  assert.equal(pointerLines(atCap.on.result.output).length, 2);
  assert.equal(capWords(atCap.on.result.output), CAP, 'lands exactly on the cap');
  const oneShort = await runWithRoom(exactTwo - 1);
  assert.equal(pointerLines(oneShort.on.result.output).length, 1, 'one fits but not two');
  assert.ok(capWords(oneShort.on.result.output) <= CAP);
});

// A pointer that is too long is skipped but a shorter one after it is still tried (function level,
// with made-up lengths: the long name comes first).
test('Step 9AQ.1: a pointer that does not fit is skipped and a later one that does fit is still added', () => {
  const input = fourStockInput();
  const table = 'Stock | Ticker | Last Price | Change\nMy Stocks\nMicrosoft | MSFT | $105.00 | ↑ 3.00 (2.94%)\n'
    + 'Apple | AAPL | $105.00 | ↑ 3.00 (2.94%)\nWatchlist\nBroadcom | AVGO | $105.00 | ↑ 3.00 (2.94%)\n'
    + 'NVIDIA | NVDA | $105.00 | ↑ 3.00 (2.94%)\nPrices at the close on Fri 4 Sep.';
  const section = {content: `${table}\n\nNo material news for all stocks.`, evidenceRefs: [], telemetryRefs: []};
  const three = {content: 'Large technology companies led shares.', evidenceRefs: ['e4']};
  const nonTable = text => wordCount(text.split('\n\n').slice(1).join(' '));
  const all = sectionFourFocusPointers(section, three, input, [], splitReportSentences, () => true);
  assert.equal(all.pointerCount, 3);
  const lines = all.content.split('\n\n')[1].split('\n');
  // A limit that fits the 2nd and 3rd pointers only if the 1st is skipped is impossible with equal-sized
  // names, so make the limit fit exactly pointer 2 alone: only that one passes when pointer 1 is refused.
  const refuseFirst = text => !text.includes(lines[0]);
  const result = sectionFourFocusPointers(section, three, input, [], splitReportSentences, refuseFirst);
  assert.equal(result.pointerCount, 2);
  assert.deepEqual(result.content.split('\n\n')[1].split('\n'), [lines[1], lines[2]]);
  assert.equal(result.wantedPointerCount, 3);
  assert.ok(nonTable(result.content) > 0);
});

test('Step 9AQ.1: a single pointer is judged as before (added when it fits; report unchanged when it does not)', () => {
  const input = fourStockInput();
  const row = (name, ticker) => `${name} | ${ticker} | $105.00 | ↑ 3.00 (2.94%)`;
  const table = ['Stock | Ticker | Last Price | Change', 'My Stocks', row('Microsoft', 'MSFT'), row('Apple', 'AAPL'),
    'Watchlist', row('Broadcom', 'AVGO'), row('NVIDIA', 'NVDA'), 'Prices at the close on Fri 4 Sep.'].join('\n');
  const section = {content: `${table}\n\nNo material news for all stocks.`, evidenceRefs: [], telemetryRefs: []};
  const cited = {content: 'Large technology companies led shares.', evidenceRefs: ['e4']};
  const onlyOne = text => text.split('\n').filter(line => line.endsWith(': see Stocks & Sectors in Focus.')).length <= 1;
  const one = sectionFourFocusPointers(section, cited, input, [], splitReportSentences, onlyOne);
  assert.equal(one.pointerCount, 1);
  assert.equal(one.wantedPointerCount, 3);
  assert.equal(one.content.split('\n\n')[1], 'Microsoft: see Stocks & Sectors in Focus.');
  const refused = sectionFourFocusPointers(section, cited, input, [], splitReportSentences, () => false);
  assert.equal(refused.unchanged, true);
  assert.equal(refused.pointerCount, 0);
  assert.equal(refused.content, section.content);
});

test('Step 9AQ.1: with the pointer switch off the report and the log are the 9AP ones', async () => {
  const input = fourStockInput();
  const reply = replyFor(input);
  const off = await runWriter(input, [reply], {...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'});
  assert.equal(off.pointerEvents.length, 0);
  assert.equal(pointerLines(off.result.output).length, 0);
  assert.equal(closingLine(off.result.output), 'No material news for all stocks.');
  const four = await runWriter(input, [reply], {CLAUDE_MODEL: 'haiku-4.5'});
  assert.equal(four.pointerEvents.length, 0);
  assert.equal(four.wordingEvents.length, 0);
});

// ---------------------------------------------------------------- the wording log, once, on the finished report

function closedCase() {
  const entry = MARKET_STATE_CASES.find(candidate => candidate[0] === 'CLOSED');
  return marketStateCase(...entry);
}

const FILLED_TEXT = ' The rebound came from the jobs report. The jobs report is not a cause of the move.'
  + ' The package lists a gain. Investors will be watching what comes next.';

test('Step 9AQ.1: a section a retry filled is counted in the one wording log line, and the report text is untouched', async () => {
  const {input, output} = closedCase();
  const filled = structuredClone(output);
  filled.sections[4].content += FILLED_TEXT;
  const emptyFive = structuredClone(output);
  emptyFive.sections[4] = {...emptyFive.sections[4], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Nothing confirmed for this section.']};
  emptyFive.status = 'DEGRADED';
  emptyFive.evidenceGaps = ['Some sections had too little evidence.'];
  const run = await runWriter(input, [emptyFive, filled]);
  assert.equal(run.result.type, 'SUCCESS', run.result.message);
  assert.equal(run.calls, 2, 'one retry filled Section 5');
  assert.ok(run.result.output.sections[4].content.includes('The package lists a gain.'));
  assert.equal(run.wordingEvents.length, 1, 'written once');
  const entry = run.wordingEvents[0].sections.find(value => value.sectionIndex === 4);
  assert.deepEqual(entry, {sectionIndex: 4, readerWordCount: 1, contradictionCount: 1, closingFillerCount: 1});
  // Counts only: no report text.
  assert.doesNotMatch(JSON.stringify(run.wordingEvents[0]), /package|jobs|rebound|watching/);
});

test('Step 9AQ.1: with no retry the log is the same single line as before', async () => {
  const {input, output} = closedCase();
  const planted = structuredClone(output);
  planted.sections[0].content += ' Investors will be watching what comes next.';
  const run = await runWriter(input, [planted]);
  assert.equal(run.result.type, 'SUCCESS', run.result.message);
  assert.equal(run.wordingEvents.length, 1);
  assert.deepEqual(run.wordingEvents[0].sections,
    [{sectionIndex: 0, readerWordCount: 0, contradictionCount: 0, closingFillerCount: 1}]);
});

test('Step 9AQ.1: the log is silent with the wording switch off, on Haiku 4.5, and when the report is clean', async () => {
  const {input, output} = closedCase();
  const filled = structuredClone(output);
  filled.sections[4].content += FILLED_TEXT;
  const off = await runWriter(input, [filled], {...H55, READER_WORDING_ENABLED: 'off'});
  assert.equal(off.wordingEvents.length, 0);
  const four = await runWriter(input, [filled], {CLAUDE_MODEL: 'haiku-4.5'});
  assert.equal(four.wordingEvents.length, 0);
  const clean = await runWriter(input, [output]);
  assert.equal(clean.wordingEvents.length, 0);
  assert.deepEqual(off.result.output, (await runWriter(input, [filled])).result.output, 'the log never changes the report');
});

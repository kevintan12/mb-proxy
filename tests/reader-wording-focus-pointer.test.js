// Step 9AQ: reader wording, the Section 4 focus pointer and the Section 3 no-repeat sentence. Three
// Admin switches (readerWordingEnabled, sectionFourFocusPointerEnabled, sectionThreeNoRepeatEnabled),
// default on, all for Haiku 5.5 requests that carry the writing-depth block. Off, or any other
// model: the 9AP request and report byte for byte. Free tests only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  REPORT_SECTION_NAMES,
  splitReportSentences
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {sectionFourFocusPointers, sectionFourPriceRecordOn} = require('../lib/section-rules');
const {
  createCompletedRegularSession,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {supportedOutput} = require('./fixtures/us-market-brief-quality');
const {MARKET_STATE_CASES, marketStateCase, anthropicResponse} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED', 'SECTION_FOUR_BOTH_LISTS_ENABLED',
  'READER_WORDING_ENABLED', 'SECTION_FOUR_FOCUS_POINTER_ENABLED', 'SECTION_THREE_NO_REPEAT_ENABLED',
  'WRITER_SECTION_RETRY_ENABLED', 'WRITER_RETRY_GUIDANCE_ENABLED'];
const H55 = {CLAUDE_MODEL: 'haiku-5.5'};
const ALL_OFF = {READER_WORDING_ENABLED: 'off', SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off',
  SECTION_THREE_NO_REPEAT_ENABLED: 'off'};

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

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

// sha256 of JSON.stringify(writer request) at eb16f22 (the 9AP head), per fixture state, with the
// default environment: the default model, Haiku 4.5, Haiku 5.5 with the block (haiku55) and Haiku
// 5.5 with the block off (off55).
const BASELINE_9AP = Object.freeze({
  PRE: {default: 'cb7152d6210f8ae2d2564b8aef4bf345677e236897efc2af377b68529e654938',
    haiku45: 'cb7152d6210f8ae2d2564b8aef4bf345677e236897efc2af377b68529e654938',
    haiku55: '1e6d8d780ca513f1b5d24c84f16292fd1daa4c83e40e9c4cc600d275b8488a95',
    off55: '144ae0468900e3408a765e413e251db60e2f18f95c39a3092e6d6df71db3e7d3'},
  REGULAR: {default: 'f32cbc8b5a5d2602a6c4b37235ea8425407b025c5a4bfd7dd6a1654d47f0e9c1',
    haiku45: 'f32cbc8b5a5d2602a6c4b37235ea8425407b025c5a4bfd7dd6a1654d47f0e9c1',
    haiku55: 'acdd9421fe9b84412c7f3fa61ffd7237065a04c004fd16f40923cc4e3cd1feed',
    off55: '38ab56011ac6b41ffd61455550771f707229f4f9cb20a4d7a1821920cc2e5fea'},
  POST: {default: 'db94828b2d61ba1737376ac3ba99bbf9041bd5c9cb382cd6afe64264370b05b5',
    haiku45: 'db94828b2d61ba1737376ac3ba99bbf9041bd5c9cb382cd6afe64264370b05b5',
    haiku55: '9652f32157180b05aebd36dfb4350f3bc3b411e107b948bae5b25fe0647a533f',
    off55: 'bfa965e8c49a4b91a025af057a6fecad3e3d67d4b52e6bc1687ceaf2cbd408b5'},
  CLOSED: {default: '6703e94fb6ac42b4321a9701918e69ce6d6f1b19db9049bd529211d5e8e2a9c9',
    haiku45: '6703e94fb6ac42b4321a9701918e69ce6d6f1b19db9049bd529211d5e8e2a9c9',
    haiku55: 'ec76b04f09ad5d04d105c3cbaa9d715527e44ce40ba862ab9d84e61a515ded2f',
    off55: 'b6d4bb91118d8591f9eb8fa292d69bfdde69df343f501d506b81ff1d94965e14'},
  WEEKEND: {default: '95bb910a0a9c4ccef0aa600bd30851b2db717339590e8824b5e7cba041a51558',
    haiku45: '95bb910a0a9c4ccef0aa600bd30851b2db717339590e8824b5e7cba041a51558',
    haiku55: '44f6dbe0dcc7fa402e598590e0a34a59cb7e6b5d39d07051cbd7006ad3c2a191',
    off55: '629607e7bd111c669de7bb487ab9af73bdcbe257d8e7db288814375da0b85eeb'},
  HOLIDAY: {default: '7552a06d9c68874a2b896c9fb93fe2eb21886f7fe405a3e78b14ff18a9e7d5a4',
    haiku45: '7552a06d9c68874a2b896c9fb93fe2eb21886f7fe405a3e78b14ff18a9e7d5a4',
    haiku55: '53e08506253068ce6d84bf10b39e20905be4264fee6dc0e6fe32d6fa76e0e2fd',
    off55: '13df00fc7f48df4145a035550c3a10a8f718c62929d4b0adcc19a524b24d9de0'}
});

// An independent copy of the new wording (the code's constants are not imported).
const FINAL_LINE_START = ' All other rules still apply:';
const READER_WORDS_LINE = 'READER WORDS: write for someone who has never seen how this report was put together. Never write '
  + '"the package", "the supplied news", "the supplied data", "the evidence supplied", "the report '
  + 'ties", "the report lists" or "the report gives" (the report does nothing; say the fact), '
  + '"this section", "market-data article" or "market-data reference". Write the fact itself '
  + 'instead (for example "Nvidia rose 3%", not "the package lists a 3% rise"), and when something is '
  + 'not known say so in plain words (for example "no news article explains why").';
const CAUSE_LINE = 'CAUSE OR BACKGROUND, NEVER BOTH: describe each driver either as a cause or as background. Say a '
  + 'driver moved the market only when a cited principal catalyst supports it, in a sentence of its '
  + 'own. Otherwise give it as background with no cause words. Never write that a driver both explains '
  + 'a move and is "not a cause" or "not the cause" in the same section; if it is not a cause, leave '
  + 'out words such as "came from", "thanks to", "driven by" and "behind the rebound" for it.';
const ENDINGS_LINE = 'SECTION ENDINGS: end every section on its last supported fact or on what that fact means for an '
  + 'investor. Never finish a section with a general wrap-up such as the mood in general, "investors '
  + 'will be watching", "it remains to be seen" or "time will tell". On CLOSED, WEEKEND and HOLIDAY '
  + 'days the since-the-close paragraph, its pointer sentence and the fixed no-news sentence stay '
  + 'exactly as the earlier instructions require.';
const NO_REPEAT_LINE = 'The do-not-repeat rule also covers Section 3: a company or sector '
  + 'figure, or reason, already given in Section 3 is not restated in Sections 1, 2 or 5. Where the '
  + 'reader needs the link, refer back in a few words without naming a section number (for example '
  + '"as covered under Stocks & Sectors in Focus").';
const OLD_ONE = 'cite those index market-data references, and say plainly that the supplied news does not explain why';
const NEW_ONE = 'cite those index references, and say plainly that no news article explains why';
const OLD_TWO = 'write them for a reader who has never seen the package, for example';
const NEW_TWO = 'write them for a reader who knows nothing about how the report was built, for example';
const SHARED_REPEAT_LINE = 'do not repeat the same sentence or substantially identical explanation across Sections 1, 2, 5, 6, and 7.';

function count(text, part) {
  return text.split(part).length - 1;
}

async function requestFor(input, env) {
  return withEnvs(env, () => buildClaudeAnalysisRequest(input));
}

// ---------------------------------------------------------------- the settings

test('Step 9AQ: three Admin on/off switches, default on, each with its own environment name', () => {
  const expected = {
    readerWordingEnabled: 'READER_WORDING_ENABLED',
    sectionFourFocusPointerEnabled: 'SECTION_FOUR_FOCUS_POINTER_ENABLED',
    sectionThreeNoRepeatEnabled: 'SECTION_THREE_NO_REPEAT_ENABLED'
  };
  for (const [name, envVar] of Object.entries(expected)) {
    const entry = SETTINGS_REGISTRY[name];
    assert.equal(entry.boolean, true, name);
    assert.equal(entry.admin, 'Admin', name);
    assert.equal(entry.default, true, name);
    assert.equal(entry.envVar, envVar, name);
    assert.equal(entry.wired, true, name);
    assert.equal(settingValue(name, {env: {}}), true, name);
    for (const value of ['off', 'false', '0']) assert.equal(settingValue(name, {env: {[envVar]: value}}), false, name);
    for (const value of ['on', 'true', '1']) assert.equal(settingValue(name, {env: {[envVar]: value}}), true, name);
  }
});

// ---------------------------------------------------------------- the writer request

for (const [marketState, ...rest] of MARKET_STATE_CASES) {
  test(`Step 9AQ: ${marketState} -- Haiku 4.5 and Haiku 5.5 with the block off are the 9AP requests, with every switch on`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const baseline = BASELINE_9AP[marketState];
    assert.equal(fingerprint(await requestFor(input, {})), baseline.default, 'default model');
    assert.equal(fingerprint(await requestFor(input, {CLAUDE_MODEL: 'haiku-4.5'})), baseline.haiku45, 'Haiku 4.5');
    assert.equal(fingerprint(await requestFor(input, {...H55, HAIKU55_WRITER_DEPTH_ENABLED: 'off'})),
      baseline.off55, 'Haiku 5.5 block off');
    const four = (await requestFor(input, {CLAUDE_MODEL: 'haiku-4.5'})).system;
    for (const part of [READER_WORDS_LINE, CAUSE_LINE, ENDINGS_LINE, NO_REPEAT_LINE, NEW_ONE, NEW_TWO]) {
      assert.equal(four.includes(part), false);
    }
  });

  test(`Step 9AQ: ${marketState} -- Haiku 5.5 with the wording and no-repeat switches off is the 9AP request, byte for byte`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    assert.equal(fingerprint(await requestFor(input, {...H55, ...ALL_OFF})), BASELINE_9AP[marketState].haiku55);
    // The focus-pointer switch does not touch the request.
    const pointerOnly = await requestFor(input, {...H55, ...ALL_OFF, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'on'});
    assert.equal(fingerprint(pointerOnly), BASELINE_9AP[marketState].haiku55);
    // Either of the other two switches on does change it.
    const wordingOn = await requestFor(input, {...H55, ...ALL_OFF, READER_WORDING_ENABLED: 'on'});
    assert.notEqual(fingerprint(wordingOn), BASELINE_9AP[marketState].haiku55);
  });

  test(`Step 9AQ: ${marketState} -- the no-repeat switch adds exactly one sentence before the block's last line; the shared line is untouched`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const off = (await requestFor(input, {...H55, ...ALL_OFF})).system;
    const on = (await requestFor(input, {...H55, ...ALL_OFF, SECTION_THREE_NO_REPEAT_ENABLED: 'on'})).system;
    assert.equal(count(off, FINAL_LINE_START), 1);
    assert.equal(on, off.replace(FINAL_LINE_START, () => ` ${NO_REPEAT_LINE}${FINAL_LINE_START}`));
    assert.equal(count(on, NO_REPEAT_LINE), 1);
    assert.equal(count(on, SHARED_REPEAT_LINE), 1);
    assert.equal(count(on, 'Sections 1, 2, 5, 6, and 7'), 1);
  });

  test(`Step 9AQ: ${marketState} -- the reader-wording switch rewords two lines and adds three before the block's last line, nothing else`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const off = (await requestFor(input, {...H55, ...ALL_OFF})).system;
    const on = (await requestFor(input, {...H55, ...ALL_OFF, READER_WORDING_ENABLED: 'on'})).system;
    assert.equal(count(off, OLD_ONE), 1);
    assert.equal(count(off, OLD_TWO), 1);
    let expected = off.replace(OLD_ONE, () => NEW_ONE).replace(OLD_TWO, () => NEW_TWO);
    expected = expected.replace(FINAL_LINE_START,
      () => ` ${READER_WORDS_LINE} ${CAUSE_LINE} ${ENDINGS_LINE}${FINAL_LINE_START}`);
    assert.equal(on, expected);
    // The reworded lines no longer teach the words the reader must never see.
    assert.equal(on.includes('market-data references'), false);
    assert.equal(on.includes('never seen the package'), false);
    // The phrase an existing test pins is kept as it was.
    assert.equal(count(on, 'THIN EVIDENCE: a package with few articles and no principal catalyst'), 1);
    // Both switches on: both additions, in that order, still before the last line.
    const both = (await requestFor(input, H55)).system;
    assert.ok(both.indexOf(ENDINGS_LINE) < both.indexOf(NO_REPEAT_LINE));
    assert.ok(both.indexOf(NO_REPEAT_LINE) < both.indexOf(FINAL_LINE_START));
    assert.equal(count(both, READER_WORDS_LINE), 1);
  });
}

// ---------------------------------------------------------------- the Section 4 focus pointer

const NAMES = {MSFT: 'Microsoft Corporation', AAPL: 'Apple Inc.', AVGO: 'Broadcom Inc.', NVDA: 'NVIDIA Corporation'};

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

// A completed-day input with My Stocks and a Watchlist, a market-data item per stock, and the
// Broadcom (e4) and Health-care (e5) focus entries. No stock has a linked news article.
function tableInput({myStocks = [], watchlist = [], marketState = 'CLOSED'} = {}) {
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

// The writer's reply: Section 4 left null (as the table prompt allows), Section 3 as given.
function replyFor(input, {sectionThree} = {}) {
  const output = supportedOutput(input);
  output.sections[3] = {name: REPORT_SECTION_NAMES[3], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: []};
  if (sectionThree) output.sections[2] = {name: REPORT_SECTION_NAMES[2], ...sectionThree};
  return output;
}

const EMPTY_THREE = {content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: ['Nothing confirmed for this section.']};
const SECTOR_ONLY_THREE = {content: 'Health-care stocks advanced as constructive industry developments continued.',
  evidenceRefs: ['e5'], telemetryRefs: [], uncertainties: []};

function withEmptyThree(output) {
  const copy = structuredClone(output);
  copy.sections[2] = {...copy.sections[2], ...EMPTY_THREE};
  copy.status = 'DEGRADED';
  copy.evidenceGaps = [...copy.evidenceGaps, 'Some sections had too little evidence.'];
  return copy;
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
  return {result, diagnostics, calls, pointerEvents: diagnostics.filter(value => value.stage === 'sectionFourFocusPointer')};
}

const POINTER = 'Broadcom: see Stocks & Sectors in Focus.';
const OTHER_CLOSING = () => (sectionFourPriceRecordOn()
  ? 'No material news for the other stock.' : 'No material news for the other stocks.');

test('Step 9AQ: a stock named in a focus entry the finished Section 3 cites gets the fixed line, and the closing line says "the other"', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const reply = replyFor(input);
  const on = await runWriter(input, [reply]);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  const parts = on.result.output.sections[3].content.split('\n\n');
  assert.match(parts[0], /^Stock \| Ticker \| Last Price \| Change\n/);
  assert.deepEqual(parts.slice(1), [POINTER, OTHER_CLOSING()]);
  assert.deepEqual(on.pointerEvents, [{stage: 'sectionFourFocusPointer', marketState: 'CLOSED',
    pointerCount: 1, coveredStocks: 1, action: 'ADDED'}]);
  assert.equal(validateClaudeAnalysisOutput(on.result.output, input).valid, true);
  // Nothing is added to the citations or to the report's status.
  const off = await runWriter(input, [reply], {...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'});
  assert.deepEqual(off.result.output.sections[3].evidenceRefs, on.result.output.sections[3].evidenceRefs);
  assert.deepEqual(off.result.output.sections[3].telemetryRefs, on.result.output.sections[3].telemetryRefs);
  assert.equal(off.result.output.status, on.result.output.status);
  assert.deepEqual(off.result.output.evidenceGaps, on.result.output.evidenceGaps);
  assert.deepEqual(off.result.output.sections[3].content.split('\n\n').slice(1), ['No material news for all stocks.']);
  assert.equal(off.pointerEvents.length, 0);
  // No figure, time or link is in the added line.
  assert.doesNotMatch(POINTER, /\d|http/);
});

test('Step 9AQ: when the pointer covers every stock there is no closing line', async () => {
  const input = tableInput({myStocks: [], watchlist: ['AVGO']});
  const on = await runWriter(input, [replyFor(input)]);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  const parts = on.result.output.sections[3].content.split('\n\n');
  assert.deepEqual(parts.slice(1), [POINTER]);
  assert.equal(on.pointerEvents[0].coveredStocks, 1);
});

test('Step 9AQ: a focus entry that Section 3 does not cite gives no pointer', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const reply = replyFor(input, {sectionThree: SECTOR_ONLY_THREE});
  const on = await runWriter(input, [reply]);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  assert.deepEqual(on.result.output.sections[3].content.split('\n\n').slice(1), ['No material news for all stocks.']);
  assert.equal(on.pointerEvents.length, 0);
});

test('Step 9AQ: an empty Section 3 gives no pointer', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const reply = withEmptyThree(replyFor(input));
  const on = await runWriter(input, [reply], {...H55, WRITER_SECTION_RETRY_ENABLED: 'off'});
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  assert.equal(on.result.output.sections[2].content, null);
  assert.deepEqual(on.result.output.sections[3].content.split('\n\n').slice(1), ['No material news for all stocks.']);
  assert.equal(on.pointerEvents.length, 0);
});

test('Step 9AQ: after a section retry fills Section 3 the pointer is there; it is never doubled', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const full = replyFor(input);
  const retried = await runWriter(input, [withEmptyThree(full), full]);
  assert.equal(retried.result.type, 'SUCCESS', retried.result.message);
  assert.equal(retried.calls, 2, JSON.stringify(retried.diagnostics.filter(value => value.stage === 'writerSectionRetry')));
  assert.notEqual(retried.result.output.sections[2].content, null);
  const parts = retried.result.output.sections[3].content.split('\n\n');
  assert.deepEqual(parts.slice(1), [POINTER, OTHER_CLOSING()]);
  assert.equal(retried.result.output.sections[3].content.split(POINTER).length - 1, 1);
  // A retry for another section leaves the one pointer as it was.
  const withEmptySeven = structuredClone(full);
  withEmptySeven.sections[6] = {...withEmptySeven.sections[6], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Nothing confirmed for this section.']};
  withEmptySeven.status = 'DEGRADED';
  withEmptySeven.evidenceGaps = ['Some sections had too little evidence.'];
  const other = await runWriter(input, [withEmptySeven, full]);
  assert.equal(other.calls, 2);
  assert.deepEqual(other.result.output.sections[3].content.split('\n\n').slice(1), [POINTER, OTHER_CLOSING()]);
});

test('Step 9AQ: checked again on the finished report, a pointer left over from an emptied Section 3 is dropped', () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const stocks = [];
  const table = 'Stock | Ticker | Last Price | Change\nMy Stocks\nMicrosoft | MSFT | $105.00 | ↑ 3.00 (2.94%)\n'
    + 'Watchlist\nBroadcom | AVGO | $105.00 | ↑ 3.00 (2.94%)\nPrices at the close on Fri 4 Sep.';
  const withPointer = {content: `${table}\n\n${POINTER}\n\n${OTHER_CLOSING()}`, evidenceRefs: [], telemetryRefs: []};
  const cited = {content: 'Broadcom led semiconductor shares.', evidenceRefs: ['e4']};
  // Section 3 still cites the entry: nothing to change.
  assert.equal(sectionFourFocusPointers(withPointer, cited, input, stocks, splitReportSentences), null);
  // Section 3 emptied: the stale pointer goes and the closing line goes back to "all stocks".
  const emptied = sectionFourFocusPointers(withPointer, {content: null, evidenceRefs: []}, input, stocks, splitReportSentences);
  assert.equal(emptied.content, `${table}\n\nNo material news for all stocks.`);
  assert.equal(emptied.pointerCount, 0);
});

test('Step 9AQ: switch off, Haiku 4.5 and the default model keep the 9AP Section 4', async () => {
  const input = tableInput({myStocks: ['MSFT'], watchlist: ['AVGO']});
  const reply = replyFor(input);
  const closing = ['No material news for all stocks.'];
  for (const env of [{...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'}, {CLAUDE_MODEL: 'haiku-4.5'}, {},
    {...H55, HAIKU55_WRITER_DEPTH_ENABLED: 'off'}]) {
    const run = await runWriter(input, [reply], env);
    assert.equal(run.result.type, 'SUCCESS', run.result.message);
    assert.deepEqual(run.result.output.sections[3].content.split('\n\n').slice(1), closing, JSON.stringify(env));
    assert.equal(run.pointerEvents.length, 0);
  }
});

for (const [marketState, ...rest] of MARKET_STATE_CASES) {
  test(`Step 9AQ: ${marketState} -- with no stock named in a cited focus entry the report is the same with the pointer switch on or off`, async () => {
    const {input, output} = marketStateCase(marketState, ...rest);
    const on = await runWriter(input, [output]);
    const off = await runWriter(input, [output], {...H55, SECTION_FOUR_FOCUS_POINTER_ENABLED: 'off'});
    assert.equal(on.result.type, 'SUCCESS', `${marketState}: ${on.result.message}`);
    assert.deepEqual(on.result.output, off.result.output);
    assert.equal(on.pointerEvents.length, 0);
  });
}

// ---------------------------------------------------------------- the counts-only log

const WORDING_PLANTED = {
  0: ' Investors will be watching what comes next.',
  1: ' The rebound came from the jobs report. The jobs report is not a cause of the move. The package lists a gain.'
};

function closedCase() {
  const entry = MARKET_STATE_CASES.find(candidate => candidate[0] === 'CLOSED');
  return marketStateCase(...entry);
}

test('Step 9AQ: the wording log counts only and never changes the report; Haiku 4.5 and the switch off log nothing', async () => {
  const {input, output} = closedCase();
  const planted = structuredClone(output);
  for (const [index, text] of Object.entries(WORDING_PLANTED)) planted.sections[index].content += text;
  const on = await runWriter(input, [planted]);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  const events = on.diagnostics.filter(value => value.stage === 'readerWordingResidue');
  assert.equal(events.length, 1);
  assert.equal(events[0].marketState, 'CLOSED');
  const byIndex = Object.fromEntries(events[0].sections.map(entry => [entry.sectionIndex, entry]));
  assert.deepEqual(byIndex[0], {sectionIndex: 0, readerWordCount: 0, contradictionCount: 0, closingFillerCount: 1});
  assert.equal(byIndex[1].readerWordCount, 1);
  assert.equal(byIndex[1].contradictionCount, 1);
  assert.equal(byIndex[1].closingFillerCount, 0);
  // Counts only: no report text in the log line.
  assert.doesNotMatch(JSON.stringify(events[0]), /package|jobs|rebound|watching/);
  // The words are still in the report: nothing is deleted or changed because of them.
  assert.ok(on.result.output.sections[1].content.includes('The package lists a gain.'));
  assert.ok(on.result.output.sections[1].content.includes('The jobs report is not a cause of the move.'));
  assert.ok(on.result.output.sections[0].content.includes('Investors will be watching what comes next.'));
  const off = await runWriter(input, [planted], {...H55, READER_WORDING_ENABLED: 'off'});
  assert.deepEqual(off.result.output, on.result.output);
  assert.equal(off.diagnostics.filter(value => value.stage === 'readerWordingResidue').length, 0);
  const four = await runWriter(input, [planted], {CLAUDE_MODEL: 'haiku-4.5'});
  assert.equal(four.diagnostics.filter(value => value.stage === 'readerWordingResidue').length, 0);
  assert.deepEqual(four.result.output, on.result.output);
});

test('Step 9AQ: a clean report logs no wording line', async () => {
  const {input, output} = closedCase();
  const run = await runWriter(input, [output]);
  assert.equal(run.result.type, 'SUCCESS', run.result.message);
  assert.equal(run.diagnostics.filter(value => value.stage === 'readerWordingResidue').length, 0);
});

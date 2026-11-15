// Step 21D.1: Section 4 gives a reason for a stock's move only when an article linked to THAT
// stock is cited in Section 4; any other stock sentence keeps only its move facts. One shared cut
// (lib/section-rules.js, sectionFourCauseCut) in every market state, behind the Admin switch
// sectionFourCauseCheckEnabled (default on). Off gives the 3d5f595 behaviour.
'use strict';

const {startingListTests} = require('./fixtures/section-four-switch');
// Step 21D.2: these pin the starting-list-only Section 4 rule, so they run with the switch off.
const startingListTest = startingListTests(require('node:test'), [
  "Step 21D.1: in every state a Section 4 with only unsupported reasons is emptied as before",
  "Step 21D.1: in every state a supported reason and the empty-list statement are unchanged"
]);
// Step 8W: these write "Thursday" where nothing cited supports that day, which the date check
// (on) correctly removes; they pin the Section 4 cut alone, so they run with dateAccuracyEnabled off.
const dateAccuracyTest = require('./fixtures/step-8w-switches').dateAccuracyOffTests(startingListTest, [
  "Step 21D.1: in every state an unsupported reason is cut, a supported one kept, NORMAL on one call",
  "Step 21D.1: in every state the switch off leaves Section 4 exactly as written"
]);
// Step 9AA Build 1: these pin the 5409b44 Section 4 text, so they run with sectionFourTableEnabled off.
const test = require('./fixtures/section-four-table-switch').sectionFourTableOffTests(dateAccuracyTest, [
  "Step 21D.1: in every state an unsupported reason is cut, a supported one kept, NORMAL on one call",
  "Step 21D.1: in every state the switch off leaves Section 4 exactly as written"
]);
const assert = require('node:assert/strict');

const {splitReportSentences, EMPTY_INITIATING_LIST_CONTENT} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {settingValue} = require('../lib/settings-registry');
const {
  sectionFourNameVariants,
  sectionFourStocks,
  sectionFourMoveFactsOnly,
  sectionFourCauseCut
} = require('../lib/section-rules');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  marketStateCase,
  invokeCounted
} = require('./fixtures/market-state-cases');

function withCauseCheck(value, run) {
  const saved = process.env.SECTION_FOUR_CAUSE_CHECK_ENABLED;
  if (value === undefined) delete process.env.SECTION_FOUR_CAUSE_CHECK_ENABLED;
  else process.env.SECTION_FOUR_CAUSE_CHECK_ENABLED = value;
  const restore = () => {
    if (saved === undefined) delete process.env.SECTION_FOUR_CAUSE_CHECK_ENABLED;
    else process.env.SECTION_FOUR_CAUSE_CHECK_ENABLED = saved;
  };
  let result;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// The saved 17 Oct 2026 My Stocks list (Replay Packages), names as Yahoo gives them.
const SAVED_NAMES = {
  CPRI: 'Capri Holdings Limited', UNH: 'UnitedHealth Group Incorporated', NVO: 'Novo Nordisk A/S',
  CPRT: 'Copart, Inc.', NVDA: 'NVIDIA Corporation', MSFT: 'Microsoft Corporation',
  VEEV: 'Veeva Systems Inc.', SPYM: 'State Street SPDR Portfolio S&P 500 ETF'
};

function savedStocks(supportedSymbols) {
  const portfolio = Object.keys(SAVED_NAMES).map(symbol => ({
    market: 'US', symbol, telemetryRefs: [], upcomingEvents: [],
    evidenceRefs: [`md-${symbol}`].concat(supportedSymbols.includes(symbol) ? [`news-${symbol}`] : [])
  }));
  const cited = portfolio.flatMap(security => security.evidenceRefs);
  return sectionFourStocks(portfolio, security => SAVED_NAMES[security.symbol], cited,
    reference => reference.startsWith('news-') ? 'news' : 'market-data');
}

test('Step 21D.1: the switch is one Admin setting, default on', () => {
  assert.equal(settingValue('sectionFourCauseCheckEnabled', {env: {}}), true);
  assert.equal(settingValue('sectionFourCauseCheckEnabled',
    {env: {SECTION_FOUR_CAUSE_CHECK_ENABLED: 'off'}}), false);
});

test('Step 21D.1: shortened names cover UnitedHealth, Novo Nordisk and the other saved names', () => {
  assert.deepEqual(sectionFourNameVariants('UnitedHealth Group Incorporated'),
    ['unitedhealth group incorporated', 'unitedhealth group', 'unitedhealth']);
  assert.deepEqual(sectionFourNameVariants('Novo Nordisk A/S'), ['novo nordisk a/s', 'novo nordisk']);
  assert.deepEqual(sectionFourNameVariants('Capri Holdings Limited'),
    ['capri holdings limited', 'capri holdings', 'capri']);
  assert.deepEqual(sectionFourNameVariants('Veeva Systems Inc.'),
    ['veeva systems inc.', 'veeva systems', 'veeva']);
  assert.deepEqual(sectionFourNameVariants('Copart, Inc.'), ['copart, inc.', 'copart']);
  assert.deepEqual(sectionFourNameVariants('Meta Platforms, Inc.'),
    ['meta platforms, inc.', 'meta platforms', 'meta']);
  assert.deepEqual(sectionFourNameVariants('Waste Management, Inc.'),
    ['waste management, inc.', 'waste management']);
  assert.deepEqual(sectionFourNameVariants(''), []);
});

test('Step 21D.1: the six example sentences keep only their move facts', () => {
  const stocks = savedStocks([]);
  for (const [sentence, expected] of [
    ['Capri Holdings gained 0.63% Friday to 15.95 and rose 5.53% Thursday, outperforming amid luxury goods optimism.',
      'Capri Holdings gained 0.63% Friday to 15.95 and rose 5.53% Thursday.'],
    ['Copart rose 0.43% Friday to 27.87 and surged 5.63% Thursday, benefiting from non-tech rotation.',
      'Copart rose 0.43% Friday to 27.87 and surged 5.63% Thursday.'],
    ['Veeva Systems fell 0.85% Friday to 310.36 after jumping 5.27% Thursday as software found dip-buying.',
      'Veeva Systems fell 0.85% Friday to 310.36 after jumping 5.27% Thursday.'],
    ['UnitedHealth fell 1.29% Friday to 401.43 after climbing 2.79% Thursday on healthcare rotation.',
      'UnitedHealth fell 1.29% Friday to 401.43 after climbing 2.79% Thursday.'],
    ['Novo Nordisk declined 0.99% Friday to 38.83 in line with pharma sector pressure.',
      'Novo Nordisk declined 0.99% Friday to 38.83.'],
    ['Microsoft fell 1.93% Friday to 529.05, tracking technology sector weakness.',
      'Microsoft fell 1.93% Friday to 529.05.'],
    // Trading, 16 Oct.
    ['NVIDIA fell sharply, trading near $215.26 on continued semiconductor sector weakness tied to AI financing concerns cited in current-session news.',
      'NVIDIA fell sharply, trading near $215.26.'],
    ['Veeva Systems fell $5.53 (1.77%) to $307.50 from Thursday\'s $313.03 close, affected by broader cloud and software weakness.',
      'Veeva Systems fell $5.53 (1.77%) to $307.50 from Thursday\'s $313.03 close.'],
    ['Copart gained $0.05 (0.20%) to $27.81, edging higher despite broad market pressure.',
      'Copart gained $0.05 (0.20%) to $27.81, edging higher.']
  ]) assert.equal(sectionFourMoveFactsOnly(sentence, stocks), expected, sentence);
});

test('Step 21D.1: move facts, 52-week highs and index comparisons are kept word for word', () => {
  const stocks = savedStocks([]);
  for (const sentence of [
    'Capri Holdings held steady near Thursday\'s close at $15.85, little changed on the session.',
    'Microsoft hit a 52-week high of 540.10 on Friday, its third straight gain.',
    'Copart fell 2.1%, more than the S&P 500\'s 0.6% decline.',
    'The SPDR S&P 500 ETF (SPYM) fell 1.11% Friday to 89.83, mirroring broad-market declines.',
    'Novo Nordisk slipped to a 52-week low in premarket trading.'
  ]) assert.equal(sectionFourMoveFactsOnly(sentence, stocks), sentence, sentence);
});

test('Step 21D.1: a reason with no move fact before it, or no stock, leaves nothing', () => {
  const stocks = savedStocks([]);
  assert.equal(sectionFourMoveFactsOnly('Takeover talk lifted Copart.', stocks), null);
  assert.equal(sectionFourMoveFactsOnly('Analysts expect a strong quarter from Microsoft.', stocks), null);
  assert.equal(sectionFourMoveFactsOnly('Investors rotated into healthcare.', stocks), null);
});

test('Step 21D.1: a stock with a linked cited article keeps its reason; two stocks need both', () => {
  const stocks = savedStocks(['NVDA']);
  const content = 'NVIDIA fell 1.43% Friday to 214.13, pressured by the semiconductor selloff. '
    + 'Analyst Dan Ives said NVIDIA\'s ecosystem supports growth. '
    + 'He kept his price target. '
    + 'Microsoft fell 1.93% Friday to 529.05, tracking technology sector weakness. '
    + 'NVIDIA and Microsoft both fell as AI worries spread. '
    + 'Microsoft dropped on Friday.';
  const result = sectionFourCauseCut({content}, stocks, splitReportSentences);
  assert.equal(result.section.content, 'NVIDIA fell 1.43% Friday to 214.13, pressured by the semiconductor selloff. '
    + 'Analyst Dan Ives said NVIDIA\'s ecosystem supports growth. '
    + 'He kept his price target. '
    + 'Microsoft fell 1.93% Friday to 529.05. '
    + 'NVIDIA and Microsoft both fell. '
    + 'Microsoft dropped on Friday.');
  assert.equal(result.shortenedSentenceCount, 2);
  assert.equal(result.removedSentenceCount, 0);
  // Nothing to cut: the same section object comes back.
  const clean = {content: 'NVIDIA fell 1.43% Friday on chip worries.'};
  assert.equal(sectionFourCauseCut(clean, stocks, splitReportSentences).section, clean);
});

test('Step 21D.1: a sentence naming no stock is about the whole list', () => {
  const stocks = savedStocks(['NVDA']);
  const result = sectionFourCauseCut({content: 'Your stocks were mostly lower amid AI fears.'},
    stocks, splitReportSentences);
  assert.equal(result.section.content, 'Your stocks were mostly lower.');
  const all = savedStocks(Object.keys(SAVED_NAMES));
  const kept = {content: 'Your stocks were mostly lower amid AI fears.'};
  assert.equal(sectionFourCauseCut(kept, all, splitReportSentences).section, kept);
});

test('Step 21D.1: an article linked to another stock, or a market-data page, never supports a stock', () => {
  const portfolio = [
    {market: 'US', symbol: 'NVDA', telemetryRefs: [], evidenceRefs: ['e9', 'e40'], upcomingEvents: []},
    {market: 'US', symbol: 'MSFT', telemetryRefs: [], evidenceRefs: ['e10'], upcomingEvents: []}
  ];
  const stocks = sectionFourStocks(portfolio, security => SAVED_NAMES[security.symbol],
    ['e9', 'e10', 'e40', 'e31'], reference => (reference === 'e40' || reference === 'e31') ? 'news' : 'market-data');
  assert.deepEqual(stocks.map(stock => [stock.symbol, stock.supported]), [['NVDA', true], ['MSFT', false]]);
  // Not cited in Section 4: no support.
  const uncited = sectionFourStocks(portfolio, security => SAVED_NAMES[security.symbol], ['e9'],
    reference => reference === 'e40' ? 'news' : 'market-data');
  assert.equal(uncited[0].supported, false);
});

// ---------------------------------------------------------------------------
// The full invocation in every market state.
// ---------------------------------------------------------------------------

// MSFT has its own linked news article (active: e1; completed: e2) cited in Section 4; CPRT has
// none (named by symbol only, so the fixture's instrument names don't matter).
function stateCase(state) {
  const [marketState, generatedAt, overlayAsOf, currentPublishedAt] = state;
  const built = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
  const input = structuredClone(built.input);
  const output = structuredClone(built.output);
  const active = ACTIVE_MARKET_STATES.has(marketState);
  const linked = active ? 'e1' : 'e2';
  input.portfolioContext.myStocks = [
    {market: 'US', symbol: 'MSFT', telemetryRefs: active ? [] : ['t2'], evidenceRefs: [linked], upcomingEvents: []},
    {market: 'US', symbol: 'CPRT', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []}
  ];
  output.sections[3] = {
    ...output.sections[3], evidenceRefs: [linked], telemetryRefs: active ? [] : ['t2'], uncertainties: []
  };
  return {input, output, marketState};
}

const CLEAN_CONTENT = 'MSFT rose 2.1% to 410.5 after Yahoo Finance reported a raised outlook. '
  + 'CPRT rose 5.63% Thursday, benefiting from non-tech rotation. '
  + 'MSFT and CPRT both gained as investors rotated.';
const CUT_CONTENT = 'MSFT rose 2.1% to 410.5 after Yahoo Finance reported a raised outlook. '
  + 'CPRT rose 5.63% Thursday. '
  + 'MSFT and CPRT both gained.';

test('Step 21D.1: in every state an unsupported reason is cut, a supported one kept, NORMAL on one call', async () => {
  for (const state of MARKET_STATE_CASES) {
    const {input, output, marketState} = stateCase(state);
    output.sections[3].content = CLEAN_CONTENT;
    const {result, calls, diagnostics} = await withCauseCheck(undefined, () => invokeCounted(input, output));
    assert.equal(result.type, 'SUCCESS', `${marketState}: ${result.message}`);
    assert.equal(calls, 1, marketState);
    assert.equal(result.output.status, 'NORMAL', marketState);
    assert.equal(result.output.sections[3].content, CUT_CONTENT, marketState);
    assert.deepEqual(result.output.sections[3].evidenceRefs, output.sections[3].evidenceRefs, marketState);
    const events = diagnostics.filter(event => event.violationCategory === 'UNSUPPORTED_STOCK_CAUSE');
    assert.deepEqual(events, [{
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 3,
      violationCategory: 'UNSUPPORTED_STOCK_CAUSE', suppliedReferenceCount: 1,
      allowedReferenceCount: 1, offendingReferenceCount: 0,
      shortenedSentenceCount: 2, removedSentenceCount: 0, action: 'TRIMMED'
    }], marketState);
    // Every other section is untouched.
    for (const index of [0, 1, 2, 4, 5, 6]) {
      assert.deepEqual(result.output.sections[index], (await withCauseCheck('off',
        () => invokeCounted(input, output))).result.output.sections[index], `${marketState} ${index}`);
    }
  }
});

test('Step 21D.1: in every state the switch off leaves Section 4 exactly as written', async () => {
  for (const state of MARKET_STATE_CASES) {
    const {input, output, marketState} = stateCase(state);
    output.sections[3].content = CLEAN_CONTENT;
    const {result, diagnostics} = await withCauseCheck('off', () => invokeCounted(input, output));
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(result.output.sections[3].content, CLEAN_CONTENT, marketState);
    assert.equal(diagnostics.some(event => event.violationCategory === 'UNSUPPORTED_STOCK_CAUSE'), false);
  }
});

test('Step 21D.1: in every state a Section 4 with only unsupported reasons is emptied as before', async () => {
  for (const state of MARKET_STATE_CASES) {
    const {input, output, marketState} = stateCase(state);
    output.sections[3].content = 'Takeover talk lifted CPRT. Rotation helped CPRT.';
    const {result, diagnostics} = await withCauseCheck(undefined, () => invokeCounted(input, output));
    assert.equal(result.type, 'SUCCESS', marketState);
    assert.equal(result.output.status, 'DEGRADED', marketState);
    assert.equal(result.output.sections[3].content, null, marketState);
    assert.deepEqual(result.output.sections[3].uncertainties,
      ['Not enough data to comment on the stocks in this list.'], marketState);
    const event = diagnostics.find(value => value.violationCategory === 'UNSUPPORTED_STOCK_CAUSE');
    assert.equal(event.removedSentenceCount, 2, marketState);
    assert.equal(Object.hasOwn(event, 'action'), false, marketState);
  }
});

test('Step 21D.1: in every state a supported reason and the empty-list statement are unchanged', async () => {
  for (const state of MARKET_STATE_CASES) {
    const {input, output, marketState} = stateCase(state);
    output.sections[3].content = 'MSFT rose 2.1% to 410.5 after Yahoo Finance reported a raised outlook.';
    const {result, diagnostics} = await withCauseCheck(undefined, () => invokeCounted(input, output));
    assert.equal(result.output.sections[3].content, output.sections[3].content, marketState);
    assert.equal(diagnostics.some(event => event.violationCategory === 'UNSUPPORTED_STOCK_CAUSE'), false);

    const built = marketStateCase(...state);
    const empty = {input: structuredClone(built.input), output: structuredClone(built.output)};
    const emptyRun = await withCauseCheck(undefined, () => {
      empty.input.portfolioContext.myStocks = [];
      empty.output.sections[3] = {...empty.output.sections[3],
        content: EMPTY_INITIATING_LIST_CONTENT.myStocks, evidenceRefs: [], telemetryRefs: [], uncertainties: []};
      return invokeCounted(empty.input, empty.output);
    });
    assert.equal(emptyRun.result.output.sections[3].content, EMPTY_INITIATING_LIST_CONTENT.myStocks, marketState);
  }
});

test('Step 21D.1: the writer instruction is in every state while on and absent while off', () => {
  for (const state of MARKET_STATE_CASES) {
    const {input, marketState} = stateCase(state);
    const on = withCauseCheck(undefined, () => buildClaudeAnalysisRequest(input));
    const off = withCauseCheck('off', () => buildClaudeAnalysisRequest(input));
    assert.equal(on.system.includes('SECTION 4 REASONS (every market state)'), true, marketState);
    assert.equal(off.system.includes('SECTION 4 REASONS'), false, marketState);
    // On adds the one instruction and nothing else.
    const instruction = on.system.slice(on.system.indexOf(' SECTION 4 REASONS'),
      on.system.indexOf('or "benefiting from".') + 'or "benefiting from".'.length);
    assert.equal(on.system.replace(instruction, ''), off.system, marketState);
    assert.deepEqual(on.messages, off.messages, marketState);
  }
});

// Step 9D.6: market-neutral section rules. The hard-coded `selectedScope === 'US'` switches
// are gone from the section rules; they now read lib/section-rules.js's new MARKET_SETTINGS
// table instead. This file tests:
//   (a) the US row reproduces today's exact values, and the US-facing detectors still default
//       to that row so every existing US call site is unaffected;
//   (b) Singapore and Hong Kong stay disabled, and a full report round trip for each is
//       unchanged from before this step;
//   (c) a TEST-ONLY fake market settings object -- defined only in this file, never added to
//       MARKET_SETTINGS -- proves the shared detector functions themselves no longer hard-code
//       the US market: passed a different benchmark-name list or locale, they answer correctly
//       for that market's own data, exactly as they do for the US market's data today.
//
// This file does not make Singapore or Hong Kong work (Step 9M); see docs/DECISIONS.md, Step
// 9D.6, for what still blocks them, and for the one pre-existing gap this step found but did
// not change (several section rules were never scope-gated at all, for any market).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  createClaudeAnalysisInput,
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT,
  hasDirectMarketCausalClaim,
  containsWholeTerm
} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  US_ACTIVE_SESSION_STATES
} = require('../lib/us-active-session-evidence');
const {
  US_COMPLETED_SESSION_STATES,
  marketSettings,
  reportSettings,
  reportSettingsForInput,
  normalizeSectionText,
  namesCitedFocusSubject
} = require('../lib/section-rules');

// ---------------------------------------------------------------------------
// (a) The US row reproduces today's exact values.
// ---------------------------------------------------------------------------

test('Step 9D.6: the US market settings row reproduces today\'s values exactly', () => {
  assert.deepEqual(marketSettings('US'), {
    sectionRulesEnabled: true,
    activeStates: US_ACTIVE_SESSION_STATES,
    completedStates: US_COMPLETED_SESSION_STATES,
    benchmarkNames: ['s&p 500', 'nasdaq', 'dow'],
    locale: 'en-US'
  });
});

test('Step 9D.6: reportSettings\'s own shape and six-state behaviour are unchanged for US', () => {
  const ACTIVE_ROW = {
    sessionMode: 'ACTIVE', sectionOneRequired: false, catalystScope: 'SPLIT_CURRENT_COMPLETED',
    nothingSurvivedFallback: true, failedRescue: 'ANY_SECTION', furtherReadingsSource: 'ACTIVE_CITED_YAHOO'
  };
  const COMPLETED_ROW = {
    sessionMode: 'COMPLETED', sectionOneRequired: true, catalystScope: 'ANY_PRINCIPAL',
    nothingSurvivedFallback: false, failedRescue: 'SECTION_ONE', furtherReadingsSource: 'PACKAGE_LIST'
  };
  for (const state of ['PRE', 'REGULAR', 'POST']) {
    assert.deepEqual(reportSettings('US', state), {sectionRulesEnabled: true, ...ACTIVE_ROW, hasCurrentEvidence: false}, state);
  }
  for (const state of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    assert.deepEqual(reportSettings('US', state), {sectionRulesEnabled: true, ...COMPLETED_ROW, hasCurrentEvidence: false}, state);
  }
  assert.throws(() => reportSettings('US', 'LUNCH'), /Unsupported US market state: LUNCH/);
});

test('Step 9D.6: hasDirectMarketCausalClaim\'s default reads the US benchmark names from settings', () => {
  const sentences = [
    'The S&P 500 rose because of strong earnings.',
    'Stocks fell due to weak guidance.',
    'The Nasdaq rallied on better-than-expected jobs data.'
  ];
  for (const sentence of sentences) {
    assert.equal(hasDirectMarketCausalClaim(sentence), hasDirectMarketCausalClaim(sentence, marketSettings('US').benchmarkNames), sentence);
  }
});

test('Step 9D.6: containsWholeTerm\'s default reads the US locale from settings', () => {
  assert.equal(containsWholeTerm('index rallied', 'INDEX', false), containsWholeTerm('index rallied', 'INDEX', false, marketSettings('US').locale));
});

test('Step 9D.6: normalizeSectionText and namesCitedFocusSubject default to the US locale from settings', () => {
  assert.equal(normalizeSectionText('index'), normalizeSectionText('index', marketSettings('US').locale));
  const focus = [{evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'INDEX'}]}];
  assert.equal(
    namesCitedFocusSubject('index rallied', ['e1'], focus),
    namesCitedFocusSubject('index rallied', ['e1'], focus, marketSettings('US').locale)
  );
});

// ---------------------------------------------------------------------------
// (b) Singapore and Hong Kong stay disabled.
// ---------------------------------------------------------------------------

test('Step 9D.6: Singapore and Hong Kong settings rows stay disabled', () => {
  assert.deepEqual(marketSettings('SG'), {sectionRulesEnabled: false});
  assert.deepEqual(marketSettings('HK'), {sectionRulesEnabled: false});
  for (const state of ['PRE', 'REGULAR', 'POST', 'CLOSED', 'WEEKEND', 'HOLIDAY', 'LUNCH', 'OPEN', 'anything']) {
    assert.deepEqual(reportSettings('SG', state), {sectionRulesEnabled: false}, state);
    assert.deepEqual(reportSettings('HK', state), {sectionRulesEnabled: false}, state);
  }
});

test('Step 9D.6: a market with no settings row, including the legacy ALL scope, stays disabled', () => {
  for (const market of ['ALL', 'ZZ', '', null, undefined]) {
    assert.deepEqual(marketSettings(market), {sectionRulesEnabled: false}, String(market));
    assert.deepEqual(reportSettings(market, 'CLOSED'), {sectionRulesEnabled: false}, String(market));
  }
});

// A minimal, fully checker-valid canonical input for a given market (SG or
// HK), built independently of tests/claude-analysis-invocation.test.js's own
// SG fixture so that file stays untouched.
function marketInput(market) {
  const exchangeTimezone = market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Singapore';
  const currency = market === 'HK' ? 'HKD' : 'SGD';
  const [symbol, instrumentName] = market === 'HK'
    ? ['^HSI', 'Hang Seng Index'] : ['^STI', 'Straits Times Index'];
  const item = createEvidenceItem({
    sourceId: `${market.toLowerCase()}.reuters`, market, evidenceCategory: 'news',
    title: 'Technology sector update',
    canonicalUrl: 'https://www.reuters.com/markets/example', publishedAt: '2026-09-06T08:00:00Z'
  });
  const session = createCompletedRegularSession({
    market, sessionDate: '2026-09-04', open: 5700, high: 5800, low: 5650,
    close: 5747, previousClose: 5710, volume: null, asOf: '2026-09-04T17:00:00+08:00',
    sourceId: `${market.toLowerCase()}.yahoo-finance`, validationState: 'VALIDATED'
  });
  const snapshot = createFiveSessionSnapshot({
    market, symbol, instrumentName, instrumentType: 'INDEX',
    currency, marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: market, initiatingList: 'myStocks', generatedAt: '2026-09-06T18:00:00+08:00',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market,
      marketContext: {
        exchangeTimezone, marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Weekend; latest completed session remains applicable.'
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
      evidenceCollection: createEvidenceCollection({market, items: [item]}),
      evidenceContext: {
        materialEvents: ['e1'], authoritativeFacts: [], principalCatalysts: ['e1'],
        supportingEvidence: ['e1'], conflictingEvidence: [], subsequentDevelopments: [],
        sessionAssociations: [],
        broadMarketFocus: [{evidenceRef: 'e1', subjects: [{kind: 'SECTOR', name: 'Technology'}]}],
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext: {myStocks: [], watchlist: []}
  });
}

// A writer reply that satisfies every checker rule that applies regardless
// of market (Section 3's focus-subject requirement, Section 2's driver
// requirement, and so on -- these are not gated by any of the four switches
// this step touches, so the fixture must pass them to isolate what this
// step actually changed). `duplicateTelemetry` injects a duplicate
// telemetryRef in Section 5, which only Step 9D.6's rule 5
// (normalizeActiveTransportMetadata) would silently dedupe -- and that rule
// stays off for a disabled market, exactly as it did before this step.
function marketOutput(input, duplicateTelemetry = false) {
  const sections = REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 7 ? null : index === 3 ? EMPTY_INITIATING_LIST_CONTENT.myStocks
      : index === 2 ? 'Technology shares were broadly supported.' : 'Readings remained stable overall.',
    evidenceRefs: index === 7 || index === 3 ? [] : ['e1'],
    telemetryRefs: index === 7 || index === 3 ? [] : (index === 4 && duplicateTelemetry ? ['t1', 't1'] : ['t1']),
    uncertainties: []
  }));
  return {
    status: 'NORMAL',
    reportContext: {
      header: 'REPORT HEADER / ANALYSIS CONTEXT', selectedScope: input.analysisRequest.selectedScope,
      generatedAt: input.analysisRequest.generatedAt, userTimezone: 'Asia/Singapore',
      reportType: 'MARKET_BRIEF', markets: [input.analysisRequest.selectedScope]
    },
    sections, evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: []
  };
}

function providerTransport(output) {
  const encode = values => values.join('|');
  return {
    status: output.status, evidenceGaps: output.evidenceGaps,
    ...Object.fromEntries(output.sections.map((section, index) => [`s${index + 1}`, index === 7 ? {} : {
      content: section.content, evidenceRefs: encode(section.evidenceRefs),
      telemetryRefs: encode(section.telemetryRefs), uncertainties: encode(section.uncertainties)
    }]))
  };
}

async function invokeCounted(input, output) {
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async () => { calls++; return {ok: true, status: 200,
      async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }}; },
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, calls, diagnostics};
}

for (const market of ['SG', 'HK']) {
  test(`Step 9D.6: ${market} settings stay disabled for both the request and the package`, () => {
    const input = marketInput(market);
    assert.equal(reportSettingsForInput(input).sectionRulesEnabled, false);
  });

  test(`Step 9D.6: a clean ${market} report round-trips unchanged, exactly as before this step`, async () => {
    const input = marketInput(market);
    const output = marketOutput(input);
    const {result, calls, diagnostics} = await invokeCounted(input, output);
    assert.equal(result.type, 'SUCCESS');
    assert.equal(calls, 1);
    assert.equal(result.output.status, 'NORMAL');
    assert.deepEqual(result.output.sections, output.sections);
    assert.deepEqual(diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'), []);
  });

  test(`Step 9D.6: ${market} stays disabled, so a duplicate telemetry ref is not silently deduped`, async () => {
    // For US this exact duplicate is removed by normalizeActiveTransportMetadata before the
    // checker ever sees it (rule 5). Here the rule is off, so the duplicate reaches the checker
    // unchanged, and the checker -- which is not scope-gated -- correctly rejects it. This is the
    // same two-step failure this input produced before Step 9D.6; only the gate's implementation
    // (settings-table read, not a literal `selectedScope === 'US'`) changed.
    const input = marketInput(market);
    const output = marketOutput(input, true);
    const {result, calls} = await invokeCounted(input, output);
    assert.equal(result.type, 'CONTRACT_FAILURE');
    assert.match(result.message, /sections\[4\]: invalid telemetry references/);
    assert.equal(calls, 2);
  });
}

// ---------------------------------------------------------------------------
// (c) A TEST-ONLY fake market settings object, never added to MARKET_SETTINGS
// in production code, proving the shared detectors are no longer hard-coded
// to the US market: given a different market's own benchmark names and
// locale, they answer correctly for that market's data, the same way they
// already do for the US market's data.
// ---------------------------------------------------------------------------

const FAKE_MARKET_SETTINGS = Object.freeze({
  sectionRulesEnabled: true,
  benchmarkNames: Object.freeze(['zeta 30']),
  locale: 'tr-TR'
});

test('Step 9D.6: a fake market\'s benchmark names run through the same causal detector as the US market\'s', () => {
  // "Zeta 30" is not a generic market word and not in the US benchmark list, so it is only
  // recognized as a cause-and-effect subject when the fake market's own names are supplied --
  // exactly the same mechanism that recognizes "S&P 500" only when the US market's names are
  // supplied (its default). Neither list recognizes the other market's specific index name.
  const zetaSentence = 'Zeta 30 rose because of strong earnings.';
  const spSentence = 'S&P 500 rose because of strong earnings.';
  assert.equal(hasDirectMarketCausalClaim(zetaSentence, FAKE_MARKET_SETTINGS.benchmarkNames), true);
  assert.equal(hasDirectMarketCausalClaim(zetaSentence), false);
  assert.equal(hasDirectMarketCausalClaim(spSentence), true);
  assert.equal(hasDirectMarketCausalClaim(spSentence, FAKE_MARKET_SETTINGS.benchmarkNames), false);
});

test('Step 9D.6: a fake market\'s locale runs through the same subject-matching functions as the US market\'s', () => {
  // Turkish case-folds capital I to dotless ı, not to i, so matching "INDEX" against lowercase
  // "index" text diverges by locale -- the same divergence the US market's 'en-US' locale avoids
  // for its own content today. This proves the locale genuinely reaches the comparison, not just
  // that the parameter is accepted and ignored.
  assert.equal(containsWholeTerm('index rallied', 'INDEX', false, 'en-US'), true);
  assert.equal(containsWholeTerm('index rallied', 'INDEX', false, FAKE_MARKET_SETTINGS.locale), false);

  assert.equal(normalizeSectionText('INDEX', 'en-US'), 'index');
  assert.equal(normalizeSectionText('INDEX', FAKE_MARKET_SETTINGS.locale), 'ındex');

  const focus = [{evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'INDEX'}]}];
  assert.equal(namesCitedFocusSubject('index rallied', ['e1'], focus, 'en-US'), true);
  assert.equal(namesCitedFocusSubject('index rallied', ['e1'], focus, FAKE_MARKET_SETTINGS.locale), false);
});

test('Step 9D.6: the fake market settings object does not exist in production code', () => {
  assert.equal(marketSettings('FAKE').sectionRulesEnabled, false);
  assert.equal(marketSettings('ZETA').sectionRulesEnabled, false);
});

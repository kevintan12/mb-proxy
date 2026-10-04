// Step 9D.1: shared test helpers for the section-rules state matrix
// (tests/section-rules-matrix.test.js). These are COPIED from
// tests/claude-analysis-invocation.test.js, not moved: that file is left
// untouched so no existing test changes. If a helper here and the original
// drift apart later, the original remains the source of truth for its own
// tests; this copy exists only to give the matrix test one place to build
// per-state fixtures from, per the Step 9D plan ("no per-state copies" means
// one table of cases, not a helper reinvented per test file).
'use strict';

const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../../lib/evidence-items');
const {createEvidenceCollection} = require('../../lib/evidence-collections');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../../lib/five-session-snapshot');
const {
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT,
  createClaudeAnalysisInput
} = require('../../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../../lib/claude-analysis-invocation');
const {
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor
} = require('../../lib/us-active-session-evidence');
const {
  richCompletedUsWeekInput,
  thinDegradedFiveSessionInput,
  supportedOutput: supportedCompletedUsOutput
} = require('./us-market-brief-quality');

// The six market states this file builds fixtures for, with the timing
// tuples the active ones need to produce a valid current-session anchor.
// Copied from STEP_8U_STATES / ACTIVE_STATE_TIMES in
// tests/claude-analysis-invocation.test.js.
const MARKET_STATE_CASES = [
  ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
  ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
  ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z'],
  ['CLOSED', '2026-09-04T22:00:00.000Z'],
  ['WEEKEND', '2026-09-06T10:00:00.000Z'],
  ['HOLIDAY', '2026-09-07T16:00:00.000Z']
];

const ACTIVE_MARKET_STATES = new Set(['PRE', 'REGULAR', 'POST']);

const UNSUPPORTED_CAUSALITY_QUALIFIER = 'The news does not show for certain what moved the market.';

function activeUsInput({
  marketState = 'REGULAR',
  generatedAt = '2026-09-08T15:00:00.000Z',
  overlayAsOf = '2026-09-08T14:55:00.000Z',
  currentPublishedAt = '2026-09-08T14:30:00.000Z',
  additionalItems = [],
  includeOverlay = true,
  materialEvents = ['e1', 'e2'],
  principalCatalysts = ['e1', 'e2'],
  supportingEvidence = ['e2'],
  subsequentDevelopments = [],
  broadMarketFocus = [{evidenceRef: 'e1', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]}],
  portfolioContext = {myStocks: [], watchlist: []},
  stockSnapshots = []
} = {}) {
  const activeSessionAnchor = serializeUsActiveSessionAnchor(createUsActiveSessionAnchor({
    marketState,
    cutoffAt: generatedAt
  }));
  assert.ok(activeSessionAnchor);
  const completed = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-04', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-04T16:00:00-04:00', sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  const overlay = includeOverlay ? createCurrentSessionOverlay({
    market: 'US', marketState, sessionDate: '2026-09-08',
    asOf: overlayAsOf, lastPrice: 106, referenceClose: 104,
    volume: 1200000, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }) : null;
  const snapshot = createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState, completedSessions: [completed],
    currentOverlay: overlay
  });
  const current = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Microsoft outlook lifts stocks',
    summary: 'Microsoft raised its outlook during the active US session.',
    canonicalUrl: 'https://finance.yahoo.com/news/microsoft-outlook-lifts-stocks.html',
    publishedAt: currentPublishedAt, symbols: ['MSFT'],
    publisher: 'Yahoo Finance'
  });
  const completedEvidence = createEvidenceItem({
    sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
    title: 'Prior completed-session market driver',
    summary: 'A supported driver of the prior completed session.',
    canonicalUrl: 'https://www.reuters.com/markets/us/prior-driver',
    publishedAt: '2026-09-04T19:00:00.000Z', symbols: []
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks',
      generatedAt, userTimezone: 'Asia/Singapore',
      reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: includeOverlay,
        calendarContext: activeSessionAnchor
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots},
      evidenceCollection: createEvidenceCollection({
        market: 'US', items: [current, completedEvidence, ...additionalItems]
      }),
      evidenceContext: {
        materialEvents, authoritativeFacts: [],
        principalCatalysts, supportingEvidence,
        conflictingEvidence: [], subsequentDevelopments, sessionAssociations: [],
        broadMarketFocus,
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext
  });
}

// A stock snapshot for a company with no broadMarketFocus entry of its own,
// for the active-day "unlinked stock telemetry" rule row.
function unlinkedStockSnapshot(marketState, symbol = 'AAPL', instrumentName = 'Apple instrument') {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-04', open: 50, high: 52, low: 49,
    close: 51, previousClose: 50, volume: 500000,
    asOf: '2026-09-04T16:00:00-04:00', sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName, instrumentType: 'EQUITY',
    currency: 'USD', marketState, completedSessions: [session], currentOverlay: null
  });
}

function reportContext(input) {
  return {
    header: REPORT_HEADER, selectedScope: input.analysisRequest.selectedScope,
    generatedAt: input.analysisRequest.generatedAt,
    userTimezone: input.analysisRequest.userTimezone,
    reportType: input.analysisRequest.reportType,
    markets: input.marketPackages.map(item => item.market)
  };
}

function sections(content = 'Supported analysis.') {
  return REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 7 ? null : index === 3 ? EMPTY_INITIATING_LIST_CONTENT.myStocks
      : content === null ? null : index === 2 ? 'Supported Technology analysis.' : content,
    evidenceRefs: index === 7 || index === 3 || content === null ? [] : ['e1'],
    telemetryRefs: index === 7 || index === 3 || content === null ? [] : ['t1'],
    uncertainties: []
  }));
}

function normalOutput(input, overrides = {}) {
  const reportSections = sections();
  const activeState = input.marketPackages.find(item => item.market === 'US')
    ?.marketContext?.marketState;
  if (ACTIVE_MARKET_STATES.has(activeState)) {
    const lead = activeState === 'PRE' ? 'pre-market'
      : activeState === 'POST' ? 'post-market' : 'regular session';
    reportSections[0].content = `In the ${lead}, current developments lead the analysis. `
      + 'The previous completed session provides comparison only.';
  }
  const firstFocus = input.marketPackages.flatMap(item => item.evidenceContext.broadMarketFocus)[0];
  if (firstFocus) reportSections[2].content = `Supported ${firstFocus.subjects[0].name} analysis.`;
  return {
    status: 'NORMAL', reportContext: reportContext(input), sections: reportSections,
    evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: [], ...overrides
  };
}

function providerTransport(output) {
  const encode = values => values.join('|');
  return {
    status: output.status,
    evidenceGaps: output.evidenceGaps,
    ...Object.fromEntries(output.sections.map((section, index) => [`s${index + 1}`, index === 7 ? {} : {
      content: section.content,
      evidenceRefs: encode(section.evidenceRefs),
      telemetryRefs: encode(section.telemetryRefs),
      uncertainties: encode(section.uncertainties)
    }]))
  };
}

function anthropicResponse(output, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; },
    ...overrides
  };
}

// Builds a {input, output} fixture for one market state, matching
// step8U2Case in tests/claude-analysis-invocation.test.js: an active-day
// package with a supported writer reply for PRE/REGULAR/POST, or the rich
// completed-week fixture (cloned and retimed) for CLOSED/WEEKEND/HOLIDAY.
function marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt) {
  if (overlayAsOf) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    return {input, output: normalOutput(input, {furtherReadings: ['e1']})};
  }
  const input = structuredClone(richCompletedUsWeekInput());
  input.analysisRequest.generatedAt = generatedAt;
  input.marketPackages[0].marketContext.marketState = marketState;
  for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
    input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
  return {input, output: supportedCompletedUsOutput(input)};
}

// A completed-day fixture with no broad-market focus evidence at all
// (thinDegradedFiveSessionInput), for the Section 3 "controlled unavailable"
// case. There is no active-day equivalent builder needed: activeUsInput
// already accepts broadMarketFocus: [] directly.
function thinCompletedMarketStateCase(marketState, generatedAt) {
  const input = structuredClone(thinDegradedFiveSessionInput());
  input.analysisRequest.generatedAt = generatedAt;
  input.marketPackages[0].marketContext.marketState = marketState;
  for (const snapshot of input.marketPackages[0].telemetry.benchmarkSnapshots.concat(
    input.marketPackages[0].telemetry.stockSnapshots)) snapshot.snapshot.marketState = marketState;
  return {input, output: supportedCompletedUsOutput(input)};
}

async function invokeCounted(input, output) {
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async () => { calls++; return anthropicResponse(output); },
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, calls, diagnostics};
}

async function invokeWithSectionEvents(input, raw) {
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(raw),
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, events: diagnostics.filter(value =>
    value.stage === 'claudeAnalysisSectionNormalization')};
}

module.exports = {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  UNSUPPORTED_CAUSALITY_QUALIFIER,
  activeUsInput,
  reportContext,
  sections,
  normalOutput,
  providerTransport,
  anthropicResponse,
  marketStateCase,
  thinCompletedMarketStateCase,
  unlinkedStockSnapshot,
  invokeCounted,
  invokeWithSectionEvents
};

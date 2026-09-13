const {createFiveSessionSnapshot, createCompletedRegularSession} = require('../../lib/five-session-snapshot');
const {createEvidenceItem} = require('../../lib/evidence-items');
const {createEvidenceCollection} = require('../../lib/evidence-collections');
const {
  EMPTY_INITIATING_LIST_CONTENT,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  createClaudeAnalysisInput
} = require('../../lib/claude-analysis-contract');

const GENERATED_AT = '2026-09-06T10:00:00.000Z';

function fiveSessionSnapshot(symbol, instrumentType = 'INDEX') {
  const facts = [
    ['2026-08-31', 100, 99],
    ['2026-09-01', 101, 100],
    ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99],
    ['2026-09-04', 105, 102]
  ];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`, instrumentType,
    currency: 'USD', marketState: 'CLOSED', currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2,
        close, previousClose, volume: 1000 + index,
        asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance',
        validationState: 'VALIDATED'
      }))
  });
}

function item(sourceId, title, canonicalUrl, publishedAt, symbols = [], evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols,
    ...(sourceId === 'us.yahoo-finance' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function richCompletedUsWeekInput({unresolvedGaps = []} = {}) {
  const benchmark = fiveSessionSnapshot('^GSPC');
  const stock = fiveSessionSnapshot('MSFT', 'EQUITY');
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
      '2026-09-04T21:00:00Z', ['^GSPC', 'MSFT']),
    item('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html',
      '2026-09-04T19:30:00Z', ['MSFT']),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', [], 'monetary-policy')
  ];
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks', generatedAt: GENERATED_AT,
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {benchmarkSnapshots: [benchmark], stockSnapshots: [stock]},
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3'], supportingEvidence: ['e2', 'e3'],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        unresolvedGaps,
        furtherReadings: [
          {evidenceRef: 'e1', sessionDate: '2026-09-04'},
          {evidenceRef: 'e2', sessionDate: '2026-09-04'}
        ]
      }
    }],
    portfolioContext: {
      myStocks: [{
        market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2'], upcomingEvents: []
      }],
      watchlist: [{
        market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []
      }]
    }
  });
}

function thinDegradedFiveSessionInput() {
  return richCompletedUsWeekInput({unresolvedGaps: [
    'Optional narrative evidence was unavailable at package assembly time.'
  ]});
}

function reportContext(input) {
  return {
    header: REPORT_HEADER, selectedScope: input.analysisRequest.selectedScope,
    generatedAt: input.analysisRequest.generatedAt, userTimezone: input.analysisRequest.userTimezone,
    reportType: input.analysisRequest.reportType, markets: ['US']
  };
}

function supportedOutput(input, {opportunity = true, plainEnglish = true} = {}) {
  const sections = REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 10 ? null
      : index === 4 ? 'Microsoft was material to the initiating My Stocks list.'
        : index === 7 && !opportunity ? null
          : plainEnglish
            ? 'The supplied evidence supports this concise market conclusion.'
            : 'Equity positioning reflected rate-path expectations and reallocation momentum.',
    evidenceRefs: index === 10 || (index === 7 && !opportunity) ? [] : ['e2'],
    telemetryRefs: index === 10 || (index === 7 && !opportunity) ? []
      : index === 4 ? ['t2'] : ['t1'],
    uncertainties: index === 7 && !opportunity ? ['No defensible opportunity is supported.'] : []
  }));
  return {
    status: opportunity ? 'NORMAL' : 'DEGRADED', reportContext: reportContext(input), sections,
    evidenceReferences: ['e2'], furtherReadings: ['e1', 'e2'],
    evidenceGaps: opportunity ? [] : ['No defensible evidence-supported opportunity was available.']
  };
}

module.exports = {
  GENERATED_AT,
  fiveSessionSnapshot,
  richCompletedUsWeekInput,
  thinDegradedFiveSessionInput,
  supportedOutput,
  EMPTY_INITIATING_LIST_CONTENT
};

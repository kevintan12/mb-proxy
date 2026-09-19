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

function fiveSessionSnapshot(symbol, instrumentType = 'INDEX', instrumentName = `${symbol} instrument`) {
  const facts = [
    ['2026-08-31', 100, 99],
    ['2026-09-01', 101, 100],
    ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99],
    ['2026-09-04', 105, 102]
  ];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName, instrumentType,
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

function completedUsWeekInput({
  unresolvedGaps = [], includeBroadMarket = true, includeFollowedFocus = false,
  stockInstrumentName = 'MSFT instrument'
} = {}) {
  const benchmark = fiveSessionSnapshot('^GSPC');
  const stock = fiveSessionSnapshot('MSFT', 'EQUITY', stockInstrumentName);
  const evidence = [
    item('us.yahoo-finance', 'Target-session Yahoo recap',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
      '2026-09-04T21:00:00Z', ['^GSPC', 'MSFT']),
    item('us.cnbc', includeFollowedFocus
      ? 'Microsoft leads broad-market software shares on Sept. 4, 2026'
      : 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html',
      '2026-09-04T19:30:00Z', ['MSFT']),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', [], 'monetary-policy')
  ];
  if (includeBroadMarket) evidence.push(
    item('us.cnbc', 'Broadcom leads semiconductor shares after a major company development',
      'https://www.cnbc.com/2026/09/04/broadcom-semiconductor-leadership.html',
      '2026-09-04T19:00:00Z'),
    item('us.cnbc', 'Health-care shares advance on constructive industry developments',
      'https://www.cnbc.com/2026/09/04/health-care-sector-advances.html',
      '2026-09-04T19:15:00Z')
  );
  const broadReferences = includeBroadMarket ? ['e4', 'e5'] : [];
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
        materialEvents: ['e1', 'e2', 'e3', ...broadReferences], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', ...(includeBroadMarket ? ['e4'] : [])],
        supportingEvidence: ['e2', 'e3', ...broadReferences],
        conflictingEvidence: [], subsequentDevelopments: ['e1'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: includeBroadMarket ? [
          ...(includeFollowedFocus ? [
            {evidenceRef: 'e2', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]}
          ] : []),
          {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          {evidenceRef: 'e5', subjects: [{kind: 'SECTOR', name: 'Health-care'}]}
        ] : [],
        unresolvedGaps,
        furtherReadings: [
          {evidenceRef: 'e1', sessionDate: '2026-09-04'},
          {evidenceRef: 'e2', sessionDate: '2026-09-04'},
          ...(includeBroadMarket ? [
            {evidenceRef: 'e4', sessionDate: '2026-09-04'},
            {evidenceRef: 'e5', sessionDate: '2026-09-04'}
          ] : [])
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

function richCompletedUsWeekInput(options = {}) {
  return completedUsWeekInput({...options, includeBroadMarket: true});
}

function thinDegradedFiveSessionInput() {
  return completedUsWeekInput({
    includeBroadMarket: false,
    unresolvedGaps: ['Optional broad-market narrative evidence was unavailable at package assembly time.']
  });
}

function reportContext(input) {
  return {
    header: REPORT_HEADER, selectedScope: input.analysisRequest.selectedScope,
    generatedAt: input.analysisRequest.generatedAt, userTimezone: input.analysisRequest.userTimezone,
    reportType: input.analysisRequest.reportType, markets: ['US']
  };
}

function supportedOutput(input, {opportunity = true, plainEnglish = true} = {}) {
  const broadMarketAvailable = input.marketPackages[0].evidenceContext.broadMarketFocus.length > 0;
  const ordinaryContent = plainEnglish
    ? [
        'The market finished higher as company and policy evidence shaped the session.',
        'Federal Reserve policy context and company developments were the main supported drivers.',
        'The recap and policy evidence support the reported completed-session move.',
        broadMarketAvailable
          ? 'Broadcom led semiconductor shares, while health-care stocks also advanced.'
          : 'The two market recaps describe broad closing-session conditions.',
        'Microsoft was material to the initiating My Stocks list.',
        'The evidence points to broader participation beyond the initiating list.',
        'Policy uncertainty remains a material risk to the market outlook.',
        'Constructive health-care developments support a specific sector opportunity.',
        'The later Yahoo recap and policy calendar identify the next developments to monitor.',
        'Company leadership broadened, but policy risk remains important.'
      ]
    : Array(10).fill('Equity positioning reflected rate-path expectations and reallocation momentum.');
  if (!plainEnglish && broadMarketAvailable) {
    ordinaryContent[3] = 'Broadcom equity positioning reflected reallocation momentum.';
  }
  const evidenceRefs = [
    ['e2', 'e3'], ['e3'], ['e2', 'e3'], broadMarketAvailable ? ['e4', 'e5'] : ['e1', 'e2'],
    ['e2'], broadMarketAvailable ? ['e4', 'e5'] : ['e2'], ['e3'], ['e5'], ['e1', 'e3'], ['e1']
  ];
  const sections = REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 10 || (index === 3 && !broadMarketAvailable)
      ? null : index === 7 && !opportunity ? null : ordinaryContent[index],
    evidenceRefs: index === 10 || (index === 3 && !broadMarketAvailable)
      || (index === 7 && !opportunity) ? [] : evidenceRefs[index],
    telemetryRefs: index === 10 || (index === 3 && !broadMarketAvailable)
      || (index === 7 && !opportunity) ? []
      : index === 4 ? ['t2'] : ['t1'],
    uncertainties: index === 3 && !broadMarketAvailable
      ? ['Validated broad-market company or sector evidence was unavailable.']
      : index === 7 && !opportunity ? ['No defensible opportunity is supported.'] : []
  }));
  const evidenceGaps = [];
  if (!broadMarketAvailable) {
    evidenceGaps.push('Validated broad-market company or sector evidence was unavailable.');
  }
  if (!opportunity) {
    evidenceGaps.push('No defensible evidence-supported opportunity was available.');
  }
  return {
    status: opportunity && broadMarketAvailable ? 'NORMAL' : 'DEGRADED',
    reportContext: reportContext(input), sections,
    evidenceReferences: broadMarketAvailable
      ? ['e2', 'e3', 'e4', 'e5', 'e1'] : ['e2', 'e3', 'e1'],
    furtherReadings: broadMarketAvailable ? ['e1', 'e2', 'e4', 'e5'] : ['e1', 'e2'],
    evidenceGaps
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

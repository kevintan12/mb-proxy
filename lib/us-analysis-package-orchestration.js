const {
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
} = require('./analysis-package-service');
const {createEvidenceCollection} = require('./evidence-collections');
const {validateThreeSessionSnapshot} = require('./three-session-snapshot');
const {performance} = require('node:perf_hooks');

const ORCHESTRATION_REQUEST_KEYS = Object.freeze([
  'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
]);
const BENCHMARK_ANCHOR_KEYS = Object.freeze(['market', 'symbol']);
const FEDERAL_RESERVE_UNAVAILABLE_GAP =
  'Federal Reserve monetary-policy evidence was unavailable at package assembly time.';

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function marketForSymbol(symbol) {
  if (symbol.endsWith('.SI') || symbol === '^STI') return 'SG';
  if (symbol.endsWith('.HK') || symbol === '^HSI') return 'HK';
  return 'US';
}

function canonicalBenchmarkAnchors(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('benchmarkAnchors must be a non-empty array');
  }
  const seen = new Set();
  const anchors = [];
  for (const anchor of value) {
    if (!hasExactKeys(anchor, BENCHMARK_ANCHOR_KEYS)) {
      throw new TypeError('benchmarkAnchors contains an invalid anchor');
    }
    const market = typeof anchor.market === 'string' ? anchor.market.trim().toUpperCase() : '';
    const symbol = typeof anchor.symbol === 'string' ? anchor.symbol.trim().toUpperCase() : '';
    if (market !== 'US' || !symbol || marketForSymbol(symbol) !== 'US') {
      throw new TypeError('benchmarkAnchors supports valid US anchors only');
    }
    const key = `${market}|${symbol}`;
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push({market, symbol});
    }
  }
  return Object.freeze(anchors.map(anchor => Object.freeze(anchor)));
}

function validateUsAnalysisOrchestrationRequest(input) {
  if (!hasExactKeys(input, ORCHESTRATION_REQUEST_KEYS)) {
    throw new TypeError('Invalid US analysis orchestration request shape or order');
  }
  const benchmarkAnchors = canonicalBenchmarkAnchors(input.benchmarkAnchors);
  const canonicalRequest = canonicalizeAnalysisPackageRequest({
    selectedScope: input.selectedScope,
    initiatingList: input.initiatingList,
    userTimezone: input.userTimezone,
    myStocks: input.myStocks,
    watchlist: input.watchlist
  });
  if (canonicalRequest.selectedScope !== 'US') {
    throw new TypeError('US analysis package orchestration supports selectedScope US only');
  }
  const benchmarkSymbols = new Set(benchmarkAnchors.map(anchor => anchor.symbol));
  if (canonicalRequest.myStocks.concat(canonicalRequest.watchlist)
    .some(item => benchmarkSymbols.has(item.symbol))) {
    throw new TypeError('Benchmark anchors cannot be portfolio membership');
  }
  return Object.freeze({benchmarkAnchors, canonicalRequest});
}

function requireMethod(value, method, name) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${name} must provide ${method}()`);
  }
}

function elapsedMilliseconds(start, end) {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function uniquePortfolioSymbols(myStocks, watchlist) {
  const seen = new Set();
  const symbols = [];
  for (const item of myStocks.concat(watchlist)) {
    if (!seen.has(item.symbol)) {
      seen.add(item.symbol);
      symbols.push(item.symbol);
    }
  }
  return symbols;
}

function requireSnapshot(snapshot, symbol) {
  const validation = validateThreeSessionSnapshot(snapshot);
  if (!validation.valid || snapshot.market !== 'US' || snapshot.symbol !== symbol) {
    throw new TypeError(`Invalid canonical US snapshot for ${symbol}`);
  }
  return snapshot;
}

function requireEvidenceCollection(collection, {sourceId, symbol = null}) {
  let canonical;
  try {
    canonical = createEvidenceCollection(collection);
  } catch (error) {
    throw new TypeError(`Invalid canonical ${sourceId} evidence collection`);
  }
  if (canonical.market !== 'US' || canonical.items.length === 0
      || (symbol !== null && canonical.items.length !== 1)
      || canonical.items.some(item => item.sourceId !== sourceId
        || item.market !== 'US'
        || (symbol !== null && (item.symbols.length !== 1 || item.symbols[0] !== symbol)))) {
    throw new TypeError(`Invalid canonical ${sourceId} evidence collection`);
  }
  return canonical;
}

function rejectFutureEvidence(items, generatedAt) {
  const generatedTime = Date.parse(generatedAt);
  if (items.some(item => Date.parse(item.publishedAt) > generatedTime)) {
    throw new TypeError('Future-dated evidence is not allowed');
  }
}

function createMarketContext(snapshots) {
  const first = snapshots[0];
  if (!first || snapshots.some(snapshot => snapshot.exchangeTimezone !== 'America/New_York'
      || snapshot.marketState !== first.marketState)) {
    throw new TypeError('US snapshots have inconsistent market/session context');
  }
  const dates = snapshots.map(snapshot => snapshot.primaryCompletedSessionDate).filter(Boolean).sort();
  return {
    exchangeTimezone: 'America/New_York',
    marketState: first.marketState,
    primaryCompletedSessionDate: dates.length ? dates[dates.length - 1] : null,
    includesCurrentOverlay: snapshots.some(snapshot => snapshot.currentOverlay !== null),
    calendarContext: null
  };
}

function createUsAnalysisPackageOrchestrationService({
  createTelemetryAcquisition,
  snapshotPersistence,
  yahooEvidenceAcquisition,
  federalReserveEvidenceAcquisition,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  onDiagnostics
} = {}) {
  if (typeof createTelemetryAcquisition !== 'function') {
    throw new TypeError('createTelemetryAcquisition must be a function');
  }
  requireMethod(snapshotPersistence, 'persistSnapshot', 'snapshotPersistence');
  requireMethod(yahooEvidenceAcquisition, 'acquireEvidence', 'yahooEvidenceAcquisition');
  requireMethod(federalReserveEvidenceAcquisition, 'acquireEvidence', 'federalReserveEvidenceAcquisition');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof monotonicNow !== 'function') throw new TypeError('monotonicNow must be a function');

  async function acquireAnalysisMaterial(context, benchmarkAnchors, stageTiming) {
    if (context.selectedScope !== 'US' || context.markets.length !== 1 || context.markets[0] !== 'US') {
      throw new TypeError('US analysis package orchestration supports selectedScope US only');
    }
    const benchmarkSymbols = benchmarkAnchors.map(anchor => anchor.symbol);
    const benchmarkSymbolSet = new Set(benchmarkSymbols);
    if (context.myStocks.concat(context.watchlist).some(item => benchmarkSymbolSet.has(item.symbol))) {
      throw new TypeError('Benchmark anchors cannot be portfolio membership');
    }

    const telemetryAcquisition = createTelemetryAcquisition({generatedAt: context.generatedAt});
    requireMethod(telemetryAcquisition, 'acquireSnapshot', 'telemetryAcquisition');
    const portfolioSymbols = uniquePortfolioSymbols(context.myStocks, context.watchlist);
    const acquisitionSymbols = benchmarkSymbols.concat(portfolioSymbols);
    const snapshots = [];
    const yahooCollections = [];

    async function timed(stage, operation) {
      const started = monotonicNow();
      try {
        return await operation();
      } finally {
        stageTiming[stage] += elapsedMilliseconds(started, monotonicNow());
      }
    }

    for (const symbol of acquisitionSymbols) {
      const acquired = requireSnapshot(
        await timed('yahooTelemetryAcquisitionMs', () =>
          telemetryAcquisition.acquireSnapshot({market: 'US', symbol})),
        symbol
      );
      const persisted = requireSnapshot(await timed('postgresPersistenceReadbackMs', () =>
        snapshotPersistence.persistSnapshot(acquired)), symbol);
      snapshots.push(persisted);
      yahooCollections.push(requireEvidenceCollection(
        await timed('yahooMarketDataEvidenceAcquisitionMs', () =>
          yahooEvidenceAcquisition.acquireEvidence({symbol})),
        {sourceId: 'us.yahoo-finance', symbol}
      ));
    }

    let federalReserveCollection;
    let federalReserveUnavailable = false;
    try {
      federalReserveCollection = requireEvidenceCollection(
        await timed('federalReserveEvidenceAcquisitionMs', () =>
          federalReserveEvidenceAcquisition.acquireEvidence()),
        {sourceId: 'us.federal-reserve'}
      );
      if (federalReserveCollection.items.some(item => item.evidenceCategory !== 'monetary-policy')) {
        throw new TypeError('Invalid canonical Federal Reserve monetary-policy evidence collection');
      }
    } catch (error) {
      federalReserveUnavailable = true;
      federalReserveCollection = null;
    }

    const yahooItems = yahooCollections.flatMap(collection => collection.items);
    const federalReserveItems = federalReserveCollection ? federalReserveCollection.items : [];
    const evidenceItems = yahooItems.concat(federalReserveItems);
    rejectFutureEvidence(evidenceItems, context.generatedAt);
    const evidenceCollection = createEvidenceCollection({market: 'US', items: evidenceItems});

    const portfolioTelemetryReferenceBySymbol = new Map(
      portfolioSymbols.map((symbol, index) => [symbol, `t${benchmarkSymbols.length + index + 1}`])
    );
    const portfolioEvidenceReferenceBySymbol = new Map(
      portfolioSymbols.map((symbol, index) => [symbol, `e${benchmarkSymbols.length + index + 1}`])
    );
    const yahooReferences = yahooItems.map((item, index) => `e${index + 1}`);
    const federalReserveReferences = federalReserveItems.map(
      (item, index) => `e${yahooItems.length + index + 1}`
    );
    const allEvidenceReferences = yahooReferences.concat(federalReserveReferences);

    function portfolioList(items) {
      return items.map(item => ({
        market: item.market,
        symbol: item.symbol,
        telemetryRefs: [portfolioTelemetryReferenceBySymbol.get(item.symbol)],
        evidenceRefs: [portfolioEvidenceReferenceBySymbol.get(item.symbol)],
        upcomingEvents: []
      }));
    }

    return {
      marketPackages: [{
        market: 'US',
        marketContext: createMarketContext(snapshots),
        telemetry: {
          benchmarkSnapshots: snapshots.slice(0, benchmarkSymbols.length),
          stockSnapshots: snapshots.slice(benchmarkSymbols.length)
        },
        evidenceCollection,
        evidenceContext: {
          materialEvents: [],
          authoritativeFacts: allEvidenceReferences,
          principalCatalysts: [],
          supportingEvidence: allEvidenceReferences,
          conflictingEvidence: [],
          subsequentDevelopments: [],
          unresolvedGaps: federalReserveUnavailable ? [FEDERAL_RESERVE_UNAVAILABLE_GAP] : [],
          furtherReadings: []
        }
      }],
      portfolioContext: {
        myStocks: portfolioList(context.myStocks),
        watchlist: portfolioList(context.watchlist)
      }
    };
  }

  return Object.freeze({
    async assemble(input) {
      const stageTiming = {
        yahooTelemetryAcquisitionMs: 0,
        postgresPersistenceReadbackMs: 0,
        yahooMarketDataEvidenceAcquisitionMs: 0,
        federalReserveEvidenceAcquisitionMs: 0,
        packageAssemblyFinalizationMs: 0,
        packageRuntimeTotalMs: 0
      };
      const runtimeStarted = monotonicNow();
      try {
        const {benchmarkAnchors, canonicalRequest} = validateUsAnalysisOrchestrationRequest(input);
        const packageService = createAnalysisPackageService({
          acquireAnalysisMaterial: context => acquireAnalysisMaterial(
            context,
            benchmarkAnchors,
            stageTiming
          ),
          now
        });
        return await packageService.assemble(canonicalRequest);
      } finally {
        stageTiming.packageRuntimeTotalMs = elapsedMilliseconds(runtimeStarted, monotonicNow());
        const measuredStages = stageTiming.yahooTelemetryAcquisitionMs
          + stageTiming.postgresPersistenceReadbackMs
          + stageTiming.yahooMarketDataEvidenceAcquisitionMs
          + stageTiming.federalReserveEvidenceAcquisitionMs;
        stageTiming.packageAssemblyFinalizationMs = Math.max(
          0,
          stageTiming.packageRuntimeTotalMs - measuredStages
        );
        if (typeof onDiagnostics === 'function') {
          try {
            onDiagnostics(Object.freeze({timing: Object.freeze({...stageTiming})}));
          } catch (error) {
            // Observability must not affect package assembly behavior.
          }
        }
      }
    }
  });
}

module.exports = {
  BENCHMARK_ANCHOR_KEYS,
  FEDERAL_RESERVE_UNAVAILABLE_GAP,
  ORCHESTRATION_REQUEST_KEYS,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
};

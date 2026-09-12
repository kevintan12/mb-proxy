const {
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
} = require('./analysis-package-service');
const {createEvidenceCollection} = require('./evidence-collections');
const {validateEvidenceItem} = require('./evidence-items');
const {validateThreeSessionSnapshot} = require('./three-session-snapshot');
const {performance} = require('node:perf_hooks');

const ORCHESTRATION_REQUEST_KEYS = Object.freeze([
  'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
]);
const BENCHMARK_ANCHOR_KEYS = Object.freeze(['market', 'symbol']);
const FEDERAL_RESERVE_UNAVAILABLE_GAP =
  'Federal Reserve monetary-policy evidence was unavailable at package assembly time.';
const CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP =
  'CNBC market-news research was unavailable at package assembly time.';
const YAHOO_RECAP_UNAVAILABLE_GAP =
  'Yahoo Finance completed-session recap was unavailable at package assembly time.';
const YAHOO_RECAP_RETRIEVAL_FAILURE_GAP =
  'Yahoo Finance completed-session recap validation or retrieval failed at package assembly time.';
const YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP =
  'Yahoo Finance completed-session recap evidence construction failed at package assembly time.';

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

function deriveCnbcResearchHorizons(benchmarkSnapshots, generatedAt) {
  if (!Array.isArray(benchmarkSnapshots) || benchmarkSnapshots.length === 0) {
    throw new TypeError('Canonical benchmark close boundaries are unavailable');
  }
  const boundaries = benchmarkSnapshots.map(snapshot => {
    if (!Array.isArray(snapshot.completedSessions) || snapshot.completedSessions.length < 2) {
      throw new TypeError('Canonical benchmark close boundaries are unavailable');
    }
    const primary = snapshot.completedSessions.at(-1).asOf;
    const previous = snapshot.completedSessions.at(-2).asOf;
    if (!Number.isFinite(Date.parse(previous)) || !Number.isFinite(Date.parse(primary))
        || Date.parse(previous) >= Date.parse(primary)) {
      throw new TypeError('Canonical benchmark close boundaries are invalid');
    }
    return {previous, primary};
  });
  if (boundaries.some(boundary => boundary.previous !== boundaries[0].previous
      || boundary.primary !== boundaries[0].primary)) {
    throw new TypeError('Canonical benchmark close boundaries are inconsistent');
  }
  const generatedTime = Date.parse(generatedAt);
  const primaryTime = Date.parse(boundaries[0].primary);
  if (!Number.isFinite(generatedTime) || generatedTime < primaryTime) {
    throw new TypeError('Package time precedes the primary completed close');
  }
  const horizons = [{
    classification: 'COMPLETED_SESSION',
    startsAtExclusive: boundaries[0].previous,
    endsAtInclusive: boundaries[0].primary
  }];
  if (generatedTime > primaryTime) {
    horizons.push({
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: boundaries[0].primary,
      endsAtInclusive: generatedAt
    });
  }
  return Object.freeze(horizons.map(horizon => Object.freeze(horizon)));
}

function horizonForArticle(horizons, articleContent) {
  return horizons.find(horizon => {
    const published = Date.parse(articleContent.publishedAt);
    const updated = articleContent.updatedAt === null ? published : Date.parse(articleContent.updatedAt);
    return published > Date.parse(horizon.startsAtExclusive)
      && published <= Date.parse(horizon.endsAtInclusive)
      && updated > Date.parse(horizon.startsAtExclusive)
      && updated <= Date.parse(horizon.endsAtInclusive);
  }) || null;
}

function yahooRecapArticleMatchesResearch(research, articleContent, targetSessionDate) {
  return articleContent && articleContent.sourceId === 'us.yahoo-finance'
    && articleContent.targetSessionDate === targetSessionDate
    && articleContent.canonicalUrl === research.discovery.url
    && articleContent.publishedAt === research.validation.datePublished
    && articleContent.updatedAt === research.validation.dateModified
    && (research.validation.headline === null
      || articleContent.headline === research.validation.headline)
    && articleContent.publisher && typeof articleContent.publisher.name === 'string'
    && articleContent.publisher.name.length > 0;
}

function requireYahooRecapConstructedEvidence(result, articleContent, targetSessionDate, horizon) {
  const record = result?.constructedEvidence;
  const item = record?.evidenceItem;
  if (!result || result.ok !== true || result.type !== 'SUCCESS'
      || !record || record.targetSessionDate !== targetSessionDate
      || record.updatedAt !== articleContent.updatedAt
      || JSON.stringify(record.horizon) !== JSON.stringify(horizon)
      || !validateEvidenceItem(item).valid
      || item.sourceId !== articleContent.sourceId || item.market !== 'US'
      || item.evidenceCategory !== 'news'
      || item.title !== articleContent.headline
      || item.summary !== articleContent.articleText
      || item.canonicalUrl !== articleContent.canonicalUrl
      || item.publishedAt !== articleContent.publishedAt
      || item.symbols.length !== 0
      || item.provenance.publisher !== articleContent.publisher.name) {
    throw new TypeError('Invalid canonical Yahoo recap constructed evidence');
  }
  return Object.freeze({
    targetSessionDate: record.targetSessionDate,
    updatedAt: record.updatedAt,
    horizon: Object.freeze({...record.horizon}),
    evidenceItem: item
  });
}

function requireCnbcConstructedEvidence(result, horizons) {
  if (!result || result.ok !== true || result.type !== 'SUCCESS'
      || !Array.isArray(result.candidateCollection?.candidates)
      || !Array.isArray(result.selections)
      || !Array.isArray(result.retrievedArticles)
      || !Array.isArray(result.constructedEvidence)) {
    throw new TypeError('CNBC news research failed');
  }
  const candidates = new Map(result.candidateCollection.candidates.map(candidate => [
    candidate.reference,
    candidate
  ]));
  if (candidates.size === 0 || result.selections.length !== candidates.size) {
    throw new TypeError('Invalid CNBC news research coverage');
  }
  for (let index = 0; index < result.candidateCollection.candidates.length; index++) {
    const candidate = result.candidateCollection.candidates[index];
    const selection = result.selections[index];
    if (candidate.reference !== `c${index + 1}` || selection?.reference !== candidate.reference
        || (selection.decision !== 'USE' && selection.decision !== 'SKIP')) {
      throw new TypeError('Invalid CNBC news research ordering');
    }
  }
  let previousCandidateNumber = 0;
  return result.constructedEvidence.map(record => {
    const candidate = candidates.get(record?.candidateReference);
    const referenceMatch = /^c([1-9][0-9]*)$/.exec(record?.candidateReference || '');
    const horizon = horizons.find(item => item.classification === record?.horizon?.classification);
    if (!candidate || !referenceMatch || Number(referenceMatch[1]) <= previousCandidateNumber
        || candidate.sourceId !== 'us.cnbc' || candidate.market !== 'US'
        || candidate.evidenceCategory !== 'news'
        || JSON.stringify(candidate.horizon) !== JSON.stringify(record.horizon)
        || !horizon || JSON.stringify(horizon) !== JSON.stringify(record.horizon)
        || record.selection?.reference !== record.candidateReference
        || record.selection?.decision !== 'USE'
        || !validateEvidenceItem(record.evidenceItem).valid
        || record.evidenceItem.sourceId !== candidate.sourceId
        || record.evidenceItem.market !== candidate.market
        || record.evidenceItem.evidenceCategory !== candidate.evidenceCategory
        || record.evidenceItem.title !== candidate.title
        || record.evidenceItem.canonicalUrl !== candidate.canonicalUrl
        || record.evidenceItem.publishedAt !== candidate.publishedAt
        || JSON.stringify(record.evidenceItem.symbols) !== JSON.stringify(candidate.symbols)
        || JSON.stringify(record.evidenceItem.provenance) !== JSON.stringify(candidate.provenance)) {
      throw new TypeError('Invalid canonical CNBC constructed evidence');
    }
    previousCandidateNumber = Number(referenceMatch[1]);
    return Object.freeze({
      candidateReference: record.candidateReference,
      horizon: Object.freeze({...record.horizon}),
      evidenceItem: record.evidenceItem
    });
  });
}

function createUsAnalysisPackageOrchestrationService({
  createTelemetryAcquisition,
  snapshotPersistence,
  yahooEvidenceAcquisition,
  federalReserveEvidenceAcquisition,
  yahooRecapResearch,
  yahooRecapArticleContentAcquisition,
  yahooRecapEvidenceConstruction,
  yahooRecapArticleContentBounds,
  cnbcNewsResearch,
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
  requireMethod(yahooRecapResearch, 'discoverAndValidateRecap', 'yahooRecapResearch');
  requireMethod(
    yahooRecapArticleContentAcquisition,
    'acquireArticleContent',
    'yahooRecapArticleContentAcquisition'
  );
  requireMethod(yahooRecapEvidenceConstruction, 'constructEvidence', 'yahooRecapEvidenceConstruction');
  if (!yahooRecapArticleContentBounds || typeof yahooRecapArticleContentBounds !== 'object') {
    throw new TypeError('yahooRecapArticleContentBounds must be provided');
  }
  requireMethod(cnbcNewsResearch, 'researchNews', 'cnbcNewsResearch');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof monotonicNow !== 'function') throw new TypeError('monotonicNow must be a function');

  async function acquireAnalysisMaterial(context, benchmarkAnchors, stageTiming, setAssemblyFailureStage) {
    if (context.selectedScope !== 'US' || context.markets.length !== 1 || context.markets[0] !== 'US') {
      throw new TypeError('US analysis package orchestration supports selectedScope US only');
    }
    const benchmarkSymbols = benchmarkAnchors.map(anchor => anchor.symbol);
    const benchmarkSymbolSet = new Set(benchmarkSymbols);
    if (context.myStocks.concat(context.watchlist).some(item => benchmarkSymbolSet.has(item.symbol))) {
      throw new TypeError('Benchmark anchors cannot be portfolio membership');
    }

    const telemetryAcquisition = createTelemetryAcquisition({generatedAt: context.acquisitionStartedAt});
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

    const benchmarkSnapshots = snapshots.slice(0, benchmarkSymbols.length);
    const marketContext = createMarketContext(snapshots);
    let canonicalHorizons = null;
    try {
      canonicalHorizons = deriveCnbcResearchHorizons(benchmarkSnapshots, context.acquisitionStartedAt);
    } catch (error) {
      canonicalHorizons = null;
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

    let yahooRecapConstructedEvidence = null;
    let yahooRecapGap = null;
    let yahooRecapFailureType = null;
    let yahooRecapFailureOutcome = null;
    if (marketContext.primaryCompletedSessionDate === null) {
      yahooRecapGap = YAHOO_RECAP_UNAVAILABLE_GAP;
      yahooRecapFailureType = 'PRIMARY_COMPLETED_SESSION_UNAVAILABLE';
      yahooRecapFailureOutcome = 'UNAVAILABLE';
    } else if (!canonicalHorizons) {
      yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
      yahooRecapFailureType = 'HORIZON_UNAVAILABLE';
      yahooRecapFailureOutcome = 'FAILURE';
    } else {
      let yahooRecapStage = 'RESEARCH';
      try {
        const research = await timed('yahooRecapResearchMs', () =>
          yahooRecapResearch.discoverAndValidateRecap({
            targetSessionDate: marketContext.primaryCompletedSessionDate
          }));
        if (research?.ok === true && (research.type === 'NOT_FOUND'
            || research.type === 'NOT_VALIDATED')) {
          yahooRecapGap = YAHOO_RECAP_UNAVAILABLE_GAP;
          yahooRecapFailureType = research.type;
          yahooRecapFailureOutcome = 'UNAVAILABLE';
        } else if (!research || research.ok !== true || research.type !== 'VALIDATED'
            || !research.discovery || !research.validation
            || research.discovery.targetSessionDate !== marketContext.primaryCompletedSessionDate
            || research.validation.targetSessionDate !== marketContext.primaryCompletedSessionDate) {
          yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
          yahooRecapFailureType = typeof research?.type === 'string'
            ? research.type : 'UNKNOWN_FAILURE';
          yahooRecapFailureOutcome = 'FAILURE';
        } else {
          yahooRecapStage = 'ARTICLE';
          const acquired = await timed('yahooRecapArticleContentAcquisitionMs', () =>
            yahooRecapArticleContentAcquisition.acquireArticleContent({
              discovery: research.discovery,
              validation: research.validation,
              bounds: yahooRecapArticleContentBounds
            }));
          if (!acquired || acquired.ok !== true || acquired.type !== 'SUCCESS'
              || !yahooRecapArticleMatchesResearch(
                research,
                acquired.articleContent,
                marketContext.primaryCompletedSessionDate
              )) {
            yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
            yahooRecapFailureType = acquired?.ok === true
              ? 'ARTICLE_CONTRACT_FAILURE'
              : typeof acquired?.type === 'string' ? acquired.type : 'UNKNOWN_FAILURE';
            yahooRecapFailureOutcome = 'FAILURE';
          } else {
            const horizon = horizonForArticle(canonicalHorizons, acquired.articleContent);
            if (!horizon) {
              yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
              yahooRecapFailureType = 'HORIZON_MISMATCH';
              yahooRecapFailureOutcome = 'FAILURE';
            } else {
              yahooRecapStage = 'EVIDENCE';
              const constructed = await timed('yahooRecapEvidenceConstructionMs', () =>
                yahooRecapEvidenceConstruction.constructEvidence({
                  articleContent: acquired.articleContent,
                  horizon
                }));
              try {
                yahooRecapConstructedEvidence = requireYahooRecapConstructedEvidence(
                  constructed,
                  acquired.articleContent,
                  marketContext.primaryCompletedSessionDate,
                  horizon
                );
              } catch (error) {
                yahooRecapGap = YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP;
                yahooRecapFailureType = typeof constructed?.type === 'string'
                  ? constructed.type : 'EVIDENCE_CONTRACT_FAILURE';
                yahooRecapFailureOutcome = 'FAILURE';
              }
            }
          }
        }
      } catch (error) {
        const evidenceFailure = yahooRecapStage === 'EVIDENCE';
        yahooRecapGap = evidenceFailure
          ? YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP
          : YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
        yahooRecapFailureType = 'THROWN_FAILURE';
        yahooRecapFailureOutcome = 'FAILURE';
      }
    }
    if (yahooRecapGap && typeof onDiagnostics === 'function') {
      try {
        onDiagnostics(Object.freeze({
          stage: 'yahooRecapIntegration',
          outcome: yahooRecapFailureOutcome,
          failureType: yahooRecapFailureType
        }));
      } catch (diagnosticError) {
        // Observability must not affect package assembly behavior.
      }
    }

    let cnbcConstructedEvidence = [];
    let cnbcUnavailable = false;
    let cnbcFailureType = null;
    try {
      if (!canonicalHorizons) throw new TypeError('Canonical research horizons are unavailable');
      const horizons = canonicalHorizons;
      const result = await timed('cnbcNewsResearchMs', () =>
        cnbcNewsResearch.researchNews({horizons}));
      if (!result || result.ok !== true) {
        cnbcFailureType = typeof result?.type === 'string' ? result.type : 'UNKNOWN_FAILURE';
        throw new TypeError('CNBC news research failed');
      }
      cnbcConstructedEvidence = requireCnbcConstructedEvidence(result, horizons);
    } catch (error) {
      cnbcUnavailable = true;
      cnbcConstructedEvidence = [];
      if (!cnbcFailureType) cnbcFailureType = 'HORIZON_OR_CONTRACT_FAILURE';
      if (typeof onDiagnostics === 'function') {
        try {
          onDiagnostics(Object.freeze({
            stage: 'cnbcNewsResearchIntegration',
            outcome: 'FAILURE',
            failureType: cnbcFailureType
          }));
        } catch (diagnosticError) {
          // Observability must not affect package assembly behavior.
        }
      }
    }

    const yahooItems = yahooCollections.flatMap(collection => collection.items);
    const yahooRecapItems = yahooRecapConstructedEvidence
      ? [yahooRecapConstructedEvidence.evidenceItem] : [];
    const federalReserveItems = federalReserveCollection ? federalReserveCollection.items : [];
    const cnbcItems = cnbcConstructedEvidence.map(record => record.evidenceItem);
    const evidenceItems = yahooItems.concat(yahooRecapItems, federalReserveItems, cnbcItems);
    setAssemblyFailureStage('EVIDENCE_COLLECTION_CONSTRUCTION');
    const evidenceCollection = createEvidenceCollection({market: 'US', items: evidenceItems});
    setAssemblyFailureStage('ANALYSIS_MATERIAL_ACQUISITION');

    const portfolioTelemetryReferenceBySymbol = new Map(
      portfolioSymbols.map((symbol, index) => [symbol, `t${benchmarkSymbols.length + index + 1}`])
    );
    const portfolioEvidenceReferenceBySymbol = new Map(
      portfolioSymbols.map((symbol, index) => [symbol, `e${benchmarkSymbols.length + index + 1}`])
    );
    const yahooReferences = yahooItems.map((item, index) => `e${index + 1}`);
    const yahooRecapReferences = yahooRecapItems.map(
      (item, index) => `e${yahooItems.length + index + 1}`
    );
    const federalReserveReferences = federalReserveItems.map(
      (item, index) => `e${yahooItems.length + yahooRecapItems.length + index + 1}`
    );
    const cnbcReferences = cnbcConstructedEvidence.map(
      (record, index) => `e${yahooItems.length + yahooRecapItems.length
        + federalReserveItems.length + index + 1}`
    );
    const existingEvidenceReferences = yahooReferences.concat(federalReserveReferences);
    const completedSessionYahooRecapReferences = yahooRecapReferences.filter(() =>
      yahooRecapConstructedEvidence.horizon.classification === 'COMPLETED_SESSION');
    const subsequentYahooRecapReferences = yahooRecapReferences.filter(() =>
      yahooRecapConstructedEvidence.horizon.classification === 'SUBSEQUENT_DEVELOPMENT');
    const completedSessionCnbcReferences = cnbcReferences.filter((reference, index) =>
      cnbcConstructedEvidence[index].horizon.classification === 'COMPLETED_SESSION');
    const subsequentCnbcReferences = cnbcReferences.filter((reference, index) =>
      cnbcConstructedEvidence[index].horizon.classification === 'SUBSEQUENT_DEVELOPMENT');

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
        marketContext,
        telemetry: {
          benchmarkSnapshots,
          stockSnapshots: snapshots.slice(benchmarkSymbols.length)
        },
        evidenceCollection,
        evidenceContext: {
          materialEvents: [],
          authoritativeFacts: existingEvidenceReferences,
          principalCatalysts: [],
          supportingEvidence: yahooReferences.concat(
            completedSessionYahooRecapReferences,
            federalReserveReferences,
            completedSessionCnbcReferences
          ),
          conflictingEvidence: [],
          subsequentDevelopments: subsequentYahooRecapReferences.concat(subsequentCnbcReferences),
          unresolvedGaps: [
            ...(federalReserveUnavailable ? [FEDERAL_RESERVE_UNAVAILABLE_GAP] : []),
            ...(yahooRecapGap ? [yahooRecapGap] : []),
            ...(cnbcUnavailable ? [CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP] : [])
          ],
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
        yahooRecapResearchMs: 0,
        yahooRecapArticleContentAcquisitionMs: 0,
        yahooRecapEvidenceConstructionMs: 0,
        cnbcNewsResearchMs: 0,
        packageAssemblyFinalizationMs: 0,
        packageRuntimeTotalMs: 0
      };
      const runtimeStarted = monotonicNow();
      try {
        const {benchmarkAnchors, canonicalRequest} = validateUsAnalysisOrchestrationRequest(input);
        const packageService = createAnalysisPackageService({
          acquireAnalysisMaterial: (context, setAssemblyFailureStage) => acquireAnalysisMaterial(
            context,
            benchmarkAnchors,
            stageTiming,
            setAssemblyFailureStage
          ),
          now,
          onDiagnostics
        });
        return await packageService.assemble(canonicalRequest);
      } finally {
        stageTiming.packageRuntimeTotalMs = elapsedMilliseconds(runtimeStarted, monotonicNow());
        const measuredStages = stageTiming.yahooTelemetryAcquisitionMs
          + stageTiming.postgresPersistenceReadbackMs
          + stageTiming.yahooMarketDataEvidenceAcquisitionMs
          + stageTiming.federalReserveEvidenceAcquisitionMs
          + stageTiming.cnbcNewsResearchMs;
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
  CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
  FEDERAL_RESERVE_UNAVAILABLE_GAP,
  YAHOO_RECAP_UNAVAILABLE_GAP,
  YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
  YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP,
  ORCHESTRATION_REQUEST_KEYS,
  deriveCnbcResearchHorizons,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
};

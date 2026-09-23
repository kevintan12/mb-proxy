const {
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
} = require('./analysis-package-service');
const {createEvidenceCollection} = require('./evidence-collections');
const {createEvidenceItem, validateEvidenceItem} = require('./evidence-items');
const {validateFiveSessionSnapshot} = require('./five-session-snapshot');
const {createPostCloseSessionAssociation} = require('./post-close-session-relevance');
const {deterministicCnbcRecapCandidate} = require('./cnbc-deterministic-recap-discovery');
const {
  US_ACTIVE_SESSION_STATES,
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor,
  activeSessionEvidenceWindowResult,
  isTimestampWithinUsActiveSessionWindow
} = require('./us-active-session-evidence');
const {isSpecificBroadMarketSubject} = require('./broad-market-subjects');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  completeClaudeEvidenceRoleClassificationOutput,
  classificationCoverage,
  createClaudeEvidenceSubjectRepairOutput,
  MAX_CLASSIFICATION_EVIDENCE_ITEMS,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES
} = require('./claude-evidence-role-classification');
const {performance} = require('node:perf_hooks');

const ORCHESTRATION_REQUEST_KEYS = Object.freeze([
  'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
]);
const BENCHMARK_ANCHOR_KEYS = Object.freeze(['market', 'symbol']);
const FEDERAL_RESERVE_UNAVAILABLE_GAP =
  'Federal Reserve monetary-policy evidence was unavailable at package assembly time.';
const CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP =
  'CNBC market-news research was unavailable at package assembly time.';
const CNBC_RECAP_UNAVAILABLE_GAP =
  'CNBC completed-session recap was unavailable at package assembly time.';
const YAHOO_RECAP_UNAVAILABLE_GAP =
  'Yahoo Finance completed-session recap was unavailable at package assembly time.';
const YAHOO_RECAP_RETRIEVAL_FAILURE_GAP =
  'Yahoo Finance completed-session recap validation or retrieval failed at package assembly time.';
const YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP =
  'Yahoo Finance completed-session recap evidence construction failed at package assembly time.';
const EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP =
  'Evidence-role classification was unavailable because no primary completed session was established.';
const BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP =
  'Validated broad-market company or sector evidence was unavailable.';
const CNBC_INTEGRATION_FAILURE_TYPES = Object.freeze({
  MISSING_CANONICAL_HORIZONS: 'MISSING_CANONICAL_HORIZONS',
  RESEARCH_NEWS_THROW: 'RESEARCH_NEWS_THROW',
  INVALID_RESEARCH_RESULT: 'INVALID_RESEARCH_RESULT',
  CANDIDATE_COVERAGE_MISMATCH: 'CANDIDATE_COVERAGE_MISMATCH',
  CANDIDATE_REFERENCE_ORDERING_MISMATCH: 'CANDIDATE_REFERENCE_ORDERING_MISMATCH',
  HORIZON_MISMATCH: 'HORIZON_MISMATCH',
  CONSTRUCTED_EVIDENCE_MISMATCH: 'CONSTRUCTED_EVIDENCE_MISMATCH',
  INTEGRATION_CONTRACT_MISMATCH: 'INTEGRATION_CONTRACT_MISMATCH'
});
const CNBC_RESEARCH_FAILURE_TYPES = new Set([
  'DISCOVERY_PROVIDER_FAILURE',
  'CANDIDATE_ACQUISITION_FAILURE',
  'MATERIALITY_PROVIDER_FAILURE',
  'MATERIALITY_CONTRACT_FAILURE',
  'MATERIALITY_REQUEST_TOO_LARGE',
  'ARTICLE_RETRIEVAL_FAILURE',
  'EVIDENCE_CONSTRUCTION_FAILURE'
]);
const CNBC_INTEGRATION_FAILURE_TYPE_VALUES = new Set(
  Object.values(CNBC_INTEGRATION_FAILURE_TYPES)
);
const ANALYSIS_MODES = Object.freeze({
  ACTIVE_SESSION: 'ACTIVE_SESSION',
  COMPLETED_SESSION: 'COMPLETED_SESSION'
});
const ACTIVE_SESSION_STATES = new Set(US_ACTIVE_SESSION_STATES);
const COMPLETED_SESSION_STATES = new Set(['CLOSED', 'WEEKEND', 'HOLIDAY']);
const ACTIVE_YAHOO_INITIAL_CANDIDATE_ATTEMPTS = 5;
const ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS = 8;
const AMBIGUOUS_TICKER_SYMBOLS = new Set([
  'ALL', 'ARE', 'BEST', 'BIG', 'CAN', 'CAR', 'CAT', 'FOR', 'HAS', 'JOB', 'KEY',
  'LIFE', 'LOVE', 'LOW', 'MAN', 'NOW', 'OPEN', 'PLAY', 'REAL', 'RUN', 'SAVE',
  'SUN', 'WELL'
]);

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

function analysisModeForMarketState(marketState) {
  if (ACTIVE_SESSION_STATES.has(marketState)) return ANALYSIS_MODES.ACTIVE_SESSION;
  if (COMPLETED_SESSION_STATES.has(marketState)) return ANALYSIS_MODES.COMPLETED_SESSION;
  throw new TypeError(`Unsupported US market state: ${marketState}`);
}

function emitDiagnostics(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(Object.freeze(value)); } catch (error) {
    // Observability must not alter package assembly behavior.
  }
}

const SNAPSHOT_PERSISTENCE_FAILURE_SUBTYPES = new Set([
  'SNAPSHOT_READ_INVALID',
  'SNAPSHOT_CALENDAR_UNSUPPORTED',
  'SNAPSHOT_CONTINUITY_INVALID',
  'SNAPSHOT_READ_MISMATCH',
  'SNAPSHOT_PERSISTENCE_FAILED'
]);

function snapshotPersistenceFailureSubtype(error) {
  return SNAPSHOT_PERSISTENCE_FAILURE_SUBTYPES.has(error?.code)
    ? error.code
    : 'SNAPSHOT_PERSISTENCE_FAILED';
}

const SNAPSHOT_MISMATCH_REASONS = new Set([
  'NEWEST_SESSION_DATE',
  'MISSING_ACQUIRED_SESSION',
  'CANONICAL_SESSION_VALUES'
]);
const SNAPSHOT_DIFFERING_FIELDS = new Set([
  'open', 'high', 'low', 'close', 'previousClose', 'absoluteChange', 'percentChange',
  'volume', 'asOf', 'sourceId', 'provenance', 'validationState'
]);
const CANONICAL_SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizedSnapshotMismatchDetails(error) {
  if (error?.code !== 'SNAPSHOT_READ_MISMATCH') return {};
  const details = error.diagnosticDetails;
  if (!details || !SNAPSHOT_MISMATCH_REASONS.has(details.mismatchReason)) return {};
  if (details.mismatchReason === 'NEWEST_SESSION_DATE'
      && CANONICAL_SESSION_DATE.test(details.acquiredNewestSessionDate)
      && CANONICAL_SESSION_DATE.test(details.persistedNewestSessionDate)) {
    return {
      mismatchReason: details.mismatchReason,
      acquiredNewestSessionDate: details.acquiredNewestSessionDate,
      persistedNewestSessionDate: details.persistedNewestSessionDate
    };
  }
  if (details.mismatchReason === 'MISSING_ACQUIRED_SESSION'
      && CANONICAL_SESSION_DATE.test(details.missingSessionDate)) {
    return {mismatchReason: details.mismatchReason, missingSessionDate: details.missingSessionDate};
  }
  if (details.mismatchReason === 'CANONICAL_SESSION_VALUES'
      && CANONICAL_SESSION_DATE.test(details.sessionDate)
      && Array.isArray(details.differingFields)) {
    return {
      mismatchReason: details.mismatchReason,
      sessionDate: details.sessionDate,
      differingFields: details.differingFields.filter(field => SNAPSHOT_DIFFERING_FIELDS.has(field))
    };
  }
  return {};
}

function companyNameVariants(item) {
  return [item.shortName, item.longName].flatMap(value => {
    if (typeof value !== 'string' || value.trim().length < 4) return [];
    const normalized = value.trim().toLowerCase();
    const withoutSuffix = normalized.replace(
      /(?:,?\s+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc))\.?$/i,
      ''
    ).trim();
    return withoutSuffix && withoutSuffix !== normalized
      ? [normalized, withoutSuffix] : [normalized];
  });
}

function headlineMatchesIdentity(headline, item) {
  if (typeof headline !== 'string') return false;
  const lowerHeadline = headline.toLowerCase();
  if (companyNameVariants(item).some(name => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escapedName}([^a-z0-9]|$)`, 'i').test(lowerHeadline);
  })) return true;
  const escaped = item.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (item.symbol.length <= 2 || AMBIGUOUS_TICKER_SYMBOLS.has(item.symbol)) {
    return new RegExp(`(?:\\$${escaped}\\b|\\(${escaped}\\)|\\b(?:NASDAQ|NYSE)\\s*:\\s*${escaped}\\b)`)
      .test(headline.toUpperCase());
  }
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(headline);
}

function headlineMatchesMostActive(candidate, mostActive) {
  const headline = typeof candidate?.headline === 'string' ? candidate.headline : '';
  return mostActive.some(item => {
    return headlineMatchesIdentity(headline, item);
  });
}

function selectedActiveYahooCandidates(mostActive, candidates) {
  const matched = [];
  const remaining = [];
  for (const candidate of candidates) {
    (headlineMatchesMostActive(candidate, mostActive) ? matched : remaining).push(candidate);
  }
  return Object.freeze(matched.concat(remaining));
}

function activeYahooSymbols(headline, mostActive, portfolioSnapshots) {
  const identities = mostActive.map(item => ({
    symbol: item.symbol,
    shortName: item.shortName,
    longName: item.longName
  })).concat(portfolioSnapshots.map(snapshot => ({
    symbol: snapshot.symbol,
    shortName: snapshot.instrumentName,
    longName: snapshot.instrumentName
  })));
  const seen = new Set();
  const symbols = [];
  for (const item of identities) {
    if (seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    if (headlineMatchesIdentity(headline, item)) {
      symbols.push(item.symbol);
    }
  }
  return symbols;
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
  const validation = validateFiveSessionSnapshot(snapshot);
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

function broadMarketNewsReferences(items, validatedBroadMarketNewsItems) {
  const validated = new Set(validatedBroadMarketNewsItems);
  return new Set(items.flatMap((item, index) =>
    validated.has(item) && item.evidenceCategory === 'news' ? [`e${index + 1}`] : []));
}

function canonicalUtcTimestampMilliseconds(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

function yahooRecapArticleMatchesResearch(research, articleContent, targetSessionDate) {
  const articleHasNoUpdate = articleContent?.updatedAt === null;
  const validationHasNoUpdate = research?.validation?.dateModified === null;
  const publishedTime = canonicalUtcTimestampMilliseconds(articleContent?.publishedAt);
  const updatedTime = articleHasNoUpdate
    ? null : canonicalUtcTimestampMilliseconds(articleContent?.updatedAt);
  const validatedUpdatedTime = validationHasNoUpdate
    ? null : canonicalUtcTimestampMilliseconds(research?.validation?.dateModified);
  return articleContent && articleContent.sourceId === 'us.yahoo-finance'
    && articleContent.targetSessionDate === targetSessionDate
    && articleContent.canonicalUrl === research.discovery.url
    && articleContent.publishedAt === research.validation.datePublished
    && publishedTime !== null
    && (articleHasNoUpdate || (updatedTime !== null && updatedTime >= publishedTime))
    && (validationHasNoUpdate
      || (validatedUpdatedTime !== null && updatedTime !== null
        && updatedTime >= validatedUpdatedTime))
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

function cnbcIntegrationFailure(type, message) {
  const error = new TypeError(message);
  error.cnbcIntegrationFailureType = type;
  return error;
}

function requireCnbcConstructedEvidence(result, horizons) {
  if (!result || result.ok !== true || result.type !== 'SUCCESS'
      || !Array.isArray(result.candidateCollection?.candidates)
      || !Array.isArray(result.selections)
      || !Array.isArray(result.retrievedArticles)
      || !Array.isArray(result.constructedEvidence)) {
    throw cnbcIntegrationFailure(
      CNBC_INTEGRATION_FAILURE_TYPES.INVALID_RESEARCH_RESULT,
      'CNBC news research failed'
    );
  }
  const candidates = new Map(result.candidateCollection.candidates.map(candidate => [
    candidate.reference,
    candidate
  ]));
  if (candidates.size === 0 || result.selections.length !== 0
      || result.retrievedArticles.length !== candidates.size
      || result.constructedEvidence.length !== candidates.size) {
    throw cnbcIntegrationFailure(
      CNBC_INTEGRATION_FAILURE_TYPES.CANDIDATE_COVERAGE_MISMATCH,
      'Invalid CNBC news research coverage'
    );
  }
  for (let index = 0; index < result.candidateCollection.candidates.length; index++) {
    const candidate = result.candidateCollection.candidates[index];
    if (candidate.reference !== `c${index + 1}`) {
      throw cnbcIntegrationFailure(
        CNBC_INTEGRATION_FAILURE_TYPES.CANDIDATE_REFERENCE_ORDERING_MISMATCH,
        'Invalid CNBC news research ordering'
      );
    }
  }
  let previousCandidateNumber = 0;
  return result.constructedEvidence.map(record => {
    const candidate = candidates.get(record?.candidateReference);
    const referenceMatch = /^c([1-9][0-9]*)$/.exec(record?.candidateReference || '');
    const horizon = horizons.find(item => item.classification === record?.horizon?.classification);
    if (!candidate || !referenceMatch || Number(referenceMatch[1]) <= previousCandidateNumber) {
      throw cnbcIntegrationFailure(
        CNBC_INTEGRATION_FAILURE_TYPES.CANDIDATE_REFERENCE_ORDERING_MISMATCH,
        'Invalid CNBC constructed evidence ordering'
      );
    }
    if (JSON.stringify(candidate.horizon) !== JSON.stringify(record.horizon)
        || !horizon || JSON.stringify(horizon) !== JSON.stringify(record.horizon)) {
      throw cnbcIntegrationFailure(
        CNBC_INTEGRATION_FAILURE_TYPES.HORIZON_MISMATCH,
        'Invalid CNBC constructed evidence horizon'
      );
    }
    if (!validateEvidenceItem(record.evidenceItem).valid
        || record.evidenceItem.sourceId !== candidate.sourceId
        || record.evidenceItem.market !== candidate.market
        || record.evidenceItem.evidenceCategory !== candidate.evidenceCategory
        || record.evidenceItem.title !== candidate.title
        || record.evidenceItem.summary !== candidate.extract
        || record.evidenceItem.canonicalUrl !== candidate.canonicalUrl
        || record.evidenceItem.publishedAt !== candidate.publishedAt
        || JSON.stringify(record.evidenceItem.symbols) !== JSON.stringify(candidate.symbols)
        || JSON.stringify(record.evidenceItem.provenance) !== JSON.stringify(candidate.provenance)) {
      throw cnbcIntegrationFailure(
        CNBC_INTEGRATION_FAILURE_TYPES.CONSTRUCTED_EVIDENCE_MISMATCH,
        'Invalid canonical CNBC constructed evidence'
      );
    }
    if (candidate.sourceId !== 'us.cnbc' || candidate.market !== 'US'
        || candidate.evidenceCategory !== 'news') {
      throw cnbcIntegrationFailure(
        CNBC_INTEGRATION_FAILURE_TYPES.INTEGRATION_CONTRACT_MISMATCH,
        'Invalid CNBC integration contract'
      );
    }
    previousCandidateNumber = Number(referenceMatch[1]);
    return Object.freeze({
      candidateReference: record.candidateReference,
      horizon: Object.freeze({...record.horizon}),
      evidenceItem: record.evidenceItem
    });
  });
}

function requireCnbcRecapConstructedEvidence(result, targetSessionDate) {
  const record = result?.constructedEvidence;
  const item = record?.evidenceItem;
  if (!result || result.ok !== true || result.type !== 'SUCCESS'
      || !record || record.targetSessionDate !== targetSessionDate
      || !validateEvidenceItem(item).valid
      || item.canonicalUrl !== deterministicCnbcRecapCandidate(targetSessionDate)?.url
      || item.sourceId !== 'us.cnbc' || item.market !== 'US'
      || item.evidenceCategory !== 'news') {
    throw new TypeError('Invalid canonical CNBC recap constructed evidence');
  }
  return Object.freeze({
    targetSessionDate: record.targetSessionDate,
    updatedAt: record.updatedAt,
    horizon: null,
    evidenceItem: item
  });
}

function createUsAnalysisPackageOrchestrationService({
  createTelemetryAcquisition,
  snapshotPersistence,
  yahooEvidenceAcquisition,
  yahooMostActiveAcquisition,
  yahooLatestNewsDiscovery,
  yahooCurrentNewsArticleContentAcquisition,
  federalReserveEvidenceAcquisition,
  yahooRecapResearch,
  yahooRecapArticleContentAcquisition,
  yahooRecapEvidenceConstruction,
  yahooRecapArticleContentBounds,
  cnbcRecapResearch,
  cnbcNewsResearch,
  evidenceRoleClassification,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  onDiagnostics
} = {}) {
  if (typeof createTelemetryAcquisition !== 'function') {
    throw new TypeError('createTelemetryAcquisition must be a function');
  }
  requireMethod(snapshotPersistence, 'persistSnapshot', 'snapshotPersistence');
  requireMethod(yahooEvidenceAcquisition, 'acquireEvidence', 'yahooEvidenceAcquisition');
  requireMethod(yahooMostActiveAcquisition, 'acquireMostActive', 'yahooMostActiveAcquisition');
  requireMethod(yahooLatestNewsDiscovery, 'discoverLatestNews', 'yahooLatestNewsDiscovery');
  requireMethod(
    yahooCurrentNewsArticleContentAcquisition,
    'acquireArticleContent',
    'yahooCurrentNewsArticleContentAcquisition'
  );
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
  requireMethod(cnbcRecapResearch, 'researchCompletedSessionRecap', 'cnbcRecapResearch');
  requireMethod(evidenceRoleClassification, 'classifyEvidenceRoles', 'evidenceRoleClassification');
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
      let persistedReadback;
      try {
        persistedReadback = await timed('postgresPersistenceReadbackMs', () =>
          snapshotPersistence.persistSnapshot(acquired));
      } catch (error) {
        emitDiagnostics(onDiagnostics, {
          stage: 'snapshotPersistenceReadbackFailure',
          symbol,
          boundary: 'PERSISTENCE',
          failureSubtype: snapshotPersistenceFailureSubtype(error),
          ...sanitizedSnapshotMismatchDetails(error)
        });
        throw error;
      }
      let persisted;
      try {
        persisted = requireSnapshot(persistedReadback, symbol);
      } catch (error) {
        emitDiagnostics(onDiagnostics, {
          stage: 'snapshotPersistenceReadbackFailure',
          symbol,
          boundary: 'POST_READBACK_VALIDATION',
          failureSubtype: 'INVALID_PERSISTED_SNAPSHOT'
        });
        throw error;
      }
      snapshots.push(persisted);
      yahooCollections.push(requireEvidenceCollection(
        await timed('yahooMarketDataEvidenceAcquisitionMs', () =>
          yahooEvidenceAcquisition.acquireEvidence({symbol})),
        {sourceId: 'us.yahoo-finance', symbol}
      ));
    }

    const benchmarkSnapshots = snapshots.slice(0, benchmarkSymbols.length);
    let marketContext = createMarketContext(snapshots);
    const analysisMode = analysisModeForMarketState(marketContext.marketState);
    const completedSessionMode = analysisMode === ANALYSIS_MODES.COMPLETED_SESSION;
    const activeSessionAnchor = analysisMode === ANALYSIS_MODES.ACTIVE_SESSION
      ? createUsActiveSessionAnchor({
          marketState: marketContext.marketState,
          cutoffAt: context.acquisitionStartedAt
        }) : null;
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION && !activeSessionAnchor) {
      throw new TypeError('Canonical US active-session anchor is unavailable');
    }
    if (activeSessionAnchor) marketContext = {
      ...marketContext,
      calendarContext: serializeUsActiveSessionAnchor(activeSessionAnchor)
    };
    const activeSessionWindowResult = analysisMode === ANALYSIS_MODES.ACTIVE_SESSION
      ? activeSessionEvidenceWindowResult({
          marketState: marketContext.marketState,
          generatedAt: context.acquisitionStartedAt,
          benchmarkSnapshots,
          anchor: activeSessionAnchor
        }) : null;
    const activeSessionWindow = activeSessionWindowResult?.window || null;
    emitDiagnostics(onDiagnostics, {
      stage: 'analysisModeSelection',
      analysisMode,
      marketState: marketContext.marketState
    });
    let canonicalHorizons = null;
    try {
      canonicalHorizons = deriveCnbcResearchHorizons(benchmarkSnapshots, context.acquisitionStartedAt);
    } catch (error) {
      canonicalHorizons = null;
    }

    let federalReserveCollection;
    let federalReserveUnavailable = false;
    async function acquireFederalReserveEvidence() {
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
    }
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) await acquireFederalReserveEvidence();

    const acquiredActiveYahooItems = [];
    const activeYahooCounts = {
      missingOrMalformedPublicationTimeCount: 0,
      beforeSessionWindowCount: 0,
      afterSessionWindowCount: 0,
      duplicateEvidenceCount: 0,
      activeWindowUnavailableCount: 0,
      benchmarkOverlayInvalidCount: 0,
      otherEvidenceConstructionRejectedCount: 0,
      selectedCandidateCount: 0,
      candidateConsideredCount: 0,
      articleFetchRequestFailureCount: 0,
      articleExtractionFailureCount: 0,
      articleMetadataFailureCount: 0,
      articleIdentityHeadlineMismatchCount: 0,
      articleBodyUnavailableCount: 0,
      articleCanonicalRedirectMismatchCount: 0,
      otherArticleExtractionRejectionCount: 0,
      activeWindowRejectionCount: 0,
      classifierPreflightRejectedCount: 0
    };
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) {
      let mostActive = [];
      let latestNews = [];
      let articleFetchAttemptCount = 0;
      let articleFetchSuccessCount = 0;
      try {
        const result = await timed('yahooMostActiveAcquisitionMs', () =>
          yahooMostActiveAcquisition.acquireMostActive());
        if (result?.ok === true && Array.isArray(result.candidates)) mostActive = result.candidates;
      } catch (error) {
        mostActive = [];
      }
      try {
        const result = await timed('yahooLatestNewsDiscoveryMs', () =>
          yahooLatestNewsDiscovery.discoverLatestNews());
        if (result?.ok === true && Array.isArray(result.candidates)) latestNews = result.candidates;
      } catch (error) {
        latestNews = [];
      }
      const selected = selectedActiveYahooCandidates(mostActive, latestNews);
      activeYahooCounts.selectedCandidateCount = selected.length;
      const seenUrls = new Set();
      const activeRequiredItems = yahooCollections.flatMap(collection => collection.items).concat(
        federalReserveCollection ? federalReserveCollection.items : []
      );
      function activeCandidateFitsClassifier(candidateItem) {
        const items = activeRequiredItems.concat(candidateItem);
        if (items.length > MAX_CLASSIFICATION_EVIDENCE_ITEMS) return false;
        try {
          const collection = createEvidenceCollection({market: 'US', items});
          const candidateReference = `e${items.length}`;
          const request = buildClaudeEvidenceRoleClassificationRequest(Object.freeze({
            marketContext: Object.freeze({
              market: 'US',
              exchangeTimezone: marketContext.exchangeTimezone,
              marketState: marketContext.marketState,
              primaryCompletedSessionDate: marketContext.primaryCompletedSessionDate
            }),
            benchmarkTelemetry: Object.freeze(benchmarkSnapshots.map((snapshot, index) => Object.freeze({
              reference: `t${index + 1}`,
              snapshot
            }))),
            evidence: Object.freeze(collection.items.map((item, index) => Object.freeze({
              reference: `e${index + 1}`,
              horizon: index === collection.items.length - 1 ? 'CURRENT_SESSION' : 'COMPLETED_SESSION',
              requiresBroadMarketSubjects: `e${index + 1}` === candidateReference,
              item
            })))
          }));
          return Buffer.byteLength(JSON.stringify(request), 'utf8')
            <= CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES;
        } catch (error) {
          return false;
        }
      }
      for (const candidate of selected) {
        if (articleFetchAttemptCount >= ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS
            || acquiredActiveYahooItems.length > 0) break;
        activeYahooCounts.candidateConsideredCount++;
        articleFetchAttemptCount++;
        let result;
        try {
          result = await timed('yahooCurrentNewsArticleAcquisitionMs', () =>
            yahooCurrentNewsArticleContentAcquisition.acquireArticleContent({
              url: candidate.url,
              headline: candidate.headline
            }));
        } catch (error) {
          activeYahooCounts.articleFetchRequestFailureCount++;
          continue;
        }
        if (result?.ok !== true || result.type !== 'SUCCESS' || !result.articleContent) {
          if (['TIMEOUT', 'RETRIEVAL_FAILURE', 'HTTP_FAILURE', 'RESPONSE_READ_FAILURE',
            'RESPONSE_TOO_LARGE'].includes(result?.type)) {
            activeYahooCounts.articleFetchRequestFailureCount++;
          } else {
            activeYahooCounts.articleExtractionFailureCount++;
            if (result?.extractionFailureType === 'NO_COMPATIBLE_ARTICLE_METADATA') {
              activeYahooCounts.articleMetadataFailureCount++;
            } else if (result?.extractionFailureType === 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH') {
              activeYahooCounts.articleIdentityHeadlineMismatchCount++;
            } else if (result?.extractionFailureType === 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT') {
              activeYahooCounts.articleBodyUnavailableCount++;
            } else if (result?.extractionFailureType === 'CANONICAL_OR_REDIRECT_MISMATCH') {
              activeYahooCounts.articleCanonicalRedirectMismatchCount++;
            } else {
              activeYahooCounts.otherArticleExtractionRejectionCount++;
            }
          }
          continue;
        }
        articleFetchSuccessCount++;
        const article = result.articleContent;
        const publishedAt = typeof article.publishedAt === 'string'
          ? Date.parse(article.publishedAt) : NaN;
        if (!Number.isFinite(publishedAt)) {
          activeYahooCounts.missingOrMalformedPublicationTimeCount++;
          continue;
        }
        if (activeSessionWindow && publishedAt < Date.parse(activeSessionWindow.startsAtInclusive)) {
          activeYahooCounts.beforeSessionWindowCount++;
          activeYahooCounts.activeWindowRejectionCount++;
          continue;
        }
        if (activeSessionWindow && publishedAt > Date.parse(activeSessionWindow.endsAtInclusive)) {
          activeYahooCounts.afterSessionWindowCount++;
          activeYahooCounts.activeWindowRejectionCount++;
          continue;
        }
        if (!activeSessionWindow) {
          if (activeSessionWindowResult?.failureType === 'BENCHMARK_OVERLAY_INVALID') {
            activeYahooCounts.benchmarkOverlayInvalidCount++;
          } else {
            activeYahooCounts.activeWindowUnavailableCount++;
          }
          continue;
        }
        if (!isTimestampWithinUsActiveSessionWindow(article.publishedAt, activeSessionWindow)) {
          activeYahooCounts.otherEvidenceConstructionRejectedCount++;
          continue;
        }
        if (seenUrls.has(article.canonicalUrl)) {
          activeYahooCounts.duplicateEvidenceCount++;
          continue;
        }
        try {
          const item = createEvidenceItem({
            sourceId: 'us.yahoo-finance',
            market: 'US',
            evidenceCategory: 'news',
            title: article.headline,
            summary: article.articleText,
            canonicalUrl: article.canonicalUrl,
            publishedAt: article.publishedAt,
            symbols: activeYahooSymbols(
              article.headline,
              mostActive,
              snapshots.slice(benchmarkSymbols.length)
            ),
            ...(typeof article.publisher === 'string' && article.publisher.trim()
              ? {publisher: article.publisher} : {})
          });
          if (!activeCandidateFitsClassifier(item)) {
            activeYahooCounts.classifierPreflightRejectedCount++;
            activeYahooCounts.otherEvidenceConstructionRejectedCount++;
            continue;
          }
          seenUrls.add(item.canonicalUrl);
          acquiredActiveYahooItems.push(item);
        } catch (error) {
          // An invalid optional article is omitted without affecting package assembly.
          activeYahooCounts.otherEvidenceConstructionRejectedCount++;
        }
      }
      emitDiagnostics(onDiagnostics, {
        stage: 'activeYahooAcquisition',
        outcome: acquiredActiveYahooItems.length > 0 ? 'SUCCESS' : 'NOT_FOUND',
        mostActiveCount: mostActive.length,
        latestNewsCandidateCount: latestNews.length,
        selectedCandidateCount: activeYahooCounts.selectedCandidateCount,
        candidateConsideredCount: activeYahooCounts.candidateConsideredCount,
        articleFetchAttemptCount,
        articleFetchSuccessCount,
        articleFetchRequestFailureCount: activeYahooCounts.articleFetchRequestFailureCount,
        articleExtractionFailureCount: activeYahooCounts.articleExtractionFailureCount,
        articleMetadataFailureCount: activeYahooCounts.articleMetadataFailureCount,
        articleIdentityHeadlineMismatchCount: activeYahooCounts.articleIdentityHeadlineMismatchCount,
        articleBodyUnavailableCount: activeYahooCounts.articleBodyUnavailableCount,
        articleCanonicalRedirectMismatchCount: activeYahooCounts.articleCanonicalRedirectMismatchCount,
        otherArticleExtractionRejectionCount: activeYahooCounts.otherArticleExtractionRejectionCount,
        missingOrMalformedPublicationTimeCount: activeYahooCounts.missingOrMalformedPublicationTimeCount,
        beforeSessionWindowCount: activeYahooCounts.beforeSessionWindowCount,
        afterSessionWindowCount: activeYahooCounts.afterSessionWindowCount,
        duplicateEvidenceCount: activeYahooCounts.duplicateEvidenceCount,
        activeWindowUnavailableCount: activeYahooCounts.activeWindowUnavailableCount,
        benchmarkOverlayInvalidCount: activeYahooCounts.benchmarkOverlayInvalidCount,
        otherEvidenceConstructionRejectedCount: activeYahooCounts.otherEvidenceConstructionRejectedCount,
        activeWindowRejectionCount: activeYahooCounts.activeWindowRejectionCount,
        classifierPreflightRejectedCount: activeYahooCounts.classifierPreflightRejectedCount,
        backfillUsed: activeYahooCounts.candidateConsideredCount > ACTIVE_YAHOO_INITIAL_CANDIDATE_ATTEMPTS,
        acquiredCurrentSessionCount: acquiredActiveYahooItems.length
      });
      emitDiagnostics(onDiagnostics, {
        stage: 'completedSessionResearch',
        outcome: 'SKIPPED_ACTIVE_SESSION'
      });
    } else {
      emitDiagnostics(onDiagnostics, {
        stage: 'activeYahooAcquisition',
        outcome: 'SKIPPED_COMPLETED_SESSION',
        mostActiveCount: 0,
        latestNewsCandidateCount: 0,
        articleFetchAttemptCount: 0,
        articleFetchSuccessCount: 0
      });
    }

    if (analysisMode !== ANALYSIS_MODES.ACTIVE_SESSION) await acquireFederalReserveEvidence();

    let yahooRecapConstructedEvidence = null;
    let yahooRecapGap = null;
    let yahooRecapFailureType = null;
    let yahooRecapFailureOutcome = null;
    let yahooRecapResearchType = null;
    if (!completedSessionMode) {
      // Active-session evidence is acquired separately; completed-session recap research is skipped.
    } else if (marketContext.primaryCompletedSessionDate === null) {
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
        for (let attempt = 0; attempt < 2; attempt++) {
          const research = await timed('yahooRecapResearchMs', () =>
            yahooRecapResearch.discoverAndValidateRecap({
              targetSessionDate: marketContext.primaryCompletedSessionDate
            }));
          yahooRecapResearchType = typeof research?.type === 'string' ? research.type : null;
          const validatedCacheHit = attempt === 0
            && typeof yahooRecapResearch.isValidatedCacheHit === 'function'
            && yahooRecapResearch.isValidatedCacheHit(research);
          if (research?.ok === true && (research.type === 'NOT_FOUND'
              || research.type === 'NOT_VALIDATED')) {
            yahooRecapGap = YAHOO_RECAP_UNAVAILABLE_GAP;
            yahooRecapFailureType = research.type;
            yahooRecapFailureOutcome = 'UNAVAILABLE';
            break;
          }
          if (!research || research.ok !== true || research.type !== 'VALIDATED'
              || !research.discovery || !research.validation
              || research.discovery.targetSessionDate !== marketContext.primaryCompletedSessionDate
              || research.validation.targetSessionDate !== marketContext.primaryCompletedSessionDate) {
            yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
            yahooRecapFailureType = typeof research?.failureType === 'string'
              ? research.failureType
              : typeof research?.type === 'string' ? research.type : 'UNKNOWN_FAILURE';
            yahooRecapFailureOutcome = 'FAILURE';
            break;
          }
          yahooRecapStage = 'ARTICLE';
          let acquired;
          try {
            acquired = await timed('yahooRecapArticleContentAcquisitionMs', () =>
              yahooRecapArticleContentAcquisition.acquireArticleContent({
                discovery: research.discovery,
                validation: research.validation,
                bounds: yahooRecapArticleContentBounds
              }));
          } catch (error) {
            if (validatedCacheHit && yahooRecapResearch.evictValidatedCacheHit(research)) {
              yahooRecapStage = 'RESEARCH';
              continue;
            }
            throw error;
          }
          const articleMatches = acquired?.ok === true && acquired.type === 'SUCCESS'
            && yahooRecapArticleMatchesResearch(
              research,
              acquired.articleContent,
              marketContext.primaryCompletedSessionDate
            );
          if (!articleMatches) {
            if (validatedCacheHit && yahooRecapResearch.evictValidatedCacheHit(research)) {
              yahooRecapStage = 'RESEARCH';
              continue;
            }
            yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
            yahooRecapFailureType = acquired?.ok === true
              ? 'ARTICLE_CONTRACT_FAILURE'
              : typeof acquired?.type === 'string' ? acquired.type : 'UNKNOWN_FAILURE';
            yahooRecapFailureOutcome = 'FAILURE';
            break;
          }
          const horizon = horizonForArticle(canonicalHorizons, acquired.articleContent);
          if (!horizon) {
            if (validatedCacheHit && yahooRecapResearch.evictValidatedCacheHit(research)) {
              yahooRecapStage = 'RESEARCH';
              continue;
            }
            yahooRecapGap = YAHOO_RECAP_RETRIEVAL_FAILURE_GAP;
            yahooRecapFailureType = 'HORIZON_MISMATCH';
            yahooRecapFailureOutcome = 'FAILURE';
            break;
          }
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
            if (typeof yahooRecapResearch.rememberValidatedDiscovery === 'function') {
              try {
                yahooRecapResearch.rememberValidatedDiscovery({
                  targetSessionDate: marketContext.primaryCompletedSessionDate,
                  discovery: research.discovery
                });
              } catch (cacheError) {
                // A warm-runtime optimization must never affect package correctness.
              }
            }
          } catch (error) {
            yahooRecapGap = YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP;
            yahooRecapFailureType = typeof constructed?.type === 'string'
              ? constructed.type : 'EVIDENCE_CONTRACT_FAILURE';
            yahooRecapFailureOutcome = 'FAILURE';
          }
          break;
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
          researchType: yahooRecapResearchType,
          failureType: yahooRecapFailureType,
          candidateRank: null
        }));
      } catch (diagnosticError) {
        // Observability must not affect package assembly behavior.
      }
    }

    let cnbcRecapConstructedEvidence = null;
    let cnbcRecapUnavailable = false;
    let cnbcRecapFailureType = null;
    if (completedSessionMode) {
      try {
        if (marketContext.primaryCompletedSessionDate === null) {
          throw new TypeError('CNBC recap research prerequisites are unavailable');
        }
        const result = await timed('cnbcRecapResearchMs', () =>
          cnbcRecapResearch.researchCompletedSessionRecap({
            targetSessionDate: marketContext.primaryCompletedSessionDate,
            horizons: canonicalHorizons
          }));
        if (result?.ok === true && (result.type === 'NOT_FOUND'
            || result.type === 'NOT_VALIDATED')) {
          cnbcRecapUnavailable = true;
          cnbcRecapFailureType = result.type;
        } else {
          cnbcRecapConstructedEvidence = requireCnbcRecapConstructedEvidence(
            result,
            marketContext.primaryCompletedSessionDate
          );
        }
      } catch (error) {
        cnbcRecapUnavailable = true;
        cnbcRecapConstructedEvidence = null;
        if (!cnbcRecapFailureType) cnbcRecapFailureType = 'RESEARCH_OR_CONTRACT_FAILURE';
      }
    }
    if (cnbcRecapUnavailable && typeof onDiagnostics === 'function') {
      try {
        onDiagnostics(Object.freeze({
          stage: 'cnbcRecapResearchIntegration',
          outcome: cnbcRecapFailureType === 'NOT_FOUND' || cnbcRecapFailureType === 'NOT_VALIDATED'
            ? 'UNAVAILABLE' : 'FAILURE',
          failureType: cnbcRecapFailureType
        }));
      } catch (diagnosticError) {
        // Observability must not affect package assembly behavior.
      }
    }

    let cnbcConstructedEvidence = [];
    let cnbcUnavailable = false;
    let cnbcFailureType = null;
    if (completedSessionMode) {
      try {
        if (!canonicalHorizons) {
          throw cnbcIntegrationFailure(
            CNBC_INTEGRATION_FAILURE_TYPES.MISSING_CANONICAL_HORIZONS,
            'Canonical research horizons are unavailable'
          );
        }
        const horizons = canonicalHorizons;
        let result;
        try {
          result = await timed('cnbcNewsResearchMs', () =>
            cnbcNewsResearch.researchNews({
              targetSessionDate: marketContext.primaryCompletedSessionDate,
              horizons
            }));
        } catch (error) {
          throw cnbcIntegrationFailure(
            CNBC_INTEGRATION_FAILURE_TYPES.RESEARCH_NEWS_THROW,
            'CNBC news research threw'
          );
        }
        if (!result || result.ok !== true) {
          cnbcFailureType = result && result.ok === false
            && CNBC_RESEARCH_FAILURE_TYPES.has(result.type)
            ? result.type
            : CNBC_INTEGRATION_FAILURE_TYPES.INVALID_RESEARCH_RESULT;
          throw cnbcIntegrationFailure(cnbcFailureType, 'CNBC news research failed');
        }
        if (result.type === 'NOT_FOUND') {
          cnbcUnavailable = true;
          cnbcFailureType = 'NOT_FOUND';
          if (typeof onDiagnostics === 'function') {
            try {
              onDiagnostics(Object.freeze({
                stage: 'cnbcNewsResearchIntegration',
                outcome: 'NOT_FOUND',
                failureType: 'NOT_FOUND'
              }));
            } catch (diagnosticError) {
              // Observability must not affect package assembly behavior.
            }
          }
        } else {
          cnbcConstructedEvidence = requireCnbcConstructedEvidence(result, horizons);
        }
      } catch (error) {
        cnbcUnavailable = true;
        cnbcConstructedEvidence = [];
        if (!cnbcFailureType) {
          cnbcFailureType = CNBC_INTEGRATION_FAILURE_TYPE_VALUES
            .has(error?.cnbcIntegrationFailureType)
            ? error.cnbcIntegrationFailureType
            : CNBC_INTEGRATION_FAILURE_TYPES.INTEGRATION_CONTRACT_MISMATCH;
        }
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
    }

    const yahooItems = yahooCollections.flatMap(collection => collection.items);
    const yahooRecapItems = yahooRecapConstructedEvidence
      ? [yahooRecapConstructedEvidence.evidenceItem] : [];
    const federalReserveItems = federalReserveCollection ? federalReserveCollection.items : [];
    const cnbcRecapItems = cnbcRecapConstructedEvidence
      ? [cnbcRecapConstructedEvidence.evidenceItem] : [];
    const requiredBaseEvidenceItems = yahooItems.concat(
      yahooRecapItems, federalReserveItems, cnbcRecapItems
    );
    const requiredBaseBroadMarketNewsItems = yahooRecapItems.concat(cnbcRecapItems);
    const requiredBaseEvidenceHorizons = [
      ...yahooItems.map(() => 'COMPLETED_SESSION'),
      ...yahooRecapItems.map(() => yahooRecapConstructedEvidence.horizon.classification),
      ...federalReserveItems.map(() => 'COMPLETED_SESSION'),
      ...cnbcRecapItems.map(() => 'SUBSEQUENT_DEVELOPMENT')
    ];

    function classificationInputFor(items, horizons, validatedBroadMarketNewsItems) {
      const collection = createEvidenceCollection({market: 'US', items});
      const broadMarketNewsRefs = broadMarketNewsReferences(
        items, validatedBroadMarketNewsItems
      );
      return Object.freeze({
        marketContext: Object.freeze({
          market: 'US',
          exchangeTimezone: marketContext.exchangeTimezone,
          marketState: marketContext.marketState,
          primaryCompletedSessionDate: marketContext.primaryCompletedSessionDate
        }),
        benchmarkTelemetry: Object.freeze(benchmarkSnapshots.map((snapshot, index) => Object.freeze({
          reference: `t${index + 1}`,
          snapshot
        }))),
        evidence: Object.freeze(collection.items.map((item, index) => Object.freeze({
          reference: `e${index + 1}`,
          horizon: horizons[index],
          requiresBroadMarketSubjects: broadMarketNewsRefs.has(`e${index + 1}`),
          item
        })))
      });
    }

    const activeYahooItems = [];
    for (const item of acquiredActiveYahooItems) {
      const trialItems = requiredBaseEvidenceItems.concat(activeYahooItems, item);
      const trialHorizons = requiredBaseEvidenceHorizons.concat(
        activeYahooItems.map(() => 'CURRENT_SESSION'),
        'CURRENT_SESSION'
      );
      if (trialItems.length > MAX_CLASSIFICATION_EVIDENCE_ITEMS) break;
      try {
        const request = buildClaudeEvidenceRoleClassificationRequest(
          classificationInputFor(
            trialItems,
            trialHorizons,
            requiredBaseBroadMarketNewsItems.concat(activeYahooItems, item)
          )
        );
        if (Buffer.byteLength(JSON.stringify(request), 'utf8')
            > CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES) break;
        activeYahooItems.push(item);
      } catch (error) {
        break;
      }
    }
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) emitDiagnostics(onDiagnostics, {
      stage: 'activeYahooEvidenceHandoff',
      acquiredCurrentSessionCount: acquiredActiveYahooItems.length,
      admittedCurrentSessionCount: activeYahooItems.length,
      classifierAdmissionRejectedCount: acquiredActiveYahooItems.length - activeYahooItems.length
    });
    const baseEvidenceItems = requiredBaseEvidenceItems.concat(activeYahooItems);
    const baseBroadMarketNewsItems = requiredBaseBroadMarketNewsItems.concat(activeYahooItems);
    const baseEvidenceHorizons = requiredBaseEvidenceHorizons.concat(
      activeYahooItems.map(() => 'CURRENT_SESSION')
    );

    const admittedCnbcConstructedEvidence = [];
    if (marketContext.primaryCompletedSessionDate !== null) {
      for (const record of cnbcConstructedEvidence) {
        const trialRecords = admittedCnbcConstructedEvidence.concat(record);
        const trialItems = baseEvidenceItems.concat(
          trialRecords.map(candidate => candidate.evidenceItem)
        );
        const trialHorizons = baseEvidenceHorizons.concat(
          trialRecords.map(candidate => candidate.horizon.classification)
        );
        if (trialItems.length > MAX_CLASSIFICATION_EVIDENCE_ITEMS) break;
        try {
          const request = buildClaudeEvidenceRoleClassificationRequest(
            classificationInputFor(trialItems, trialHorizons,
              baseBroadMarketNewsItems.concat(trialRecords.map(record => record.evidenceItem)))
          );
          if (Buffer.byteLength(JSON.stringify(request), 'utf8')
              > CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES) break;
          admittedCnbcConstructedEvidence.push(record);
        } catch (error) {
          break;
        }
      }
    }
    const provisionalEvidenceItems = baseEvidenceItems.concat(
      admittedCnbcConstructedEvidence.map(record => record.evidenceItem)
    );
    const cnbcClassifierCapacityUnavailable = cnbcConstructedEvidence.length > 0
      && admittedCnbcConstructedEvidence.length === 0;
    const provisionalEvidenceHorizons = baseEvidenceHorizons.concat(
      admittedCnbcConstructedEvidence.map(record => record.horizon.classification)
    );
    const classificationInput = classificationInputFor(
      provisionalEvidenceItems,
      provisionalEvidenceHorizons,
      baseBroadMarketNewsItems.concat(
        admittedCnbcConstructedEvidence.map(record => record.evidenceItem)
      )
    );

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
    const completedSessionHorizon = canonicalHorizons?.find(horizon =>
      horizon.classification === 'COMPLETED_SESSION'
    ) || null;
    const yahooSessionAssociations = yahooRecapConstructedEvidence
      ? [createPostCloseSessionAssociation({
          evidenceRef: yahooRecapReferences[0],
          sessionDate: yahooRecapConstructedEvidence.targetSessionDate,
          exchangeTimezone: marketContext.exchangeTimezone,
          canonicalCloseAt: completedSessionHorizon?.endsAtInclusive,
          publishedAt: yahooRecapConstructedEvidence.evidenceItem.publishedAt
        })].filter(Boolean)
      : [];
    const federalReserveReferences = federalReserveItems.map(
      (item, index) => `e${yahooItems.length + yahooRecapItems.length + index + 1}`
    );
    const cnbcRecapReferences = cnbcRecapItems.map(
      (item, index) => `e${yahooItems.length + yahooRecapItems.length
        + federalReserveItems.length + index + 1}`
    );
    const activeYahooReferences = activeYahooItems.map(
      (item, index) => `e${yahooItems.length + yahooRecapItems.length
        + federalReserveItems.length + cnbcRecapItems.length + index + 1}`
    );
    const provisionalCnbcReferences = admittedCnbcConstructedEvidence.map(
      (record, index) => `e${baseEvidenceItems.length + index + 1}`
    );
    const existingEvidenceReferences = yahooReferences.concat(federalReserveReferences);
    const completedSessionYahooRecapReferences = yahooRecapReferences.filter(() =>
      yahooRecapConstructedEvidence.horizon.classification === 'COMPLETED_SESSION');
    const subsequentYahooRecapReferences = yahooRecapReferences.filter(() =>
      yahooRecapConstructedEvidence.horizon.classification === 'SUBSEQUENT_DEVELOPMENT');
    const completedSessionCnbcRecapReferences = [];
    const subsequentCnbcRecapReferences = cnbcRecapReferences;
    const cnbcSessionAssociations = cnbcRecapConstructedEvidence
      && completedSessionHorizon
      && cnbcRecapConstructedEvidence.evidenceItem.publishedAt !== null
      ? [createPostCloseSessionAssociation({
          evidenceRef: cnbcRecapReferences[0],
          sessionDate: cnbcRecapConstructedEvidence.targetSessionDate,
          exchangeTimezone: marketContext.exchangeTimezone,
          canonicalCloseAt: completedSessionHorizon.endsAtInclusive,
          publishedAt: cnbcRecapConstructedEvidence.evidenceItem.publishedAt
        })].filter(Boolean)
      : [];
    let materialEvents = [];
    let principalCatalysts = [];
    let retainedCnbcConstructedEvidence = [];
    let finalClassifications = [];
    let broadMarketFocus = [];
    const skipClassificationForZeroCurrentActive = analysisMode === ANALYSIS_MODES.ACTIVE_SESSION
      && activeYahooItems.length === 0;
    if (skipClassificationForZeroCurrentActive) {
      emitDiagnostics(onDiagnostics, {
        stage: 'evidenceRoleClassification',
        outcome: 'SKIPPED_ZERO_CURRENT_SESSION_EVIDENCE'
      });
    } else if (marketContext.primaryCompletedSessionDate !== null) {
      setAssemblyFailureStage('EVIDENCE_ROLE_CLASSIFICATION');
      const result = await timed('evidenceRoleClassificationMs', () =>
        evidenceRoleClassification.classifyEvidenceRoles(classificationInput));
      if (!result || result.ok !== true || result.type !== 'SUCCESS') {
        if (typeof onDiagnostics === 'function') {
          try {
            onDiagnostics(Object.freeze({
              stage: 'evidenceRoleClassificationFailure',
              failureType: result?.type,
              failureMessage: result?.message,
              upstreamStatus: result?.upstreamStatus
            }));
          } catch (diagnosticError) {
            // Observability must not affect package assembly behavior.
          }
        }
        throw new TypeError('Evidence-role classification failed');
      }
      const activeClassificationInput = classificationInput.evidence.some(entry =>
        entry.horizon === 'CURRENT_SESSION');
      let completion;
      let coverage;
      try {
        completion = completeClaudeEvidenceRoleClassificationOutput(result.output, classificationInput, {
          allowConservativeCompletion: activeClassificationInput
        });
        coverage = result.classificationCoverage && typeof result.classificationCoverage === 'object'
          ? result.classificationCoverage : completion.classificationCoverage;
      } catch (error) {
        coverage = classificationCoverage(result.output, classificationInput);
        if (typeof onDiagnostics === 'function') {
          try {
            onDiagnostics(Object.freeze({stage: 'evidenceRoleClassificationCoverage', ...coverage}));
          } catch (diagnosticError) {
            // Observability must not affect package assembly behavior.
          }
        }
        throw error;
      }
      if (typeof onDiagnostics === 'function') {
        try {
          onDiagnostics(Object.freeze({stage: 'evidenceRoleClassificationCoverage', ...coverage}));
        } catch (diagnosticError) {
          // Observability must not affect package assembly behavior.
        }
      }
      const output = completion.output;
      const classifications = output.classifications;
      const classificationsByReference = new Map(
        classifications.map(classification => [classification.reference, classification])
      );
      retainedCnbcConstructedEvidence = admittedCnbcConstructedEvidence.filter((record, index) => {
        const classification = classificationsByReference.get(provisionalCnbcReferences[index]);
        return ['HIGH', 'MEDIUM'].includes(classification.materiality)
          && classification.roles.some(role =>
            role === 'MATERIAL_EVENT' || role === 'PRINCIPAL_CATALYST');
      });
      const retainedIdentity = new Set(retainedCnbcConstructedEvidence);
      const provisionalToFinal = new Map();
      let retainedIndex = 0;
      admittedCnbcConstructedEvidence.forEach((record, index) => {
        if (!retainedIdentity.has(record)) return;
        provisionalToFinal.set(
          provisionalCnbcReferences[index],
          `e${baseEvidenceItems.length + ++retainedIndex}`
        );
      });
      finalClassifications = classifications.flatMap(classification => {
        const number = Number(classification.reference.slice(1));
        if (number <= baseEvidenceItems.length) return [classification];
        const reference = provisionalToFinal.get(classification.reference);
        return reference ? [{...classification, reference}] : [];
      });
      const repairEvidence = classifications.flatMap((classification, index) => {
        const evidence = classificationInput.evidence[index];
        const number = Number(classification.reference.slice(1));
        const reference = number <= baseEvidenceItems.length
          ? classification.reference : provisionalToFinal.get(classification.reference);
        return reference
            && evidence.requiresBroadMarketSubjects
            && evidence.item.evidenceCategory === 'news'
            && ['HIGH', 'MEDIUM'].includes(classification.materiality)
            && classification.roles.some(role =>
              role === 'MATERIAL_EVENT' || role === 'PRINCIPAL_CATALYST')
            && classification.subjects.length === 0
          ? [{
              reference,
              title: evidence.item.title,
              summary: evidence.item.summary ?? null
            }]
          : [];
      });
      if (repairEvidence.length > 0) {
        let repairOutcome = 'FAILURE';
        let repairedReferenceCount = 0;
        let repairFailureType = null;
        try {
          const repairResult = typeof evidenceRoleClassification.repairEvidenceSubjects === 'function'
            ? await timed('evidenceRoleClassificationMs', () =>
                evidenceRoleClassification.repairEvidenceSubjects({evidence: repairEvidence}))
            : null;
          if (repairResult?.ok === true && repairResult.type === 'SUCCESS') {
            const repairOutput = createClaudeEvidenceSubjectRepairOutput(
              repairResult.output,
              {evidence: repairEvidence}
            );
            const repairedByReference = new Map(
              repairOutput.repairs.map(repair => [repair.reference, repair.subjects])
            );
            finalClassifications = finalClassifications.map(classification => {
              const subjects = repairedByReference.get(classification.reference);
              if (!subjects?.length) return classification;
              repairedReferenceCount++;
              return Object.freeze({...classification, subjects});
            });
            repairOutcome = repairedReferenceCount === 0
              ? 'REMAINED_EMPTY'
              : repairedReferenceCount === repairEvidence.length ? 'SUCCESS' : 'PARTIAL_SUCCESS';
          } else {
            repairFailureType = typeof repairResult?.type === 'string'
              ? repairResult.type : 'UNAVAILABLE';
          }
        } catch (error) {
          repairFailureType = 'CONTRACT_FAILURE';
        }
        if (typeof onDiagnostics === 'function') {
          try {
            onDiagnostics(Object.freeze({
              stage: 'evidenceSubjectRepair',
              primaryOmittedSubjectCount:
                result.subjectCoverage?.primaryOmittedSubjectCount ?? null,
              primarySanitizedEmptySubjectCount:
                result.subjectCoverage?.primarySanitizedEmptySubjectCount ?? null,
              attemptedReferenceCount: repairEvidence.length,
              repairedReferenceCount,
              outcome: repairOutcome,
              failureType: repairFailureType
            }));
          } catch (diagnosticError) {
            // Observability must not affect package assembly behavior.
          }
        }
      }
      materialEvents = finalClassifications
        .filter(classification => classification.roles.includes('MATERIAL_EVENT'))
        .map(classification => classification.reference);
      principalCatalysts = finalClassifications
        .filter(classification => classification.roles.includes('PRINCIPAL_CATALYST'))
        .map(classification => classification.reference);
      setAssemblyFailureStage('ANALYSIS_MATERIAL_ACQUISITION');
    }

    const cnbcItems = retainedCnbcConstructedEvidence.map(record => record.evidenceItem);
    const evidenceItems = baseEvidenceItems.concat(cnbcItems);
    setAssemblyFailureStage('EVIDENCE_COLLECTION_CONSTRUCTION');
    const evidenceCollection = createEvidenceCollection({market: 'US', items: evidenceItems});
    setAssemblyFailureStage('ANALYSIS_MATERIAL_ACQUISITION');
    const cnbcReferences = retainedCnbcConstructedEvidence.map(
      (record, index) => `e${baseEvidenceItems.length + index + 1}`
    );
    const completedSessionCnbcReferences = cnbcReferences.filter((reference, index) =>
      retainedCnbcConstructedEvidence[index].horizon.classification === 'COMPLETED_SESSION');
    const subsequentCnbcReferences = cnbcReferences.filter((reference, index) =>
      retainedCnbcConstructedEvidence[index].horizon.classification
        === 'SUBSEQUENT_DEVELOPMENT');
    const finalEvidenceByReference = new Map(
      evidenceCollection.items.map((item, index) => [`e${index + 1}`, item])
    );
    const finalBroadMarketNewsReferences = broadMarketNewsReferences(
      evidenceItems,
      baseBroadMarketNewsItems.concat(cnbcItems)
    );
    broadMarketFocus = finalClassifications
      .filter(classification => {
        const item = finalEvidenceByReference.get(classification.reference);
        return finalBroadMarketNewsReferences.has(classification.reference)
          && item?.evidenceCategory === 'news'
          && ['HIGH', 'MEDIUM'].includes(classification.materiality)
          && classification.roles.some(role =>
            role === 'MATERIAL_EVENT' || role === 'PRINCIPAL_CATALYST');
      }).map(classification => ({
        evidenceRef: classification.reference,
        subjects: classification.subjects
          .filter(isSpecificBroadMarketSubject)
          .map(subject => ({...subject}))
      })).filter(entry => entry.subjects.length > 0);

    const furtherReadingReferences = [];
    const furtherReadingUrls = new Set();
    for (const [reference, item] of [
      ...yahooRecapReferences.map((reference, index) => [reference, yahooRecapItems[index]]),
      ...cnbcRecapReferences.map((reference, index) => [reference, cnbcRecapItems[index]]),
      ...cnbcReferences.map((reference, index) => [reference, cnbcItems[index]])
    ]) {
      if (!furtherReadingUrls.has(item.canonicalUrl)) {
        furtherReadingUrls.add(item.canonicalUrl);
        furtherReadingReferences.push(reference);
      }
    }

    const unresolvedGaps = [
      ...(federalReserveUnavailable ? [FEDERAL_RESERVE_UNAVAILABLE_GAP] : []),
      ...(yahooRecapGap ? [yahooRecapGap] : []),
      ...(cnbcRecapUnavailable ? [CNBC_RECAP_UNAVAILABLE_GAP] : []),
      ...(cnbcUnavailable ? [CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP] : []),
      ...(cnbcClassifierCapacityUnavailable ? [BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP] : []),
      ...(marketContext.primaryCompletedSessionDate === null
        ? [EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP] : [])
    ].filter((gap, index, gaps) => gaps.indexOf(gap) === index);

    function portfolioList(items) {
      return items.map(item => ({
        market: item.market,
        symbol: item.symbol,
        telemetryRefs: [portfolioTelemetryReferenceBySymbol.get(item.symbol)],
        evidenceRefs: [portfolioEvidenceReferenceBySymbol.get(item.symbol)].concat(
          activeYahooReferences.filter((reference, index) =>
            activeYahooItems[index].symbols.includes(item.symbol))
        ),
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
          materialEvents,
          authoritativeFacts: existingEvidenceReferences,
          principalCatalysts,
          supportingEvidence: yahooReferences.concat(
            completedSessionYahooRecapReferences,
            federalReserveReferences,
            completedSessionCnbcRecapReferences,
            completedSessionCnbcReferences
          ),
          conflictingEvidence: [],
          subsequentDevelopments: subsequentYahooRecapReferences.concat(
            subsequentCnbcRecapReferences, subsequentCnbcReferences
          ),
          sessionAssociations: yahooSessionAssociations.concat(cnbcSessionAssociations),
          broadMarketFocus,
          unresolvedGaps,
          furtherReadings: furtherReadingReferences.map(evidenceRef => ({
            evidenceRef,
            sessionDate: marketContext.primaryCompletedSessionDate
          }))
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
        yahooMostActiveAcquisitionMs: 0,
        yahooLatestNewsDiscoveryMs: 0,
        yahooCurrentNewsArticleAcquisitionMs: 0,
        federalReserveEvidenceAcquisitionMs: 0,
        yahooRecapResearchMs: 0,
        yahooRecapArticleContentAcquisitionMs: 0,
        yahooRecapEvidenceConstructionMs: 0,
        cnbcRecapResearchMs: 0,
        cnbcNewsResearchMs: 0,
        evidenceRoleClassificationMs: 0,
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
          + stageTiming.yahooMostActiveAcquisitionMs
          + stageTiming.yahooLatestNewsDiscoveryMs
          + stageTiming.yahooCurrentNewsArticleAcquisitionMs
          + stageTiming.federalReserveEvidenceAcquisitionMs
          + stageTiming.yahooRecapResearchMs
          + stageTiming.yahooRecapArticleContentAcquisitionMs
          + stageTiming.yahooRecapEvidenceConstructionMs
          + stageTiming.cnbcRecapResearchMs
          + stageTiming.cnbcNewsResearchMs
          + stageTiming.evidenceRoleClassificationMs;
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
  BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP,
  ANALYSIS_MODES,
  ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS,
  CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
  CNBC_RECAP_UNAVAILABLE_GAP,
  EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP,
  FEDERAL_RESERVE_UNAVAILABLE_GAP,
  YAHOO_RECAP_UNAVAILABLE_GAP,
  YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
  YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP,
  ORCHESTRATION_REQUEST_KEYS,
  broadMarketNewsReferences,
  analysisModeForMarketState,
  deriveCnbcResearchHorizons,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
};

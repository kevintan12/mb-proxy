const {
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
} = require('./analysis-package-service');
const {createEvidenceCollection} = require('./evidence-collections');
const {createEvidenceItem, validateEvidenceItem} = require('./evidence-items');
const {validateFiveSessionSnapshot} = require('./five-session-snapshot');
const {createPostCloseSessionAssociation} = require('./post-close-session-relevance');
const {isDeterministicCnbcRecapUrl} = require('./cnbc-deterministic-recap-discovery');
const {
  US_ACTIVE_SESSION_STATES,
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor,
  activeSessionEvidenceWindowResult,
  isTimestampWithinUsActiveSessionWindow
} = require('./us-active-session-evidence');
const {
  US_COMPLETED_SESSION_STATES,
  sectionFourBothListsOn,
  sectionFourPriceRecordOn,
  sectionFourPriceRecordFields
} = require('./section-rules');
const {isSpecificBroadMarketSubject} = require('./broad-market-subjects');
const {getSessionContext} = require('./market-session-calendar');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  completeClaudeEvidenceRoleClassificationOutput,
  classificationCoverage,
  classifierPartialKeepFor,
  createClaudeEvidenceSubjectRepairOutput,
  MAX_CLASSIFICATION_EVIDENCE_ITEMS,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES
} = require('./claude-evidence-role-classification');
const {readingSettings, createReadingBudget, downloadWithRetries} = require('./reading-window');
const {settingValue} = require('./settings-registry');
// Step 9F.6a.3: each news source's limits are read through the shared source
// reader's per-source table. Step 9F.6a.6: news is read through the shared
// source reader directly (lib/yahoo-news-reading.js is gone).
const {sourceLimits, readRunContext, readSource} = require('./source-reader');
const {createYahooNewsSource} = require('./sources/yahoo-news');
// Step 9F.2e.3.2: both Yahoo hand-off loops run through the shared selection
// step's list-order fit check, in today's STOP mode.
const {checkListOrderFit, applyWriterTextBudgetToNewsItems} = require('./article-selection');
const {AUDIT_FIELD_LIMITS, truncatedText} = require('./source-audit');
// Step 9W Build A: the spotlight's price lines and the S&P 500 move.
const {priceLineItem, sp500MovePctFrom} = require('./company-spotlight');
const {performance} = require('node:perf_hooks');

const ORCHESTRATION_REQUEST_KEYS = Object.freeze([
  'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
]);
const BENCHMARK_ANCHOR_KEYS = Object.freeze(['market', 'symbol']);
const FEDERAL_RESERVE_UNAVAILABLE_GAP =
  'Could not get Federal Reserve interest-rate information for this report.';
const CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP =
  'Could not get CNBC market news for this report.';
const CNBC_RECAP_UNAVAILABLE_GAP =
  'Could not get a CNBC recap of the last trading day.';
const YAHOO_RECAP_UNAVAILABLE_GAP =
  'Could not get a Yahoo Finance recap of the last trading day.';
const YAHOO_RECAP_RETRIEVAL_FAILURE_GAP =
  'Could not get a usable Yahoo Finance recap of the last trading day.';
const YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP =
  'Could not turn the Yahoo Finance recap of the last trading day into usable evidence.';
const EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP =
  'Not enough data to sort the news by what it explains, because the last trading day could not be pinned down.';
const BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP =
  'Not enough data to point out specific stocks or sectors.';
const TELEMETRY_UNAVAILABLE_GAP =
  'Price data was missing for some stocks, so they are left out.';
const STALE_COMPLETED_SESSION_TELEMETRY_GAP =
  'Some stocks are left out because their price data was out of date and did not include the last trading day.';
const SNAPSHOT_PERSISTENCE_UNAVAILABLE_GAP =
  'The saved price history could not be checked, so the freshly fetched prices are used as they are.';
const SNAPSHOT_PERSISTENCE_LAG_GAP =
  'The fresh price feed was behind the saved price history, so the newer saved prices are used.';
const YAHOO_MARKET_DATA_EVIDENCE_UNAVAILABLE_GAP =
  'Some Yahoo Finance market data was missing, so it is left out.';
const ACTIVE_YAHOO_NEWS_UNAVAILABLE_GAP =
  'Not enough current Yahoo Finance news to say what is moving the market today.';
const EVIDENCE_ROLE_CLASSIFICATION_FAILED_GAP =
  'Could not sort the news by what it explains, so no news is presented as the cause of a move.';
const EVIDENCE_ROLE_CLASSIFICATION_PARTIAL_GAP =
  'Could not sort some of the news by what it explains, so those items are not presented as the cause of a move.';
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
// Step 9D.2: sourced from lib/section-rules.js, which is now this literal's
// one canonical definition (it previously existed only here).
const COMPLETED_SESSION_STATES = new Set(US_COMPLETED_SESSION_STATES);
// Step 9F.2a: moved into the shared settings registry (lib/settings-registry.js),
// same default values, same behaviour when no environment variable is set.
// Step 9F.6a.3: read once when the module loads, as before, through the shared
// source reader's per-source table; these names stay as aliases. The first-pass
// size is a Fixed registry row since Step 9F.6a.1; the stale-label tolerance and
// the audit limits are read where they are used (lib/source-ranking.js,
// lib/source-audit.js).
// Step 9F.2e.5: these load-time values are exported for tests and reference;
// each run reads sourceLimits again (article slots on: 18 attempts and the
// general-slot cap; off: 12 and 6).
const YAHOO_NEWS_LIMITS = sourceLimits('us.yahoo-finance');
const ACTIVE_YAHOO_INITIAL_CANDIDATE_ATTEMPTS = YAHOO_NEWS_LIMITS.initialCandidateAttempts;
const ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS = YAHOO_NEWS_LIMITS.maxArticleAttempts;
const ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES = YAHOO_NEWS_LIMITS.maxAdmittedArticles;
const MAX_ACTIVE_COVERAGE_DIAGNOSTIC_REFS = 50;

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

// Step 9F.2e.6: one log line each time the writer text budget drops articles
// (plain wording in the plan's summary; this event itself keeps the shape
// every other audit event uses -- headline truncated, no full article text).
// Step 9F.6d Build B (decision 6): with `reportOverBudget` (completed states,
// CNBC read through the shared reader), a total still over the budget after
// every droppable article went is logged as `overBudget: true`, even when
// nothing was dropped. The text is sent anyway; the writer's own request-size
// check is the backstop. Without it, exactly as before.
function emitWriterTextBudgetDrop(onDiagnostics, fit, {reportOverBudget = false} = {}) {
  const overBudget = reportOverBudget && fit?.overBudget === true;
  if (!fit || (fit.dropped.length === 0 && !overBudget)) return;
  emitDiagnostics(onDiagnostics, {
    stage: 'writerTextBudgetDrop',
    budgetBytes: fit.budgetBytes,
    totalBytesBefore: fit.totalBytesBefore,
    totalBytesAfter: fit.totalBytesAfter,
    droppedCount: fit.dropped.length,
    dropped: fit.dropped.map(entry => ({
      headline: truncatedText(entry.headline,
        AUDIT_FIELD_LIMITS.headlineCharacters, AUDIT_FIELD_LIMITS.headlineBytes),
      slot: entry.slot,
      score: entry.score,
      textBytes: entry.textBytes,
      reason: entry.reason
    })),
    ...(overBudget ? {overBudget: true} : {})
  });
}

// Step 9F.6d Build B: the shared reader's admitted CNBC items in today's CNBC
// record shape ({candidateReference c1..cN, horizon, evidenceItem}), so every
// later step (classifier fit, references, retention, Further Readings, gaps)
// runs exactly as on the paid path. Each horizon is the matching canonical
// horizon object; anything that does not check out throws.
function cnbcRecordsFromReading(reading, horizons) {
  if (!reading || !Array.isArray(reading.items) || !Array.isArray(reading.horizons)
      || reading.items.length !== reading.horizons.length || !Array.isArray(horizons)) {
    throw new TypeError('Invalid CNBC shared-reader result');
  }
  return reading.items.map((item, index) => {
    const horizon = horizons.find(entry => entry.classification === reading.horizons[index]);
    if (!horizon || !validateEvidenceItem(item).valid || item.sourceId !== 'us.cnbc'
        || item.market !== 'US' || item.evidenceCategory !== 'news') {
      throw new TypeError('Invalid CNBC shared-reader evidence');
    }
    return Object.freeze({
      candidateReference: `c${index + 1}`,
      horizon: Object.freeze({...horizon}),
      evidenceItem: item
    });
  });
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

// Step 9F.6a.2: the headline tier ranking, stale-by-label check, symbol tagging
// and candidate-audit helpers moved to lib/source-ranking.js and
// lib/source-audit.js. Step 9F.6a.3: the shared source reader
// (lib/source-reader.js) uses them directly, so nothing is handed in from here.

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

function shiftExchangeDate(exchangeDate, days) {
  const [year, month, day] = exchangeDate.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + days);
  return date.toISOString().slice(0, 10);
}

function expectedLatestCompletedUsSessionDate(instant) {
  const current = getSessionContext({market: 'US', instant});
  if (!current.calendarSupported) {
    throw new TypeError('Canonical US exchange calendar is unavailable');
  }
  let candidate = current.tradingDay && current.regularSessionCompleted
    ? current.exchangeDate : shiftExchangeDate(current.exchangeDate, -1);
  for (let attempt = 0; attempt < 16; attempt++) {
    const session = getSessionContext({market: 'US', exchangeDate: candidate});
    if (!session.calendarSupported) {
      throw new TypeError('Canonical US exchange calendar is unavailable');
    }
    if (session.tradingDay) return candidate;
    candidate = shiftExchangeDate(candidate, -1);
  }
  throw new TypeError('Expected completed US session could not be derived');
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

function errorHasCanonicalSessionConflict(error) {
  return error?.code === 'SNAPSHOT_READ_MISMATCH'
    && error?.diagnosticDetails?.mismatchReason === 'CANONICAL_SESSION_VALUES';
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

// Step 9F.1g: the Yahoo recap's horizon is decided by its publish time only
// (recap-only; CNBC uses its own horizon checks).
function horizonForArticle(horizons, articleContent) {
  const published = Date.parse(articleContent.publishedAt);
  return horizons.find(horizon => published > Date.parse(horizon.startsAtExclusive)
    && published <= Date.parse(horizon.endsAtInclusive)) || null;
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

// Step 9F.1g: the article must be the checked page (same link, publish time and
// headline); its update time is not compared.
function yahooRecapArticleMatchesResearch(research, articleContent, targetSessionDate) {
  const publishedTime = canonicalUtcTimestampMilliseconds(articleContent?.publishedAt);
  return articleContent && articleContent.sourceId === 'us.yahoo-finance'
    && articleContent.targetSessionDate === targetSessionDate
    && articleContent.canonicalUrl === research.discovery.url
    && articleContent.publishedAt === research.validation.datePublished
    && publishedTime !== null
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
      || !isDeterministicCnbcRecapUrl(item.canonicalUrl, targetSessionDate)
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
  // Step 9F.6d Build B: optional; the CNBC source for the shared reader
  // (lib/sources/cnbc-rss.js, built by lib/analysis-package-runtime.js). Left
  // out, every run takes the paid-search path exactly as with the switch off.
  cnbcNewsSource = null,
  // Step 9X: optional; the read-only stored-session reader (listLatest from
  // lib/postgres-five-session-snapshot-repository.js). Left out, or with
  // storedPrecedingCloseEnabled off, telemetry acquisition is as at ec47f9a.
  storedSessionReader = null,
  evidenceRoleClassification,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  sleep,
  onDiagnostics,
  // Step 9F.6a.4: optional; receives each news source's candidate pool
  // ({sourceId, pool}). Nothing in the pipeline uses it (tests and the replay
  // harness do); its errors never affect package assembly.
  onCandidatePool
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
  if (cnbcNewsSource !== null && cnbcNewsSource !== undefined) {
    requireMethod(cnbcNewsSource, 'findCandidates', 'cnbcNewsSource');
    requireMethod(cnbcNewsSource, 'readPage', 'cnbcNewsSource');
    if (cnbcNewsSource.sourceId !== 'us.cnbc') throw new TypeError('cnbcNewsSource must be the us.cnbc source');
  }
  if (storedSessionReader !== null && storedSessionReader !== undefined) {
    requireMethod(storedSessionReader, 'listLatest', 'storedSessionReader');
  }
  // Step 9X: fail-soft; any read failure is a miss and acquisition goes on as before.
  async function storedPrecedingCloseLookup({market, symbol}) {
    try {
      return await storedSessionReader.listLatest({market, symbol});
    } catch (error) {
      return null;
    }
  }
  requireMethod(evidenceRoleClassification, 'classifyEvidenceRoles', 'evidenceRoleClassification');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof monotonicNow !== 'function') throw new TypeError('monotonicNow must be a function');
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (onCandidatePool !== undefined && typeof onCandidatePool !== 'function') {
    throw new TypeError('onCandidatePool must be a function');
  }
  // Step 9F.6a.6: Yahoo is the shared source reader's first source; it
  // supplies only its listing pages and its article page reader.
  const yahooNewsSource = createYahooNewsSource({
    yahooLatestNewsDiscovery,
    yahooCurrentNewsArticleContentAcquisition
  });

  function reportCandidatePools(candidatePools) {
    if (typeof onCandidatePool !== 'function') return;
    for (const [sourceId, pool] of Object.entries(candidatePools)) {
      try {
        onCandidatePool(Object.freeze({sourceId, pool}));
      } catch (error) {
        // Like diagnostics, the hook must not affect package assembly.
      }
    }
  }

  async function acquireAnalysisMaterial(context, benchmarkAnchors, stageTiming, setAssemblyFailureStage,
    initiatingList) {
    if (context.selectedScope !== 'US' || context.markets.length !== 1 || context.markets[0] !== 'US') {
      throw new TypeError('US analysis package orchestration supports selectedScope US only');
    }
    const benchmarkSymbols = benchmarkAnchors.map(anchor => anchor.symbol);
    const benchmarkSymbolSet = new Set(benchmarkSymbols);
    if (context.myStocks.concat(context.watchlist).some(item => benchmarkSymbolSet.has(item.symbol))) {
      throw new TypeError('Benchmark anchors cannot be portfolio membership');
    }

    const expectedLatestCompletedSessionDate = expectedLatestCompletedUsSessionDate(
      context.acquisitionStartedAt
    );

    // Step 9X: read once per package.
    const storedPrecedingCloseOn = storedSessionReader !== null && storedSessionReader !== undefined
      && settingValue('storedPrecedingCloseEnabled') === true;
    const telemetryAcquisition = createTelemetryAcquisition(storedPrecedingCloseOn
      ? {generatedAt: context.acquisitionStartedAt, precedingCloseLookup: storedPrecedingCloseLookup}
      : {generatedAt: context.acquisitionStartedAt});
    requireMethod(telemetryAcquisition, 'acquireSnapshot', 'telemetryAcquisition');
    const portfolioSymbols = uniquePortfolioSymbols(context.myStocks, context.watchlist);
    const acquisitionSymbols = benchmarkSymbols.concat(portfolioSymbols);
    const snapshots = [];
    const yahooCollections = [];
    const yahooEvidenceSymbols = [];
    let telemetryUnavailable = false;
    let persistenceUnavailable = false;
    let persistenceLagged = false;
    let staleTelemetryUnavailable = false;
    let yahooEvidenceUnavailable = false;

    async function timed(stage, operation) {
      const started = monotonicNow();
      try {
        return await operation();
      } finally {
        stageTiming[stage] += elapsedMilliseconds(started, monotonicNow());
      }
    }

    for (const symbol of acquisitionSymbols) {
      let acquired;
      try {
        acquired = requireSnapshot(
          await timed('yahooTelemetryAcquisitionMs', () =>
            telemetryAcquisition.acquireSnapshot({market: 'US', symbol})),
          symbol
        );
        if (snapshots.length && acquired.marketState !== snapshots[0].marketState) {
          throw new TypeError('Inconsistent US snapshot market state');
        }
      } catch (error) {
        telemetryUnavailable = true;
        emitDiagnostics(onDiagnostics, {
          stage: 'analysisMaterialOmission', symbol, source: 'YAHOO_TELEMETRY',
          failureType: 'INVALID_OR_UNAVAILABLE_SNAPSHOT'
        });
        continue;
      }
      let persistedReadback;
      let persistenceSucceeded = false;
      let persistenceError = null;
      try {
        persistedReadback = await timed('postgresPersistenceReadbackMs', () =>
          snapshotPersistence.persistSnapshot(acquired));
        persistenceSucceeded = true;
      } catch (error) {
        persistenceError = error;
        emitDiagnostics(onDiagnostics, {
          stage: 'snapshotPersistenceReadbackFailure',
          symbol,
          boundary: 'PERSISTENCE',
          failureSubtype: snapshotPersistenceFailureSubtype(error),
          ...sanitizedSnapshotMismatchDetails(error)
        });
        persistenceUnavailable = true;
      }
      let persisted = acquired;
      let omitPersistedConflict = false;
      if (errorHasCanonicalSessionConflict(persistenceError)) {
        omitPersistedConflict = true;
      }
      if (persistenceError?.persistedSnapshot) {
        try {
          const promoted = requireSnapshot(persistenceError.persistedSnapshot, symbol);
          const acquiredDate = acquired.primaryCompletedSessionDate;
          const promotedDate = promoted.primaryCompletedSessionDate;
          if (promotedDate === expectedLatestCompletedSessionDate
              && promotedDate > acquiredDate) {
            persisted = promoted;
            persistenceLagged = true;
          }
        } catch (error) {
          // Never promote an unvalidated persisted candidate.
        }
      }
      if (persistenceSucceeded) {
        try {
          const readback = requireSnapshot(persistedReadback, symbol);
          if (JSON.stringify(readback) !== JSON.stringify(acquired)) {
            throw new TypeError('Persisted snapshot differs from acquired snapshot');
          }
          persisted = readback;
        } catch (error) {
          emitDiagnostics(onDiagnostics, {
            stage: 'snapshotPersistenceReadbackFailure',
            symbol,
            boundary: 'POST_READBACK_VALIDATION',
            failureSubtype: 'INVALID_PERSISTED_SNAPSHOT'
          });
          persistenceUnavailable = true;
        }
      }
      if (omitPersistedConflict) {
        telemetryUnavailable = true;
        emitDiagnostics(onDiagnostics, {
          stage: 'analysisMaterialOmission', symbol, source: 'SNAPSHOT_PERSISTENCE',
          failureType: 'CANONICAL_SESSION_VALUES_CONFLICT'
        });
        continue;
      }
      if (persisted.primaryCompletedSessionDate !== expectedLatestCompletedSessionDate) {
        telemetryUnavailable = true;
        staleTelemetryUnavailable = true;
        emitDiagnostics(onDiagnostics, {
          stage: 'analysisMaterialOmission',
          symbol,
          source: 'US_COMPLETED_SESSION_FRESHNESS',
          failureType: 'COMPLETED_SESSION_DATE_MISMATCH',
          expectedSessionDate: expectedLatestCompletedSessionDate,
          acquiredSessionDate: acquired.primaryCompletedSessionDate,
          selectedSessionDate: persisted.primaryCompletedSessionDate
        });
        continue;
      }
      snapshots.push(persisted);
      try {
        yahooCollections.push(requireEvidenceCollection(
          await timed('yahooMarketDataEvidenceAcquisitionMs', () =>
            yahooEvidenceAcquisition.acquireEvidence({symbol})),
          {sourceId: 'us.yahoo-finance', symbol}
        ));
        yahooEvidenceSymbols.push(symbol);
      } catch (error) {
        yahooEvidenceUnavailable = true;
        emitDiagnostics(onDiagnostics, {
          stage: 'analysisMaterialOmission', symbol, source: 'YAHOO_MARKET_DATA_EVIDENCE',
          failureType: 'INVALID_OR_UNAVAILABLE_EVIDENCE'
        });
      }
    }

    if (snapshots.length === 0) throw new TypeError('No validated US telemetry is available');
    const benchmarkSnapshots = snapshots.filter(snapshot => benchmarkSymbolSet.has(snapshot.symbol));
    const stockSnapshots = snapshots.filter(snapshot => !benchmarkSymbolSet.has(snapshot.symbol));
    let marketContext = createMarketContext(snapshots);
    const classificationPreflightAvailable = benchmarkSnapshots.length > 0
      && marketContext.primaryCompletedSessionDate !== null
      && benchmarkSnapshots.every(snapshot =>
        snapshot.primaryCompletedSessionDate === marketContext.primaryCompletedSessionDate);
    const analysisMode = analysisModeForMarketState(marketContext.marketState);
    const completedSessionMode = analysisMode === ANALYSIS_MODES.COMPLETED_SESSION;
    // Step 9F.4d: read once per run.
    const classifierPartialKeepOn = settingValue('classifierPartialKeepEnabled') === true;
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

    // Step 9F.1e: the Yahoo news list is now read in every state, once, after the
    // recap and CNBC research below.

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
      // Step 9F.1g: the recap's page checks and article download use the shared
      // retry helper and their own reading budget (its own 30 s setting, kept
      // separately from the Yahoo news reading, which runs later and keeps its
      // own budget -- Step 9F.2a makes the two independently tunable settings).
      const recapRetryOptions = {
        budget: createReadingBudget({
          budgetMs: settingValue('recapReadingBudgetSeconds') * 1000,
          now: monotonicNow
        }),
        attempts: readingSettings({market: 'US'}).downloadAttempts,
        ...(sleep ? {sleep} : {})
      };
      let recapArticleAttempts = 0;
      let recapArticleRetriesStoppedByBudget = false;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const research = await timed('yahooRecapResearchMs', () =>
            yahooRecapResearch.discoverAndValidateRecap({
              targetSessionDate: marketContext.primaryCompletedSessionDate
            }, recapRetryOptions));
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
          const download = await timed('yahooRecapArticleContentAcquisitionMs', () =>
            downloadWithRetries(() => yahooRecapArticleContentAcquisition.acquireArticleContent({
              discovery: research.discovery,
              validation: research.validation,
              bounds: yahooRecapArticleContentBounds
            }), recapRetryOptions));
          recapArticleAttempts += download.attempts;
          if (download.budgetStopped) recapArticleRetriesStoppedByBudget = true;
          if (download.error) {
            if (validatedCacheHit && yahooRecapResearch.evictValidatedCacheHit(research)) {
              yahooRecapStage = 'RESEARCH';
              continue;
            }
            throw download.error;
          }
          const acquired = download.result;
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
      if (recapArticleAttempts > 0) {
        emitDiagnostics(onDiagnostics, {
          stage: 'yahooRecapArticleDownload',
          attempts: recapArticleAttempts,
          retriesStoppedByBudget: recapArticleRetriesStoppedByBudget
        });
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

    // Step 9W Build A: `let`, so the spotlight price lines can be appended
    // after the Yahoo news reading (before any reference is numbered).
    let yahooItems = yahooCollections.flatMap(collection => collection.items);
    const yahooRecapItems = yahooRecapConstructedEvidence
      ? [yahooRecapConstructedEvidence.evidenceItem] : [];
    const federalReserveItems = federalReserveCollection ? federalReserveCollection.items : [];
    const cnbcRecapItems = cnbcRecapConstructedEvidence
      ? [cnbcRecapConstructedEvidence.evidenceItem] : [];

    // Step 9F.1e: one Yahoo news reading for every state, after the recap and CNBC
    // research so neither waits on it. Completed states keep after-close articles
    // apart with the existing canonical horizons: published after the completed
    // close is SUBSEQUENT_DEVELOPMENT, otherwise COMPLETED_SESSION. With no
    // canonical close the article is rejected as window unavailable.
    // Step 9F.6d Build B: the same horizon rule judges CNBC news read through the
    // shared reader, so these definitions now sit above the CNBC reading (moved
    // unchanged; nothing in them has a side effect).
    const completedSessionClose = Date.parse(canonicalHorizons?.find(horizon =>
      horizon.classification === 'COMPLETED_SESSION')?.endsAtInclusive);
    const completedYahooNewsHorizon = publishedAt => !Number.isFinite(completedSessionClose)
      ? null : publishedAt > completedSessionClose ? 'SUBSEQUENT_DEVELOPMENT' : 'COMPLETED_SESSION';

    let cnbcConstructedEvidence = [];
    let cnbcUnavailable = false;
    let cnbcFailureType = null;
    // Today's paid CNBC search: the only CNBC news path with the switch off and,
    // with it on, the fallback when every CNBC list failed. `method` is null on
    // the switch-off path, so its log lines are exactly as before.
    async function researchCnbcNewsPaid(method) {
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
                failureType: 'NOT_FOUND',
                ...(method ? {method} : {})
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
              failureType: cnbcFailureType,
              ...(method ? {method} : {})
            }));
          } catch (diagnosticError) {
            // Observability must not affect package assembly behavior.
          }
        }
      }
    }
    // Step 9F.6d Build B (Kevin, 18 Oct 2026): while
    // cnbcSharedReaderCompletedEnabled is on (read once per run, completed states
    // only, and only when a CNBC source is connected), CNBC news is read from the
    // free CNBC lists through the shared reader, before Yahoo. CNBC keeps up to
    // its general slots (cnbcSlots); Yahoo is then read with only the slots CNBC
    // left unused. The paid search runs only when every list failed, and keeps
    // its first cnbcSlots results. Off (or no source): exactly as before.
    const cnbcSharedReaderOn = Boolean(completedSessionMode && cnbcNewsSource
      && settingValue('cnbcSharedReaderCompletedEnabled'));
    let sharedRunContext = null;
    let cnbcNewsReading = null;
    if (completedSessionMode && !cnbcSharedReaderOn) {
      await researchCnbcNewsPaid(null);
    } else if (cnbcSharedReaderOn) {
      const cnbcLimits = sourceLimits('us.cnbc', {slotContext: {pendingSources: ['us.yahoo-finance']}});
      const emitSharedIntegration = (outcome, failureType) => emitDiagnostics(onDiagnostics, {
        stage: 'cnbcNewsResearchIntegration', outcome, failureType, method: 'SHARED_READER'
      });
      if (!canonicalHorizons) {
        // As on the paid path: no canonical horizons, no CNBC reading at all.
        cnbcUnavailable = true;
        cnbcFailureType = CNBC_INTEGRATION_FAILURE_TYPES.MISSING_CANONICAL_HORIZONS;
        emitSharedIntegration('FAILURE', cnbcFailureType);
      } else {
        // Most Active is the shared run context: fetched once, here before CNBC.
        sharedRunContext = await readRunContext({yahooMostActiveAcquisition, timed});
        cnbcNewsReading = await readSource({
          source: cnbcNewsSource,
          runContext: sharedRunContext,
          market: 'US',
          mode: 'COMPLETED',
          timed,
          emit: event => emitDiagnostics(onDiagnostics, event),
          acquisitionStartedAt: context.acquisitionStartedAt,
          marketContext,
          benchmarkSnapshots,
          stockSnapshots,
          portfolioSlotSnapshots: [],
          classificationPreflightAvailable,
          requiredItems: yahooItems.concat(yahooRecapItems, federalReserveItems, cnbcRecapItems),
          horizonFor: completedYahooNewsHorizon,
          windowUnavailableReason: activeSessionWindowResult?.failureType ?? null,
          sessionWindow: activeSessionWindow,
          acquiredItems: [],
          acquiredMeta: [],
          clock: {monotonicNow, sleep},
          limits: cnbcLimits
        });
        const listingOutcome = cnbcNewsReading.stats.listingOutcome;
        if (listingOutcome === 'ALL_LISTS_FAILED' || listingOutcome === 'FAILED') {
          // Decision 4: every list failed, so the paid search is the fallback.
          emitDiagnostics(onDiagnostics, {stage: 'cnbcPaidSearchFallback', reason: listingOutcome});
          await researchCnbcNewsPaid('PAID_SEARCH_FALLBACK');
          // Decision 5: the same slot rule, first results in the search's own order.
          cnbcConstructedEvidence = cnbcConstructedEvidence.slice(0, cnbcLimits.maxAdmittedArticles);
          // Build B fix: the gap is decided after the slot cut, so no CNBC
          // article kept (cnbcSlots 0) gives the gap line like an empty search.
          if (cnbcConstructedEvidence.length === 0 && !cnbcUnavailable) {
            cnbcUnavailable = true;
            cnbcFailureType = 'NOT_FOUND';
            emitDiagnostics(onDiagnostics, {
              stage: 'cnbcNewsResearchIntegration', outcome: 'NOT_FOUND',
              failureType: 'NOT_FOUND', method: 'PAID_SEARCH_FALLBACK'
            });
          }
        } else {
          try {
            cnbcConstructedEvidence = cnbcRecordsFromReading(cnbcNewsReading, canonicalHorizons);
            if (cnbcConstructedEvidence.length === 0) {
              cnbcUnavailable = true;
              cnbcFailureType = 'NOT_FOUND';
              emitSharedIntegration('NOT_FOUND', 'NOT_FOUND');
            }
          } catch (error) {
            cnbcConstructedEvidence = [];
            cnbcUnavailable = true;
            cnbcFailureType = CNBC_INTEGRATION_FAILURE_TYPES.INTEGRATION_CONTRACT_MISMATCH;
            emitSharedIntegration('FAILURE', cnbcFailureType);
          }
        }
      }
    }
    // Step 9F.6a.6: read through the shared source reader. Most Active is the
    // shared run context, fetched once before any source. Active states judge
    // articles as CURRENT_SESSION while the session window exists and check
    // duplicates and classifier size against the Yahoo quote pages and the Fed;
    // completed states also count the recaps and CNBC.
    const acquiredYahooNewsItems = [];
    // Step 9F.2e.6: parallel to acquiredYahooNewsItems -- one {score, ageHours,
    // slot} row per admitted article, read by nothing but the writer text budget.
    const acquiredYahooNewsMeta = [];
    // Step 9F.2e.1: the stock snapshots of the list that started the run (My
    // Stocks or Watchlist), for the candidate pool's portfolioSlotEligible flag
    // only. One named input, so Step 21D can widen it to both lists.
    // Step 9F.2d.3: the reader's limits are read first (once per run, below);
    // while the portfolio slots are on (limits.portfolioSlots), the names are
    // BOTH lists (Kevin, 11 Oct 2026), for the slots and the pool flag alike.
    // Step 9F.6d Build B: with CNBC read first (switch on), Yahoo gets its own
    // slots plus only the ones CNBC left unused (CNBC admits 2: Yahoo 8).
    const yahooNewsLimits = cnbcSharedReaderOn
      ? sourceLimits('us.yahoo-finance', {slotContext: {readSources: {'us.cnbc': cnbcConstructedEvidence.length}}})
      : sourceLimits('us.yahoo-finance');
    const portfolioSlotsOn = Boolean(yahooNewsLimits.portfolioSlots);
    // Step 21D.2: while sectionFourBothListsEnabled is on, both lists even with the slots off.
    const portfolioSlotSymbols = new Set((portfolioSlotsOn || sectionFourBothListsOn()
      ? (context.myStocks || []).concat(context.watchlist || [])
      : context[initiatingList] || []).map(item => item.symbol));
    const portfolioSlotSnapshots = stockSnapshots.filter(snapshot =>
      portfolioSlotSymbols.has(snapshot.symbol));
    // Step 9F.6d Build B: already fetched before CNBC when CNBC was read.
    const runContext = sharedRunContext || await readRunContext({yahooMostActiveAcquisition, timed});
    // Step 9W Build A: read once per package. While on (and the run context
    // has the spotlight inputs), the Yahoo reading builds the company
    // spotlight from the S&P 500 move, both lists (left out of the spotlight)
    // and CNBC's listed headlines when CNBC was read. Off: no spotlight input.
    const companySpotlightOn = settingValue('companySpotlightEnabled') === true
      && Boolean(runContext.spotlightInputs);
    const spotlightContext = companySpotlightOn ? (() => {
      const namesBySymbol = new Map(stockSnapshots.map(snapshot => [snapshot.symbol, snapshot.instrumentName]));
      return {
        sp500MovePct: sp500MovePctFrom(benchmarkSnapshots),
        listIdentities: portfolioSymbols.map(symbol => ({
          symbol, shortName: namesBySymbol.get(symbol) || null, longName: namesBySymbol.get(symbol) || null
        })),
        extraHeadlines: cnbcNewsReading ? cnbcNewsReading.pool.map(entry => entry.headline) : []
      };
    })() : null;
    const yahooNewsReading = await readSource({
      source: yahooNewsSource,
      runContext,
      ...(spotlightContext ? {spotlightContext} : {}),
      market: 'US',
      mode: completedSessionMode ? 'COMPLETED' : 'ACTIVE',
      timed,
      emit: event => emitDiagnostics(onDiagnostics, event),
      acquisitionStartedAt: context.acquisitionStartedAt,
      marketContext,
      benchmarkSnapshots,
      stockSnapshots,
      portfolioSlotSnapshots,
      classificationPreflightAvailable,
      requiredItems: completedSessionMode
        ? yahooItems.concat(yahooRecapItems, federalReserveItems, cnbcRecapItems,
          cnbcConstructedEvidence.map(record => record.evidenceItem))
        : yahooItems.concat(federalReserveItems),
      horizonFor: completedSessionMode ? completedYahooNewsHorizon
        : () => activeSessionWindow ? 'CURRENT_SESSION' : null,
      windowUnavailableReason: activeSessionWindowResult?.failureType ?? null,
      sessionWindow: activeSessionWindow,
      acquiredItems: acquiredYahooNewsItems,
      acquiredMeta: acquiredYahooNewsMeta,
      clock: {monotonicNow, sleep},
      // Step 9F.2e.5: read once per run, so the article-slots switch
      // (articleSlotsEnabled) takes effect without a reload. Off, the same
      // values as the load-time constants above.
      limits: yahooNewsLimits
    });
    // Step 9F.6a.4: every source's candidate pool, kept in memory for this run
    // only. Nothing reads it yet (Step 9F.2h will); Further Readings is unchanged.
    const candidatePools = {
      [yahooNewsSource.sourceId]: yahooNewsReading.pool,
      // Step 9F.6d Build B: CNBC's pool, when CNBC was read through the shared reader.
      ...(cnbcNewsReading ? {[cnbcNewsSource.sourceId]: cnbcNewsReading.pool} : {})
    };
    reportCandidatePools(candidatePools);
    // Step 9W Build A: one compact market-data price line per spotlight
    // company, after the portfolio quote lines in the same Yahoo market-data
    // block, so every later reference treats it as ordinary evidence. A line
    // that cannot be built is left out; any failure leaves the block as it was.
    if (companySpotlightOn && yahooNewsReading.spotlight) {
      const spotlight = yahooNewsReading.spotlight;
      let priceLines = [];
      try {
        priceLines = spotlight.companies.flatMap(company => {
          try {
            return [priceLineItem(company, {sp500MovePct: spotlight.sp500MovePct})];
          } catch (error) {
            return [];
          }
        });
        yahooItems = yahooItems.concat(priceLines);
      } catch (error) {
        priceLines = [];
      }
      emitDiagnostics(onDiagnostics, {
        stage: 'companySpotlight',
        outcome: spotlight.companies.length ? 'SUCCESS' : 'NONE',
        sp500MovePct: spotlight.sp500MovePct,
        screenerOutcomes: spotlight.screenerOutcomes,
        anchorQuotes: `${spotlight.anchorQuoteCount}/${spotlight.anchorCount}`,
        consideredCount: spotlight.considered,
        companies: spotlight.companies.map(company => ({
          symbol: company.symbol,
          movePct: company.movePct === null ? null : Number(company.movePct.toFixed(2)),
          relativeMovePct: company.relativeMovePct === null ? null : Number(company.relativeMovePct.toFixed(2)),
          marketCapUsdBn: company.marketCapUsdBn === null ? null : Math.round(company.marketCapUsdBn),
          outlets: company.outlets,
          reasons: company.reasons.slice()
        })),
        spotlightSlots: spotlight.slots,
        spotlightSlotsFilled: spotlight.slotsFilled,
        spotlightCoveredSymbols: spotlight.coveredSymbols.slice(),
        priceLineCount: priceLines.length
      });
    }
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) {
      emitDiagnostics(onDiagnostics, {
        stage: 'completedSessionResearch',
        outcome: 'SKIPPED_ACTIVE_SESSION'
      });
    }
    const acquiredActiveYahooItems = completedSessionMode ? [] : acquiredYahooNewsItems;
    const acquiredActiveYahooMeta = completedSessionMode ? [] : acquiredYahooNewsMeta;
    // Step 9F.2e.6 + 9F.2g: while articleTextBudgetEnabled is on, the writer
    // text budget runs on the reader's own acquired Yahoo articles before the
    // classifier size/item fit below (no CNBC or recap in active states, so
    // nothing never-dropped to count here). A dropped article never gets a
    // reference and never reaches classification, so no citation ever points
    // at it. Off: unchanged (budgetedActiveYahooItems is acquiredActiveYahooItems).
    const activeWriterTextBudget = settingValue('articleTextBudgetEnabled')
      ? applyWriterTextBudgetToNewsItems({items: acquiredActiveYahooItems, meta: acquiredActiveYahooMeta})
      : null;
    emitWriterTextBudgetDrop(onDiagnostics, activeWriterTextBudget);
    const budgetedActiveYahooItems = activeWriterTextBudget
      ? activeWriterTextBudget.items : acquiredActiveYahooItems;
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

    // Step 9F.2e.3.2: the first article that would pass 50 items or the
    // classifier request limit (or fails to measure) stops the hand-off, with
    // everything after it. Without the classifier pre-check only the item count
    // is tested.
    const activeYahooFit = checkListOrderFit({
      items: budgetedActiveYahooItems,
      mode: 'STOP',
      baseCount: requiredBaseEvidenceItems.length,
      maxItems: MAX_CLASSIFICATION_EVIDENCE_ITEMS,
      maxBytes: CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES,
      measure: classificationPreflightAvailable
        ? trial => Buffer.byteLength(JSON.stringify(buildClaudeEvidenceRoleClassificationRequest(
          classificationInputFor(
            requiredBaseEvidenceItems.concat(trial),
            requiredBaseEvidenceHorizons.concat(trial.map(() => 'CURRENT_SESSION')),
            requiredBaseBroadMarketNewsItems.concat(trial)
          )
        )), 'utf8')
        : null
    });
    const activeYahooItems = activeYahooFit.kept.map(position => budgetedActiveYahooItems[position]);
    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) emitDiagnostics(onDiagnostics, {
      stage: 'activeYahooEvidenceHandoff',
      acquiredCurrentSessionCount: acquiredActiveYahooItems.length,
      admittedCurrentSessionCount: activeYahooItems.length,
      classifierAdmissionRejectedCount: budgetedActiveYahooItems.length - activeYahooItems.length
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
    const provisionalCnbcEvidenceItems = baseEvidenceItems.concat(
      admittedCnbcConstructedEvidence.map(record => record.evidenceItem)
    );
    const cnbcClassifierCapacityUnavailable = cnbcConstructedEvidence.length > 0
      && admittedCnbcConstructedEvidence.length === 0;
    const provisionalCnbcEvidenceHorizons = baseEvidenceHorizons.concat(
      admittedCnbcConstructedEvidence.map(record => record.horizon.classification)
    );
    const provisionalCnbcBroadMarketNewsItems = baseBroadMarketNewsItems.concat(
      admittedCnbcConstructedEvidence.map(record => record.evidenceItem)
    );

    // Step 9F.1e: completed-state Yahoo news goes after all existing evidence (CNBC
    // included), so no existing reference moves. Like CNBC news it is broad-market
    // news, and it carries the canonical horizon of its publish time.
    const completedYahooNewsItems = [];
    const completedYahooNewsHorizons = [];
    if (completedSessionMode) {
      // Step 9F.2e.6 + 9F.2g: never-drop weight = CNBC news already admitted
      // for this run, plus both recaps (counted by text size only; neither is
      // read as an article here). The writer text budget runs on the reader's
      // own acquired Yahoo articles before any card, horizon or reference is
      // built for them, so a dropped article never enters classification and
      // there is no citation anywhere to clean up afterward.
      const neverDropBytes = admittedCnbcConstructedEvidence.reduce(
        (sum, record) => sum + Buffer.byteLength(record.evidenceItem.summary || '', 'utf8'), 0
      ) + yahooRecapItems.concat(cnbcRecapItems).reduce(
        (sum, item) => sum + Buffer.byteLength(item.summary || '', 'utf8'), 0
      );
      const completedWriterTextBudget = settingValue('articleTextBudgetEnabled')
        ? applyWriterTextBudgetToNewsItems({items: acquiredYahooNewsItems, meta: acquiredYahooNewsMeta, neverDropBytes})
        : null;
      emitWriterTextBudgetDrop(onDiagnostics, completedWriterTextBudget, {reportOverBudget: cnbcSharedReaderOn});
      const budgetedYahooNewsItems = completedWriterTextBudget
        ? completedWriterTextBudget.items : acquiredYahooNewsItems;
      // Step 9F.2e.3.2: a lookup card per article carries its horizon; an
      // article with no horizon stops the hand-off before any measuring. Only
      // the cards' articles and horizons reach the classifier input.
      const completedYahooCards = budgetedYahooNewsItems.map(item => {
        const horizon = completedYahooNewsHorizon(Date.parse(item.publishedAt));
        return {item, horizon, noHorizon: !horizon};
      });
      const completedYahooFit = checkListOrderFit({
        items: completedYahooCards,
        mode: 'STOP',
        baseCount: provisionalCnbcEvidenceItems.length,
        maxItems: MAX_CLASSIFICATION_EVIDENCE_ITEMS,
        maxBytes: CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES,
        measure: classificationPreflightAvailable
          ? trial => Buffer.byteLength(JSON.stringify(buildClaudeEvidenceRoleClassificationRequest(
            classificationInputFor(
              provisionalCnbcEvidenceItems.concat(trial.map(card => card.item)),
              provisionalCnbcEvidenceHorizons.concat(trial.map(card => card.horizon)),
              provisionalCnbcBroadMarketNewsItems.concat(trial.map(card => card.item))
            )
          )), 'utf8')
          : null
      });
      for (const position of completedYahooFit.kept) {
        completedYahooNewsItems.push(completedYahooCards[position].item);
        completedYahooNewsHorizons.push(completedYahooCards[position].horizon);
      }
      emitDiagnostics(onDiagnostics, {
        stage: 'completedYahooEvidenceHandoff',
        acquiredCount: acquiredYahooNewsItems.length,
        admittedCount: completedYahooNewsItems.length,
        subsequentDevelopmentCount: completedYahooNewsHorizons
          .filter(horizon => horizon === 'SUBSEQUENT_DEVELOPMENT').length,
        classifierAdmissionRejectedCount:
          budgetedYahooNewsItems.length - completedYahooNewsItems.length
      });
    }
    const provisionalEvidenceItems = provisionalCnbcEvidenceItems.concat(completedYahooNewsItems);
    const classificationInput = classificationInputFor(
      provisionalEvidenceItems,
      provisionalCnbcEvidenceHorizons.concat(completedYahooNewsHorizons),
      provisionalCnbcBroadMarketNewsItems.concat(completedYahooNewsItems)
    );

    const portfolioTelemetryReferenceBySymbol = new Map(
      snapshots.map((snapshot, index) => [snapshot.symbol, `t${index + 1}`])
    );
    const portfolioEvidenceReferenceBySymbol = new Map(
      yahooEvidenceSymbols.map((symbol, index) => [symbol, `e${index + 1}`])
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
    let classificationUnavailable = false;
    let classificationPartial = false;
    const skipClassificationForZeroCurrentActive = analysisMode === ANALYSIS_MODES.ACTIVE_SESSION
      && activeYahooItems.length === 0;
    if (skipClassificationForZeroCurrentActive) {
      emitDiagnostics(onDiagnostics, {
        stage: 'evidenceRoleClassification',
        outcome: 'SKIPPED_ZERO_CURRENT_SESSION_EVIDENCE'
      });
    } else if (marketContext.primaryCompletedSessionDate !== null
        && classificationPreflightAvailable && provisionalEvidenceItems.length > 0) {
      setAssemblyFailureStage('EVIDENCE_ROLE_CLASSIFICATION');
      try {
      let result = await timed('evidenceRoleClassificationMs', () =>
        evidenceRoleClassification.classifyEvidenceRoles(classificationInput));
      let partialKeep = null;
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
        // Step 9F.4d: when the last attempt broke only the "subsequent development
        // cannot be a principal catalyst" rule, just those items become material
        // events and every other label is kept; the subject repair is skipped (no
        // added call) and no gap line is added. Anything else degrades as before.
        partialKeep = classifierPartialKeepOn ? classifierPartialKeepFor(result) : null;
        if (!partialKeep) throw new TypeError('Evidence-role classification failed');
        emitDiagnostics(onDiagnostics, {
          stage: 'evidenceRoleClassificationPartialKeep',
          outcome: 'DEMOTED_PRINCIPAL_CATALYST',
          demotedReferences: partialKeep.demotedReferences.slice(),
          demotedReferenceCount: partialKeep.demotedReferences.length,
          keptReferenceCount: classificationInput.evidence.length - partialKeep.demotedReferences.length,
          subjectRepairSkipped: true
        });
        result = Object.freeze({
          ok: true,
          type: 'SUCCESS',
          output: partialKeep.output,
          classificationCoverage: partialKeep.classificationCoverage
        });
      }
      let completion;
      let coverage;
      try {
        completion = completeClaudeEvidenceRoleClassificationOutput(result.output, classificationInput, {
          allowConservativeCompletion: analysisMode === ANALYSIS_MODES.ACTIVE_SESSION
        });
        classificationPartial = completion.classificationCoverage.missingReferenceCount > 0;
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
      // Step 9F.2f (10 Oct 2026 decision: CNBC gets no special conditions).
      // While cnbcNoSpecialConditionsEnabled is on, general CNBC evidence is
      // admitted on the same terms as Yahoo news and the base evidence items
      // (classified and roled, but not gated afterward by materiality/role).
      // Off reproduces the 907aacf gate exactly.
      retainedCnbcConstructedEvidence = settingValue('cnbcNoSpecialConditionsEnabled')
        ? admittedCnbcConstructedEvidence
        : admittedCnbcConstructedEvidence.filter((record, index) => {
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
      completedYahooNewsItems.forEach((item, index) => provisionalToFinal.set(
        `e${provisionalCnbcEvidenceItems.length + index + 1}`,
        `e${baseEvidenceItems.length + retainedCnbcConstructedEvidence.length + index + 1}`
      ));
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
      if (repairEvidence.length > 0 && !partialKeep) {
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
      } catch (error) {
        // Step 8U.10: completed days degrade like active days. The rejected
        // output is discarded whole, so no item (post-close included) gets a role.
        classificationUnavailable = true;
        classificationPartial = false;
        // Step 9F.6d Build B (decision 3): with CNBC read through the shared
        // reader, CNBC news is kept unclassified like Yahoo (paid fallback too).
        retainedCnbcConstructedEvidence = cnbcSharedReaderOn ? admittedCnbcConstructedEvidence : [];
        finalClassifications = [];
        materialEvents = [];
        principalCatalysts = [];
        emitDiagnostics(onDiagnostics, {
          stage: 'evidenceRoleClassificationFallback',
          outcome: 'CONSERVATIVE_UNCLASSIFIED',
          suppliedReferenceCount: classificationInput.evidence.length
        });
      }
      setAssemblyFailureStage('ANALYSIS_MATERIAL_ACQUISITION');
    } else if (!skipClassificationForZeroCurrentActive
        && marketContext.primaryCompletedSessionDate !== null) {
      classificationUnavailable = true;
      // Step 9F.6d Build B (decision 3): no classification, CNBC kept like Yahoo.
      if (cnbcSharedReaderOn) retainedCnbcConstructedEvidence = admittedCnbcConstructedEvidence;
      emitDiagnostics(onDiagnostics, {
        stage: 'evidenceRoleClassificationFallback',
        outcome: 'CONSERVATIVE_UNCLASSIFIED',
        suppliedReferenceCount: classificationInput.evidence.length
      });
    }

    const cnbcItems = retainedCnbcConstructedEvidence.map(record => record.evidenceItem);
    const listedEvidenceItems = baseEvidenceItems.concat(cnbcItems, completedYahooNewsItems);
    // Step 9AA.2: while sectionFourPriceRecordEnabled is on, every My Stocks /
    // Watchlist stock with no Yahoo quote line gets a price record (the price its
    // Section 4 row shows, or "no price available"; lib/section-rules.js
    // sectionFourPriceRecordFields), appended after every other item so no
    // existing reference moves. Records are in no role list and never in Further
    // Readings; the writer never sees them (lib/claude-model-input-projection.js).
    // A record that cannot be built is left out. Off: nothing is added.
    const priceRecordItems = [];
    const priceRecordReferenceBySymbol = new Map();
    if (sectionFourPriceRecordOn()) {
      for (const symbol of portfolioSymbols) {
        if (portfolioEvidenceReferenceBySymbol.has(symbol)) continue;
        try {
          const fields = sectionFourPriceRecordFields(symbol,
            stockSnapshots.find(snapshot => snapshot.symbol === symbol) || null,
            marketContext.marketState, context.acquisitionStartedAt);
          const item = createEvidenceItem({
            sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
            title: fields.title, summary: fields.summary, canonicalUrl: fields.canonicalUrl,
            publishedAt: fields.publishedAt, symbols: [symbol]
          });
          priceRecordItems.push(item);
          priceRecordReferenceBySymbol.set(symbol,
            `e${listedEvidenceItems.length + priceRecordItems.length}`);
        } catch (error) {
          // A record is bookkeeping for the table; it never fails the package.
        }
      }
    }
    const evidenceItems = listedEvidenceItems.concat(priceRecordItems);
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
    const completedYahooNewsReferences = completedYahooNewsItems.map(
      (item, index) => `e${baseEvidenceItems.length + cnbcItems.length + index + 1}`
    );
    const completedSessionYahooNewsReferences = completedYahooNewsReferences.filter(
      (reference, index) => completedYahooNewsHorizons[index] === 'COMPLETED_SESSION');
    const subsequentYahooNewsReferences = completedYahooNewsReferences.filter(
      (reference, index) => completedYahooNewsHorizons[index] === 'SUBSEQUENT_DEVELOPMENT');
    const finalEvidenceByReference = new Map(
      evidenceCollection.items.map((item, index) => [`e${index + 1}`, item])
    );
    const finalBroadMarketNewsReferences = broadMarketNewsReferences(
      evidenceItems,
      baseBroadMarketNewsItems.concat(cnbcItems, completedYahooNewsItems)
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

    if (analysisMode === ANALYSIS_MODES.ACTIVE_SESSION) {
      const validEvidenceReference = reference => typeof reference === 'string'
        && /^e[1-9][0-9]*$/.test(reference);
      const boundedReferences = values => [...new Set(values.filter(validEvidenceReference))]
        .slice(0, MAX_ACTIVE_COVERAGE_DIAGNOSTIC_REFS);
      const classificationByReference = new Map(finalClassifications.map(classification =>
        [classification.reference, classification]));
      const broadMarketFocusDetails = broadMarketFocus
        .filter(entry => validEvidenceReference(entry.evidenceRef))
        .slice(0, MAX_ACTIVE_COVERAGE_DIAGNOSTIC_REFS)
        .map(entry => {
          const classification = classificationByReference.get(entry.evidenceRef);
          return {
            evidenceRef: entry.evidenceRef,
            classificationRoles: (classification?.roles || [])
              .filter(role => ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'].includes(role)),
            materialityTier: ['HIGH', 'MEDIUM', 'LOW'].includes(classification?.materiality)
              ? classification.materiality : null,
            confidence: null,
            specificSubjectCount: entry.subjects.length
          };
        });
      const upcomingEventRefs = [];
      const unresolvedDevelopmentRefs = boundedReferences(
        subsequentYahooRecapReferences.concat(
          subsequentCnbcRecapReferences, subsequentCnbcReferences
        )
      );
      emitDiagnostics(onDiagnostics, {
        stage: 'activeSessionSectionCoveragePackage',
        materialEventRefs: boundedReferences(materialEvents),
        principalCatalystRefs: boundedReferences(principalCatalysts),
        broadMarketFocusRefCount: broadMarketFocus.length,
        broadMarketFocusRefs: boundedReferences(broadMarketFocus.map(entry => entry.evidenceRef)),
        broadMarketFocusDetails,
        conflictRefs: [],
        upcomingEventCount: upcomingEventRefs.length,
        upcomingEventRefs,
        unresolvedDevelopmentCount: unresolvedDevelopmentRefs.length,
        unresolvedDevelopmentRefs
      });
    }

    // Step 9AB Build 1: the Further Readings candidates, each marked. The recaps first
    // (RECAP), then every read Yahoo and CNBC article (READ), best score first (ties: the
    // newer article, then evidence order), leaving out drop-list headlines and articles
    // under furtherReadingExtrasMinScore. A read article with no reader score (CNBC from the
    // paid search) is not offered here. Cited articles are chosen later, from the report.
    const minReadScore = settingValue('furtherReadingExtrasMinScore');
    const readMetaByItem = new Map();
    for (const reading of [yahooNewsReading, cnbcNewsReading]) {
      if (!reading || !Array.isArray(reading.items) || !Array.isArray(reading.meta)) continue;
      reading.items.forEach((item, index) => readMetaByItem.set(item, reading.meta[index]));
    }
    const readFurtherReadingCandidates = [
      ...activeYahooReferences.map((reference, index) => [reference, activeYahooItems[index]]),
      ...cnbcReferences.map((reference, index) => [reference, cnbcItems[index]]),
      ...completedYahooNewsReferences.map((reference, index) => [reference, completedYahooNewsItems[index]])
    ].map(([reference, item], order) => ({reference, item, order, meta: readMetaByItem.get(item)}))
      .filter(({meta}) => meta && Number.isFinite(meta.score) && meta.score >= minReadScore
        && !meta.dropReason)
      .sort((a, b) => b.meta.score - a.meta.score
        || (Number.isFinite(a.meta.ageHours) && Number.isFinite(b.meta.ageHours)
          ? a.meta.ageHours - b.meta.ageHours : 0)
        || a.order - b.order);
    const furtherReadingEntries = [];
    const furtherReadingUrls = new Set();
    for (const [reference, item, kind] of [
      ...yahooRecapReferences.map((reference, index) => [reference, yahooRecapItems[index], 'RECAP']),
      ...cnbcRecapReferences.map((reference, index) => [reference, cnbcRecapItems[index], 'RECAP']),
      ...readFurtherReadingCandidates.map(candidate => [candidate.reference, candidate.item, 'READ'])
    ]) {
      if (marketContext.primaryCompletedSessionDate !== null
          && !furtherReadingUrls.has(item.canonicalUrl)) {
        furtherReadingUrls.add(item.canonicalUrl);
        furtherReadingEntries.push({evidenceRef: reference, kind});
      }
    }

    const unresolvedGaps = [
      ...(telemetryUnavailable ? [TELEMETRY_UNAVAILABLE_GAP] : []),
      ...(staleTelemetryUnavailable ? [STALE_COMPLETED_SESSION_TELEMETRY_GAP] : []),
      ...(persistenceUnavailable ? [SNAPSHOT_PERSISTENCE_UNAVAILABLE_GAP] : []),
      ...(persistenceLagged ? [SNAPSHOT_PERSISTENCE_LAG_GAP] : []),
      ...(yahooEvidenceUnavailable ? [YAHOO_MARKET_DATA_EVIDENCE_UNAVAILABLE_GAP] : []),
      ...(analysisMode === ANALYSIS_MODES.ACTIVE_SESSION && activeYahooItems.length === 0
        ? [ACTIVE_YAHOO_NEWS_UNAVAILABLE_GAP] : []),
      ...(classificationUnavailable ? [EVIDENCE_ROLE_CLASSIFICATION_FAILED_GAP] : []),
      ...(classificationPartial ? [EVIDENCE_ROLE_CLASSIFICATION_PARTIAL_GAP] : []),
      ...(federalReserveUnavailable ? [FEDERAL_RESERVE_UNAVAILABLE_GAP] : []),
      ...(yahooRecapGap ? [yahooRecapGap] : []),
      ...(cnbcRecapUnavailable ? [CNBC_RECAP_UNAVAILABLE_GAP] : []),
      ...(cnbcUnavailable ? [CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP] : []),
      ...(cnbcClassifierCapacityUnavailable ? [BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP] : []),
      ...(marketContext.primaryCompletedSessionDate === null
        ? [EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP] : [])
    ].filter((gap, index, gaps) => gaps.indexOf(gap) === index);

    // Step 9F.2d.3: while the portfolio slots are on, completed-day (CLOSED,
    // WEEKEND, HOLIDAY) Yahoo news naming a company is offered to Section 4 for
    // that company, as active-day Yahoo news already is. Off: none.
    const completedYahooNewsForSection4 = portfolioSlotsOn ? completedYahooNewsReferences : [];
    function portfolioList(items) {
      return items.map(item => ({
        market: item.market,
        symbol: item.symbol,
        telemetryRefs: [portfolioTelemetryReferenceBySymbol.get(item.symbol)].filter(Boolean),
        // Step 9AA.2: the quote line, or else the stock's price record (switch on).
        evidenceRefs: [portfolioEvidenceReferenceBySymbol.get(item.symbol)
          ?? priceRecordReferenceBySymbol.get(item.symbol)].filter(Boolean).concat(
          activeYahooReferences.filter((reference, index) =>
            activeYahooItems[index].symbols.includes(item.symbol)),
          completedYahooNewsForSection4.filter((reference, index) =>
            completedYahooNewsItems[index].symbols.includes(item.symbol))
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
          stockSnapshots
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
            completedSessionCnbcReferences,
            completedSessionYahooNewsReferences
          ),
          conflictingEvidence: [],
          subsequentDevelopments: subsequentYahooRecapReferences.concat(
            subsequentCnbcRecapReferences, subsequentCnbcReferences, subsequentYahooNewsReferences
          ),
          sessionAssociations: yahooSessionAssociations.concat(cnbcSessionAssociations),
          broadMarketFocus,
          unresolvedGaps,
          furtherReadings: furtherReadingEntries.map(({evidenceRef, kind}) => ({
            evidenceRef,
            sessionDate: marketContext.primaryCompletedSessionDate,
            kind
          })),
          // Step 9V: completed days with completedSinceCloseEnabled on list the after-close
          // CNBC and Yahoo news (never the two recaps, which describe the close itself). Nothing
          // new is admitted. Active days, or the switch off: no field, exactly as before.
          ...(analysisMode === ANALYSIS_MODES.COMPLETED_SESSION
            && settingValue('completedSinceCloseEnabled') === true
            ? {sinceCloseDevelopments: subsequentCnbcReferences.concat(subsequentYahooNewsReferences)}
            : {})
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
            setAssemblyFailureStage,
            canonicalRequest.initiatingList
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
  STALE_COMPLETED_SESSION_TELEMETRY_GAP,
  ANALYSIS_MODES,
  ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS,
  ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES,
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
  expectedLatestCompletedUsSessionDate,
  deriveCnbcResearchHorizons,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
};

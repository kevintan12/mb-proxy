const {MARKETS} = require('./evidence-sources');
const {EVIDENCE_COLLECTION_KEYS, createEvidenceCollection} = require('./evidence-collections');
const {validateEvidenceItem} = require('./evidence-items');
const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');
const {createThreeSessionSnapshot, validateThreeSessionSnapshot} = require('./three-session-snapshot');

const ANALYTICAL_STATUSES = Object.freeze(['NORMAL', 'DEGRADED', 'FAILED']);
const SELECTED_SCOPES = Object.freeze(['US', 'SG', 'HK', 'ALL']);
const REPORT_TYPES = Object.freeze(['MARKET_BRIEF']);
const INITIATING_LISTS = Object.freeze(['myStocks', 'watchlist']);
const EMPTY_INITIATING_LIST_CONTENT = Object.freeze({
  myStocks: 'No securities are configured in My Stocks.',
  watchlist: 'No securities are configured in Watchlist.'
});
const REPORT_HEADER = 'REPORT HEADER / ANALYSIS CONTEXT';
const REPORT_SECTION_NAMES = Object.freeze([
  'EXECUTIVE MARKET SUMMARY',
  'KEY MARKET DRIVERS',
  'WHAT DROVE / IS DRIVING THE MARKET',
  'STOCKS & SECTORS IN FOCUS',
  'MY STOCKS & WATCHLIST - MATERIAL MOVEMENTS',
  'MARKET INTERPRETATION',
  'KEY RISKS',
  'OPPORTUNITIES',
  'WHAT TO WATCH FOR NEXT',
  'MARKETBRIEF TAKEAWAY',
  'FURTHER READINGS'
]);
const REPORT_SECTION_PURPOSES = Object.freeze([
  'Summarize the applicable market outcome or in-progress state and the most important supported conclusions.',
  'Identify the material macroeconomic, policy, earnings, geopolitical, sector, and market-specific drivers supported by the package.',
  'Explain the supported causal relationship between the material drivers and completed or current market movements, distinguishing current from finalized results.',
  'Cover materially significant broad-market stocks and sectors independently of My Stocks and Watchlist, grouping shared catalysts while preserving distinct company events.',
  'Cover only material movements and relevant known upcoming events within 14 days for the initiating My Stocks or Watchlist list; do not substitute securities from the other list.',
  'Provide supported interpretation, significance assessment, qualified inference, and shared-catalyst synthesis without inventing facts.',
  'Identify material supported risks and clearly qualify unresolved risk explanations.',
  'Identify evidence-supported opportunities without converting incomplete evidence into certainty.',
  'Identify the next material supported catalysts, scheduled events, and unresolved developments to monitor.',
  'State the concise evidence-supported MarketBrief conclusion without padding.',
  'Use only the validated Further Readings references supplied by MarketBrief; do not create or alter URLs.'
]);
const REPORT_SECTION_REQUIREMENTS = Object.freeze(REPORT_SECTION_NAMES.map((name, index) => Object.freeze({
  name,
  purpose: REPORT_SECTION_PURPOSES[index]
})));
const MAXIMUM_REPORT_WORDS = 2500;

const CLAUDE_ANALYSIS_INPUT_KEYS = Object.freeze([
  'analysisRequest', 'marketPackages', 'portfolioContext', 'outputRequirements'
]);
const CLAUDE_ANALYSIS_ARGUMENT_KEYS = Object.freeze([
  'analysisRequest', 'marketPackages', 'portfolioContext'
]);
const ANALYSIS_REQUEST_KEYS = Object.freeze([
  'selectedScope', 'initiatingList', 'generatedAt', 'userTimezone', 'reportType'
]);
const MARKET_PACKAGE_INPUT_KEYS = Object.freeze([
  'market', 'marketContext', 'telemetry', 'evidenceCollection', 'evidenceContext'
]);
const MARKET_PACKAGE_KEYS = Object.freeze([
  'market', 'marketContext', 'telemetry', 'evidenceContext'
]);
const MARKET_CONTEXT_KEYS = Object.freeze([
  'exchangeTimezone', 'marketState', 'primaryCompletedSessionDate',
  'includesCurrentOverlay', 'calendarContext'
]);
const TELEMETRY_CONTEXT_KEYS = Object.freeze(['benchmarkSnapshots', 'stockSnapshots']);
const TELEMETRY_REFERENCE_KEYS = Object.freeze(['reference', 'snapshot']);
const EVIDENCE_CONTEXT_INPUT_KEYS = Object.freeze([
  'materialEvents', 'authoritativeFacts', 'principalCatalysts', 'supportingEvidence',
  'conflictingEvidence', 'subsequentDevelopments', 'unresolvedGaps', 'furtherReadings'
]);
const EVIDENCE_CONTEXT_KEYS = Object.freeze([
  'evidence', ...EVIDENCE_CONTEXT_INPUT_KEYS
]);
const CLAUDE_EVIDENCE_REFERENCE_KEYS = Object.freeze(['reference', 'item']);
const FURTHER_READING_KEYS = Object.freeze(['evidenceRef', 'sessionDate']);
const PORTFOLIO_CONTEXT_KEYS = Object.freeze(['myStocks', 'watchlist']);
const PORTFOLIO_SECURITY_KEYS = Object.freeze([
  'market', 'symbol', 'telemetryRefs', 'evidenceRefs', 'upcomingEvents'
]);
const UPCOMING_EVENT_KEYS = Object.freeze(['title', 'scheduledAt', 'evidenceRefs']);
const OUTPUT_REQUIREMENTS_KEYS = Object.freeze(['header', 'sections', 'maximumWords']);
const OUTPUT_SECTION_REQUIREMENT_KEYS = Object.freeze(['name', 'purpose']);

const CLAUDE_ANALYSIS_OUTPUT_KEYS = Object.freeze([
  'status', 'reportContext', 'sections', 'evidenceReferences', 'furtherReadings', 'evidenceGaps'
]);
const REPORT_CONTEXT_KEYS = Object.freeze([
  'header', 'selectedScope', 'generatedAt', 'userTimezone', 'reportType', 'markets'
]);
const REPORT_SECTION_KEYS = Object.freeze([
  'name', 'content', 'evidenceRefs', 'telemetryRefs', 'uncertainties'
]);

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const UPCOMING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalString(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalDate(value) {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return isValidCalendarDate(year, month, day) ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (!isValidCalendarDate(year, month, day)
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function canonicalTimeZone(value) {
  const timeZone = canonicalString(value);
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {timeZone}).resolvedOptions().timeZone;
  } catch (error) {
    return null;
  }
}

function canonicalSymbol(value) {
  const symbol = canonicalString(value);
  return symbol ? symbol.toUpperCase() : null;
}

function canonicalStringArray(value) {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const item of value) {
    const canonical = canonicalString(item);
    if (!canonical || result.includes(canonical)) return null;
    result.push(canonical);
  }
  return result;
}

function validateCanonicalStringArray(value, allowed = null) {
  const canonical = canonicalStringArray(value);
  return canonical !== null
    && canonical.length === value.length
    && canonical.every((item, index) => item === value[index] && (!allowed || allowed.has(item)));
}

function copySnapshot(snapshot) {
  return createThreeSessionSnapshot({
    market: snapshot.market,
    symbol: snapshot.symbol,
    instrumentName: snapshot.instrumentName,
    instrumentType: snapshot.instrumentType,
    currency: snapshot.currency,
    marketState: snapshot.marketState,
    completedSessions: snapshot.completedSessions,
    currentOverlay: snapshot.currentOverlay
  });
}

function expectedMarkets(scope) {
  return scope === 'ALL' ? MARKETS.slice() : [scope];
}

function normalizeAnalysisRequest(input) {
  if (!hasExactKeys(input, ANALYSIS_REQUEST_KEYS)) return null;
  const selectedScope = typeof input.selectedScope === 'string' ? input.selectedScope.trim().toUpperCase() : '';
  const initiatingList = input.initiatingList;
  const generatedAt = canonicalTimestamp(input.generatedAt);
  const userTimezone = canonicalTimeZone(input.userTimezone);
  const reportType = typeof input.reportType === 'string' ? input.reportType.trim().toUpperCase() : '';
  if (!SELECTED_SCOPES.includes(selectedScope) || !INITIATING_LISTS.includes(initiatingList)
      || !generatedAt || !userTimezone
      || !REPORT_TYPES.includes(reportType)) return null;
  return {selectedScope, initiatingList, generatedAt, userTimezone, reportType};
}

function copySnapshotList(list, market, nextReference) {
  if (!Array.isArray(list)) throw new TypeError('snapshot list must be an array');
  const symbols = new Set();
  return list.map(snapshot => {
    if (!validateThreeSessionSnapshot(snapshot).valid || snapshot.market !== market || symbols.has(snapshot.symbol)) {
      throw new TypeError('invalid or duplicate canonical three-session snapshot');
    }
    symbols.add(snapshot.symbol);
    return {reference: nextReference(), snapshot: copySnapshot(snapshot)};
  });
}

function validateReferenceList(value, allowed) {
  const result = canonicalStringArray(value);
  if (!result || result.some(reference => !allowed.has(reference))) {
    throw new TypeError('invalid reference list');
  }
  return result;
}

function normalizeEvidenceContext(input, collection, references, marketContext) {
  if (!hasExactKeys(input, EVIDENCE_CONTEXT_INPUT_KEYS)) {
    throw new TypeError('invalid evidence context property shape or order');
  }
  const allowed = new Set(references.map(entry => entry.reference));
  const roles = {};
  for (const key of EVIDENCE_CONTEXT_INPUT_KEYS.slice(0, 6)) {
    roles[key] = validateReferenceList(input[key], allowed);
  }
  const unresolvedGaps = canonicalStringArray(input.unresolvedGaps);
  if (!unresolvedGaps) throw new TypeError('invalid evidence unresolved gaps');
  if (!Array.isArray(input.furtherReadings)) throw new TypeError('invalid Further Readings');
  const seen = new Set();
  const furtherReadings = input.furtherReadings.map(reading => {
    if (!hasExactKeys(reading, FURTHER_READING_KEYS)
        || !allowed.has(reading.evidenceRef) || seen.has(reading.evidenceRef)) {
      throw new TypeError('invalid Further Readings reference');
    }
    const sessionDate = canonicalDate(reading.sessionDate);
    if (!sessionDate || sessionDate !== marketContext.primaryCompletedSessionDate) {
      throw new TypeError('Further Readings must match the primary completed session date');
    }
    seen.add(reading.evidenceRef);
    return {evidenceRef: reading.evidenceRef, sessionDate};
  });
  return {
    evidence: references,
    materialEvents: roles.materialEvents,
    authoritativeFacts: roles.authoritativeFacts,
    principalCatalysts: roles.principalCatalysts,
    supportingEvidence: roles.supportingEvidence,
    conflictingEvidence: roles.conflictingEvidence,
    subsequentDevelopments: roles.subsequentDevelopments,
    unresolvedGaps,
    furtherReadings
  };
}

function normalizeMarketPackage(input, expectedMarket, nextEvidenceReference, nextTelemetryReference) {
  if (!hasExactKeys(input, MARKET_PACKAGE_INPUT_KEYS)) {
    throw new TypeError('invalid market package property shape or order');
  }
  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  if (market !== expectedMarket) throw new TypeError('market package does not match selected scope');
  if (!hasExactKeys(input.marketContext, MARKET_CONTEXT_KEYS)) throw new TypeError('invalid market context');
  const exchangeTimezone = canonicalTimeZone(input.marketContext.exchangeTimezone);
  const marketState = canonicalString(input.marketContext.marketState);
  const primaryCompletedSessionDate = input.marketContext.primaryCompletedSessionDate === null
    ? null : canonicalDate(input.marketContext.primaryCompletedSessionDate);
  const includesCurrentOverlay = input.marketContext.includesCurrentOverlay;
  const calendarContext = input.marketContext.calendarContext === null
    ? null : canonicalString(input.marketContext.calendarContext);
  if (!exchangeTimezone || exchangeTimezone !== MARKET_TIME_ZONES[market]
      || !marketState || typeof includesCurrentOverlay !== 'boolean'
      || (input.marketContext.primaryCompletedSessionDate !== null && !primaryCompletedSessionDate)
      || (input.marketContext.calendarContext !== null && !calendarContext)) {
    throw new TypeError('invalid market context values');
  }

  if (!hasExactKeys(input.telemetry, TELEMETRY_CONTEXT_KEYS)) throw new TypeError('invalid telemetry context');
  const benchmarkSnapshots = copySnapshotList(input.telemetry.benchmarkSnapshots, market, nextTelemetryReference);
  const stockSnapshots = copySnapshotList(input.telemetry.stockSnapshots, market, nextTelemetryReference);
  const snapshots = benchmarkSnapshots.concat(stockSnapshots).map(entry => entry.snapshot);
  if (new Set(snapshots.map(snapshot => snapshot.symbol)).size !== snapshots.length
      || snapshots.some(snapshot => snapshot.exchangeTimezone !== exchangeTimezone
        || snapshot.marketState !== marketState)) {
    throw new TypeError('snapshot market context mismatch');
  }
  const dates = snapshots.map(snapshot => snapshot.primaryCompletedSessionDate).filter(Boolean).sort();
  if (primaryCompletedSessionDate !== (dates.length ? dates[dates.length - 1] : null)
      || includesCurrentOverlay !== snapshots.some(snapshot => snapshot.currentOverlay !== null)) {
    throw new TypeError('snapshot date or overlay context mismatch');
  }

  if (!hasExactKeys(input.evidenceCollection, EVIDENCE_COLLECTION_KEYS)) {
    throw new TypeError('invalid evidence collection');
  }
  const collection = createEvidenceCollection(input.evidenceCollection);
  if (collection.market !== market) throw new TypeError('evidence collection market mismatch');
  const references = collection.items.map(item => ({reference: nextEvidenceReference(), item}));
  const marketContext = {
    exchangeTimezone,
    marketState,
    primaryCompletedSessionDate,
    includesCurrentOverlay,
    calendarContext
  };
  return {
    market,
    marketContext,
    telemetry: {benchmarkSnapshots, stockSnapshots},
    evidenceContext: normalizeEvidenceContext(input.evidenceContext, collection, references, marketContext)
  };
}

function normalizeUpcomingEvents(value, market, evidence, generatedAt) {
  if (!Array.isArray(value)) throw new TypeError('upcomingEvents must be an array');
  return value.map(event => {
    if (!hasExactKeys(event, UPCOMING_EVENT_KEYS)) throw new TypeError('invalid upcoming event shape');
    const title = canonicalString(event.title);
    const scheduledAt = canonicalTimestamp(event.scheduledAt);
    const evidenceRefs = validateReferenceList(event.evidenceRefs, new Set(evidence.keys()));
    const eventTime = Date.parse(scheduledAt);
    const generationTime = Date.parse(generatedAt);
    if (!title || !scheduledAt || evidenceRefs.length === 0
        || eventTime <= generationTime || eventTime > generationTime + UPCOMING_WINDOW_MS
        || evidenceRefs.some(reference => evidence.get(reference).market !== market)) {
      throw new TypeError('invalid upcoming event values or horizon');
    }
    return {title, scheduledAt, evidenceRefs};
  });
}

function normalizePortfolioList(value, markets, evidence, telemetry, generatedAt) {
  if (!Array.isArray(value)) throw new TypeError('portfolio list must be an array');
  const seen = new Set();
  return value.map(security => {
    if (!hasExactKeys(security, PORTFOLIO_SECURITY_KEYS)) throw new TypeError('invalid portfolio security shape');
    const market = typeof security.market === 'string' ? security.market.trim().toUpperCase() : '';
    const symbol = canonicalSymbol(security.symbol);
    if (!markets.has(market) || !symbol || seen.has(`${market}|${symbol}`)) {
      throw new TypeError('invalid or duplicate portfolio security');
    }
    seen.add(`${market}|${symbol}`);
    const telemetryRefs = canonicalStringArray(security.telemetryRefs);
    if (!telemetryRefs || telemetryRefs.some(reference => {
      const snapshot = telemetry.get(reference);
      return !snapshot || snapshot.market !== market || snapshot.symbol !== symbol;
    })) throw new TypeError('invalid portfolio telemetry reference');
    const evidenceRefs = validateReferenceList(security.evidenceRefs, new Set(evidence.keys()));
    if (evidenceRefs.some(reference => evidence.get(reference).market !== market)) {
      throw new TypeError('portfolio evidence market mismatch');
    }
    return {
      market,
      symbol,
      telemetryRefs,
      evidenceRefs,
      upcomingEvents: normalizeUpcomingEvents(security.upcomingEvents, market, evidence, generatedAt)
    };
  });
}

function createClaudeAnalysisInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid Claude analysis input: input must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'outputRequirements')) {
    throw new TypeError('Invalid Claude analysis input: outputRequirements is deterministic and must not be supplied');
  }
  if (!hasExactKeys(input, CLAUDE_ANALYSIS_ARGUMENT_KEYS)) {
    throw new TypeError('Invalid Claude analysis input: invalid input property shape or order');
  }
  const analysisRequest = normalizeAnalysisRequest(input.analysisRequest);
  if (!analysisRequest) throw new TypeError('Invalid Claude analysis request');
  if (!Array.isArray(input.marketPackages)) throw new TypeError('Invalid Claude market packages');
  const requiredMarkets = expectedMarkets(analysisRequest.selectedScope);
  if (input.marketPackages.length !== requiredMarkets.length) {
    throw new TypeError('Claude market packages do not match selected scope');
  }
  let evidenceCounter = 0;
  let telemetryCounter = 0;
  const marketPackages = input.marketPackages.map((marketPackage, index) => normalizeMarketPackage(
    marketPackage,
    requiredMarkets[index],
    () => `e${++evidenceCounter}`,
    () => `t${++telemetryCounter}`
  ));
  if (!hasExactKeys(input.portfolioContext, PORTFOLIO_CONTEXT_KEYS)) {
    throw new TypeError('Invalid portfolio context');
  }
  const evidence = new Map();
  const telemetry = new Map();
  for (const marketPackage of marketPackages) {
    for (const entry of marketPackage.evidenceContext.evidence) evidence.set(entry.reference, entry.item);
    for (const key of TELEMETRY_CONTEXT_KEYS) {
      for (const entry of marketPackage.telemetry[key]) telemetry.set(entry.reference, entry.snapshot);
    }
  }
  const markets = new Set(requiredMarkets);
  const portfolioContext = {
    myStocks: normalizePortfolioList(input.portfolioContext.myStocks, markets, evidence, telemetry, analysisRequest.generatedAt),
    watchlist: normalizePortfolioList(input.portfolioContext.watchlist, markets, evidence, telemetry, analysisRequest.generatedAt)
  };
  return deepFreeze({
    analysisRequest,
    marketPackages,
    portfolioContext,
    outputRequirements: {
      header: REPORT_HEADER,
      sections: REPORT_SECTION_REQUIREMENTS.map(section => ({...section})),
      maximumWords: MAXIMUM_REPORT_WORDS
    }
  });
}

function validateClaudeAnalysisInput(input) {
  if (!hasExactKeys(input, CLAUDE_ANALYSIS_INPUT_KEYS)
      || !hasExactKeys(input.analysisRequest, ANALYSIS_REQUEST_KEYS)
      || !hasExactKeys(input.portfolioContext, PORTFOLIO_CONTEXT_KEYS)
      || !hasExactKeys(input.outputRequirements, OUTPUT_REQUIREMENTS_KEYS)) return false;
  const request = normalizeAnalysisRequest(input.analysisRequest);
  if (!request || JSON.stringify(request) !== JSON.stringify(input.analysisRequest)) return false;
  const requiredMarkets = expectedMarkets(request.selectedScope);
  if (!Array.isArray(input.marketPackages) || input.marketPackages.length !== requiredMarkets.length
      || input.outputRequirements.header !== REPORT_HEADER
      || input.outputRequirements.maximumWords !== MAXIMUM_REPORT_WORDS
      || !Array.isArray(input.outputRequirements.sections)
      || input.outputRequirements.sections.length !== REPORT_SECTION_REQUIREMENTS.length) return false;
  for (let index = 0; index < REPORT_SECTION_REQUIREMENTS.length; index++) {
    const actual = input.outputRequirements.sections[index];
    const expected = REPORT_SECTION_REQUIREMENTS[index];
    if (!hasExactKeys(actual, OUTPUT_SECTION_REQUIREMENT_KEYS)
        || actual.name !== expected.name || actual.purpose !== expected.purpose) return false;
  }

  const evidence = new Map();
  const telemetry = new Map();
  let evidenceNumber = 1;
  let telemetryNumber = 1;
  for (let packageIndex = 0; packageIndex < input.marketPackages.length; packageIndex++) {
    const marketPackage = input.marketPackages[packageIndex];
    if (!hasExactKeys(marketPackage, MARKET_PACKAGE_KEYS)
        || marketPackage.market !== requiredMarkets[packageIndex]
        || !hasExactKeys(marketPackage.marketContext, MARKET_CONTEXT_KEYS)
        || !hasExactKeys(marketPackage.telemetry, TELEMETRY_CONTEXT_KEYS)
        || !hasExactKeys(marketPackage.evidenceContext, EVIDENCE_CONTEXT_KEYS)) return false;
    const context = marketPackage.marketContext;
    if (canonicalTimeZone(context.exchangeTimezone) !== context.exchangeTimezone
        || context.exchangeTimezone !== MARKET_TIME_ZONES[marketPackage.market]
        || canonicalString(context.marketState) !== context.marketState
        || (context.primaryCompletedSessionDate !== null
          && canonicalDate(context.primaryCompletedSessionDate) !== context.primaryCompletedSessionDate)
        || typeof context.includesCurrentOverlay !== 'boolean'
        || (context.calendarContext !== null
          && canonicalString(context.calendarContext) !== context.calendarContext)) return false;
    const snapshots = [];
    for (const key of TELEMETRY_CONTEXT_KEYS) {
      if (!Array.isArray(marketPackage.telemetry[key])) return false;
      for (const entry of marketPackage.telemetry[key]) {
        if (!hasExactKeys(entry, TELEMETRY_REFERENCE_KEYS)
            || entry.reference !== `t${telemetryNumber++}`
            || !validateThreeSessionSnapshot(entry.snapshot).valid
            || entry.snapshot.market !== marketPackage.market || telemetry.has(entry.reference)) return false;
        telemetry.set(entry.reference, entry.snapshot);
        snapshots.push(entry.snapshot);
      }
    }
    if (new Set(snapshots.map(snapshot => snapshot.symbol)).size !== snapshots.length
        || snapshots.some(snapshot => snapshot.exchangeTimezone !== context.exchangeTimezone
          || snapshot.marketState !== context.marketState)) return false;
    const dates = snapshots.map(snapshot => snapshot.primaryCompletedSessionDate).filter(Boolean).sort();
    if (context.primaryCompletedSessionDate !== (dates.length ? dates[dates.length - 1] : null)
        || context.includesCurrentOverlay !== snapshots.some(snapshot => snapshot.currentOverlay !== null)) return false;

    const packageEvidence = new Set();
    if (!Array.isArray(marketPackage.evidenceContext.evidence)) return false;
    for (const entry of marketPackage.evidenceContext.evidence) {
      if (!hasExactKeys(entry, CLAUDE_EVIDENCE_REFERENCE_KEYS)
          || entry.reference !== `e${evidenceNumber++}`
          || !validateEvidenceItem(entry.item).valid
          || entry.item.market !== marketPackage.market || evidence.has(entry.reference)) return false;
      evidence.set(entry.reference, entry.item);
      packageEvidence.add(entry.reference);
    }
    for (const key of EVIDENCE_CONTEXT_INPUT_KEYS.slice(0, 6)) {
      if (!validateCanonicalStringArray(marketPackage.evidenceContext[key], packageEvidence)) return false;
    }
    if (!validateCanonicalStringArray(marketPackage.evidenceContext.unresolvedGaps)) return false;
    const furtherSeen = new Set();
    if (!Array.isArray(marketPackage.evidenceContext.furtherReadings)) return false;
    for (const reading of marketPackage.evidenceContext.furtherReadings) {
      if (!hasExactKeys(reading, FURTHER_READING_KEYS)
          || !packageEvidence.has(reading.evidenceRef) || furtherSeen.has(reading.evidenceRef)
          || canonicalDate(reading.sessionDate) !== reading.sessionDate
          || reading.sessionDate !== context.primaryCompletedSessionDate) return false;
      furtherSeen.add(reading.evidenceRef);
    }
  }

  const marketSet = new Set(requiredMarkets);
  for (const key of PORTFOLIO_CONTEXT_KEYS) {
    if (!Array.isArray(input.portfolioContext[key])) return false;
    const seen = new Set();
    for (const security of input.portfolioContext[key]) {
      if (!hasExactKeys(security, PORTFOLIO_SECURITY_KEYS)
          || !marketSet.has(security.market) || canonicalSymbol(security.symbol) !== security.symbol
          || seen.has(`${security.market}|${security.symbol}`)
          || !validateCanonicalStringArray(security.telemetryRefs, new Set(telemetry.keys()))
          || !validateCanonicalStringArray(security.evidenceRefs, new Set(evidence.keys()))
          || security.telemetryRefs.some(reference => {
            const snapshot = telemetry.get(reference);
            return snapshot.market !== security.market || snapshot.symbol !== security.symbol;
          })
          || security.evidenceRefs.some(reference => evidence.get(reference).market !== security.market)
          || !Array.isArray(security.upcomingEvents)) return false;
      seen.add(`${security.market}|${security.symbol}`);
      for (const event of security.upcomingEvents) {
        if (!hasExactKeys(event, UPCOMING_EVENT_KEYS)
            || canonicalString(event.title) !== event.title
            || canonicalTimestamp(event.scheduledAt) !== event.scheduledAt
            || !validateCanonicalStringArray(event.evidenceRefs, new Set(evidence.keys()))
            || event.evidenceRefs.length === 0
            || event.evidenceRefs.some(reference => evidence.get(reference).market !== security.market)) return false;
        const eventTime = Date.parse(event.scheduledAt);
        const generatedTime = Date.parse(request.generatedAt);
        if (eventTime <= generatedTime || eventTime > generatedTime + UPCOMING_WINDOW_MS) return false;
      }
    }
  }
  return true;
}

function collectReferences(input) {
  const evidence = new Set();
  const telemetry = new Set();
  const furtherReadings = [];
  for (const marketPackage of input.marketPackages) {
    for (const entry of marketPackage.evidenceContext.evidence) evidence.add(entry.reference);
    for (const key of TELEMETRY_CONTEXT_KEYS) {
      for (const entry of marketPackage.telemetry[key]) telemetry.add(entry.reference);
    }
    for (const reading of marketPackage.evidenceContext.furtherReadings) furtherReadings.push(reading.evidenceRef);
  }
  return {evidence, telemetry, furtherReadings};
}

function reportContextMatches(context, input) {
  return hasExactKeys(context, REPORT_CONTEXT_KEYS)
    && context.header === REPORT_HEADER
    && context.selectedScope === input.analysisRequest.selectedScope
    && context.generatedAt === input.analysisRequest.generatedAt
    && context.userTimezone === input.analysisRequest.userTimezone
    && context.reportType === input.analysisRequest.reportType
    && Array.isArray(context.markets)
    && context.markets.length === input.marketPackages.length
    && context.markets.every((market, index) => market === input.marketPackages[index].market);
}

function validateClaudeAnalysisOutput(output, input) {
  const errors = [];
  if (!validateClaudeAnalysisInput(input)) {
    return deepFreeze({valid: false, errors: ['invalid canonical Claude analysis input']});
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return deepFreeze({valid: false, errors: ['Claude analysis output must be an object']});
  }
  if (!hasExactKeys(output, CLAUDE_ANALYSIS_OUTPUT_KEYS)) errors.push('invalid canonical output shape or order');
  if (!ANALYTICAL_STATUSES.includes(output.status)) errors.push('invalid analytical status');
  if (!reportContextMatches(output.reportContext, input)) errors.push('invalid or mismatched report context');

  const references = collectReferences(input);
  const initiatingPortfolio = input.portfolioContext[input.analysisRequest.initiatingList];
  const initiatingEvidence = new Set(initiatingPortfolio.flatMap(security => security.evidenceRefs.concat(
    security.upcomingEvents.flatMap(event => event.evidenceRefs)
  )));
  const initiatingTelemetry = new Set(initiatingPortfolio.flatMap(security => security.telemetryRefs));
  const emptyInitiatingContent = EMPTY_INITIATING_LIST_CONTENT[input.analysisRequest.initiatingList];
  const usedEvidence = [];
  let supportedSections = 0;
  let completedSections = 0;
  if (!Array.isArray(output.sections) || output.sections.length !== REPORT_SECTION_NAMES.length) {
    errors.push('invalid report sections');
  } else {
    for (let index = 0; index < output.sections.length; index++) {
      const section = output.sections[index];
      if (!hasExactKeys(section, REPORT_SECTION_KEYS) || section.name !== REPORT_SECTION_NAMES[index]) {
        errors.push(`sections[${index}]: invalid shape, name, or order`);
        continue;
      }
      if (section.content !== null
          && (canonicalString(section.content) === null || section.content !== section.content.trim())) {
        errors.push(`sections[${index}]: invalid content`);
      }
      const validEvidenceRefs = validateCanonicalStringArray(section.evidenceRefs, references.evidence);
      const validTelemetryRefs = validateCanonicalStringArray(section.telemetryRefs, references.telemetry);
      const validUncertainties = validateCanonicalStringArray(section.uncertainties);
      if (!validEvidenceRefs) {
        errors.push(`sections[${index}]: invalid evidence references`);
      }
      if (!validTelemetryRefs) {
        errors.push(`sections[${index}]: invalid telemetry references`);
      }
      if (!validUncertainties) {
        errors.push(`sections[${index}]: invalid uncertainties`);
      }
      const isInitiatingListSection = index === 4;
      if (isInitiatingListSection && validEvidenceRefs
          && section.evidenceRefs.some(reference => !initiatingEvidence.has(reference))) {
        errors.push('sections[4]: evidence references must belong to the initiating list');
      }
      if (isInitiatingListSection && validTelemetryRefs
          && section.telemetryRefs.some(reference => !initiatingTelemetry.has(reference))) {
        errors.push('sections[4]: telemetry references must belong to the initiating list');
      }
      const isEmptyInitiatingListStatement = isInitiatingListSection
        && initiatingPortfolio.length === 0
        && section.content === emptyInitiatingContent
        && validEvidenceRefs && section.evidenceRefs.length === 0
        && validTelemetryRefs && section.telemetryRefs.length === 0
        && validUncertainties && section.uncertainties.length === 0;
      if (isInitiatingListSection && initiatingPortfolio.length === 0
          && !isEmptyInitiatingListStatement) {
        errors.push('sections[4]: empty initiating list requires the deterministic no-securities statement');
      }
      if (validEvidenceRefs) {
        for (const reference of section.evidenceRefs) if (!usedEvidence.includes(reference)) usedEvidence.push(reference);
      }
      if (index === REPORT_SECTION_NAMES.length - 1) {
        if (section.content !== null || !validEvidenceRefs || section.evidenceRefs.length
            || !validTelemetryRefs || section.telemetryRefs.length
            || !validUncertainties || section.uncertainties.length) {
          errors.push('FURTHER READINGS section is resolved by MarketBrief');
        }
      } else if (section.content !== null) {
        completedSections++;
        if (!isEmptyInitiatingListStatement) {
          supportedSections++;
          if (!validEvidenceRefs || section.evidenceRefs.length === 0) {
            errors.push(`sections[${index}]: factual content requires supplied evidence`);
          }
        }
      }
    }
  }

  if (!validateCanonicalStringArray(output.evidenceReferences, references.evidence)
      || JSON.stringify(output.evidenceReferences) !== JSON.stringify(usedEvidence)) {
    errors.push('evidenceReferences must match first-use order');
  }
  if (!validateCanonicalStringArray(output.furtherReadings, references.evidence)
      || JSON.stringify(output.furtherReadings) !== JSON.stringify(references.furtherReadings)) {
    errors.push('Further Readings must match MarketBrief-supplied references');
  }
  if (!validateCanonicalStringArray(output.evidenceGaps)) errors.push('invalid evidence gaps');

  const analysisSections = Array.isArray(output.sections)
    ? output.sections.slice(0, REPORT_SECTION_NAMES.length - 1) : [];
  if (output.status === 'NORMAL') {
    if (completedSections !== analysisSections.length) errors.push('NORMAL requires every analysis section');
    if (!Array.isArray(output.evidenceGaps) || output.evidenceGaps.length) {
      errors.push('NORMAL must not contain unresolved evidence gaps');
    }
  } else if (output.status === 'DEGRADED') {
    if (supportedSections === 0) errors.push('DEGRADED requires supported analysis');
    if (!Array.isArray(output.evidenceGaps) || output.evidenceGaps.length === 0) {
      errors.push('DEGRADED requires unresolved evidence gaps');
    }
    for (let index = 0; index < analysisSections.length; index++) {
      const section = analysisSections[index];
      if (section && section.content === null && section.uncertainties.length === 0) {
        errors.push(`sections[${index}]: unavailable DEGRADED section requires uncertainty`);
      }
    }
  } else if (output.status === 'FAILED') {
    if (supportedSections !== 0) errors.push('FAILED must not contain normal-analysis content');
    if (!Array.isArray(output.evidenceGaps) || output.evidenceGaps.length === 0) {
      errors.push('FAILED requires at least one failure gap');
    }
  }

  if (Array.isArray(output.sections) && Array.isArray(output.evidenceGaps)) {
    const words = output.sections.flatMap(section => section && typeof section === 'object'
      ? [typeof section.content === 'string' ? section.content : '',
        ...(Array.isArray(section.uncertainties) ? section.uncertainties : [])]
      : [])
      .concat(output.evidenceGaps).join(' ').trim();
    if (words && words.split(/\s+/).length > MAXIMUM_REPORT_WORDS) {
      errors.push('report exceeds maximum word allowance');
    }
  }
  return deepFreeze({valid: errors.length === 0, errors});
}

function createClaudeAnalysisOutput(output, input) {
  const validation = validateClaudeAnalysisOutput(output, input);
  if (!validation.valid) throw new TypeError(`Invalid Claude analysis output: ${validation.errors.join('; ')}`);
  return deepFreeze({
    status: output.status,
    reportContext: {
      header: output.reportContext.header,
      selectedScope: output.reportContext.selectedScope,
      generatedAt: output.reportContext.generatedAt,
      userTimezone: output.reportContext.userTimezone,
      reportType: output.reportContext.reportType,
      markets: output.reportContext.markets.slice()
    },
    sections: output.sections.map(section => ({
      name: section.name,
      content: section.content,
      evidenceRefs: section.evidenceRefs.slice(),
      telemetryRefs: section.telemetryRefs.slice(),
      uncertainties: section.uncertainties.slice()
    })),
    evidenceReferences: output.evidenceReferences.slice(),
    furtherReadings: output.furtherReadings.slice(),
    evidenceGaps: output.evidenceGaps.slice()
  });
}

const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: REPORT_SECTION_KEYS.slice(),
  properties: {
    name: {type: 'string', enum: REPORT_SECTION_NAMES.slice()},
    content: {type: ['string', 'null']},
    evidenceRefs: {type: 'array', items: {type: 'string', pattern: '^e[1-9][0-9]*$'}},
    telemetryRefs: {type: 'array', items: {type: 'string', pattern: '^t[1-9][0-9]*$'}},
    uncertainties: {type: 'array', items: {type: 'string', minLength: 1}}
  }
};
const CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: CLAUDE_ANALYSIS_OUTPUT_KEYS.slice(),
  properties: {
    status: {type: 'string', enum: ANALYTICAL_STATUSES.slice()},
    reportContext: {
      type: 'object',
      additionalProperties: false,
      required: REPORT_CONTEXT_KEYS.slice(),
      properties: {
        header: {type: 'string', const: REPORT_HEADER},
        selectedScope: {type: 'string', enum: SELECTED_SCOPES.slice()},
        generatedAt: {type: 'string'},
        userTimezone: {type: 'string'},
        reportType: {type: 'string', enum: REPORT_TYPES.slice()},
        markets: {type: 'array', items: {type: 'string', enum: MARKETS.slice()}}
      }
    },
    sections: {
      type: 'array', minItems: REPORT_SECTION_NAMES.length, maxItems: REPORT_SECTION_NAMES.length,
      items: SECTION_SCHEMA
    },
    evidenceReferences: {type: 'array', items: {type: 'string', pattern: '^e[1-9][0-9]*$'}},
    furtherReadings: {type: 'array', items: {type: 'string', pattern: '^e[1-9][0-9]*$'}},
    evidenceGaps: {type: 'array', items: {type: 'string', minLength: 1}}
  }
});

module.exports = {
  ANALYTICAL_STATUSES,
  SELECTED_SCOPES,
  REPORT_TYPES,
  INITIATING_LISTS,
  EMPTY_INITIATING_LIST_CONTENT,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  REPORT_SECTION_REQUIREMENTS,
  CLAUDE_ANALYSIS_INPUT_KEYS,
  ANALYSIS_REQUEST_KEYS,
  MARKET_PACKAGE_KEYS,
  MARKET_CONTEXT_KEYS,
  TELEMETRY_CONTEXT_KEYS,
  TELEMETRY_REFERENCE_KEYS,
  EVIDENCE_CONTEXT_KEYS,
  CLAUDE_EVIDENCE_REFERENCE_KEYS,
  PORTFOLIO_CONTEXT_KEYS,
  PORTFOLIO_SECURITY_KEYS,
  UPCOMING_EVENT_KEYS,
  OUTPUT_REQUIREMENTS_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_KEYS,
  REPORT_CONTEXT_KEYS,
  REPORT_SECTION_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  createClaudeAnalysisInput,
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  createClaudeAnalysisOutput
};

const {MARKETS} = require('./evidence-sources');
const {EVIDENCE_COLLECTION_KEYS, createEvidenceCollection} = require('./evidence-collections');
const {validateEvidenceItem} = require('./evidence-items');
const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');
const {createFiveSessionSnapshot, validateFiveSessionSnapshot} = require('./five-session-snapshot');
const {isSpecificBroadMarketSubject} = require('./broad-market-subjects');
const {
  US_ACTIVE_SESSION_STATES,
  currentSessionEvidenceContext
} = require('./us-active-session-evidence');

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
  'STOCKS & SECTORS IN FOCUS',
  'MY STOCKS & WATCHLIST - MATERIAL MOVEMENTS',
  'MARKET INTERPRETATION',
  'KEY RISKS & OPPORTUNITIES',
  'WHAT TO WATCH FOR NEXT',
  'FURTHER READINGS'
]);
const REPORT_SECTION_PURPOSES = Object.freeze([
  'Summarize the applicable market outcome or in-progress state and the most important supported conclusions.',
  'Identify material drivers and explain supported relationships to market movements where evidence permits, distinguishing completed-session facts from current developments without inventing causality.',
  'Cover materially significant broad-market stocks and sectors independently of My Stocks and Watchlist, grouping shared catalysts while preserving distinct company events.',
  'Cover only material movements and relevant known upcoming events within 14 days for the initiating My Stocks or Watchlist list; do not substitute securities from the other list.',
  'Provide supported interpretation, significance assessment, qualified inference, and shared-catalyst synthesis without inventing facts.',
  'Distinguish material evidence-supported downside risks from constructive opportunities, qualify uncertainty, and do not force an opportunity where none is supported.',
  'Identify the next material supported catalysts, scheduled events, and unresolved developments to monitor.',
  'Use only the validated Further Readings references supplied by MarketBrief; do not create or alter URLs.'
]);
const REPORT_SECTION_REQUIREMENTS = Object.freeze(REPORT_SECTION_NAMES.map((name, index) => Object.freeze({
  name,
  purpose: REPORT_SECTION_PURPOSES[index]
})));
const MAXIMUM_REPORT_WORDS = 2500;
const MAX_ACTIVE_FURTHER_READINGS = 5;
const NO_CURRENT_SESSION_EVIDENCE_GAP =
  'Validated current-session evidence is insufficient for an active-session Market Brief.';
const NO_CURRENT_SESSION_SUMMARY =
  'Current-session analysis is unavailable because no validated current-session evidence was supplied.';

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
  'conflictingEvidence', 'subsequentDevelopments', 'sessionAssociations', 'broadMarketFocus',
  'unresolvedGaps', 'furtherReadings'
]);
const EVIDENCE_CONTEXT_KEYS = Object.freeze([
  'evidence', ...EVIDENCE_CONTEXT_INPUT_KEYS
]);
const CLAUDE_EVIDENCE_REFERENCE_KEYS = Object.freeze(['reference', 'item']);
const SESSION_ASSOCIATION_KEYS = Object.freeze(['evidenceRef', 'sessionDate']);
const BROAD_MARKET_FOCUS_KEYS = Object.freeze(['evidenceRef', 'subjects']);
const BROAD_MARKET_SUBJECT_KEYS = Object.freeze(['kind', 'name']);
const BROAD_MARKET_SUBJECT_KINDS = Object.freeze(['COMPANY', 'SECTOR']);
const MAX_BROAD_MARKET_SUBJECTS = 5;
const MAX_BROAD_MARKET_SUBJECT_NAME_BYTES = 128;
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
  return createFiveSessionSnapshot({
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
    if (!validateFiveSessionSnapshot(snapshot).valid || snapshot.market !== market || symbols.has(snapshot.symbol)) {
      throw new TypeError('invalid or duplicate canonical five-session snapshot');
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

function normalizeSessionAssociations(value, references, marketContext, subsequentDevelopments) {
  if (!Array.isArray(value)) throw new TypeError('invalid session associations');
  const referenceIndexes = new Map(references.map((entry, index) => [entry.reference, index]));
  const seen = new Set();
  let previousIndex = -1;
  return value.map(association => {
    if (!hasExactKeys(association, SESSION_ASSOCIATION_KEYS)
        || !referenceIndexes.has(association.evidenceRef) || seen.has(association.evidenceRef)
        || !subsequentDevelopments.includes(association.evidenceRef)) {
      throw new TypeError('invalid session association reference');
    }
    const sessionDate = canonicalDate(association.sessionDate);
    const referenceIndex = referenceIndexes.get(association.evidenceRef);
    if (!sessionDate || sessionDate !== marketContext.primaryCompletedSessionDate
        || referenceIndex <= previousIndex) {
      throw new TypeError('invalid session association session date or order');
    }
    seen.add(association.evidenceRef);
    previousIndex = referenceIndex;
    return {evidenceRef: association.evidenceRef, sessionDate};
  });
}

function normalizedSubjectText(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function normalizeBroadMarketFocus(value, references, materialRoleReferences) {
  if (!Array.isArray(value)) throw new TypeError('invalid broad-market focus');
  const referenceIndexes = new Map(references.map((entry, index) => [entry.reference, index]));
  const evidenceByReference = new Map(references.map(entry => [entry.reference, entry.item]));
  const seen = new Set();
  let previousIndex = -1;
  return value.map(entry => {
    const referenceIndex = referenceIndexes.get(entry?.evidenceRef);
    const evidence = evidenceByReference.get(entry?.evidenceRef);
    if (!hasExactKeys(entry, BROAD_MARKET_FOCUS_KEYS)
        || referenceIndex === undefined || referenceIndex <= previousIndex
        || seen.has(entry.evidenceRef) || !materialRoleReferences.has(entry.evidenceRef)
        || evidence?.evidenceCategory !== 'news'
        || !Array.isArray(entry.subjects) || entry.subjects.length === 0
        || entry.subjects.length > MAX_BROAD_MARKET_SUBJECTS) {
      throw new TypeError('invalid broad-market focus reference or order');
    }
    const searchable = normalizedSubjectText(`${evidence.title} ${evidence.summary || ''}`);
    const subjectSeen = new Set();
    const subjects = entry.subjects.map(subject => {
      if (!hasExactKeys(subject, BROAD_MARKET_SUBJECT_KEYS)
          || !BROAD_MARKET_SUBJECT_KINDS.includes(subject.kind)
          || typeof subject.name !== 'string' || !subject.name
          || subject.name !== subject.name.trim()
          || Buffer.byteLength(subject.name, 'utf8') > MAX_BROAD_MARKET_SUBJECT_NAME_BYTES
          || !isSpecificBroadMarketSubject(subject)) {
        throw new TypeError('invalid broad-market focus subject');
      }
      const normalizedName = normalizedSubjectText(subject.name);
      const identity = `${subject.kind}:${normalizedName}`;
      if (!normalizedName || subjectSeen.has(identity) || !searchable.includes(normalizedName)) {
        throw new TypeError('invalid broad-market focus subject');
      }
      subjectSeen.add(identity);
      return {kind: subject.kind, name: subject.name};
    });
    seen.add(entry.evidenceRef);
    previousIndex = referenceIndex;
    return {evidenceRef: entry.evidenceRef, subjects};
  });
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
  const sessionAssociations = normalizeSessionAssociations(
    input.sessionAssociations, references, marketContext, roles.subsequentDevelopments
  );
  const broadMarketFocus = normalizeBroadMarketFocus(
    input.broadMarketFocus,
    references,
    new Set(roles.materialEvents.concat(roles.principalCatalysts))
  );
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
    sessionAssociations,
    broadMarketFocus,
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
            || !validateFiveSessionSnapshot(entry.snapshot).valid
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
    try {
      const canonicalAssociations = normalizeSessionAssociations(
        marketPackage.evidenceContext.sessionAssociations,
        marketPackage.evidenceContext.evidence,
        context,
        marketPackage.evidenceContext.subsequentDevelopments
      );
      if (JSON.stringify(canonicalAssociations)
          !== JSON.stringify(marketPackage.evidenceContext.sessionAssociations)) return false;
      const canonicalFocus = normalizeBroadMarketFocus(
        marketPackage.evidenceContext.broadMarketFocus,
        marketPackage.evidenceContext.evidence,
        new Set(marketPackage.evidenceContext.materialEvents.concat(
          marketPackage.evidenceContext.principalCatalysts
        ))
      );
      if (JSON.stringify(canonicalFocus)
          !== JSON.stringify(marketPackage.evidenceContext.broadMarketFocus)) return false;
    } catch (error) {
      return false;
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

function isActiveUsAnalysis(input) {
  return Boolean(input?.analysisRequest?.selectedScope === 'US'
    && Array.isArray(input.marketPackages) && input.marketPackages.some(
    marketPackage => marketPackage?.market === 'US'
      && US_ACTIVE_SESSION_STATES.includes(marketPackage?.marketContext?.marketState)
  ));
}

function hasCanonicalYahooFinanceUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['finance.yahoo.com', 'sg.finance.yahoo.com'].includes(url.hostname.toLowerCase())
      && /^\/(?:news\/[^/]+|[a-z0-9-]+\/articles\/[^/]+)\.html\/?$/i.test(url.pathname)
      && !url.search && !url.hash;
  } catch (error) {
    return false;
  }
}

function eligibleActiveFurtherReadingReferences(input) {
  const currentReferences = new Set(currentSessionEvidenceContext(input)
    .flatMap(entry => entry.evidenceRefs));
  return new Set(input.marketPackages.flatMap(marketPackage =>
    marketPackage.market === 'US' ? marketPackage.evidenceContext.evidence
      .filter(entry => currentReferences.has(entry.reference)
        && entry.item.sourceId === 'us.yahoo-finance'
        && entry.item.evidenceCategory === 'news'
        && hasCanonicalYahooFinanceUrl(entry.item.canonicalUrl))
      .map(entry => entry.reference) : []
  ));
}

function resolvedActiveFurtherReadingReferences(output, input) {
  if (!isActiveUsAnalysis(input)) return null;
  const eligible = eligibleActiveFurtherReadingReferences(input);
  if (!output || !Array.isArray(output.sections)) return [];
  const resolved = [];
  const seenReferences = new Set();
  const seenUrls = new Set();
  for (const section of output.sections.slice(0, REPORT_SECTION_NAMES.length - 1)) {
    if (!section || section.content === null || !Array.isArray(section.evidenceRefs)) continue;
    for (const reference of section.evidenceRefs) {
      if (!eligible.has(reference) || seenReferences.has(reference)) continue;
      const entry = input.marketPackages.find(marketPackage => marketPackage.market === 'US')
        ?.evidenceContext.evidence.find(candidate => candidate.reference === reference);
      const canonicalUrl = entry?.item?.canonicalUrl;
      if (typeof canonicalUrl !== 'string' || seenUrls.has(canonicalUrl)) continue;
      seenReferences.add(reference);
      seenUrls.add(canonicalUrl);
      resolved.push(reference);
      if (resolved.length === MAX_ACTIVE_FURTHER_READINGS) return resolved;
    }
  }
  return resolved;
}

function resolveActiveFurtherReadings(output, input) {
  const resolved = resolvedActiveFurtherReadingReferences(output, input);
  return resolved === null || !output || typeof output !== 'object' || Array.isArray(output)
    ? output : {...output, furtherReadings: resolved};
}

function sectionThreeScopeViolations(section, input) {
  const focus = input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.broadMarketFocus);
  const focusReferences = new Set(focus.map(entry => entry.evidenceRef));
  const benchmarkReferences = new Set(input.marketPackages.flatMap(marketPackage =>
    marketPackage.telemetry.benchmarkSnapshots.map(entry => entry.reference)));
  const stockSnapshots = new Map(input.marketPackages.flatMap(marketPackage =>
    marketPackage.telemetry.stockSnapshots.map(entry => [entry.reference, entry.snapshot])));
  const focusCompanies = focus.filter(entry => section.evidenceRefs.includes(entry.evidenceRef))
    .flatMap(entry => entry.subjects
      .filter(subject => subject.kind === 'COMPANY')
      .map(subject => normalizedSubjectText(subject.name)));
  const mentionedPortfolioNames = new Set();
  for (const security of input.portfolioContext.myStocks.concat(input.portfolioContext.watchlist)) {
    const instrumentNames = security.telemetryRefs.map(reference => stockSnapshots.get(reference))
      .filter(snapshot => snapshot && snapshot.market === security.market
        && snapshot.symbol === security.symbol)
      .map(snapshot => snapshot.instrumentName);
    const independentlyFocused = focusCompanies.some(name =>
      name === normalizedSubjectText(security.symbol)
      || instrumentNames.some(instrumentName =>
        containsWholeTerm(instrumentName, name)));
    if (independentlyFocused) continue;
    if (containsWholeTerm(section.content, security.symbol, true)) {
      mentionedPortfolioNames.add(`${security.market}:${security.symbol}`);
    }
    if (instrumentNames.some(name => containsWholeTerm(section.content, name))) {
      mentionedPortfolioNames.add(`${security.market}:${security.symbol}`);
    }
  }
  return {
    focusReferenceCount: focusReferences.size,
    benchmarkReferenceCount: benchmarkReferences.size,
    nonFocusEvidenceCount: section.evidenceRefs.filter(reference =>
      !focusReferences.has(reference)).length,
    nonBenchmarkTelemetryCount: section.telemetryRefs.filter(reference =>
      !benchmarkReferences.has(reference)).length,
    unfocusedPortfolioMentionCount: mentionedPortfolioNames.size
  };
}

function containsWholeTerm(content, term, caseSensitive = false) {
  if (typeof content !== 'string' || typeof term !== 'string' || !term) return false;
  const text = caseSensitive ? content.normalize('NFKC') : normalizedSubjectText(content);
  const needle = caseSensitive ? term.normalize('NFKC') : normalizedSubjectText(term);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function hasDirectMarketCausalClaim(content) {
  if (typeof content !== 'string') return false;
  const market = '\\b(?:market|markets|stock market|stocks|shares|equities|equity market|risk assets|risk-assets|indices|indexes|index|s&p 500|nasdaq|dow)\\b';
  const move = '\\b(?:higher|lower|up|down|rise|rose|rally|rallied|gain|gained|advance|advanced|fall|fell|drop|dropped|decline|declined|slip|slipped|selloff|sell-off|loss|lost|move|movement|weakness|strength)\\b';
  const cause = '\\b(?:caused|causing|drove|driven|driving|sent|send|sending|triggered|sparked|fueled|fuelled|pushed|pulled|lifted|weighed on|led to)\\b';
  return content.split(/[.!?;]+/).some(sentence =>
    new RegExp(`${cause}.{0,80}${market}.{0,35}${move}`, 'i').test(sentence)
    || new RegExp(`${cause}.{0,45}${move}.{0,20}\\b(?:in|for|across)\\b.{0,12}${market}`, 'i').test(sentence)
    || new RegExp(`${market}.{0,20}\\b(?:driven|sent|pushed|pulled)\\b.{0,15}${move}.{0,30}\\bby\\b`, 'i').test(sentence)
    || new RegExp(`${market}.{0,35}${move}.{0,45}\\b(?:because of|due to|in response to|on)\\b`, 'i').test(sentence)
    || new RegExp(`\\bweighed on\\s+(?:the\\s+)?${market}`, 'i').test(sentence));
}

function completedSessionDatePatterns(input) {
  if (!input || !Array.isArray(input.marketPackages)) return [];
  const patterns = [];
  const dates = [...new Set(input.marketPackages
    .filter(marketPackage => marketPackage?.market === 'US')
    .map(marketPackage => marketPackage?.marketContext?.primaryCompletedSessionDate)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))];
  for (const value of dates) {
    const [year, month, day] = value.split('-').map(Number);
    const instant = new Date(Date.UTC(year, month - 1, day, 12));
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', timeZone: 'UTC'
    }).format(instant);
    const longMonth = new Intl.DateTimeFormat('en-US', {
      month: 'long', timeZone: 'UTC'
    }).format(instant);
    const shortMonth = new Intl.DateTimeFormat('en-US', {
      month: 'short', timeZone: 'UTC'
    }).format(instant);
    const escaped = term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`\\b${escaped(weekday)}(?:['’]s)?\\s+close\\b`, 'i'));
    patterns.push(new RegExp(`\\b${escaped(value)}\\b`, 'i'));
    patterns.push(new RegExp(
      `\\b(?:${escaped(longMonth)}|${escaped(shortMonth)}\\.?)\\s+0?${day}(?:st|nd|rd|th)?(?:,?\\s+${year})?\\b`,
      'i'
    ));
    patterns.push(new RegExp(`\\b0?${month}/0?${day}/${year}\\b`));
  }
  return patterns;
}

function hasPriorCompletedSessionCausalClaim(content, input) {
  if (typeof content !== 'string') return false;
  const priorTarget = /\b(?:previous|prior|earlier|last)\s+(?:(?:trading\s+)?session|(?:session\s+)?close)\b|\bcompleted(?:-|\s+)(?:trading(?:-|\s+))?session(?:\s+close)?\b|\byesterday(?:['’]s)?\b/i;
  const datePatterns = completedSessionDatePatterns(input);
  const normalized = content.replace(
    /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s+\d{1,2}\b)/gi,
    '$1'
  );
  return normalized.split(/[.!?;]+/).some(sentence =>
    (priorTarget.test(sentence) || datePatterns.some(pattern => pattern.test(sentence)))
      && hasDirectMarketCausalClaim(sentence));
}

function hasOpportunityClaim(content) {
  return typeof content === 'string'
    && /\b(?:opportunit(?:y|ies)|constructive upside|bullish setup|buy(?:ing)? opportunity)\b/i.test(content);
}

function hasGenericOpportunityFiller(content) {
  return typeof content === 'string'
    && /\b(?:rebound|buy(?:ing)? the dip|buy-the-dip|oversold)\b/i.test(content)
    && hasOpportunityClaim(content);
}

function sectionSixOpportunityViolations(section, input) {
  const focus = input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.broadMarketFocus);
  const citedFocus = focus.filter(entry => section.evidenceRefs.includes(entry.evidenceRef));
  const missingFocusEvidence = citedFocus.length === 0;
  const missingGroundedSubject = citedFocus.length > 0 && !citedFocus.some(entry =>
    entry.subjects.some(subject => containsWholeTerm(section.content, subject.name)));
  return {
    focusReferenceCount: new Set(focus.map(entry => entry.evidenceRef)).size,
    genericFiller: hasGenericOpportunityFiller(section.content)
      && (missingFocusEvidence || missingGroundedSubject),
    missingFocusEvidence,
    missingGroundedSubject
  };
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

function noCurrentSessionEvidenceOutput(input) {
  if (!isActiveUsAnalysis(input)
      || currentSessionEvidenceContext(input).some(entry => entry.evidenceRefs.length > 0)) {
    return null;
  }
  return deepFreeze({
    status: 'DEGRADED',
    reportContext: {
      header: REPORT_HEADER,
      selectedScope: input.analysisRequest.selectedScope,
      generatedAt: input.analysisRequest.generatedAt,
      userTimezone: input.analysisRequest.userTimezone,
      reportType: input.analysisRequest.reportType,
      markets: input.marketPackages.map(item => item.market)
    },
    sections: REPORT_SECTION_NAMES.map((name, index) => ({
      name,
      content: index === 0 ? NO_CURRENT_SESSION_SUMMARY : null,
      evidenceRefs: [], telemetryRefs: [],
      uncertainties: index === REPORT_SECTION_NAMES.length - 1
        ? [] : [NO_CURRENT_SESSION_EVIDENCE_GAP]
    })),
    evidenceReferences: [], furtherReadings: [],
    evidenceGaps: [NO_CURRENT_SESSION_EVIDENCE_GAP]
  });
}

function activeSectionOneLeadsCurrentSession(section, input) {
  if (typeof section?.content !== 'string') return false;
  const firstParagraph = section.content.split(/\n\s*\n/, 1)[0];
  const firstSentence = firstParagraph.split(/[.!?](?:\s|$)/, 1)[0].trim();
  const state = input.marketPackages.find(item => item.market === 'US')?.marketContext?.marketState;
  const stateName = state === 'PRE' ? 'pre[- ]market'
    : state === 'POST' ? 'post[- ]market' : 'regular(?:\\s+trading)?\\s+session';
  return new RegExp(`^(?:in|during|as of|at)\\s+(?:the\\s+)?(?:us\\s+)?(?:current\\s+session|${stateName})\\b|^current\\s+session\\s*[:—–-]`, 'i')
    .test(firstSentence) && !hasPriorCompletedSessionCausalClaim(firstParagraph, input);
}

function validateClaudeAnalysisOutput(output, input) {
  const errors = [];
  if (!validateClaudeAnalysisInput(input)) {
    return deepFreeze({valid: false, errors: ['invalid canonical Claude analysis input']});
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return deepFreeze({valid: false, errors: ['Claude analysis output must be an object']});
  }
  const noCurrentOutput = noCurrentSessionEvidenceOutput(input);
  if (noCurrentOutput) {
    return deepFreeze(JSON.stringify(output) === JSON.stringify(noCurrentOutput)
      ? {valid: true, errors: []}
      : {valid: false, errors: ['active session without current evidence requires the deterministic degraded outcome']});
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
  const driverReferences = new Set(input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.materialEvents.concat(
      marketPackage.evidenceContext.principalCatalysts
    )));
  const catalystReferences = new Set(input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.principalCatalysts));
  const currentSessionContext = currentSessionEvidenceContext(input);
  const currentSessionReferences = new Set(currentSessionContext.flatMap(entry => entry.evidenceRefs));
  const activeWithCurrentEvidence = isActiveUsAnalysis(input) && currentSessionReferences.size > 0;
  const completedSessionCatalystReferences = new Set(
    [...catalystReferences].filter(reference => !currentSessionReferences.has(reference))
  );
  const broadMarketFocus = input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.broadMarketFocus);
  const emptyInitiatingContent = EMPTY_INITIATING_LIST_CONTENT[input.analysisRequest.initiatingList];
  const usedEvidence = [];
  let supportedSections = 0;
  let completedSections = 0;
  if (!Array.isArray(output.sections) || output.sections.length !== REPORT_SECTION_NAMES.length) {
    errors.push('invalid report sections');
  } else {
    if (activeWithCurrentEvidence && output.status !== 'FAILED') {
      const summary = output.sections[0];
      if (!Array.isArray(summary?.evidenceRefs)
          || !currentSessionReferences.has(summary.evidenceRefs[0])) {
        errors.push('sections[0]: active summary requires a CURRENT_SESSION evidence reference');
      }
      if (!activeSectionOneLeadsCurrentSession(summary, input)) {
        errors.push('sections[0]: active summary must lead with the current session');
      }
      if (!output.sections.slice(0, REPORT_SECTION_NAMES.length - 1).some(section =>
        section?.content !== null && Array.isArray(section?.evidenceRefs)
          && section.evidenceRefs.some(reference => currentSessionReferences.has(reference)))) {
        errors.push('active analysis requires a cited CURRENT_SESSION evidence reference');
      }
    }
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
      const isInitiatingListSection = index === 3;
      if (isInitiatingListSection && validEvidenceRefs
          && section.evidenceRefs.some(reference => !initiatingEvidence.has(reference))) {
        errors.push('sections[3]: evidence references must belong to the initiating list');
      }
      if (isInitiatingListSection && validTelemetryRefs
          && section.telemetryRefs.some(reference => !initiatingTelemetry.has(reference))) {
        errors.push('sections[3]: telemetry references must belong to the initiating list');
      }
      if (index === 1 && section.content !== null && validEvidenceRefs
          && !section.evidenceRefs.some(reference => driverReferences.has(reference))) {
        errors.push('sections[1]: key market drivers require a material event or principal catalyst');
      }
      if (index === 1 && section.content !== null && validEvidenceRefs
          && hasDirectMarketCausalClaim(section.content)
          && !section.evidenceRefs.some(reference => catalystReferences.has(reference))) {
        errors.push('sections[1]: market causality requires a principal catalyst');
      }
      if (index === 1 && section.content !== null && validEvidenceRefs
          && currentSessionContext.length > 0
          && hasPriorCompletedSessionCausalClaim(section.content, input)
          && !section.evidenceRefs.some(reference =>
            completedSessionCatalystReferences.has(reference))) {
        errors.push('sections[1]: prior completed-session causality requires a completed-session principal catalyst');
      }
      if (index === 2 && section.content !== null && validEvidenceRefs) {
        const citedFocus = broadMarketFocus.filter(entry =>
          section.evidenceRefs.includes(entry.evidenceRef));
        if (citedFocus.length === 0) {
          errors.push('sections[2]: stocks and sectors require broad-market focus evidence');
        } else {
          const content = normalizedSubjectText(section.content);
          const mentionsSubject = citedFocus.some(entry => entry.subjects.some(subject =>
            content.includes(normalizedSubjectText(subject.name))));
          if (!mentionsSubject) {
            errors.push('sections[2]: stocks and sectors must mention a validated broad-market subject');
          }
        }
      }
      if (index === 2 && validEvidenceRefs && validTelemetryRefs) {
        const scope = sectionThreeScopeViolations(section, input);
        if (scope.nonFocusEvidenceCount) {
          errors.push('sections[2]: evidence references must belong to broad-market focus');
        }
        if (scope.nonBenchmarkTelemetryCount) {
          errors.push('sections[2]: telemetry references must belong to benchmark telemetry');
        }
        if (scope.unfocusedPortfolioMentionCount) {
          errors.push('sections[2]: portfolio company requires independent broad-market focus');
        }
      }
      if (index === 5 && section.content !== null && validEvidenceRefs
          && hasOpportunityClaim(section.content)) {
        const scope = sectionSixOpportunityViolations(section, input);
        if (scope.genericFiller) {
          errors.push('sections[5]: generic opportunity claim is not permitted');
        }
        if (scope.missingFocusEvidence) {
          errors.push('sections[5]: opportunity requires relevant broad-market focus evidence');
        } else if (scope.missingGroundedSubject) {
          errors.push('sections[5]: opportunity must name a cited broad-market subject');
        }
      }
      const isEmptyInitiatingListStatement = isInitiatingListSection
        && initiatingPortfolio.length === 0
        && section.content === emptyInitiatingContent
        && validEvidenceRefs && section.evidenceRefs.length === 0
        && validTelemetryRefs && section.telemetryRefs.length === 0
        && validUncertainties && section.uncertainties.length === 0;
      if (isInitiatingListSection && initiatingPortfolio.length === 0
          && !isEmptyInitiatingListStatement) {
        errors.push('sections[3]: empty initiating list requires the deterministic no-securities statement');
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
  const expectedActiveFurtherReadings = resolvedActiveFurtherReadingReferences(output, input);
  const requiredFurtherReadings = expectedActiveFurtherReadings === null
    ? references.furtherReadings : expectedActiveFurtherReadings;
  if (!validateCanonicalStringArray(output.furtherReadings, references.evidence)
      || JSON.stringify(output.furtherReadings) !== JSON.stringify(requiredFurtherReadings)) {
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
  sectionThreeScopeViolations,
  hasDirectMarketCausalClaim,
  hasPriorCompletedSessionCausalClaim,
  hasOpportunityClaim,
  hasGenericOpportunityFiller,
  sectionSixOpportunityViolations,
  MAX_ACTIVE_FURTHER_READINGS,
  NO_CURRENT_SESSION_EVIDENCE_GAP,
  NO_CURRENT_SESSION_SUMMARY,
  noCurrentSessionEvidenceOutput,
  activeSectionOneLeadsCurrentSession,
  eligibleActiveFurtherReadingReferences,
  resolvedActiveFurtherReadingReferences,
  resolveActiveFurtherReadings,
  createClaudeAnalysisOutput
};

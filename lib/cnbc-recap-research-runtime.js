const {
  buildClaudeBoundedCnbcRecapDiscoveryRequest,
  createClaudeBoundedCnbcRecapDiscoveryService
} = require('./claude-bounded-cnbc-recap-discovery');
const {
  CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
} = require('./cnbc-article-content-acquisition');
const {
  createCnbcRecapEvidenceConstructionService
} = require('./cnbc-recap-evidence-construction');
const {NEWS_EVIDENCE_HORIZONS} = require('./news-evidence-candidates');

const CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS = Object.freeze({
  articleRetrievalBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1280 * 1024,
    maxArticleTextBytes: 8 * 1024,
    maxTitleBytes: 512,
    maxResultBytes: 12 * 1024
  }),
  evidenceConstructionBounds: Object.freeze({
    maxEvidenceTextBytes: 8 * 1024,
    maxTitleBytes: 512,
    maxResultBytes: 12 * 1024
  })
});
const INPUT_KEYS = Object.freeze(['targetSessionDate', 'horizons']);
const HORIZON_KEYS = Object.freeze(['classification', 'startsAtExclusive', 'endsAtInclusive']);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DISCOVERY_FAILURE_TYPES = new Set([
  'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'SEARCH_TOOL_FAILURE', 'CONTRACT_FAILURE'
]);
const ACQUISITION_FAILURE_TYPES = new Set([
  'INVALID_INPUT', 'TIMEOUT', 'NETWORK_FAILURE', 'HTTP_FAILURE', 'INVALID_PAGE',
  'EXTRACTION_FAILURE', 'CONTENT_TOO_LARGE', 'SESSION_MISMATCH'
]);
const CONSTRUCTION_FAILURE_TYPES = new Set([
  'INPUT_FAILURE', 'EVIDENCE_TOO_LARGE', 'EVIDENCE_CONTRACT_FAILURE'
]);
const EXTRACTION_FAILURE_TYPES = new Set(CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function newYorkDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) return null;
  try {
    buildClaudeBoundedCnbcRecapDiscoveryRequest({targetSessionDate: input.targetSessionDate});
  } catch (error) {
    return null;
  }
  if (!Array.isArray(input.horizons) || input.horizons.length < 1 || input.horizons.length > 2) return null;
  const horizons = [];
  for (const horizon of input.horizons) {
    if (!hasExactKeys(horizon, HORIZON_KEYS)
        || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)) return null;
    const startsAtExclusive = canonicalTimestamp(horizon.startsAtExclusive);
    const endsAtInclusive = canonicalTimestamp(horizon.endsAtInclusive);
    if (!startsAtExclusive || !endsAtInclusive
        || Date.parse(startsAtExclusive) >= Date.parse(endsAtInclusive)) return null;
    horizons.push({classification: horizon.classification, startsAtExclusive, endsAtInclusive});
  }
  if (horizons[0].classification !== 'COMPLETED_SESSION'
      || newYorkDate(horizons[0].endsAtInclusive) !== input.targetSessionDate
      || (horizons.length === 2
        && (horizons[1].classification !== 'SUBSEQUENT_DEVELOPMENT'
          || horizons[1].startsAtExclusive !== horizons[0].endsAtInclusive))) return null;
  return deepFreeze({targetSessionDate: input.targetSessionDate, horizons});
}

function horizonForArticle(horizons, article) {
  return horizons.find(horizon => {
    const published = Date.parse(article.publishedAt);
    const updated = article.updatedAt === null ? published : Date.parse(article.updatedAt);
    return published > Date.parse(horizon.startsAtExclusive)
      && published <= Date.parse(horizon.endsAtInclusive)
      && updated > Date.parse(horizon.startsAtExclusive)
      && updated <= Date.parse(horizon.endsAtInclusive);
  }) || null;
}

function failure(type, failureType, message) {
  return deepFreeze({ok: false, type, failureType, message});
}

function safeType(value, allowed) {
  return allowed.has(value) ? value : 'UNKNOWN_FAILURE';
}

function emitDiagnostics(onDiagnostics, event) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(deepFreeze(event)); } catch (error) { /* diagnostics cannot alter research */ }
}

function createCnbcRecapResearchRuntime({
  apiKey,
  fetchImpl = global.fetch,
  onDiagnostics,
  discoveryService,
  articleContentAcquisition,
  evidenceConstruction
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const discovery = discoveryService || createClaudeBoundedCnbcRecapDiscoveryService({
    apiKey, fetchImpl, onDiagnostics
  });
  const acquisition = articleContentAcquisition
    || createCnbcArticleContentAcquisitionService({fetchImpl});
  const construction = evidenceConstruction || createCnbcRecapEvidenceConstructionService({
    evidenceConstructionBounds: CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.evidenceConstructionBounds
  });

  return Object.freeze({
    async researchCompletedSessionRecap(input) {
      const context = canonicalInput(input);
      if (!context) return failure('INPUT_FAILURE', 'INPUT_FAILURE', 'Invalid CNBC recap research request');
      const discovered = await discovery.discoverCnbcCompletedSessionRecap({
        targetSessionDate: context.targetSessionDate
      });
      if (!discovered || discovered.ok !== true) {
        const failureType = safeType(discovered?.type, DISCOVERY_FAILURE_TYPES);
        emitDiagnostics(onDiagnostics, {stage: 'cnbcRecapResearch', outcome: 'FAILURE', failureType});
        return failure('DISCOVERY_FAILURE', failureType, 'CNBC recap discovery failed');
      }
      if (discovered.type === 'NOT_FOUND') {
        return deepFreeze({ok: true, type: 'NOT_FOUND', constructedEvidence: null});
      }
      if (discovered.type !== 'SUCCESS' || !Array.isArray(discovered.candidates)
          || discovered.candidates.length === 0) {
        return failure('DISCOVERY_FAILURE', 'UNKNOWN_FAILURE', 'CNBC recap discovery failed');
      }

      const discoveryResult = discovered.candidates[0].discovery;
      let article;
      try {
        article = await acquisition.acquireRecapArticleContent({
          discovery: discoveryResult,
          bounds: CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds
        });
      } catch (error) {
        const failureType = error instanceof CnbcArticleContentAcquisitionError
          ? safeType(error.code, ACQUISITION_FAILURE_TYPES) : 'UNKNOWN_FAILURE';
        if (failureType === 'SESSION_MISMATCH') {
          emitDiagnostics(onDiagnostics, {stage: 'cnbcRecapResearch', outcome: 'NOT_VALIDATED', failureType});
          return deepFreeze({ok: true, type: 'NOT_VALIDATED', constructedEvidence: null});
        }
        const diagnostic = {stage: 'cnbcRecapResearch', outcome: 'FAILURE', failureType};
        if (failureType === 'EXTRACTION_FAILURE') {
          diagnostic.extractionFailureType = EXTRACTION_FAILURE_TYPES.has(error?.extractionFailureType)
            ? error.extractionFailureType
            : 'UNKNOWN_EXTRACTION_FAILURE';
        }
        emitDiagnostics(onDiagnostics, diagnostic);
        return failure('ARTICLE_ACQUISITION_FAILURE', failureType, 'CNBC recap article acquisition failed');
      }
      const horizon = horizonForArticle(context.horizons, article);
      if (!horizon) {
        emitDiagnostics(onDiagnostics, {
          stage: 'cnbcRecapResearch', outcome: 'NOT_VALIDATED', failureType: 'HORIZON_MISMATCH'
        });
        return deepFreeze({ok: true, type: 'NOT_VALIDATED', constructedEvidence: null});
      }
      const constructed = construction.constructEvidence({articleContent: article, horizon});
      if (!constructed || constructed.ok !== true || constructed.type !== 'SUCCESS') {
        const failureType = safeType(constructed?.type, CONSTRUCTION_FAILURE_TYPES);
        emitDiagnostics(onDiagnostics, {stage: 'cnbcRecapResearch', outcome: 'FAILURE', failureType});
        return failure('EVIDENCE_CONSTRUCTION_FAILURE', failureType, 'CNBC recap evidence construction failed');
      }
      return deepFreeze({
        ok: true,
        type: 'SUCCESS',
        constructedEvidence: constructed.constructedEvidence
      });
    }
  });
}

module.exports = {
  CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcRecapResearchRuntime
};

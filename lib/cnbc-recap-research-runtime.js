const {
  createDeterministicCnbcRecapDiscoveryService
} = require('./cnbc-deterministic-recap-discovery');
const {
  CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
} = require('./cnbc-article-content-acquisition');
const {
  createCnbcRecapEvidenceConstructionService
} = require('./cnbc-recap-evidence-construction');

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
const DISCOVERY_FAILURE_TYPES = new Set([
  'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'SEARCH_TOOL_FAILURE', 'CONTRACT_FAILURE'
]);
const ACQUISITION_FAILURE_TYPES = new Set([
  'INVALID_INPUT', 'TIMEOUT', 'NETWORK_FAILURE', 'HTTP_FAILURE', 'INVALID_PAGE',
  'EXTRACTION_FAILURE', 'CONTENT_TOO_LARGE', 'SESSION_MISMATCH'
]);
const SESSION_MISMATCH_DIAGNOSTIC_TYPES = new Set([
  'PUBLICATION_OR_EDITORIAL_SESSION_MISMATCH'
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

function canonicalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).some(key => key !== 'targetSessionDate' && key !== 'horizons')) {
    return null;
  }
  if (typeof input.targetSessionDate !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(input.targetSessionDate)) return null;
  const [year, month, day] = input.targetSessionDate.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day) return null;
  return deepFreeze({
    targetSessionDate: input.targetSessionDate,
    observedAt: input.horizons?.at(-1)?.endsAtInclusive ?? null
  });
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
  fetchImpl = global.fetch,
  onDiagnostics,
  discoveryService,
  articleContentAcquisition,
  evidenceConstruction,
  completedSessionRecapDiscoveryCache
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const discovery = discoveryService || createDeterministicCnbcRecapDiscoveryService();
  const acquisition = articleContentAcquisition
    || createCnbcArticleContentAcquisitionService({fetchImpl, onDiagnostics});
  const construction = evidenceConstruction || createCnbcRecapEvidenceConstructionService({
    evidenceConstructionBounds: CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS.evidenceConstructionBounds
  });
  const cache = completedSessionRecapDiscoveryCache
    && typeof completedSessionRecapDiscoveryCache.get === 'function'
    && typeof completedSessionRecapDiscoveryCache.set === 'function'
    && typeof completedSessionRecapDiscoveryCache.delete === 'function'
    ? completedSessionRecapDiscoveryCache
    : null;

  function emitCache(outcome) {
    emitDiagnostics(onDiagnostics, {
      stage: 'completedSessionRecapDiscoveryCache',
      provider: 'CNBC',
      outcome
    });
  }

  async function constructFromDiscovery(context, discoveryResult, emitStageDiagnostics) {
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
        if (emitStageDiagnostics) {
          const diagnostic = {
            stage: 'cnbcRecapResearch', outcome: 'NOT_VALIDATED', failureType
          };
          if (SESSION_MISMATCH_DIAGNOSTIC_TYPES.has(error?.sessionMismatchType)) {
            diagnostic.sessionMismatchType = error.sessionMismatchType;
          }
          emitDiagnostics(onDiagnostics, diagnostic);
        }
        return {
          identityValid: false,
          result: deepFreeze({ok: true, type: 'NOT_VALIDATED', constructedEvidence: null})
        };
      }
      if (emitStageDiagnostics) {
        const diagnostic = {stage: 'cnbcRecapResearch', outcome: 'FAILURE', failureType};
        if (failureType === 'EXTRACTION_FAILURE') {
          diagnostic.extractionFailureType = EXTRACTION_FAILURE_TYPES.has(error?.extractionFailureType)
            ? error.extractionFailureType
            : 'UNKNOWN_EXTRACTION_FAILURE';
        }
        emitDiagnostics(onDiagnostics, diagnostic);
      }
      return {
        identityValid: false,
        result: failure('ARTICLE_ACQUISITION_FAILURE', failureType,
          'CNBC recap article acquisition failed')
      };
    }
    const constructed = construction.constructEvidence({
      articleContent: article, observedAt: context.observedAt
    });
    if (!constructed || constructed.ok !== true || constructed.type !== 'SUCCESS') {
      const failureType = safeType(constructed?.type, CONSTRUCTION_FAILURE_TYPES);
      if (emitStageDiagnostics) {
        emitDiagnostics(onDiagnostics, {stage: 'cnbcRecapResearch', outcome: 'FAILURE', failureType});
      }
      return {
        identityValid: true,
        result: failure('EVIDENCE_CONSTRUCTION_FAILURE', failureType,
          'CNBC recap evidence construction failed')
      };
    }
    return {
      identityValid: true,
      result: deepFreeze({
        ok: true,
        type: 'SUCCESS',
        constructedEvidence: constructed.constructedEvidence
      })
    };
  }

  return Object.freeze({
    async researchCompletedSessionRecap(input) {
      const context = canonicalInput(input);
      if (!context) return failure('INPUT_FAILURE', 'INPUT_FAILURE', 'Invalid CNBC recap research request');
      if (cache) {
        const cachedDiscovery = cache.get({
          provider: 'CNBC', targetSessionDate: context.targetSessionDate
        });
        if (cachedDiscovery) {
          const cached = await constructFromDiscovery(context, cachedDiscovery, false);
          if (cached.result.ok === true && cached.result.type === 'SUCCESS') {
            emitCache('VALIDATED_HIT');
            return cached.result;
          }
          if (cached.identityValid) return cached.result;
          cache.delete({provider: 'CNBC', targetSessionDate: context.targetSessionDate});
          emitCache('EVICTED_AFTER_VALIDATION_FAILURE');
          emitCache('FALLBACK_DISCOVERY');
        } else {
          emitCache('MISS');
          emitCache('FALLBACK_DISCOVERY');
        }
      }
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
      const completed = await constructFromDiscovery(context, discoveryResult, true);
      if (completed.result.ok === true && completed.result.type === 'SUCCESS' && cache) {
        cache.set({
          provider: 'CNBC', targetSessionDate: context.targetSessionDate,
          discovery: discoveryResult
        });
      }
      return completed.result;
    }
  });
}

module.exports = {
  CNBC_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcRecapResearchRuntime
};

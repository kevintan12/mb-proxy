const {
  buildClaudeBoundedNewsDiscoveryRequest,
  createClaudeBoundedNewsDiscoveryService
} = require('./claude-bounded-news-discovery');
const {
  createYahooRecapSessionValidationService
} = require('./yahoo-recap-session-validation');

const YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS = Object.freeze({
  sessionValidationBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1258291,
    maxHeadlineBytes: 512
  })
});
const DISCOVERY_FAILURE_TYPES = new Set([
  'INPUT_FAILURE',
  'REQUEST_TOO_LARGE',
  'UPSTREAM_FAILURE',
  'SEARCH_TOOL_FAILURE',
  'CONTRACT_FAILURE'
]);
const SESSION_VALIDATION_FAILURE_TYPES = new Set([
  'INVALID_INPUT',
  'TIMEOUT',
  'RETRIEVAL_FAILURE',
  'HTTP_FAILURE',
  'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE'
]);
const YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS = 3;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function failure(type, failureType, message) {
  return deepFreeze({ok: false, type, failureType, message});
}

function safeFailureType(value, allowed) {
  return allowed.has(value) ? value : 'UNKNOWN_FAILURE';
}

function emitDiagnostics(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try {
    onDiagnostics(deepFreeze(value));
  } catch (error) {
    // Observability must not alter research behavior.
  }
}

function candidateValidationDiagnostics(candidate, outcome, failureType = null) {
  const url = new URL(candidate.discovery.url);
  return {
    stage: 'yahooRecapSessionCandidateValidation',
    rank: candidate.rank,
    normalizedYahooUrl: url.href,
    path: url.pathname,
    outcome,
    failureType
  };
}

function createYahooRecapResearchRuntime({
  apiKey,
  fetchImpl = global.fetch,
  onDiagnostics,
  monotonicNow
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const timing = monotonicNow ? {monotonicNow} : {};
  const discovery = createClaudeBoundedNewsDiscoveryService({
    apiKey,
    fetchImpl,
    onDiagnostics,
    ...timing
  });
  const sessionValidation = createYahooRecapSessionValidationService({
    fetchImpl,
    onDiagnostics,
    ...timing
  });

  return deepFreeze({
    async discoverAndValidateRecap(input) {
      try {
        buildClaudeBoundedNewsDiscoveryRequest(input);
      } catch (error) {
        return failure('INPUT_FAILURE', 'INPUT_FAILURE', 'Invalid Yahoo recap research request');
      }
      const context = deepFreeze({targetSessionDate: input.targetSessionDate});
      const discovered = await discovery.discoverYahooCompletedSessionRecap(context);
      if (!discovered || discovered.ok !== true) {
        return failure(
          'DISCOVERY_FAILURE',
          safeFailureType(discovered?.type, DISCOVERY_FAILURE_TYPES),
          'Yahoo recap discovery failed'
        );
      }
      if (discovered.type === 'NOT_FOUND') {
        return deepFreeze({ok: true, type: 'NOT_FOUND', discovery: null, validation: null});
      }
      if (discovered.type !== 'SUCCESS' || !Array.isArray(discovered.candidates)
          || discovered.candidates.length === 0) {
        return failure('DISCOVERY_FAILURE', 'UNKNOWN_FAILURE', 'Yahoo recap discovery failed');
      }

      const candidates = discovered.candidates.slice(
        0,
        YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS
      );
      for (const candidate of candidates) {
        const validated = await sessionValidation.validateYahooRecapSession({
          discovery: candidate.discovery,
          targetSessionDate: context.targetSessionDate,
          bounds: YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS.sessionValidationBounds
        });
        if (!validated || validated.ok !== true) {
          const failureType = safeFailureType(validated?.type, SESSION_VALIDATION_FAILURE_TYPES);
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'FAILURE', failureType)
          );
          return failure(
            'SESSION_VALIDATION_FAILURE',
            failureType,
            'Yahoo recap session validation failed'
          );
        }
        if (validated.type === 'NOT_VALIDATED') {
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'NOT_VALIDATED')
          );
          continue;
        }
        if (validated.type !== 'VALIDATED' || !validated.validation) {
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'FAILURE', 'UNKNOWN_FAILURE')
          );
          return failure(
            'SESSION_VALIDATION_FAILURE',
            'UNKNOWN_FAILURE',
            'Yahoo recap session validation failed'
          );
        }
        emitDiagnostics(onDiagnostics, candidateValidationDiagnostics(candidate, 'VALIDATED'));
        return deepFreeze({
          ok: true,
          type: 'VALIDATED',
          discovery: candidate.discovery,
          validation: validated.validation
        });
      }
      return deepFreeze({
        ok: true,
        type: 'NOT_VALIDATED',
        discovery: null,
        validation: null
      });
    }
  });
}

module.exports = {
  YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS,
  createYahooRecapResearchRuntime
};

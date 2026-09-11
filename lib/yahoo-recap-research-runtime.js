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
      if (discovered.type !== 'SUCCESS' || !discovered.discovery) {
        return failure('DISCOVERY_FAILURE', 'UNKNOWN_FAILURE', 'Yahoo recap discovery failed');
      }

      const validated = await sessionValidation.validateYahooRecapSession({
        discovery: discovered.discovery,
        targetSessionDate: context.targetSessionDate,
        bounds: YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS.sessionValidationBounds
      });
      if (!validated || validated.ok !== true) {
        return failure(
          'SESSION_VALIDATION_FAILURE',
          safeFailureType(validated?.type, SESSION_VALIDATION_FAILURE_TYPES),
          'Yahoo recap session validation failed'
        );
      }
      if (validated.type === 'NOT_VALIDATED') {
        return deepFreeze({
          ok: true,
          type: 'NOT_VALIDATED',
          discovery: discovered.discovery,
          validation: null
        });
      }
      if (validated.type !== 'VALIDATED' || !validated.validation) {
        return failure(
          'SESSION_VALIDATION_FAILURE',
          'UNKNOWN_FAILURE',
          'Yahoo recap session validation failed'
        );
      }
      return deepFreeze({
        ok: true,
        type: 'VALIDATED',
        discovery: discovered.discovery,
        validation: validated.validation
      });
    }
  });
}

module.exports = {
  YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  createYahooRecapResearchRuntime
};

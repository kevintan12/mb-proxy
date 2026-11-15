const {
  buildClaudeBoundedNewsDiscoveryRequest,
  createClaudeBoundedNewsDiscoveryService
} = require('./claude-bounded-news-discovery');
const {
  createYahooRecapSessionValidationService
} = require('./yahoo-recap-session-validation');
const {
  YAHOO_RECAP_MAX_CANDIDATES,
  isOldStyleRecapAddress,
  orderRecapCandidates
} = require('./yahoo-recap-acceptance');
const {downloadWithRetries} = require('./reading-window');

const YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS = Object.freeze({
  sessionValidationBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1572864,
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
const YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS = YAHOO_RECAP_MAX_CANDIDATES;
// Same per-event size limit as the Yahoo news candidate audit.
const YAHOO_RECAP_AUDIT_MAX_EVENT_BYTES = 3400;
const YAHOO_RECAP_AUDIT_MAX_SLUG_CHARACTERS = 48;

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

// Step 9F.1g: each checked candidate also records its address style, download
// attempts and, when it is not the recap, why.
function candidateValidationDiagnostics(candidate, outcome, failureType = null, details = {}) {
  const url = new URL(candidate.discovery.url);
  return {
    stage: 'yahooRecapSessionCandidateValidation',
    rank: candidate.rank,
    normalizedYahooUrl: url.href,
    path: url.pathname,
    outcome,
    failureType,
    oldAddressStyle: isOldStyleRecapAddress(url.href),
    attempts: details.attempts ?? null,
    rejectionReason: details.rejectionReason ?? null
  };
}

function auditSlug(value) {
  try {
    const slug = new URL(value).pathname.split('/').filter(Boolean).at(-1) || '';
    return Array.from(slug).slice(0, YAHOO_RECAP_AUDIT_MAX_SLUG_CHARACTERS).join('');
  } catch (error) {
    return '';
  }
}

// One event per recap search: which candidate was chosen and why each other one
// was not. At most three entries; entries that would exceed the event size are
// left out and counted.
function recapCandidateAuditEvent(entries, chosenRank) {
  const event = {
    stage: 'yahooRecapCandidateAudit',
    chosenRank,
    chosenSlug: entries.find(entry => entry.rank === chosenRank)?.slug ?? null,
    omittedEntryCount: 0,
    candidates: []
  };
  const reservedBytes = Buffer.byteLength(JSON.stringify({...event, generationId: '0'.repeat(36)}), 'utf8');
  let bytes = reservedBytes;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (bytes + entryBytes > YAHOO_RECAP_AUDIT_MAX_EVENT_BYTES) {
      event.omittedEntryCount++;
      continue;
    }
    event.candidates.push(entry);
    bytes += entryBytes;
  }
  return event;
}

function createYahooRecapResearchRuntime({
  apiKey,
  fetchImpl = global.fetch,
  onDiagnostics,
  monotonicNow,
  completedSessionRecapDiscoveryCache
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

  const cache = completedSessionRecapDiscoveryCache
    && typeof completedSessionRecapDiscoveryCache.get === 'function'
    && typeof completedSessionRecapDiscoveryCache.set === 'function'
    && typeof completedSessionRecapDiscoveryCache.delete === 'function'
    ? completedSessionRecapDiscoveryCache
    : null;
  const validatedCacheHits = new WeakSet();

  function emitCache(outcome) {
    emitDiagnostics(onDiagnostics, {
      stage: 'completedSessionRecapDiscoveryCache',
      provider: 'YAHOO',
      outcome
    });
  }

  return deepFreeze({
    isValidatedCacheHit(result) {
      return Boolean(result && typeof result === 'object' && validatedCacheHits.has(result));
    },
    evictValidatedCacheHit(result) {
      if (!cache || !result || typeof result !== 'object' || !validatedCacheHits.has(result)) {
        return false;
      }
      validatedCacheHits.delete(result);
      const deleted = cache.delete({
        provider: 'YAHOO', targetSessionDate: result.discovery?.targetSessionDate
      });
      if (deleted) emitCache('EVICTED_AFTER_VALIDATION_FAILURE');
      return deleted;
    },
    rememberValidatedDiscovery({targetSessionDate, discovery} = {}) {
      return cache ? cache.set({provider: 'YAHOO', targetSessionDate, discovery}) : false;
    },
    // Step 9F.1g: `budget` is the recap's reading budget and `sleep` the retry
    // pause (both optional; without a budget only the 3-attempt cap applies).
    async discoverAndValidateRecap(input, {budget = null, sleep} = {}) {
      try {
        buildClaudeBoundedNewsDiscoveryRequest(input);
      } catch (error) {
        return failure('INPUT_FAILURE', 'INPUT_FAILURE', 'Invalid Yahoo recap research request');
      }
      const context = deepFreeze({targetSessionDate: input.targetSessionDate});
      const validate = candidateDiscovery => downloadWithRetries(
        () => sessionValidation.validateYahooRecapSession({
          discovery: candidateDiscovery,
          targetSessionDate: context.targetSessionDate,
          bounds: YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS.sessionValidationBounds
        }),
        {budget, ...(sleep ? {sleep} : {})}
      );
      if (cache) {
        const cachedDiscovery = cache.get({
          provider: 'YAHOO', targetSessionDate: context.targetSessionDate
        });
        if (cachedDiscovery) {
          const download = await validate(cachedDiscovery);
          const validated = download.error ? null : download.result;
          if (validated?.ok === true && validated.type === 'VALIDATED'
              && validated.validation) {
            emitCache('VALIDATED_HIT');
            const result = deepFreeze({
              ok: true,
              type: 'VALIDATED',
              discovery: cachedDiscovery,
              validation: validated.validation
            });
            validatedCacheHits.add(result);
            return result;
          }
          cache.delete({provider: 'YAHOO', targetSessionDate: context.targetSessionDate});
          emitCache('EVICTED_AFTER_VALIDATION_FAILURE');
          emitCache('FALLBACK_DISCOVERY');
        } else {
          emitCache('MISS');
          emitCache('FALLBACK_DISCOVERY');
        }
      }
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

      // Step 9F.1g: old-style addresses first in their search order, then the
      // others, at most three checked. Every discovered candidate gets an audit
      // entry saying why it was or was not chosen.
      const candidates = orderRecapCandidates(discovered.candidates);
      const auditEntries = discovered.candidates.map(candidate => ({
        rank: candidate.rank,
        slug: auditSlug(candidate.discovery.url),
        oldAddressStyle: isOldStyleRecapAddress(candidate.discovery.url),
        attempts: 0,
        decision: candidates.includes(candidate) ? null : 'NOT_CHECKED_CANDIDATE_LIMIT',
        reason: null
      }));
      const auditFor = candidate => auditEntries[discovered.candidates.indexOf(candidate)];
      const finishAudit = (chosenRank, untriedDecision) => {
        for (const entry of auditEntries) {
          if (entry.decision === null) entry.decision = untriedDecision;
        }
        emitDiagnostics(onDiagnostics, recapCandidateAuditEvent(auditEntries, chosenRank));
      };
      for (const [index, candidate] of candidates.entries()) {
        const audit = auditFor(candidate);
        if (index > 0 && budget && budget.spent()) {
          finishAudit(null, 'SKIPPED_READING_BUDGET');
          return deepFreeze({ok: true, type: 'NOT_VALIDATED', discovery: null, validation: null});
        }
        const download = await validate(candidate.discovery);
        audit.attempts = download.attempts;
        if (download.error) {
          audit.decision = 'DOWNLOAD_FAILED';
          audit.reason = 'EXCEPTION';
          finishAudit(null, 'NOT_CHECKED_AFTER_FAILURE');
          throw download.error;
        }
        const validated = download.result;
        if (!validated || validated.ok !== true) {
          const failureType = safeFailureType(validated?.type, SESSION_VALIDATION_FAILURE_TYPES);
          audit.decision = 'DOWNLOAD_FAILED';
          audit.reason = typeof validated?.reason === 'string' ? validated.reason : failureType;
          if (download.budgetStopped) audit.retriesStoppedByBudget = true;
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'FAILURE', failureType, {
              attempts: download.attempts,
              rejectionReason: typeof validated?.reason === 'string' ? validated.reason : null
            })
          );
          finishAudit(null, 'NOT_CHECKED_AFTER_FAILURE');
          return failure(
            'SESSION_VALIDATION_FAILURE',
            failureType,
            'Yahoo recap session validation failed'
          );
        }
        if (validated.type === 'NOT_VALIDATED') {
          audit.decision = 'NOT_THE_RECAP';
          audit.reason = typeof validated.reason === 'string' ? validated.reason : null;
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'NOT_VALIDATED', null, {
              attempts: download.attempts,
              rejectionReason: audit.reason
            })
          );
          continue;
        }
        if (validated.type !== 'VALIDATED' || !validated.validation) {
          audit.decision = 'DOWNLOAD_FAILED';
          audit.reason = 'UNKNOWN_FAILURE';
          emitDiagnostics(
            onDiagnostics,
            candidateValidationDiagnostics(candidate, 'FAILURE', 'UNKNOWN_FAILURE', {
              attempts: download.attempts
            })
          );
          finishAudit(null, 'NOT_CHECKED_AFTER_FAILURE');
          return failure(
            'SESSION_VALIDATION_FAILURE',
            'UNKNOWN_FAILURE',
            'Yahoo recap session validation failed'
          );
        }
        audit.decision = 'CHOSEN';
        emitDiagnostics(onDiagnostics, candidateValidationDiagnostics(candidate, 'VALIDATED', null, {
          attempts: download.attempts
        }));
        finishAudit(candidate.rank, 'NOT_CHECKED_RECAP_ALREADY_CHOSEN');
        return deepFreeze({
          ok: true,
          type: 'VALIDATED',
          discovery: candidate.discovery,
          validation: validated.validation
        });
      }
      finishAudit(null, 'NOT_CHECKED_CANDIDATE_LIMIT');
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

const {performance} = require('node:perf_hooks');

// Step 8L: one silent retry when the model's answer breaks our own contract.
const CONTRACT_RETRY_MAX_ELAPSED_MS = 150000;
const truncatedFailures = new WeakSet();

// Marks a failure whose response was cut off at the token limit; repeating the
// identical request would be cut off again, so it is never retried.
function markTruncatedFailure(result, envelope) {
  if (envelope && envelope.stop_reason === 'max_tokens'
      && result && typeof result === 'object') {
    truncatedFailures.add(result);
  }
  return result;
}

function isRetryableContractFailure(result) {
  return Boolean(result)
    && result.ok === false
    && result.type === 'CONTRACT_FAILURE'
    && !truncatedFailures.has(result);
}

async function retryOnContractFailure(attempt, {
  call,
  onDiagnostics,
  monotonicNow = () => performance.now(),
  maxElapsedMs = CONTRACT_RETRY_MAX_ELAPSED_MS
} = {}) {
  const started = monotonicNow();
  const first = await attempt();
  if (!isRetryableContractFailure(first)) return first;
  const elapsedMs = Math.round(monotonicNow() - started);
  if (elapsedMs > maxElapsedMs) return first;
  const second = await attempt();
  if (typeof onDiagnostics === 'function') {
    try {
      onDiagnostics(Object.freeze({
        stage: 'contractRetry',
        call,
        attempt: 1,
        firstFailureType: first.type,
        firstFailureMessage: first.message,
        firstAttemptElapsedMs: elapsedMs,
        retryOutcome: second && second.ok === true ? 'SUCCESS' : (second?.type ?? 'UNAVAILABLE')
      }));
    } catch (error) {
      // Observability must not affect analysis behavior.
    }
  }
  return second;
}

module.exports = {
  CONTRACT_RETRY_MAX_ELAPSED_MS,
  markTruncatedFailure,
  retryOnContractFailure
};

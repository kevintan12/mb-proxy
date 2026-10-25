const {performance} = require('node:perf_hooks');
const {modelChoiceEnabled} = require('./model-choice');

// Step 8L: one silent retry when the model's answer breaks our own contract.
const CONTRACT_RETRY_MAX_ELAPSED_MS = 150000;
const truncatedFailures = new WeakSet();
// Step 9AC: a declined request (stop_reason "refusal") is never retried either; its
// whitelisted category is kept for the one log line. Only while modelChoiceEnabled is on.
const refusalFailures = new WeakMap();
const REFUSAL_CATEGORIES = Object.freeze(['cyber', 'bio', 'frontier_llm', 'general_harms', 'reasoning_extraction']);

// Marks a failure whose response was cut off at the token limit; repeating the
// identical request would be cut off again, so it is never retried.
function markTruncatedFailure(result, envelope) {
  if (envelope && envelope.stop_reason === 'max_tokens'
      && result && typeof result === 'object') {
    truncatedFailures.add(result);
  }
  if (envelope && envelope.stop_reason === 'refusal'
      && result && typeof result === 'object' && modelChoiceEnabled(process.env)) {
    const category = envelope.stop_details?.category;
    refusalFailures.set(result, REFUSAL_CATEGORIES.includes(category) ? category : 'other');
  }
  return result;
}

function isRetryableContractFailure(result) {
  return Boolean(result)
    && result.ok === false
    && result.type === 'CONTRACT_FAILURE'
    && !truncatedFailures.has(result)
    && !refusalFailures.has(result);
}

function emitRefusal(onDiagnostics, call, result) {
  if (typeof onDiagnostics !== 'function' || !refusalFailures.has(result)) return;
  try {
    onDiagnostics(Object.freeze({
      stage: 'claudeRefusal', call, stopReason: 'refusal',
      refusalCategory: refusalFailures.get(result), retried: false
    }));
  } catch (error) {
    // Observability must not affect analysis behavior.
  }
}

// Step 9L: `allowRetry` false (the per-run writer call cap is used up) skips the
// retry; `guided` true marks a retry whose request names the broken rule. The
// second attempt receives the first failure; an attempt that ignores its argument
// (the classifier with its guidance off) still repeats the identical request.
// Step 9F.4c: `maxRetries` (default 1, the Step 8L count) allows up to that many
// retries, each only after another retryable contract failure and only while the
// time since the first attempt began is within `maxElapsedMs`. Each retry receives
// the failure just before it and its own number (`retryNumber`, from 1).
async function retryOnContractFailure(attempt, {
  call,
  onDiagnostics,
  monotonicNow = () => performance.now(),
  maxElapsedMs = CONTRACT_RETRY_MAX_ELAPSED_MS,
  allowRetry = true,
  guided = false,
  maxRetries = 1
} = {}) {
  const started = monotonicNow();
  let previous = await attempt();
  for (let retryNumber = 1; retryNumber <= maxRetries; retryNumber++) {
    emitRefusal(onDiagnostics, call, previous);
    if (!isRetryableContractFailure(previous) || !allowRetry) return previous;
    const elapsedMs = Math.round(monotonicNow() - started);
    if (elapsedMs > maxElapsedMs) return previous;
    const next = await attempt({previousFailure: previous, retryNumber});
    if (typeof onDiagnostics === 'function') {
      try {
        onDiagnostics(Object.freeze({
          stage: 'contractRetry',
          call,
          attempt: retryNumber,
          firstFailureType: previous.type,
          firstFailureMessage: previous.message,
          firstAttemptElapsedMs: elapsedMs,
          retryOutcome: next && next.ok === true ? 'SUCCESS' : (next?.type ?? 'UNAVAILABLE'),
          ...(guided ? {guided: true} : {})
        }));
      } catch (error) {
        // Observability must not affect analysis behavior.
      }
    }
    previous = next;
  }
  emitRefusal(onDiagnostics, call, previous);
  return previous;
}

module.exports = {
  CONTRACT_RETRY_MAX_ELAPSED_MS,
  markTruncatedFailure,
  retryOnContractFailure
};

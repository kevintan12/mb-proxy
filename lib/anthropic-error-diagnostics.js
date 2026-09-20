const ALLOWED_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'
]);
const ALLOWED_CODES = new Set([
  'invalid_request', 'model_not_found', 'permission_error', 'rate_limit_error',
  'overloaded_error', 'max_tokens_exceeded'
]);
const MAX_MESSAGE_LENGTH = 160;

function sanitizeMessage(value) {
  if (typeof value !== 'string' || !value) return null;
  let message = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, '[url]');
  message = message.replace(/(sk-ant-[A-Za-z0-9_-]+|api[-_ ]?key\s*[:=]\s*\S+)/gi, '[redacted]');
  message = message.replace(/\s+/g, ' ').trim();
  return message ? message.slice(0, MAX_MESSAGE_LENGTH) : null;
}

async function readAnthropicErrorDiagnostics(response) {
  const result = {upstreamStatus: Number.isInteger(response?.status) ? response.status : null};
  try {
    const envelope = await response?.json?.();
    const error = envelope?.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return result;
    if (ALLOWED_TYPES.has(error.type)) result.upstreamErrorType = error.type;
    if (ALLOWED_CODES.has(error.code)) result.upstreamErrorCode = error.code;
    const message = sanitizeMessage(error.message);
    if (message) result.upstreamErrorMessage = message;
  } catch (ignored) {
    // Diagnostics must never alter the upstream failure path.
  }
  return result;
}

module.exports = {readAnthropicErrorDiagnostics};

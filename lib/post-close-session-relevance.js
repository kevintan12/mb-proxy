const POST_CLOSE_SESSION_RELEVANCE_WINDOW_MS = 2 * 60 * 60 * 1000;

const INPUT_KEYS = Object.freeze([
  'evidenceRef',
  'sessionDate',
  'exchangeTimezone',
  'canonicalCloseAt',
  'publishedAt'
]);
const EVIDENCE_REFERENCE = /^e[1-9][0-9]*$/;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_KEY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? value : null;
}

function timestampMilliseconds(value) {
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
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone;
    return resolved === value ? value : null;
  } catch (error) {
    return null;
  }
}

function exchangeDateKey(timestamp, exchangeTimezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: exchangeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createPostCloseSessionAssociation(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) {
    throw new TypeError('Invalid post-close session association input shape or order');
  }
  if (typeof input.evidenceRef !== 'string' || !EVIDENCE_REFERENCE.test(input.evidenceRef)) {
    throw new TypeError('Invalid canonical evidence reference');
  }
  const sessionDate = canonicalDate(input.sessionDate);
  if (!sessionDate) throw new TypeError('Invalid canonical session date');
  const exchangeTimezone = canonicalTimeZone(input.exchangeTimezone);
  if (!exchangeTimezone) throw new TypeError('Invalid canonical exchange timezone');
  const closeTime = timestampMilliseconds(input.canonicalCloseAt);
  if (closeTime === null) throw new TypeError('Invalid canonical close timestamp');
  const publishedTime = timestampMilliseconds(input.publishedAt);
  if (publishedTime === null) throw new TypeError('Invalid publication timestamp');
  if (exchangeDateKey(closeTime, exchangeTimezone) !== sessionDate) {
    throw new TypeError('Canonical close does not match the session date');
  }
  if (publishedTime <= closeTime
      || publishedTime > closeTime + POST_CLOSE_SESSION_RELEVANCE_WINDOW_MS) return null;
  return Object.freeze({evidenceRef: input.evidenceRef, sessionDate});
}

module.exports = {
  POST_CLOSE_SESSION_RELEVANCE_WINDOW_MS,
  createPostCloseSessionAssociation
};

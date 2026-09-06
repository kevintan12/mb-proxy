const { MARKETS, getSourceById } = require('./evidence-sources');

const MARKET_TIME_ZONES = Object.freeze({
  US: 'America/New_York',
  SG: 'Asia/Singapore',
  HK: 'Asia/Hong_Kong'
});

const COMPLETED_SESSION_TELEMETRY_KEYS = Object.freeze([
  'market',
  'symbol',
  'sessionDate',
  'close',
  'closeTime',
  'sourceId',
  'provenance'
]);

const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalSessionDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day) ? value : null;
}

function canonicalCloseTime(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_8601_TIMESTAMP.exec(value);
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

  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? new Date(epochMilliseconds).toISOString() : null;
}

function exchangeDateKey(utcTimestamp, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      era: 'short'
    }).formatToParts(new Date(utcTimestamp));
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    const eraYear = Number(values.year);
    const astronomicalYear = /^B/i.test(values.era || '') ? 1 - eraYear : eraYear;
    if (!Number.isInteger(astronomicalYear) || astronomicalYear < 0 || astronomicalYear > 9999) return null;
    return `${String(astronomicalYear).padStart(4, '0')}-${values.month}-${values.day}`;
  } catch (error) {
    return null;
  }
}

function normalizeInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['completed-session telemetry input must be an object'], values: null };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'provenance')) {
    errors.push('provenance is derived and must not be supplied');
  }

  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  if (!MARKETS.includes(market)) errors.push('invalid market');

  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!symbol) errors.push('symbol is required');

  const sessionDate = canonicalSessionDate(input.sessionDate);
  if (!sessionDate) errors.push('sessionDate must be a valid YYYY-MM-DD date');

  const close = input.close;
  if (!Number.isFinite(close) || close <= 0) errors.push('close must be a positive finite number');

  const closeTime = canonicalCloseTime(input.closeTime);
  if (!closeTime) errors.push('closeTime must be a valid ISO-8601 timestamp with timezone');
  else if (sessionDate && MARKET_TIME_ZONES[market]
      && exchangeDateKey(closeTime, MARKET_TIME_ZONES[market]) !== sessionDate) {
    errors.push('sessionDate does not match closeTime exchange-local date');
  }

  const source = getSourceById(input.sourceId);
  if (!source) errors.push('unknown sourceId');
  else if (MARKETS.includes(market) && source.market !== market) errors.push('source does not support market');

  return {
    errors,
    values: source ? { market, symbol, sessionDate, close, closeTime, source } : null
  };
}

function validateCompletedSessionTelemetryInput(input) {
  const { errors } = normalizeInput(input);
  return deepFreeze({ valid: errors.length === 0, errors: errors.slice() });
}

function createCompletedSessionTelemetry(input) {
  const { errors, values } = normalizeInput(input);
  if (errors.length) throw new TypeError(`Invalid completed-session telemetry: ${errors.join('; ')}`);

  return deepFreeze({
    market: values.market,
    symbol: values.symbol,
    sessionDate: values.sessionDate,
    close: values.close,
    closeTime: values.closeTime,
    sourceId: values.source.id,
    provenance: {
      publisher: values.source.provenance.publisher,
      authority: values.source.provenance.authority,
      homepage: values.source.provenance.homepage,
      applicableMarket: values.source.provenance.applicableMarket,
      sourceJurisdiction: values.source.provenance.sourceJurisdiction,
      locator: values.source.provenance.locator
    }
  });
}

module.exports = {
  MARKET_TIME_ZONES,
  COMPLETED_SESSION_TELEMETRY_KEYS,
  createCompletedSessionTelemetry,
  validateCompletedSessionTelemetryInput
};

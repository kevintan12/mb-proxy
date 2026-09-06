const {MARKETS, getSourceById} = require('./evidence-sources');
const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');

const COMPLETENESS_VALUES = Object.freeze(['COMPLETE', 'PARTIAL', 'UNAVAILABLE']);
const COMPLETED_REGULAR_SESSION_KEYS = Object.freeze([
  'sessionDate',
  'open',
  'high',
  'low',
  'close',
  'previousClose',
  'absoluteChange',
  'percentChange',
  'volume',
  'asOf',
  'sourceId',
  'provenance',
  'validationState'
]);
const CURRENT_SESSION_OVERLAY_KEYS = Object.freeze([
  'marketState',
  'sessionDate',
  'asOf',
  'lastPrice',
  'referenceClose',
  'absoluteChange',
  'percentChange',
  'volume',
  'isFinal',
  'sourceId',
  'provenance',
  'validationState'
]);
const THREE_SESSION_SNAPSHOT_KEYS = Object.freeze([
  'market',
  'symbol',
  'instrumentName',
  'instrumentType',
  'currency',
  'exchangeTimezone',
  'marketState',
  'primaryCompletedSessionDate',
  'completeness',
  'completedSessions',
  'currentOverlay'
]);
const PROVENANCE_KEYS = Object.freeze([
  'publisher',
  'authority',
  'homepage',
  'applicableMarket',
  'sourceJurisdiction',
  'locator'
]);
const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

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
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) ? value : null;
}

function canonicalTimestamp(value) {
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
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function exchangeDateKey(timestamp, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      era: 'short'
    }).formatToParts(new Date(timestamp));
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

function canonicalNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const canonical = value.trim();
  return canonical || null;
}

function canonicalMarket(value) {
  const market = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return MARKETS.includes(market) ? market : null;
}

function canonicalSymbol(value) {
  if (typeof value !== 'string') return null;
  const symbol = value.trim().toUpperCase();
  return symbol || null;
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function canonicalVolume(value) {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value === 0 ? 0 : value;
}

function sourceForMarket(sourceId, market) {
  const source = getSourceById(sourceId);
  return source && source.market === market ? source : null;
}

function copyProvenance(source) {
  return {
    publisher: source.provenance.publisher,
    authority: source.provenance.authority,
    homepage: source.provenance.homepage,
    applicableMarket: source.provenance.applicableMarket,
    sourceJurisdiction: source.provenance.sourceJurisdiction,
    locator: source.provenance.locator
  };
}

function rejectDerivedInput(input, fields, errors) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      errors.push(`${field} is derived and must not be supplied`);
    }
  }
}

function normalizeCompletedRegularSession(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {errors: ['completed regular session input must be an object'], values: null};
  }
  rejectDerivedInput(input, ['absoluteChange', 'percentChange', 'provenance'], errors);

  const market = canonicalMarket(input.market);
  if (!market) errors.push('invalid market');
  const sessionDate = canonicalSessionDate(input.sessionDate);
  if (!sessionDate) errors.push('invalid sessionDate');

  for (const field of ['open', 'high', 'low', 'close', 'previousClose']) {
    if (!positiveFinite(input[field])) errors.push(`${field} must be a positive finite number`);
  }
  if (positiveFinite(input.high) && positiveFinite(input.low) && input.high < input.low) {
    errors.push('high must not be below low');
  }
  if (positiveFinite(input.open) && positiveFinite(input.high) && positiveFinite(input.low)
      && (input.open > input.high || input.open < input.low)) errors.push('open must be within low and high');
  if (positiveFinite(input.close) && positiveFinite(input.high) && positiveFinite(input.low)
      && (input.close > input.high || input.close < input.low)) errors.push('close must be within low and high');

  const volume = canonicalVolume(input.volume);
  if (volume === undefined) errors.push('volume must be null or a non-negative finite number');
  const asOf = canonicalTimestamp(input.asOf);
  if (!asOf) errors.push('asOf must be a valid ISO-8601 timestamp with timezone');
  else if (market && sessionDate
      && exchangeDateKey(asOf, MARKET_TIME_ZONES[market]) !== sessionDate) {
    errors.push('sessionDate does not match asOf exchange-local date');
  }
  const source = market ? sourceForMarket(input.sourceId, market) : null;
  if (!getSourceById(input.sourceId)) errors.push('unknown sourceId');
  else if (!source) errors.push('source does not support market');
  const validationState = canonicalNonEmptyString(input.validationState);
  if (!validationState) errors.push('validationState must be a non-empty string');

  return {
    errors,
    values: errors.length ? null : {
      market,
      sessionDate,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      previousClose: input.previousClose,
      volume,
      asOf,
      source,
      validationState
    }
  };
}

function createCompletedRegularSession(input) {
  const {errors, values} = normalizeCompletedRegularSession(input);
  if (errors.length) throw new TypeError(`Invalid completed regular session: ${errors.join('; ')}`);
  const absoluteChange = values.close - values.previousClose;
  return deepFreeze({
    sessionDate: values.sessionDate,
    open: values.open,
    high: values.high,
    low: values.low,
    close: values.close,
    previousClose: values.previousClose,
    absoluteChange,
    percentChange: absoluteChange / values.previousClose * 100,
    volume: values.volume,
    asOf: values.asOf,
    sourceId: values.source.id,
    provenance: copyProvenance(values.source),
    validationState: values.validationState
  });
}

function validateCompletedRegularSession(record, market) {
  const errors = [];
  if (!hasExactKeys(record, COMPLETED_REGULAR_SESSION_KEYS)) {
    return deepFreeze({valid: false, errors: ['invalid canonical property shape or order']});
  }
  let expected;
  try {
    expected = createCompletedRegularSession({
      market,
      sessionDate: record.sessionDate,
      open: record.open,
      high: record.high,
      low: record.low,
      close: record.close,
      previousClose: record.previousClose,
      volume: record.volume,
      asOf: record.asOf,
      sourceId: record.sourceId,
      validationState: record.validationState
    });
  } catch (error) {
    return deepFreeze({valid: false, errors: ['invalid canonical field values']});
  }
  for (const key of COMPLETED_REGULAR_SESSION_KEYS) {
    if (key === 'provenance') {
      if (!hasExactKeys(record.provenance, PROVENANCE_KEYS)
          || !PROVENANCE_KEYS.every(field => record.provenance[field] === expected.provenance[field])) {
        errors.push('altered or spoofed provenance');
      }
    } else if (!Object.is(record[key], expected[key])) {
      errors.push(`non-canonical ${key}`);
    }
  }
  return deepFreeze({valid: errors.length === 0, errors});
}

function normalizeCurrentSessionOverlay(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {errors: ['current session overlay input must be an object'], values: null};
  }
  rejectDerivedInput(input, ['absoluteChange', 'percentChange', 'isFinal', 'provenance'], errors);
  const market = canonicalMarket(input.market);
  if (!market) errors.push('invalid market');
  const marketState = canonicalNonEmptyString(input.marketState);
  if (!marketState) errors.push('marketState must be a non-empty string');
  const sessionDate = canonicalSessionDate(input.sessionDate);
  if (!sessionDate) errors.push('invalid sessionDate');
  const asOf = canonicalTimestamp(input.asOf);
  if (!asOf) errors.push('asOf must be a valid ISO-8601 timestamp with timezone');
  else if (market && sessionDate
      && exchangeDateKey(asOf, MARKET_TIME_ZONES[market]) !== sessionDate) {
    errors.push('sessionDate does not match asOf exchange-local date');
  }
  if (!positiveFinite(input.lastPrice)) errors.push('lastPrice must be a positive finite number');
  if (!positiveFinite(input.referenceClose)) errors.push('referenceClose must be a positive finite number');
  const volume = canonicalVolume(input.volume);
  if (volume === undefined) errors.push('volume must be null or a non-negative finite number');
  const source = market ? sourceForMarket(input.sourceId, market) : null;
  if (!getSourceById(input.sourceId)) errors.push('unknown sourceId');
  else if (!source) errors.push('source does not support market');
  const validationState = canonicalNonEmptyString(input.validationState);
  if (!validationState) errors.push('validationState must be a non-empty string');
  return {
    errors,
    values: errors.length ? null : {
      market,
      marketState,
      sessionDate,
      asOf,
      lastPrice: input.lastPrice,
      referenceClose: input.referenceClose,
      volume,
      source,
      validationState
    }
  };
}

function createCurrentSessionOverlay(input) {
  const {errors, values} = normalizeCurrentSessionOverlay(input);
  if (errors.length) throw new TypeError(`Invalid current session overlay: ${errors.join('; ')}`);
  const absoluteChange = values.lastPrice - values.referenceClose;
  return deepFreeze({
    marketState: values.marketState,
    sessionDate: values.sessionDate,
    asOf: values.asOf,
    lastPrice: values.lastPrice,
    referenceClose: values.referenceClose,
    absoluteChange,
    percentChange: absoluteChange / values.referenceClose * 100,
    volume: values.volume,
    isFinal: false,
    sourceId: values.source.id,
    provenance: copyProvenance(values.source),
    validationState: values.validationState
  });
}

function validateCurrentSessionOverlay(record, market) {
  if (!hasExactKeys(record, CURRENT_SESSION_OVERLAY_KEYS)) {
    return deepFreeze({valid: false, errors: ['invalid canonical property shape or order']});
  }
  let expected;
  try {
    expected = createCurrentSessionOverlay({
      market,
      marketState: record.marketState,
      sessionDate: record.sessionDate,
      asOf: record.asOf,
      lastPrice: record.lastPrice,
      referenceClose: record.referenceClose,
      volume: record.volume,
      sourceId: record.sourceId,
      validationState: record.validationState
    });
  } catch (error) {
    return deepFreeze({valid: false, errors: ['invalid canonical field values']});
  }
  const errors = [];
  for (const key of CURRENT_SESSION_OVERLAY_KEYS) {
    if (key === 'provenance') {
      if (!hasExactKeys(record.provenance, PROVENANCE_KEYS)
          || !PROVENANCE_KEYS.every(field => record.provenance[field] === expected.provenance[field])) {
        errors.push('altered or spoofed provenance');
      }
    } else if (!Object.is(record[key], expected[key])) errors.push(`non-canonical ${key}`);
  }
  return deepFreeze({valid: errors.length === 0, errors});
}

function createThreeSessionSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid three-session snapshot: input must be an object');
  }
  const forbidden = ['exchangeTimezone', 'primaryCompletedSessionDate', 'completeness'];
  for (const field of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new TypeError(`Invalid three-session snapshot: ${field} is derived and must not be supplied`);
    }
  }
  const market = canonicalMarket(input.market);
  const symbol = canonicalSymbol(input.symbol);
  const instrumentName = canonicalNonEmptyString(input.instrumentName);
  const instrumentType = canonicalNonEmptyString(input.instrumentType);
  const currency = input.currency === null ? null : canonicalNonEmptyString(input.currency);
  const marketState = canonicalNonEmptyString(input.marketState);
  if (!market || !symbol || !instrumentName || !instrumentType
      || (input.currency !== null && !currency) || !marketState) {
    throw new TypeError('Invalid three-session snapshot: invalid identity or market state');
  }
  if (!Array.isArray(input.completedSessions) || input.completedSessions.length > 3) {
    throw new TypeError('Invalid three-session snapshot: completedSessions must contain zero to three sessions');
  }
  const completedSessions = input.completedSessions.map(record => {
    const validation = validateCompletedRegularSession(record, market);
    if (!validation.valid) throw new TypeError('Invalid three-session snapshot: invalid completed session');
    return createCompletedRegularSession({
      market,
      sessionDate: record.sessionDate,
      open: record.open,
      high: record.high,
      low: record.low,
      close: record.close,
      previousClose: record.previousClose,
      volume: record.volume,
      asOf: record.asOf,
      sourceId: record.sourceId,
      validationState: record.validationState
    });
  });
  for (let index = 1; index < completedSessions.length; index += 1) {
    if (completedSessions[index - 1].sessionDate >= completedSessions[index].sessionDate) {
      throw new TypeError('Invalid three-session snapshot: completed sessions must be oldest to newest');
    }
    if (completedSessions[index].previousClose !== completedSessions[index - 1].close) {
      throw new TypeError('Invalid three-session snapshot: completed session previousClose chain is inconsistent');
    }
  }

  let currentOverlay = null;
  if (input.currentOverlay !== null) {
    const validation = validateCurrentSessionOverlay(input.currentOverlay, market);
    if (!validation.valid || input.currentOverlay.marketState !== marketState) {
      throw new TypeError('Invalid three-session snapshot: invalid current overlay');
    }
    if (completedSessions.length
        && input.currentOverlay.referenceClose !== completedSessions[completedSessions.length - 1].close) {
      throw new TypeError('Invalid three-session snapshot: current overlay referenceClose must match latest completed close');
    }
    if (completedSessions.length
        && input.currentOverlay.sessionDate < completedSessions[completedSessions.length - 1].sessionDate) {
      throw new TypeError('Invalid three-session snapshot: current overlay cannot predate latest completed session');
    }
    currentOverlay = createCurrentSessionOverlay({
      market,
      marketState: input.currentOverlay.marketState,
      sessionDate: input.currentOverlay.sessionDate,
      asOf: input.currentOverlay.asOf,
      lastPrice: input.currentOverlay.lastPrice,
      referenceClose: input.currentOverlay.referenceClose,
      volume: input.currentOverlay.volume,
      sourceId: input.currentOverlay.sourceId,
      validationState: input.currentOverlay.validationState
    });
  }

  const count = completedSessions.length;
  return deepFreeze({
    market,
    symbol,
    instrumentName,
    instrumentType,
    currency,
    exchangeTimezone: MARKET_TIME_ZONES[market],
    marketState,
    primaryCompletedSessionDate: count ? completedSessions[count - 1].sessionDate : null,
    completeness: count === 3 ? 'COMPLETE' : count ? 'PARTIAL' : 'UNAVAILABLE',
    completedSessions,
    currentOverlay
  });
}

function validateThreeSessionSnapshot(snapshot) {
  if (!hasExactKeys(snapshot, THREE_SESSION_SNAPSHOT_KEYS)) {
    return deepFreeze({valid: false, errors: ['invalid canonical property shape or order']});
  }
  try {
    const expected = createThreeSessionSnapshot({
      market: snapshot.market,
      symbol: snapshot.symbol,
      instrumentName: snapshot.instrumentName,
      instrumentType: snapshot.instrumentType,
      currency: snapshot.currency,
      marketState: snapshot.marketState,
      completedSessions: snapshot.completedSessions,
      currentOverlay: snapshot.currentOverlay
    });
    const equal = JSON.stringify(snapshot) === JSON.stringify(expected);
    return deepFreeze({valid: equal, errors: equal ? [] : ['non-canonical snapshot values']});
  } catch (error) {
    return deepFreeze({valid: false, errors: ['invalid canonical snapshot values']});
  }
}

module.exports = {
  COMPLETENESS_VALUES,
  COMPLETED_REGULAR_SESSION_KEYS,
  CURRENT_SESSION_OVERLAY_KEYS,
  THREE_SESSION_SNAPSHOT_KEYS,
  createCompletedRegularSession,
  validateCompletedRegularSession,
  createCurrentSessionOverlay,
  validateCurrentSessionOverlay,
  createThreeSessionSnapshot,
  validateThreeSessionSnapshot
};

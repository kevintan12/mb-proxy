const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');

const MARKET_SESSION_DEFINITIONS = Object.freeze({
  US: Object.freeze({
    timezone: MARKET_TIME_ZONES.US,
    regularOpen: '09:30',
    regularClose: '16:00',
    sessions: Object.freeze([
      Object.freeze({name: 'PRE', start: '04:00', end: '09:30'}),
      Object.freeze({name: 'REGULAR', start: '09:30', end: '16:00'}),
      Object.freeze({name: 'POST', start: '16:00', end: '20:00'})
    ])
  }),
  SG: Object.freeze({
    timezone: MARKET_TIME_ZONES.SG,
    regularOpen: '09:00',
    regularClose: '17:00',
    sessions: Object.freeze([
      Object.freeze({name: 'REGULAR', start: '09:00', end: '12:00'}),
      Object.freeze({name: 'LUNCH', start: '12:00', end: '13:00'}),
      Object.freeze({name: 'REGULAR', start: '13:00', end: '17:00'})
    ])
  }),
  HK: Object.freeze({
    timezone: MARKET_TIME_ZONES.HK,
    regularOpen: '09:30',
    regularClose: '16:00',
    sessions: Object.freeze([
      Object.freeze({name: 'REGULAR', start: '09:30', end: '12:00'}),
      Object.freeze({name: 'LUNCH', start: '12:00', end: '13:00'}),
      Object.freeze({name: 'REGULAR', start: '13:00', end: '16:00'})
    ])
  })
});

const FULL_DAY_HOLIDAYS = Object.freeze({
  US: Object.freeze({
    2026: Object.freeze([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
      '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'
    ]),
    2027: Object.freeze([
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
      '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
    ])
  }),
  SG: Object.freeze({
    2026: Object.freeze([
      '2026-01-01', '2026-02-17', '2026-02-18', '2026-04-03', '2026-05-01',
      '2026-05-27', '2026-06-01', '2026-08-10', '2026-11-09', '2026-12-25'
    ]),
    2027: Object.freeze([
      '2027-01-01', '2027-02-08', '2027-03-10', '2027-03-26', '2027-05-17',
      '2027-05-20', '2027-08-09', '2027-10-28'
    ])
  }),
  HK: Object.freeze({
    2026: Object.freeze([
      '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03',
      '2026-04-06', '2026-04-07', '2026-05-01', '2026-05-25', '2026-06-19',
      '2026-07-01', '2026-10-01', '2026-10-19', '2026-12-25'
    ]),
    2027: Object.freeze([
      '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-26', '2027-03-29',
      '2027-04-05', '2027-05-13', '2027-06-09', '2027-07-01', '2027-09-16',
      '2027-10-01', '2027-10-08', '2027-12-27'
    ])
  })
});

// These dates are known to use non-standard exchange hours. This checkpoint
// deliberately does not model their shortened sessions, so they remain
// identifiable trading dates but cannot supply a canonical close instant.
const UNSUPPORTED_SPECIAL_SESSION_DATES = Object.freeze({
  US: Object.freeze(['2026-11-27', '2026-12-24', '2027-11-26']),
  SG: Object.freeze(['2026-02-16', '2027-02-05']),
  HK: Object.freeze([
    '2026-02-16', '2026-12-24', '2026-12-31',
    '2027-02-05', '2027-12-24', '2027-12-31'
  ])
});

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function validDateKey(value) {
  const match = DATE_KEY.exec(value || '');
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function formatParts(instant, timezone) {
  const values = {};
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant);
  for (const part of parts) values[part.type] = part.value;
  return {
    date: `${values.year.padStart(4, '0')}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function wallClockInstant(exchangeDate, wallTime, timezone) {
  const dateMatch = DATE_KEY.exec(exchangeDate);
  const [hour, minute] = wallTime.split(':').map(Number);
  const target = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hour, minute);
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration++) {
    const actual = formatParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(
      Number(actual.date.slice(0, 4)), Number(actual.date.slice(5, 7)) - 1,
      Number(actual.date.slice(8, 10)), actual.hour, actual.minute, actual.second
    );
    const adjustment = target - actualAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const verified = formatParts(new Date(candidate), timezone);
  if (verified.date !== exchangeDate || verified.hour !== hour || verified.minute !== minute) return null;
  return new Date(candidate).toISOString();
}

function dateStatus(market, exchangeDate) {
  const definition = MARKET_SESSION_DEFINITIONS[market];
  if (!definition || !validDateKey(exchangeDate)) throw new TypeError('Invalid market or exchange date');
  const year = Number(exchangeDate.slice(0, 4));
  const yearHolidays = FULL_DAY_HOLIDAYS[market][year];
  if (!yearHolidays) {
    return {calendarSupported: false, tradingDay: false, dayType: 'UNSUPPORTED'};
  }
  const weekday = new Date(`${exchangeDate}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return {calendarSupported: true, tradingDay: false, dayType: 'WEEKEND'};
  }
  if (yearHolidays.includes(exchangeDate)) {
    return {calendarSupported: true, tradingDay: false, dayType: 'HOLIDAY'};
  }
  if (UNSUPPORTED_SPECIAL_SESSION_DATES[market].includes(exchangeDate)) {
    return {calendarSupported: false, tradingDay: true, dayType: 'UNSUPPORTED_SPECIAL_SESSION'};
  }
  return {calendarSupported: true, tradingDay: true, dayType: 'TRADING_DAY'};
}

function getSessionContext({market: inputMarket, instant, exchangeDate: inputDate} = {}) {
  const market = typeof inputMarket === 'string' ? inputMarket.trim().toUpperCase() : '';
  const definition = MARKET_SESSION_DEFINITIONS[market];
  if (!definition) throw new TypeError('Invalid market');
  const hasInstant = instant !== undefined;
  const date = hasInstant ? new Date(instant) : null;
  if (hasInstant && !Number.isFinite(date.getTime())) throw new TypeError('Invalid session instant');
  const local = hasInstant ? formatParts(date, definition.timezone) : null;
  const exchangeDate = hasInstant ? local.date : inputDate;
  const status = dateStatus(market, exchangeDate);
  const regularCloseTime = status.calendarSupported && status.tradingDay
    ? wallClockInstant(exchangeDate, definition.regularClose, definition.timezone)
    : null;
  const regularOpenTime = status.calendarSupported && status.tradingDay
    ? wallClockInstant(exchangeDate, definition.regularOpen, definition.timezone)
    : null;
  let session = status.dayType;
  let regularSessionCompleted = false;
  let sessionStartTime = null;
  let sessionEndTime = null;
  if (hasInstant && status.tradingDay) {
    const minuteOfDay = local.hour * 60 + local.minute;
    const active = definition.sessions.find(window =>
      minuteOfDay >= minutes(window.start) && minuteOfDay < minutes(window.end));
    session = active ? active.name : 'CLOSED';
    if (active && status.calendarSupported) {
      sessionStartTime = wallClockInstant(exchangeDate, active.start, definition.timezone);
      sessionEndTime = wallClockInstant(exchangeDate, active.end, definition.timezone);
    }
    regularSessionCompleted = Date.parse(regularCloseTime) <= date.getTime();
  }
  return deepFreeze({
    market,
    exchangeTimezone: definition.timezone,
    exchangeDate,
    calendarSupported: status.calendarSupported,
    tradingDay: status.tradingDay,
    dayType: status.dayType,
    session: hasInstant ? session : null,
    regularSessionCompleted: hasInstant ? regularSessionCompleted : null,
    regularOpenTime,
    sessionStartTime,
    sessionEndTime,
    regularCloseTime
  });
}

module.exports = {
  MARKET_SESSION_DEFINITIONS,
  FULL_DAY_HOLIDAYS,
  UNSUPPORTED_SPECIAL_SESSION_DATES,
  getSessionContext
};

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MARKET_SESSION_DEFINITIONS,
  getSessionContext
} = require('../lib/market-session-calendar');

test('derives regular close instants from exchange IANA timezones, including US DST', () => {
  assert.equal(
    getSessionContext({market: 'US', exchangeDate: '2026-01-08'}).regularCloseTime,
    '2026-01-08T21:00:00.000Z'
  );
  assert.equal(
    getSessionContext({market: 'US', exchangeDate: '2026-09-04'}).regularCloseTime,
    '2026-09-04T20:00:00.000Z'
  );
  assert.equal(
    getSessionContext({market: 'SG', exchangeDate: '2026-09-04'}).regularCloseTime,
    '2026-09-04T09:00:00.000Z'
  );
  assert.equal(
    getSessionContext({market: 'HK', exchangeDate: '2026-09-04'}).regularCloseTime,
    '2026-09-04T08:00:00.000Z'
  );
});

test('classifies standard PRE, REGULAR, LUNCH, POST and CLOSED sessions', () => {
  assert.equal(getSessionContext({market: 'US', instant: '2026-09-04T12:00:00Z'}).session, 'PRE');
  assert.equal(getSessionContext({market: 'US', instant: '2026-09-04T15:00:00Z'}).session, 'REGULAR');
  assert.equal(getSessionContext({market: 'US', instant: '2026-09-04T20:00:00Z'}).session, 'POST');
  assert.equal(getSessionContext({market: 'US', instant: '2026-09-05T00:00:00Z'}).session, 'CLOSED');
  assert.equal(getSessionContext({market: 'SG', instant: '2026-09-04T04:00:00Z'}).session, 'LUNCH');
  assert.equal(getSessionContext({market: 'SG', instant: '2026-09-04T05:00:00Z'}).session, 'REGULAR');
  assert.equal(getSessionContext({market: 'HK', instant: '2026-09-04T04:30:00Z'}).session, 'LUNCH');
  assert.equal(getSessionContext({market: 'HK', instant: '2026-09-04T05:00:00Z'}).session, 'REGULAR');
  const sgLunch = getSessionContext({market: 'SG', instant: '2026-09-04T04:00:00Z'});
  assert.equal(sgLunch.regularOpenTime, '2026-09-04T01:00:00.000Z');
  assert.equal(sgLunch.sessionStartTime, '2026-09-04T04:00:00.000Z');
  assert.equal(sgLunch.sessionEndTime, '2026-09-04T05:00:00.000Z');
});

test('recognizes weekends and supported full-day holidays conservatively', () => {
  const weekend = getSessionContext({market: 'HK', instant: '2026-09-06T04:00:00Z'});
  assert.equal(weekend.dayType, 'WEEKEND');
  assert.equal(weekend.tradingDay, false);
  assert.equal(weekend.regularCloseTime, null);

  assert.equal(
    getSessionContext({market: 'US', instant: '2026-09-07T15:00:00Z'}).dayType,
    'HOLIDAY'
  );
  assert.equal(
    getSessionContext({market: 'SG', instant: '2026-08-10T03:00:00Z'}).dayType,
    'HOLIDAY'
  );
  assert.equal(
    getSessionContext({market: 'HK', instant: '2026-10-01T03:00:00Z'}).dayType,
    'HOLIDAY'
  );
  assert.equal(getSessionContext({market: 'HK', exchangeDate: '2027-05-13'}).dayType, 'HOLIDAY');
  assert.equal(getSessionContext({market: 'HK', exchangeDate: '2027-05-17'}).dayType, 'TRADING_DAY');
});

test('unsupported calendar years fail closed and the helper never uses S.tz', () => {
  const oldS = global.S;
  global.S = {tz: 'Pacific/Honolulu'};
  try {
    const unsupported = getSessionContext({market: 'SG', instant: '2028-09-04T04:00:00Z'});
    assert.equal(unsupported.calendarSupported, false);
    assert.equal(unsupported.session, 'UNSUPPORTED');
    assert.equal(unsupported.regularCloseTime, null);
    assert.equal(MARKET_SESSION_DEFINITIONS.SG.timezone, 'Asia/Singapore');
  } finally {
    if (oldS === undefined) delete global.S;
    else global.S = oldS;
  }
});

test('known early-close and half-day dates are explicitly unsupported, not assumed normal', () => {
  for (const [market, exchangeDate] of [
    ['US', '2026-11-27'],
    ['SG', '2026-02-16'],
    ['HK', '2026-12-24']
  ]) {
    const context = getSessionContext({market, exchangeDate});
    assert.equal(context.dayType, 'UNSUPPORTED_SPECIAL_SESSION');
    assert.equal(context.tradingDay, true);
    assert.equal(context.calendarSupported, false);
    assert.equal(context.regularCloseTime, null);
    assert.equal(context.regularOpenTime, null);
  }
});

test('session results and definitions are immutable', () => {
  const context = getSessionContext({market: 'SG', instant: '2026-09-04T05:00:00Z'});
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(MARKET_SESSION_DEFINITIONS), true);
  assert.equal(Object.isFrozen(MARKET_SESSION_DEFINITIONS.SG.sessions), true);
});

// Step 9S.1 (Kevin, 8 Nov 2026): US half-day sessions on Fri 27 Nov 2026 and Thu 24 Dec 2026, behind
// earlyCloseDaysEnabled (env EARLY_CLOSE_DAYS_ENABLED, default on). Confirmed hours, New York time:
// pre-market from 4:00 a.m., open 9:30 a.m., early close 1:00 p.m., after-hours until 5:00 p.m. Both
// days are in standard time (UTC-5), so 1:00 p.m. is 18:00 UTC and 5:00 p.m. is 22:00 UTC.
// Every case uses fixed clocks and mock data: no network, no paid calls.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {getSessionContext, UNSUPPORTED_SPECIAL_SESSION_DATES, US_EARLY_CLOSE_DAYS} =
  require('../lib/market-session-calendar');
const {readingWindow, readingSettings} = require('../lib/reading-window');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {createUsActiveSessionAnchor, completedSessionCloseAt} = require('../lib/us-active-session-evidence');
const {deterministicCnbcRecapCandidate} = require('../lib/cnbc-deterministic-recap-discovery');
const {createYahooTelemetryAcquisitionService} = require('../lib/yahoo-telemetry-acquisition');
const {validateFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createRuntimeFiveSessionSnapshotRepository} = require('../lib/runtime-five-session-snapshot-repository');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS} = require('../lib/cnbc-news-research-runtime');
const {
  expectedLatestCompletedUsSessionDate,
  createUsAnalysisPackageOrchestrationService
} = require('../lib/us-analysis-package-orchestration');

const ENV = 'EARLY_CLOSE_DAYS_ENABLED';
const HALF_DAYS = ['2026-11-27', '2026-12-24'];

// Runs `operation` with the switch set to `value` ('on'/'off'; undefined = not set, the default).
async function withSwitch(value, operation) {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

// A New York wall time on a standard-time (UTC-5) date in Nov/Dec 2026, as an ISO instant.
function et(date, hhmm) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute)).toISOString();
}

function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The setting and the calendar data

test('Step 9S.1: earlyCloseDaysEnabled is one Admin on/off switch, default on, env EARLY_CLOSE_DAYS_ENABLED', () => {
  const entry = SETTINGS_REGISTRY.earlyCloseDaysEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('earlyCloseDaysEnabled', {env: {}}), true);
  for (const value of ['off', 'false', '0']) assert.equal(settingValue('earlyCloseDaysEnabled', {env: {[ENV]: value}}), false);
  for (const value of ['on', 'true', '1']) assert.equal(settingValue('earlyCloseDaysEnabled', {env: {[ENV]: value}}), true);
});

test('Step 9S.1: the early-close list holds exactly the two confirmed days, and the unsupported list is unchanged', () => {
  assert.deepEqual(Object.keys(US_EARLY_CLOSE_DAYS), HALF_DAYS);
  for (const date of HALF_DAYS) {
    assert.deepEqual({...US_EARLY_CLOSE_DAYS[date]}, {regularClose: '13:00', postEnd: '17:00'});
  }
  assert.deepEqual([...UNSUPPORTED_SPECIAL_SESSION_DATES.US], ['2026-11-27', '2026-12-24', '2027-11-26']);
});

// ---------------------------------------------------------------------------
// The session engine on both days

const BOUNDARIES = [
  ['03:59', 'CLOSED', false], ['04:00', 'PRE', false], ['09:29', 'PRE', false],
  ['09:30', 'REGULAR', false], ['12:59', 'REGULAR', false], ['13:00', 'POST', true],
  ['16:59', 'POST', true], ['17:00', 'CLOSED', true], ['20:00', 'CLOSED', true]
];

for (const date of HALF_DAYS) {
  test(`Step 9S.1: ${date} session at every boundary (4:00 pre, 9:30 open, 1:00 close, 5:00 after-hours end)`, async () => {
    await withSwitch(undefined, () => {
      for (const [time, session, completed] of BOUNDARIES) {
        const context = getSessionContext({market: 'US', instant: et(date, time)});
        const label = `${date} ${time}`;
        assert.equal(context.exchangeDate, date, label);
        assert.equal(context.calendarSupported, true, label);
        assert.equal(context.tradingDay, true, label);
        assert.equal(context.dayType, 'EARLY_CLOSE', label);
        assert.equal(context.session, session, label);
        assert.equal(context.regularSessionCompleted, completed, label);
        assert.equal(context.regularOpenTime, et(date, '09:30'), label);
        assert.equal(context.regularCloseTime, et(date, '13:00'), label);
      }
    });
  });

  test(`Step 9S.1: ${date} session start and end times follow the short day`, async () => {
    await withSwitch(undefined, () => {
      const at = time => getSessionContext({market: 'US', instant: et(date, time)});
      assert.deepEqual([at('05:00').sessionStartTime, at('05:00').sessionEndTime], [et(date, '04:00'), et(date, '09:30')]);
      assert.deepEqual([at('11:00').sessionStartTime, at('11:00').sessionEndTime], [et(date, '09:30'), et(date, '13:00')]);
      assert.deepEqual([at('15:00').sessionStartTime, at('15:00').sessionEndTime], [et(date, '13:00'), et(date, '17:00')]);
      assert.deepEqual([at('18:00').sessionStartTime, at('18:00').sessionEndTime], [null, null]);
      const bare = getSessionContext({market: 'US', exchangeDate: date});
      assert.equal(bare.session, null);
      assert.equal(bare.regularCloseTime, `${date}T18:00:00.000Z`);
    });
  });
}

test('Step 9S.1: 25 Nov and 30 Nov (and 23 and 28 Dec) stay ordinary trading days closing at 4:00 p.m.', async () => {
  await withSwitch(undefined, () => {
    for (const date of ['2026-11-25', '2026-11-30', '2026-12-23', '2026-12-28']) {
      const context = getSessionContext({market: 'US', exchangeDate: date});
      assert.equal(context.dayType, 'TRADING_DAY', date);
      assert.equal(context.regularCloseTime, `${date}T21:00:00.000Z`, date);
      assert.equal(getSessionContext({market: 'US', instant: et(date, '14:00')}).session, 'REGULAR', date);
      assert.equal(getSessionContext({market: 'US', instant: et(date, '16:30')}).session, 'POST', date);
      assert.equal(getSessionContext({market: 'US', instant: et(date, '19:59')}).session, 'POST', date);
      assert.equal(getSessionContext({market: 'US', instant: et(date, '20:00')}).session, 'CLOSED', date);
    }
    assert.equal(getSessionContext({market: 'US', exchangeDate: '2026-11-26'}).dayType, 'HOLIDAY');
    assert.equal(getSessionContext({market: 'US', exchangeDate: '2026-12-25'}).dayType, 'HOLIDAY');
  });
});

test('Step 9S.1: 26 Nov 2027 and the Singapore and Hong Kong half days stay unsupported with the switch on', async () => {
  await withSwitch('on', () => {
    for (const [market, date] of [['US', '2027-11-26'], ['SG', '2026-02-16'], ['SG', '2027-02-05'],
      ['HK', '2026-12-24'], ['HK', '2026-12-31'], ['HK', '2027-12-24']]) {
      const context = getSessionContext({market, exchangeDate: date});
      assert.equal(context.dayType, 'UNSUPPORTED_SPECIAL_SESSION', `${market} ${date}`);
      assert.equal(context.calendarSupported, false, `${market} ${date}`);
      assert.equal(context.regularCloseTime, null, `${market} ${date}`);
    }
  });
});

test('Step 9S.1: switch off gives the old calendar exactly on both days', async () => {
  await withSwitch('off', () => {
    for (const date of HALF_DAYS) {
      const bare = getSessionContext({market: 'US', exchangeDate: date});
      assert.deepEqual({...bare}, {
        market: 'US', exchangeTimezone: 'America/New_York', exchangeDate: date,
        calendarSupported: false, tradingDay: true, dayType: 'UNSUPPORTED_SPECIAL_SESSION',
        session: null, regularSessionCompleted: null, regularOpenTime: null,
        sessionStartTime: null, sessionEndTime: null, regularCloseTime: null
      });
      // The old engine still named the normal windows (the defect this step fixes).
      const afternoon = getSessionContext({market: 'US', instant: et(date, '14:00')});
      assert.equal(afternoon.session, 'REGULAR');
      assert.equal(afternoon.regularSessionCompleted, false);
      assert.equal(getSessionContext({market: 'US', instant: et(date, '18:00')}).session, 'POST');
    }
  });
});

// ---------------------------------------------------------------------------
// The reading window and the active-session anchor (lib/reading-window.js is unchanged)

test('Step 9S.1: the reading window for Pre-market on the next Monday starts before the early close', async () => {
  await withSwitch(undefined, () => {
    const hours = readingSettings({market: 'US'}).readingExtensionHours;
    for (const [trigger, close] of [
      [et('2026-11-30', '08:00'), '2026-11-27T18:00:00.000Z'],
      [et('2026-12-28', '08:00'), '2026-12-24T18:00:00.000Z']
    ]) {
      const window = readingWindow({market: 'US', triggerAt: trigger});
      assert.equal(window.lastClose, close);
      assert.equal(window.startsAt, new Date(Date.parse(close) - hours * 3600000).toISOString());
      assert.equal(window.endsAt, trigger);
    }
  });
});

test('Step 9S.1: the reading window on the half day uses its own early close from 1:00 p.m., the day before until then', async () => {
  await withSwitch(undefined, () => {
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-11-27', '15:00')}).lastClose, '2026-11-27T18:00:00.000Z');
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-11-27', '13:00')}).lastClose, '2026-11-27T18:00:00.000Z');
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-11-27', '12:59')}).lastClose, '2026-11-25T21:00:00.000Z');
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-12-24', '15:00')}).lastClose, '2026-12-24T18:00:00.000Z');
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-12-24', '12:59')}).lastClose, '2026-12-23T21:00:00.000Z');
    assert.equal(readingWindow({market: 'US', triggerAt: et('2026-12-25', '12:00')}).lastClose, '2026-12-24T18:00:00.000Z');
  });
});

test('Step 9S.1: the active-session anchor starts at the early close (After-Hours that day, Pre-market next Monday)', async () => {
  await withSwitch(undefined, () => {
    const post = createUsActiveSessionAnchor({marketState: 'POST', cutoffAt: et('2026-11-27', '15:00')});
    assert.deepEqual([post.sessionDate, post.startsAtInclusive], ['2026-11-27', '2026-11-27T18:00:00.000Z']);
    const pre = createUsActiveSessionAnchor({marketState: 'PRE', cutoffAt: et('2026-11-30', '08:00')});
    assert.deepEqual([pre.sessionDate, pre.startsAtInclusive], ['2026-11-30', '2026-11-27T18:00:00.000Z']);
    const regular = createUsActiveSessionAnchor({marketState: 'REGULAR', cutoffAt: et('2026-12-24', '11:00')});
    assert.deepEqual([regular.sessionDate, regular.startsAtInclusive], ['2026-12-24', '2026-12-23T21:00:00.000Z']);
    // A state the engine does not give at that instant (Trading after the early close) gives no anchor.
    assert.equal(createUsActiveSessionAnchor({marketState: 'REGULAR', cutoffAt: et('2026-12-24', '14:00')}), null);
  });
});

// ---------------------------------------------------------------------------
// The latest completed session, every hour across the days around each half day

const CLOSE_HOUR = {
  '2026-11-24': 16, '2026-11-25': 16, '2026-11-27': 13, '2026-11-30': 16, '2026-12-01': 16,
  '2026-12-22': 16, '2026-12-23': 16, '2026-12-24': 13, '2026-12-28': 16, '2026-12-29': 16
};

// Independent of the program: the date itself once its close has passed, else the trading day before.
function expectedLatest(date, hour) {
  if (CLOSE_HOUR[date] !== undefined && hour >= CLOSE_HOUR[date]) return date;
  let candidate = shiftDate(date, -1);
  while (CLOSE_HOUR[candidate] === undefined) candidate = shiftDate(candidate, -1);
  return candidate;
}

for (const [first, last] of [['2026-11-27', '2026-12-01'], ['2026-12-24', '2026-12-29']]) {
  test(`Step 9S.1: latest completed session at every hour from ${first} to ${last}`, async () => {
    await withSwitch(undefined, () => {
      let checked = 0;
      for (let date = first; date <= last; date = shiftDate(date, 1)) {
        for (let hour = 0; hour < 24; hour++) {
          const instant = et(date, `${String(hour).padStart(2, '0')}:00`);
          assert.equal(expectedLatestCompletedUsSessionDate(instant), expectedLatest(date, hour), instant);
          checked++;
        }
      }
      assert.ok(checked >= 120);
    });
  });
}

test('Step 9S.1: switch off gives the old failure for the latest completed session around the half day', async () => {
  await withSwitch('off', () => {
    for (const instant of [et('2026-11-27', '08:00'), et('2026-11-28', '12:00'), et('2026-11-30', '08:00'),
      et('2026-12-25', '12:00')]) {
      assert.throws(() => expectedLatestCompletedUsSessionDate(instant), /Canonical US exchange calendar is unavailable/);
    }
    assert.equal(expectedLatestCompletedUsSessionDate(et('2026-11-26', '12:00')), '2026-11-25');
  });
});

// ---------------------------------------------------------------------------
// Since-close close and the CNBC recap link

test('Step 9S.1: the since-close close and the CNBC recap link exist for both half days', async () => {
  await withSwitch(undefined, () => {
    assert.equal(completedSessionCloseAt('2026-11-27'), '2026-11-27T18:00:00.000Z');
    assert.equal(completedSessionCloseAt('2026-12-24'), '2026-12-24T18:00:00.000Z');
    assert.equal(completedSessionCloseAt('2027-11-26'), null);
    assert.equal(deterministicCnbcRecapCandidate('2026-11-27').url,
      'https://www.cnbc.com/2026/11/25/stock-market-today-live-updates.html');
    assert.equal(deterministicCnbcRecapCandidate('2026-11-30').url,
      'https://www.cnbc.com/2026/11/27/stock-market-today-live-updates.html');
    assert.equal(deterministicCnbcRecapCandidate('2026-12-24').url,
      'https://www.cnbc.com/2026/12/23/stock-market-today-live-updates.html');
  });
});

// ---------------------------------------------------------------------------
// Mock Yahoo data shaped like a half day

// The trading days (newest first) ending on `latestDate`, from the program's calendar.
function tradingDaysEnding(latestDate, count) {
  const dates = [];
  for (let date = latestDate; dates.length < count; date = shiftDate(date, -1)) {
    if (getSessionContext({market: 'US', exchangeDate: date}).tradingDay) dates.push(date);
  }
  return dates;
}

// Daily rows (one bar per day, stamped at the 9:30 a.m. open) for the trading days ending on
// `latestDate`. `nullCloseOn` leaves that day's bar with prices but no close (as Yahoo sometimes does).
function dailyRows(latestDate, {count = 10, nullCloseOn = null, partialToday = null} = {}) {
  const rows = tradingDaysEnding(latestDate, count).map((date, index) => {
    const close = 200 - index;
    return {time: et(date, '09:30'), open: close - 1, high: close + 2, low: close - 2,
      close: date === nullCloseOn ? null : close, volume: 1000 + index};
  });
  if (partialToday) rows.unshift({time: et(partialToday, '09:30'), open: 201, high: 203, low: 199, close: 202, volume: 5});
  return rows;
}

function dailyResponse(rows, meta = {}) {
  const body = {chart: {result: [{
    meta: {longName: 'Russell 2000', instrumentType: 'INDEX', currency: 'USD', ...meta},
    timestamp: rows.map(row => Date.parse(row.time) / 1000),
    indicators: {quote: [{
      open: rows.map(row => row.open), high: rows.map(row => row.high), low: rows.map(row => row.low),
      close: rows.map(row => row.close), volume: rows.map(row => row.volume)
    }]}
  }], error: null}};
  return {ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)};
}

// Yahoo's 1-minute shape for one session: a bar per minute from the open, then the closing print at
// the close (here 1:00 p.m., so 210 bars and the print), its O=H=L=C the official close. The bars'
// open, high and low agree with that day's daily bar, as real data does.
function minuteResponse(date, {open: dayOpen, high: dayHigh, low: dayLow, close: closingClose}) {
  const context = getSessionContext({market: 'US', exchangeDate: date});
  const open = Date.parse(context.regularOpenTime) / 1000;
  const close = Date.parse(context.regularCloseTime) / 1000;
  const timestamps = [];
  const quote = {open: [], high: [], low: [], close: [], volume: []};
  const middle = (dayHigh + dayLow) / 2;
  for (let at = open, index = 0; at < close; at += 60, index++) {
    timestamps.push(at);
    const barOpen = index === 0 ? dayOpen : middle;
    quote.open.push(barOpen);
    quote.high.push(index === 10 ? dayHigh : Math.max(barOpen, middle));
    quote.low.push(index === 20 ? dayLow : Math.min(barOpen, middle));
    quote.close.push(middle);
    quote.volume.push(10);
  }
  timestamps.push(close);
  for (const field of ['open', 'high', 'low', 'close']) quote[field].push(closingClose);
  quote.volume.push(0);
  const body = {chart: {result: [{timestamp: timestamps, indicators: {quote: [quote]}}], error: null}};
  return {ok: true, status: 200, text: async () => JSON.stringify(body)};
}

function yahooService({instant, rows, minute = null, onDiagnostics}) {
  const calls = [];
  const service = createYahooTelemetryAcquisitionService({
    now: () => new Date(instant),
    onDiagnostics,
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).includes('interval=1m')) return minute || {ok: false, status: 502, text: async () => ''};
      return dailyResponse(rows);
    }
  });
  return {service, calls};
}

test('Step 9S.1: five-day price history includes the half day, closing at 1:00 p.m. (30 Nov after-hours, 3 Dec closed)', async () => {
  await withSwitch(undefined, async () => {
    for (const [instant, latest, expected] of [
      [et('2026-11-30', '17:00'), '2026-11-30', ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']],
      [et('2026-12-03', '21:00'), '2026-12-03', ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']]
    ]) {
      const {service} = yahooService({instant, rows: dailyRows(latest)});
      const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^RUT'});
      assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
      assert.deepEqual(snapshot.completedSessions.map(session => session.sessionDate), expected);
      const half = snapshot.completedSessions.find(session => session.sessionDate === '2026-11-27');
      assert.equal(half.asOf, '2026-11-27T18:00:00.000Z');
      assert.equal(snapshot.completeness, 'COMPLETE');
    }
  });
});

test('Step 9S.1: on the half day itself, after-hours history ends with the half day; Trading history ends the day before', async () => {
  await withSwitch(undefined, async () => {
    const post = await yahooService({instant: et('2026-12-24', '14:00'), rows: dailyRows('2026-12-24')})
      .service.acquireSnapshot({market: 'US', symbol: '^RUT'});
    assert.equal(post.marketState, 'POST');
    assert.deepEqual(post.completedSessions.map(session => session.sessionDate),
      ['2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24']);
    assert.equal(post.completedSessions.at(-1).asOf, '2026-12-24T18:00:00.000Z');
    const regular = await yahooService({instant: et('2026-12-24', '11:00'),
      rows: dailyRows('2026-12-23', {partialToday: '2026-12-24'})}).service.acquireSnapshot({market: 'US', symbol: '^RUT'});
    assert.equal(regular.marketState, 'REGULAR');
    assert.equal(regular.completedSessions.at(-1).sessionDate, '2026-12-23');
    assert.equal(regular.completedSessions.length, 5);
  });
});

test('Step 9S.1: switch off gives the old behaviour (refused on the half day, history cut short after it)', async () => {
  await withSwitch('off', async () => {
    await assert.rejects(yahooService({instant: et('2026-11-27', '14:00'), rows: dailyRows('2026-11-25')})
      .service.acquireSnapshot({market: 'US', symbol: '^RUT'}), /Unsupported calendar date: 2026-11-27/);
    const rows = await withSwitch('on', () => dailyRows('2026-11-30'));
    const snapshot = await yahooService({instant: et('2026-11-30', '17:00'), rows})
      .service.acquireSnapshot({market: 'US', symbol: '^RUT'});
    assert.deepEqual(snapshot.completedSessions.map(session => session.sessionDate), ['2026-11-30']);
  });
});

test('Step 9S.1: close recovery from minute data on the half day asks for 9:30 a.m. to 1:00 p.m. and uses the closing print', async () => {
  await withSwitch(undefined, async () => {
    const diagnostics = [];
    const {service, calls} = yahooService({
      instant: et('2026-11-30', '08:00'),
      rows: dailyRows('2026-11-27', {nullCloseOn: '2026-11-27'}),
      minute: minuteResponse('2026-11-27', {open: 199, high: 202, low: 198, close: 199.25}),
      onDiagnostics: value => diagnostics.push(value)
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^RUT'});
    const half = snapshot.completedSessions.at(-1);
    assert.deepEqual([half.sessionDate, half.close, half.asOf], ['2026-11-27', 199.25, '2026-11-27T18:00:00.000Z']);
    assert.equal(snapshot.completedSessions.length, 5);
    assert.equal(diagnostics.find(value => value.intradayRecoveryResult).intradayRecoveryResult, 'SUCCESS');
    const minuteCall = calls.find(url => url.includes('interval=1m'));
    assert.match(minuteCall, new RegExp(`period1=${Date.parse('2026-11-27T14:30:00Z') / 1000}`
      + `&period2=${Date.parse('2026-11-27T18:00:00Z') / 1000}&interval=1m$`));
  });
});

test('Step 9S.1: the preceding close is recovered from half-day minute data when the next day needs it', async () => {
  await withSwitch(undefined, async () => {
    const diagnostics = [];
    const {service, calls} = yahooService({
      instant: et('2026-12-28', '17:00'),
      rows: dailyRows('2026-12-28', {nullCloseOn: '2026-12-24'}),
      minute: minuteResponse('2026-12-24', {open: 198, high: 201, low: 197, close: 197.5}),
      onDiagnostics: value => diagnostics.push(value)
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^RUT'});
    const newest = snapshot.completedSessions.at(-1);
    assert.deepEqual([newest.sessionDate, newest.previousClose], ['2026-12-28', 197.5]);
    assert.equal(diagnostics.find(value => value.precedingIntradayRecoveryResult).precedingIntradayRecoveryResult, 'SUCCESS');
    assert.match(calls.find(url => url.includes('interval=1m')),
      new RegExp(`period2=${Date.parse('2026-12-24T18:00:00Z') / 1000}&interval=1m$`));
  });
});

// ---------------------------------------------------------------------------
// The stored-history check across a half day

function memoryRepository() {
  return {upsertSnapshot: async ({sessions}) => sessions};
}

test('Step 9S.1: stored history that spans a half day passes the continuity check', async () => {
  await withSwitch(undefined, async () => {
    for (const [instant, latest] of [[et('2026-11-30', '17:00'), '2026-11-30'], [et('2026-12-28', '21:00'), '2026-12-28']]) {
      const acquired = await yahooService({instant, rows: dailyRows(latest)}).service
        .acquireSnapshot({market: 'US', symbol: '^RUT'});
      const persisted = await createRuntimeFiveSessionSnapshotRepository({repository: memoryRepository()})
        .persistSnapshot(acquired);
      assert.deepEqual(persisted.completedSessions.map(session => session.sessionDate),
        acquired.completedSessions.map(session => session.sessionDate));
      assert.equal(persisted.completedSessions.length, 5);
    }
  });
});

test('Step 9S.1: switch off gives the old stored-history refusal across the half day', async () => {
  const acquired = await withSwitch('on', () => yahooService({instant: et('2026-11-30', '17:00'),
    rows: dailyRows('2026-11-30')}).service.acquireSnapshot({market: 'US', symbol: '^RUT'}));
  await withSwitch('off', async () => {
    await assert.rejects(createRuntimeFiveSessionSnapshotRepository({repository: memoryRepository()})
      .persistSnapshot(acquired), error => error.code === 'SNAPSHOT_CALENDAR_UNSUPPORTED');
  });
});

// ---------------------------------------------------------------------------
// The whole analysis package for each of the six report states, with a fixed clock. Telemetry and
// stored history are the real code on mock Yahoo data; every other source is a quiet stand-in.

function cnbcSuccess(horizons) {
  const horizon = horizons.find(item => item.classification === 'COMPLETED_SESSION');
  const bounds = CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds;
  const candidate = createNewsEvidenceCandidate({
    reference: 'c1', horizon, sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: 'CNBC market news item 1', summary: 'CNBC candidate summary item 1.',
    extract: 'Bounded CNBC candidate extract item 1.',
    canonicalUrl: 'https://www.cnbc.com/2026/11/27/item-1.html',
    publishedAt: new Date((Date.parse(horizon.startsAtExclusive) + Date.parse(horizon.endsAtInclusive)) / 2).toISOString(),
    symbols: []
  }, {bounds});
  return {
    ok: true, type: 'SUCCESS',
    candidateCollection: createNewsEvidenceCandidateCollection({market: 'US', candidates: [candidate]}, {bounds}),
    selections: [],
    retrievedArticles: [{reference: 'c1', sourceId: 'us.cnbc', canonicalUrl: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt, updatedAt: null, title: candidate.title,
      articleText: 'Bounded CNBC article content item 1.', provenance: candidate.provenance}],
    constructedEvidence: [{candidateReference: 'c1', horizon: candidate.horizon, evidenceItem: createEvidenceItem({
      sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: candidate.title,
      summary: candidate.extract, canonicalUrl: candidate.canonicalUrl, publishedAt: candidate.publishedAt, symbols: []
    })}]
  };
}

function packageService(instant, rows) {
  const marketData = symbol => createEvidenceCollection({market: 'US', items: [createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
    title: `${symbol} market data`, summary: `${symbol} factual market data.`,
    canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    publishedAt: new Date(Date.parse(instant) - 60000).toISOString(), symbols: [symbol]
  })]});
  const fed = createEvidenceCollection({market: 'US', items: [createEvidenceItem({
    sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
    title: 'Federal Reserve policy statement',
    canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm',
    publishedAt: '2026-10-28T18:00:00Z', symbols: []
  })]});
  return createUsAnalysisPackageOrchestrationService({
    createTelemetryAcquisition: ({generatedAt}) => createYahooTelemetryAcquisitionService({
      now: () => new Date(generatedAt),
      fetchImpl: async () => dailyResponse(rows)
    }),
    snapshotPersistence: createRuntimeFiveSessionSnapshotRepository({repository: memoryRepository()}),
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) { return marketData(symbol); }},
    yahooMostActiveAcquisition: {async acquireMostActive() { return {ok: true, type: 'NOT_FOUND', candidates: []}; }},
    yahooLatestNewsDiscovery: {async discoverLatestNews() { return {ok: true, type: 'NOT_FOUND', candidates: []}; }},
    yahooCurrentNewsArticleContentAcquisition: {
      async acquireArticleContent() { return {ok: false, type: 'NO_USABLE_ARTICLE', articleContent: null}; }
    },
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return fed; }},
    yahooRecapResearch: {
      async discoverAndValidateRecap() { return {ok: true, type: 'NOT_FOUND', discovery: null, validation: null}; }
    },
    yahooRecapArticleContentAcquisition: {async acquireArticleContent() { throw new Error('not expected'); }},
    yahooRecapEvidenceConstruction: {constructEvidence() { throw new Error('not expected'); }},
    yahooRecapArticleContentBounds: Object.freeze({
      timeoutMs: 4000, maxResponseBytes: 1258291, maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256, maxArticleTextBytes: 8192, maxResultBytes: 12288
    }),
    cnbcRecapResearch: {
      async researchCompletedSessionRecap() { return {ok: true, type: 'NOT_FOUND', constructedEvidence: null}; }
    },
    cnbcNewsResearch: {async researchNews({horizons}) { return cnbcSuccess(horizons); }},
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return {ok: true, type: 'SUCCESS', output: {classifications: input.evidence.map(({reference}) =>
          ({reference, materiality: 'LOW', roles: [], subjects: []}))}};
      },
      async repairEvidenceSubjects(input) {
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(({reference}) => ({reference, subjects: []}))}};
      }
    },
    sleep: async () => {},
    now: () => new Date(instant)
  });
}

const PACKAGE_REQUEST = Object.freeze({
  benchmarkAnchors: [{market: 'US', symbol: '^RUT'}],
  selectedScope: 'US', initiatingList: 'myStocks', userTimezone: 'Asia/Singapore',
  myStocks: [], watchlist: []
});

const PACKAGE_CASES = [
  // [label, instant, report state, latest completed session, daily rows end, partial bar today]
  ['Pre-market on 27 Nov', et('2026-11-27', '08:00'), 'PRE', '2026-11-25', '2026-11-25', null],
  ['Trading on 27 Nov', et('2026-11-27', '12:00'), 'REGULAR', '2026-11-25', '2026-11-25', '2026-11-27'],
  ['After-Hours on 27 Nov', et('2026-11-27', '14:00'), 'POST', '2026-11-27', '2026-11-27', null],
  ['Closed on 27 Nov', et('2026-11-27', '18:00'), 'CLOSED', '2026-11-27', '2026-11-27', null],
  ['Weekend on 28 Nov', et('2026-11-28', '12:00'), 'WEEKEND', '2026-11-27', '2026-11-27', null],
  ['Pre-market on 30 Nov', et('2026-11-30', '08:00'), 'PRE', '2026-11-27', '2026-11-27', null],
  ['Pre-market on 24 Dec', et('2026-12-24', '05:00'), 'PRE', '2026-12-23', '2026-12-23', null],
  ['Trading on 24 Dec', et('2026-12-24', '12:59'), 'REGULAR', '2026-12-23', '2026-12-23', '2026-12-24'],
  ['After-Hours on 24 Dec', et('2026-12-24', '16:59'), 'POST', '2026-12-24', '2026-12-24', null],
  ['Closed on 24 Dec', et('2026-12-24', '17:00'), 'CLOSED', '2026-12-24', '2026-12-24', null],
  ['Holiday on 25 Dec', et('2026-12-25', '12:00'), 'HOLIDAY', '2026-12-24', '2026-12-24', null],
  ['Weekend on 26 Dec', et('2026-12-26', '12:00'), 'WEEKEND', '2026-12-24', '2026-12-24', null],
  ['Pre-market on 28 Dec', et('2026-12-28', '08:00'), 'PRE', '2026-12-24', '2026-12-24', null]
];

for (const [label, instant, state, latest, rowsEnd, partialToday] of PACKAGE_CASES) {
  test(`Step 9S.1: whole package, ${label}: built, state ${state}, five days of history ending ${latest}`, async () => {
    await withSwitch(undefined, async () => {
      const output = await packageService(instant, dailyRows(rowsEnd, {partialToday})).assemble(PACKAGE_REQUEST);
      const marketPackage = output.marketPackages[0];
      assert.equal(marketPackage.marketContext.marketState, state);
      assert.equal(marketPackage.marketContext.primaryCompletedSessionDate, latest);
      const benchmark = findSnapshot(output, '^RUT');
      assert.equal(benchmark.completedSessions.length, 5);
      assert.equal(benchmark.completedSessions.at(-1).sessionDate, latest);
      if (HALF_DAYS.includes(latest)) assert.equal(benchmark.completedSessions.at(-1).asOf, `${latest}T18:00:00.000Z`);
    });
  });
}

// The benchmark's canonical snapshot wherever the package carries it.
function findSnapshot(value, symbol) {
  if (!value || typeof value !== 'object') return null;
  if (value.symbol === symbol && Array.isArray(value.completedSessions)) return value;
  for (const child of Object.values(value)) {
    const found = findSnapshot(child, symbol);
    if (found) return found;
  }
  return null;
}

test('Step 9S.1: switch off gives the old whole-package failure on and after the half day', async () => {
  await withSwitch('off', async () => {
    const rows = await withSwitch('on', () => dailyRows('2026-11-27'));
    for (const instant of [et('2026-11-27', '08:00'), et('2026-11-28', '12:00'), et('2026-11-30', '08:00')]) {
      await assert.rejects(packageService(instant, rows).assemble(PACKAGE_REQUEST),
        /Canonical US exchange calendar is unavailable/, instant);
    }
  });
});

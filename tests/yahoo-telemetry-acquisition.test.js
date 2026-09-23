const test = require('node:test');
const assert = require('node:assert/strict');

const {createYahooTelemetryAcquisitionService} = require('../lib/yahoo-telemetry-acquisition');
const {validateFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {getSessionContext} = require('../lib/market-session-calendar');

const ZONES = Object.freeze({US: 'America/New_York', SG: 'Asia/Singapore', HK: 'Asia/Hong_Kong'});

function epoch(value) {
  return Date.parse(value) / 1000;
}

function row(date, close, overrides = {}) {
  const base = close === null ? null : close - 1;
  return {
    date,
    time: overrides.time || `${date}T01:00:00Z`,
    open: overrides.open === undefined ? base : overrides.open,
    high: overrides.high === undefined ? close === null ? null : close + 2 : overrides.high,
    low: overrides.low === undefined ? close === null ? null : close - 2 : overrides.low,
    close,
    volume: overrides.volume === undefined ? close === null ? null : Math.round(close * 1000) : overrides.volume
  };
}

function responseFor(rows, meta = {}) {
  const result = {
    meta: {
      longName: 'Test Instrument',
      instrumentType: 'INDEX',
      currency: 'SGD',
      ...meta
    },
    timestamp: rows.map(item => epoch(item.time)),
    indicators: {quote: [{
      open: rows.map(item => item.open),
      high: rows.map(item => item.high),
      low: rows.map(item => item.low),
      close: rows.map(item => item.close),
      volume: rows.map(item => item.volume)
    }]}
  };
  const body = {chart: {result: [result], error: null}};
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function normalRows(timeSuffix = 'T01:00:00Z') {
  return [
    row('2026-08-31', 100, {time: `2026-08-31${timeSuffix}`}),
    row('2026-09-01', 101, {time: `2026-09-01${timeSuffix}`}),
    row('2026-09-02', 102, {time: `2026-09-02${timeSuffix}`}),
    row('2026-09-03', 103, {time: `2026-09-03${timeSuffix}`}),
    row('2026-09-04', 104, {time: `2026-09-04${timeSuffix}`}),
    row('2026-08-28', 99, {time: `2026-08-28${timeSuffix}`})
  ];
}

function preRowsWithSep22NullClose() {
  const dates = ['2026-09-22', '2026-09-21', '2026-09-18', '2026-09-17', '2026-09-16',
    '2026-09-15', '2026-09-14', '2026-09-11', '2026-09-10', '2026-09-09'];
  return dates.map((date, index) => {
    const close = 100 - index;
    return row(date, index === 0 ? null : close, {
      time: `${date}T13:30:00Z`,
      ...(index === 0 ? {open: 101, high: 104, low: 99, volume: 1000} : {})
    });
  });
}

function preRowsWithSep22NullOhlcv() {
  return preRowsWithSep22NullClose().map((item, index) => index === 0
    ? {...item, open: null, high: null, low: null, volume: null}
    : item);
}

function intradayResponseFor(date = '2026-09-22', {
  missingFinal = false,
  mutateBar,
  malformed = false,
  oversized = false
} = {}) {
  const context = getSessionContext({market: 'US', exchangeDate: date});
  const open = Date.parse(context.regularOpenTime) / 1000;
  const close = Date.parse(context.regularCloseTime) / 1000;
  const timestamps = [];
  const quote = {open: [], high: [], low: [], close: [], volume: []};
  const count = (close - open) / 60 - (missingFinal ? 1 : 0);
  for (let index = 0; index < count; index++) {
    const bar = {open: 101, high: 104, low: 99, close: 103, volume: 10};
    if (mutateBar) mutateBar(bar, index, count);
    timestamps.push(open + index * 60);
    for (const field of Object.keys(quote)) quote[field].push(bar[field]);
  }
  if (malformed) return {ok: true, status: 200, text: async () => '{not-json'};
  if (oversized) return {ok: true, status: 200, text: async () => 'x'.repeat(128 * 1024 + 1)};
  const body = {chart: {result: [{timestamp: timestamps, indicators: {quote: [quote]}}], error: null}};
  return {ok: true, status: 200, text: async () => JSON.stringify(body)};
}

function serviceFor({
  market = 'SG', instant = '2026-09-04T10:00:00Z', rows = normalRows(), meta = {},
  intradayResponse, intradayFailure = false
} = {}) {
  const calls = [];
  const service = createYahooTelemetryAcquisitionService({
    now: () => new Date(instant),
    fetchImpl: async (...args) => {
      calls.push(args);
      if (String(args[0]).includes('interval=1m')) {
        if (intradayFailure) throw new Error('synthetic intraday network failure');
        return intradayResponse || {ok: false, status: 502, text: async () => ''};
      }
      return responseFor(rows, meta);
    }
  });
  return {service, calls, market};
}

test('makes one aligned Yahoo 10-day request and returns five sessions oldest to newest', async () => {
  const {service, calls} = serviceFor();
  const snapshot = await service.acquireSnapshot({market: 'sg', symbol: ' ^sti '});

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/%5ESTI\?interval=1d&range=10d$/);
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.deepEqual(snapshot.completedSessions.map(item => item.close), [100, 101, 102, 103, 104]);
  assert.equal(snapshot.completedSessions[0].previousClose, 99);
  assert.equal(snapshot.completedSessions[4].previousClose, 103);
  assert.equal(snapshot.completedSessions[4].asOf, '2026-09-04T09:00:00.000Z');
  assert.equal(snapshot.completeness, 'COMPLETE');
  assert.equal(snapshot.symbol, '^STI');
  assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.completedSessions), true);
});

test('keeps OHLCV aligned by original index before filtering', async () => {
  const rows = normalRows();
  rows[0] = row('2026-08-31', null);
  rows[2] = row('2026-09-02', 102, {open: 101.25, high: 109, low: 99, volume: 22002});
  const {service} = serviceFor({rows});
  const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
  const selected = snapshot.completedSessions.find(item => item.sessionDate === '2026-09-02');
  assert.equal(selected.open, 101.25);
  assert.equal(selected.high, 109);
  assert.equal(selected.low, 99);
  assert.equal(selected.close, 102);
  assert.equal(selected.volume, 22002);
});

test('does not bridge a missing expected session or fabricate COMPLETE history', async () => {
  const rows = normalRows();
  rows[3] = row('2026-09-03', null);
  const {service} = serviceFor({rows});
  const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
  assert.equal(snapshot.completeness, 'PARTIAL');
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-08-31', '2026-09-01', '2026-09-02'
  ]);
  assert.equal(snapshot.completedSessions.some(item => item.sessionDate === '2026-09-04'), false);
  assert.equal(snapshot.completedSessions[0].previousClose, 99);
  assert.equal(snapshot.completedSessions[2].previousClose, 101);
});

test('skips full-day weekends and holidays when deriving expected sessions', async () => {
  const rows = [
    row('2026-08-31', 98, {time: '2026-08-31T13:30:00Z'}),
    row('2026-09-01', 99, {time: '2026-09-01T13:30:00Z'}),
    row('2026-09-02', 100, {time: '2026-09-02T13:30:00Z'}),
    row('2026-09-03', 101, {time: '2026-09-03T13:30:00Z'}),
    row('2026-09-04', 102, {time: '2026-09-04T13:30:00Z'}),
    row('2026-09-08', 103, {time: '2026-09-08T13:30:00Z'})
  ];
  const {service} = serviceFor({market: 'US', instant: '2026-09-08T21:00:00Z', rows, meta: {currency: 'USD'}});
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: 'AAPL'});
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08'
  ]);
  assert.equal(snapshot.completedSessions[4].previousClose, 102);
  assert.equal(snapshot.completeness, 'COMPLETE');
});

test('US PRE reconstructs the expected date from a complete bounded intraday session when daily OHLCV is null', async () => {
  for (const symbol of ['^DJI', '^GSPC', '^IXIC']) {
    const {service, calls} = serviceFor({
      market: 'US',
      instant: '2026-09-23T12:00:00Z',
      rows: preRowsWithSep22NullOhlcv(),
      meta: {
        currency: 'USD',
        regularMarketPrice: 999999,
        regularMarketTime: epoch('2026-09-23T12:00:00Z')
      },
      intradayResponse: intradayResponseFor()
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol});
    assert.equal(calls.length, 2);
    assert.match(calls[1][0], /period1=1790083800&period2=1790107200&interval=1m$/);
    assert.equal(snapshot.marketState, 'PRE');
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-09-22');
    assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-22');
    assert.deepEqual({
      open: snapshot.completedSessions.at(-1).open,
      high: snapshot.completedSessions.at(-1).high,
      low: snapshot.completedSessions.at(-1).low,
      close: snapshot.completedSessions.at(-1).close,
      volume: snapshot.completedSessions.at(-1).volume
    }, {open: 101, high: 104, low: 99, close: 103, volume: null});
    assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
  }
});

test('non-null daily close stays authoritative and does not trigger an intraday request', async () => {
  for (const symbol of ['^DJI', '^GSPC', '^IXIC']) {
    const {service} = serviceFor({
      market: 'US',
      instant: '2026-09-23T12:00:00Z',
      rows: preRowsWithSep22NullClose().map((item, index) => index === 0
        ? {...item, close: 102} : item),
      meta: {
        currency: 'USD',
        regularMarketPrice: 999999,
        regularMarketTime: epoch('2026-09-23T12:00:00Z')
      },
      intradayResponse: intradayResponseFor()
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol});
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-09-22');
    assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-22');
    assert.equal(snapshot.completedSessions.at(-1).close, 102);
    assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
  }
});

test('intraday fallback rejects wrong-date, missing-final and invalid OHLC observations', async () => {
  const invalidResponses = [
    intradayResponseFor('2026-09-21'),
    intradayResponseFor('2026-09-22', {missingFinal: true}),
    intradayResponseFor('2026-09-22', {mutateBar: (bar, index, count) => {
      if (index === count - 1) bar.close = 0;
    }}),
    intradayResponseFor('2026-09-22', {mutateBar: (bar, index, count) => {
      if (index === count - 1) bar.high = 102;
    }}),
    intradayResponseFor('2026-09-22', {mutateBar: (bar, index) => {
      if (index === 10) bar.low = 0;
    }})
  ];
  for (const intradayResponse of invalidResponses) {
    const {service, calls} = serviceFor({
      market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
      intradayResponse
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(calls.length, 2);
    assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-21');
  }
});

test('malformed, oversized and failed intraday responses preserve the existing missing-session behavior', async () => {
  for (const intradayResponse of [
    intradayResponseFor('2026-09-22', {malformed: true}),
    intradayResponseFor('2026-09-22', {oversized: true}),
    {ok: false, status: 502, text: async () => ''}
  ]) {
    const {service, calls} = serviceFor({
      market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
      intradayResponse
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(calls.length, 2);
    assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-21');
  }
  const {service, calls} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayFailure: true
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(calls.length, 2);
  assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-21');
});

test('non-null chart close stays authoritative and S.tz does not affect US fallback dates', async () => {
  const rows = preRowsWithSep22NullClose();
  rows[0] = row('2026-09-22', 102, {
    time: '2026-09-22T13:30:00Z', open: 101, high: 104, low: 99, volume: 1000
  });
  const oldS = global.S;
  global.S = {tz: 'Pacific/Honolulu'};
  try {
    const {service, calls} = serviceFor({
      market: 'US',
      instant: '2026-09-23T12:00:00Z',
      rows,
      meta: {
        currency: 'USD',
        regularMarketPrice: 103,
        regularMarketTime: epoch('2026-09-22T20:00:00Z')
      }
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-09-22');
    assert.equal(snapshot.completedSessions.at(-1).close, 102);
    assert.equal(calls.length, 1);
    assert.equal(snapshot.exchangeTimezone, ZONES.US);
  } finally {
    if (oldS === undefined) delete global.S;
    else global.S = oldS;
  }
});

test('intraday fallback uses exchange-calendar open and close instants across DST', async () => {
  const rows = [
    row('2026-11-02', null, {time: '2026-11-02T14:30:00Z', open: null, high: null, low: null, volume: null}),
    row('2026-10-30', 99, {time: '2026-10-30T13:30:00Z'}),
    row('2026-10-29', 98, {time: '2026-10-29T13:30:00Z'}),
    row('2026-10-28', 97, {time: '2026-10-28T13:30:00Z'}),
    row('2026-10-27', 96, {time: '2026-10-27T13:30:00Z'}),
    row('2026-10-26', 95, {time: '2026-10-26T13:30:00Z'})
  ];
  const {service, calls} = serviceFor({
    market: 'US', instant: '2026-11-03T13:00:00Z', rows,
    intradayResponse: intradayResponseFor('2026-11-02')
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(snapshot.primaryCompletedSessionDate, '2026-11-02');
  assert.equal(snapshot.completedSessions.at(-1).close, 103);
  assert.match(calls[1][0], /period1=1793629800&period2=1793653200&interval=1m$/);
  assert.equal(snapshot.exchangeTimezone, ZONES.US);
});

test('derives close instants independently of Yahoo daily-row timestamps and ignores provider timezone metadata', async () => {
  const rows = normalRows('T15:42:17Z');
  const {service} = serviceFor({rows, meta: {exchangeTimezoneName: 'Pacific/Honolulu'}});
  const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
  assert.equal(snapshot.exchangeTimezone, 'Asia/Singapore');
  assert.equal(snapshot.completedSessions.at(-1).asOf, '2026-09-04T09:00:00.000Z');
});

test('constructs SG and HK lunch overlays from real regular-market facts only', async () => {
  for (const fixture of [
    {market: 'SG', symbol: '^STI', instant: '2026-09-04T04:15:00Z', rowTime: 'T01:00:00Z'},
    {market: 'HK', symbol: '^HSI', instant: '2026-09-04T04:15:00Z', rowTime: 'T01:30:00Z'}
  ]) {
    const rows = normalRows(fixture.rowTime).slice(0, 4);
    rows.push(row('2026-09-04', 104, {time: `2026-09-04${fixture.rowTime}`, volume: 999999}));
    const {service} = serviceFor({
      market: fixture.market,
      instant: fixture.instant,
      rows,
      meta: {
        currency: fixture.market === 'HK' ? 'HKD' : 'SGD',
        regularMarketPrice: 103.5,
        regularMarketTime: epoch('2026-09-04T04:14:00Z'),
        regularMarketVolume: 777
      }
    });
    const snapshot = await service.acquireSnapshot({market: fixture.market, symbol: fixture.symbol});
    assert.equal(snapshot.marketState, 'LUNCH');
    assert.equal(snapshot.currentOverlay.lastPrice, 103.5);
    assert.equal(snapshot.currentOverlay.referenceClose, 103);
    assert.equal(snapshot.currentOverlay.volume, 777);
    assert.equal(snapshot.currentOverlay.isFinal, false);
  }
});

test('implements US PRE, REGULAR and POST overlay reference rules', async () => {
  const baseRows = normalRows('T13:30:00Z');
  const cases = [
    {
      instant: '2026-09-04T12:00:00Z', state: 'PRE', rows: baseRows.slice(0, 4),
      meta: {preMarketPrice: 103.25, preMarketTime: epoch('2026-09-04T11:59:00Z')}, reference: 103, volume: null
    },
    {
      instant: '2026-09-04T15:00:00Z', state: 'REGULAR', rows: baseRows,
      meta: {regularMarketPrice: 103.75, regularMarketTime: epoch('2026-09-04T14:59:00Z')}, reference: 103, volume: null
    },
    {
      instant: '2026-09-04T20:30:00Z', state: 'POST', rows: baseRows,
      meta: {postMarketPrice: 104.5, postMarketTime: epoch('2026-09-04T20:29:00Z'), postMarketVolume: 42}, reference: 104, volume: 42
    }
  ];
  for (const fixture of cases) {
    const {service} = serviceFor({market: 'US', instant: fixture.instant, rows: fixture.rows, meta: {currency: 'USD', ...fixture.meta}});
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: 'aapl'});
    assert.equal(snapshot.marketState, fixture.state);
    assert.equal(snapshot.currentOverlay.referenceClose, fixture.reference);
    assert.equal(snapshot.currentOverlay.volume, fixture.volume);
  }
});

test('does not create overlays while closed, on weekends or holidays, or for SG/HK extended hours', async () => {
  const cases = [
    {market: 'US', symbol: 'AAPL', instant: '2026-09-04T10:00:00Z'},
    {market: 'US', symbol: 'AAPL', instant: '2026-09-06T15:00:00Z'},
    {market: 'US', symbol: 'AAPL', instant: '2026-09-07T15:00:00Z'},
    {market: 'SG', symbol: '^STI', instant: '2026-09-04T00:30:00Z'},
    {market: 'HK', symbol: '^HSI', instant: '2026-09-04T08:30:00Z'}
  ];
  for (const fixture of cases) {
    const {service} = serviceFor({market: fixture.market, instant: fixture.instant, rows: normalRows(), meta: {
      preMarketPrice: 999, preMarketTime: epoch('2026-09-04T00:29:00Z'),
      postMarketPrice: 999, postMarketTime: epoch('2026-09-04T08:29:00Z')
    }});
    const snapshot = await service.acquireSnapshot({market: fixture.market, symbol: fixture.symbol});
    assert.equal(snapshot.currentOverlay, null);
  }
});

test('rejects stale/invalid overlay facts and never substitutes completed-session volume', async () => {
  const {service} = serviceFor({
    instant: '2026-09-04T04:15:00Z', rows: normalRows().slice(0, 4),
    meta: {regularMarketPrice: 103.5, regularMarketTime: epoch('2026-09-04T04:14:00Z')}
  });
  const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
  assert.equal(snapshot.currentOverlay.volume, null);

  const stale = serviceFor({
    instant: '2026-09-04T04:15:00Z', rows: normalRows().slice(0, 4),
    meta: {regularMarketPrice: 103.5, regularMarketTime: epoch('2026-09-03T04:14:00Z')}
  });
  assert.equal((await stale.service.acquireSnapshot({market: 'SG', symbol: '^STI'})).currentOverlay, null);

  const preOpenSameDate = serviceFor({
    instant: '2026-09-04T05:15:00Z', rows: normalRows().slice(0, 4),
    meta: {regularMarketPrice: 103.5, regularMarketTime: epoch('2026-09-04T00:30:00Z')}
  });
  assert.equal(
    (await preOpenSameDate.service.acquireSnapshot({market: 'SG', symbol: '^STI'})).currentOverlay,
    null
  );
});

test('fails conservatively for unsupported calendars and malformed Yahoo data', async () => {
  const unsupported = serviceFor({instant: '2028-09-04T04:00:00Z'});
  await assert.rejects(
    unsupported.service.acquireSnapshot({market: 'SG', symbol: '^STI'}),
    /Unsupported calendar date/
  );
  assert.equal(unsupported.calls.length, 0);

  const failed = createYahooTelemetryAcquisitionService({
    now: () => new Date('2026-09-04T10:00:00Z'),
    fetchImpl: async () => ({ok: false, status: 429})
  });
  await assert.rejects(failed.acquireSnapshot({market: 'SG', symbol: '^STI'}), /HTTP 429/);

  const malformed = createYahooTelemetryAcquisitionService({
    now: () => new Date('2026-09-04T10:00:00Z'),
    fetchImpl: async () => ({ok: true, json: async () => ({chart: {result: []}})})
  });
  await assert.rejects(malformed.acquireSnapshot({market: 'SG', symbol: '^STI'}), /malformed/);
});

test('validates market/symbol classification and remains independent of S.tz', async () => {
  const {service} = serviceFor();
  await assert.rejects(service.acquireSnapshot({market: 'US', symbol: '^STI'}), /market or symbol/);
  assert.equal((await service.acquireSnapshot({symbol: '^STI', market: 'SG'})).symbol, '^STI');

  const oldS = global.S;
  global.S = {tz: 'Pacific/Honolulu'};
  try {
    const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
    assert.equal(snapshot.exchangeTimezone, ZONES.SG);
  } finally {
    if (oldS === undefined) delete global.S;
    else global.S = oldS;
  }
});

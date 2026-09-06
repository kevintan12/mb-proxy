const test = require('node:test');
const assert = require('node:assert/strict');

const {createYahooTelemetryAcquisitionService} = require('../lib/yahoo-telemetry-acquisition');
const {validateThreeSessionSnapshot} = require('../lib/three-session-snapshot');

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
  return {ok: true, status: 200, json: async () => ({chart: {result: [result], error: null}})};
}

function normalRows(timeSuffix = 'T01:00:00Z') {
  return [
    row('2026-08-31', 100, {time: `2026-08-31${timeSuffix}`}),
    row('2026-09-01', 101, {time: `2026-09-01${timeSuffix}`}),
    row('2026-09-02', 102, {time: `2026-09-02${timeSuffix}`}),
    row('2026-09-03', 103, {time: `2026-09-03${timeSuffix}`}),
    row('2026-09-04', 104, {time: `2026-09-04${timeSuffix}`})
  ];
}

function serviceFor({market = 'SG', instant = '2026-09-04T10:00:00Z', rows = normalRows(), meta = {}} = {}) {
  const calls = [];
  const service = createYahooTelemetryAcquisitionService({
    now: () => new Date(instant),
    fetchImpl: async (...args) => {
      calls.push(args);
      return responseFor(rows, meta);
    }
  });
  return {service, calls, market};
}

test('makes one aligned Yahoo 10-day request and returns three sessions oldest to newest', async () => {
  const {service, calls} = serviceFor();
  const snapshot = await service.acquireSnapshot({market: 'sg', symbol: ' ^sti '});

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/%5ESTI\?interval=1d&range=10d$/);
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.deepEqual(snapshot.completedSessions.map(item => item.close), [102, 103, 104]);
  assert.equal(snapshot.completedSessions[0].previousClose, 101);
  assert.equal(snapshot.completedSessions[1].previousClose, 102);
  assert.equal(snapshot.completedSessions[2].previousClose, 103);
  assert.equal(snapshot.completedSessions[2].asOf, '2026-09-04T09:00:00.000Z');
  assert.equal(snapshot.completeness, 'COMPLETE');
  assert.equal(snapshot.symbol, '^STI');
  assert.equal(validateThreeSessionSnapshot(snapshot).valid, true);
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
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), ['2026-09-01', '2026-09-02']);
  assert.equal(snapshot.completedSessions.some(item => item.sessionDate === '2026-09-04'), false);
  assert.equal(snapshot.completedSessions[0].previousClose, 100);
  assert.equal(snapshot.completedSessions[1].previousClose, 101);
});

test('skips full-day weekends and holidays when deriving expected sessions', async () => {
  const rows = [
    row('2026-09-02', 100, {time: '2026-09-02T13:30:00Z'}),
    row('2026-09-03', 101, {time: '2026-09-03T13:30:00Z'}),
    row('2026-09-04', 102, {time: '2026-09-04T13:30:00Z'}),
    row('2026-09-08', 103, {time: '2026-09-08T13:30:00Z'})
  ];
  const {service} = serviceFor({market: 'US', instant: '2026-09-08T21:00:00Z', rows, meta: {currency: 'USD'}});
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: 'AAPL'});
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-09-03', '2026-09-04', '2026-09-08'
  ]);
  assert.equal(snapshot.completedSessions[2].previousClose, 102);
  assert.equal(snapshot.completeness, 'COMPLETE');
});

test('derives close instants independently of Yahoo daily-row timestamps and ignores provider timezone metadata', async () => {
  const rows = normalRows('T15:42:17Z');
  const {service} = serviceFor({rows, meta: {exchangeTimezoneName: 'Pacific/Honolulu'}});
  const snapshot = await service.acquireSnapshot({market: 'SG', symbol: '^STI'});
  assert.equal(snapshot.exchangeTimezone, 'Asia/Singapore');
  assert.equal(snapshot.completedSessions[2].asOf, '2026-09-04T09:00:00.000Z');
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

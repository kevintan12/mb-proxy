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

function closedRowsWithSep23NullOhlcv() {
  const dates = ['2026-09-23', '2026-09-22', '2026-09-21', '2026-09-18', '2026-09-17',
    '2026-09-16', '2026-09-15', '2026-09-14', '2026-09-11', '2026-09-10'];
  return dates.map((date, index) => {
    const close = 110 - index;
    return row(date, index === 0 ? null : close, {
      time: `${date}T13:30:00Z`,
      ...(index === 0 ? {open: null, high: null, low: null, volume: null} : {})
    });
  });
}

function regularRowsWithSep23ValidSep22Invalid() {
  const dates = ['2026-09-23', '2026-09-22', '2026-09-21', '2026-09-18', '2026-09-17',
    '2026-09-16', '2026-09-15', '2026-09-14', '2026-09-11', '2026-09-10'];
  return dates.map((date, index) => {
    if (date === '2026-09-23') {
      return row(date, 110, {time: `${date}T13:30:00Z`, open: 109, high: 113, low: 107, volume: 1000});
    }
    if (date === '2026-09-22') {
      return row(date, null, {time: `${date}T13:30:00Z`, open: 101, high: 104, low: 99, volume: 1000});
    }
    return row(date, 108 - index, {time: `${date}T13:30:00Z`});
  });
}

const DEFAULT_INTRADAY_BAR = Object.freeze({open: 101, high: 104, low: 99, close: 103, volume: 10});

// D-006: Yahoo's real 1m response is 390 regular-grid bars plus one terminal "closing
// print" bar at the session close, with O=H=L=C = the official close. Defaults model
// that shape; the closing print defaults to DEFAULT_INTRADAY_BAR.close so existing
// assertions (written against the old 390-bar shape) keep passing unchanged.
function intradayResponseFor(date = '2026-09-22', {
  missingFinal = false,
  mutateBar,
  malformed = false,
  oversized = false,
  closingPrint = true,
  closingClose = DEFAULT_INTRADAY_BAR.close,
  noTradeMinutes = [],
  extraBarAfterClose = false,
  sessionContext
} = {}) {
  const context = sessionContext || getSessionContext({market: 'US', exchangeDate: date});
  const open = Date.parse(context.regularOpenTime) / 1000;
  const close = Date.parse(context.regularCloseTime) / 1000;
  const timestamps = [];
  const quote = {open: [], high: [], low: [], close: [], volume: []};
  const gridCount = (close - open) / 60 - (missingFinal ? 1 : 0);
  for (let index = 0; index < gridCount; index++) {
    const bar = {...DEFAULT_INTRADAY_BAR};
    if (noTradeMinutes.includes(index)) {
      bar.open = null; bar.high = null; bar.low = null; bar.close = null; bar.volume = 0;
    }
    if (mutateBar) mutateBar(bar, index, gridCount);
    timestamps.push(open + index * 60);
    for (const field of Object.keys(quote)) quote[field].push(bar[field]);
  }
  if (closingPrint) {
    timestamps.push(close);
    quote.open.push(closingClose);
    quote.high.push(closingClose);
    quote.low.push(closingClose);
    quote.close.push(closingClose);
    quote.volume.push(0);
  }
  if (extraBarAfterClose) {
    timestamps.push(close + 60);
    quote.open.push(DEFAULT_INTRADAY_BAR.close);
    quote.high.push(DEFAULT_INTRADAY_BAR.close);
    quote.low.push(DEFAULT_INTRADAY_BAR.close);
    quote.close.push(DEFAULT_INTRADAY_BAR.close);
    quote.volume.push(5);
  }
  if (malformed) return {ok: true, status: 200, text: async () => '{not-json'};
  if (oversized) return {ok: true, status: 200, text: async () => 'x'.repeat(128 * 1024 + 1)};
  const body = {chart: {result: [{timestamp: timestamps, indicators: {quote: [quote]}}], error: null}};
  return {ok: true, status: 200, text: async () => JSON.stringify(body)};
}

function serviceFor({
  market = 'SG', instant = '2026-09-04T10:00:00Z', rows = normalRows(), meta = {},
  intradayResponse, intradayFailure = false, onDiagnostics, sessionContextOverride
} = {}) {
  const calls = [];
  const service = createYahooTelemetryAcquisitionService({
    now: () => new Date(instant),
    onDiagnostics,
    ...(sessionContextOverride ? {getSessionContext: sessionContextOverride} : {}),
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

test('completed-session recovery diagnostics report bounded expected and preceding row state', async () => {
  for (const symbol of ['^DJI', '^GSPC', '^IXIC', '^RUT', 'AAPL']) {
    const diagnostics = [];
    const {service, calls} = serviceFor({
      market: 'US',
      instant: '2026-09-24T01:09:00Z',
      rows: closedRowsWithSep23NullOhlcv(),
      meta: {currency: 'USD', instrumentType: symbol === 'AAPL' ? 'EQUITY' : 'INDEX'},
      intradayResponse: intradayResponseFor('2026-09-23'),
      onDiagnostics: value => diagnostics.push(value)
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol});
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-09-23');
    assert.equal(calls.length, 2);
    assert.deepEqual(diagnostics, [{
      stage: 'yahooCompletedSessionRecovery',
      symbol,
      expectedCompletedDate: '2026-09-23',
      expectedDailyRowExists: true,
      expectedDailyRowDuplicateCount: 0,
      expectedDailyCloseValid: false,
      expectedDailyOhlcValid: false,
      precedingExpectedDate: '2026-09-22',
      precedingDailyRowExists: true,
      precedingDailyCloseValid: true,
      precedingDailyOhlcValid: true,
      intradayRecoveryAttempted: true,
      intradayRecoveryResult: 'SUCCESS',
      precedingIntradayRecoveryAttempted: false,
      precedingIntradayRecoveryGuardReason: 'EXPECTED_ROW_NOT_VALID_OHLC'
    }]);
  }
});

test('completed-session recovery diagnostics identify missing and duplicate expected rows without fetching', async () => {
  const missingDiagnostics = [];
  const missingRows = closedRowsWithSep23NullOhlcv().filter(item => item.date !== '2026-09-23');
  const missing = serviceFor({
    market: 'US', instant: '2026-09-24T01:09:00Z', rows: missingRows,
    onDiagnostics: value => missingDiagnostics.push(value)
  });
  await missing.service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(missing.calls.length, 1);
  assert.equal(missingDiagnostics[0].expectedDailyRowExists, false);
  assert.equal(missingDiagnostics[0].expectedDailyRowDuplicateCount, 0);
  assert.equal(missingDiagnostics[0].intradayRecoveryAttempted, false);
  assert.equal(missingDiagnostics[0].intradayRecoveryGuardReason, 'EXPECTED_ROW_MISSING');
  assert.equal(missingDiagnostics[0].precedingExpectedDate, '2026-09-22');
  assert.equal(missingDiagnostics[0].precedingDailyCloseValid, true);

  const duplicateDiagnostics = [];
  const duplicateRows = closedRowsWithSep23NullOhlcv();
  duplicateRows.push({...duplicateRows[0]});
  const duplicate = serviceFor({
    market: 'US', instant: '2026-09-24T01:09:00Z', rows: duplicateRows,
    onDiagnostics: value => duplicateDiagnostics.push(value)
  });
  await duplicate.service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(duplicate.calls.length, 1);
  assert.equal(duplicateDiagnostics[0].expectedDailyRowExists, true);
  assert.equal(duplicateDiagnostics[0].expectedDailyRowDuplicateCount, 1);
  assert.equal(duplicateDiagnostics[0].intradayRecoveryAttempted, false);
  assert.equal(duplicateDiagnostics[0].intradayRecoveryGuardReason, 'DUPLICATE_EXPECTED_ROW');
});

test('completed-session recovery diagnostics distinguish intraday rejection categories', async () => {
  const cases = [
    {intradayFailure: true, category: 'NETWORK_FAILURE'},
    {intradayResponse: {ok: false, status: 502, text: async () => ''}, category: 'HTTP_FAILURE'},
    {intradayResponse: intradayResponseFor('2026-09-22'), category: 'OUTSIDE_EXPECTED_SESSION'},
    {intradayResponse: intradayResponseFor('2026-09-23', {missingFinal: true}),
      category: 'INCOMPLETE_SESSION_COVERAGE'}
  ];
  for (const item of cases) {
    const diagnostics = [];
    const {service} = serviceFor({
      market: 'US', instant: '2026-09-24T01:09:00Z', rows: closedRowsWithSep23NullOhlcv(),
      ...item, onDiagnostics: value => diagnostics.push(value)
    });
    await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(diagnostics[0].intradayRecoveryAttempted, true);
    assert.equal(diagnostics[0].intradayRecoveryResult, 'FAILURE');
    assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, item.category);
    assert.equal(JSON.stringify(diagnostics).includes('price'), false);
    assert.equal(JSON.stringify(diagnostics).includes('Yahoo'), false);
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

test('valid latest daily row recovers only its missing preceding close for benchmarks and US stocks', async () => {
  for (const symbol of ['^DJI', '^GSPC', '^IXIC', '^RUT', 'AAPL']) {
    const diagnostics = [];
    const {service, calls} = serviceFor({
      market: 'US',
      instant: '2026-09-24T15:00:00Z',
      rows: regularRowsWithSep23ValidSep22Invalid(),
      meta: {currency: 'USD', instrumentType: symbol === 'AAPL' ? 'EQUITY' : 'INDEX'},
      intradayResponse: intradayResponseFor('2026-09-22'),
      onDiagnostics: value => diagnostics.push(value)
    });
    const result = await service.acquireSnapshot({market: 'US', symbol});
    assert.equal(calls.length, 2, `${symbol} should make one exact-date preceding-session request`);
    assert.match(calls[1][0], /period1=1790083800&period2=1790107200&interval=1m$/);
    assert.equal(result.primaryCompletedSessionDate, '2026-09-23');
    assert.deepEqual(result.completedSessions.map(session => session.sessionDate), ['2026-09-23']);
    assert.equal(result.completedSessions[0].close, 110);
    assert.equal(result.completedSessions[0].previousClose, 103);
    assert.equal(validateFiveSessionSnapshot(result).valid, true);
    assert.deepEqual({
      attempted: diagnostics[0].precedingIntradayRecoveryAttempted,
      result: diagnostics[0].precedingIntradayRecoveryResult
    }, {attempted: true, result: 'SUCCESS'});
    assert.equal(diagnostics[0].precedingExpectedDate, '2026-09-22');
  }
});

test('preceding-session recovery rejects wrong-date, incomplete, malformed and conflicting responses', async () => {
  const cases = [
    {intradayResponse: intradayResponseFor('2026-09-21'), rejection: 'OUTSIDE_EXPECTED_SESSION'},
    {intradayResponse: intradayResponseFor('2026-09-22', {missingFinal: true}),
      rejection: 'INCOMPLETE_SESSION_COVERAGE'},
    {intradayResponse: intradayResponseFor('2026-09-22', {malformed: true}), rejection: 'MALFORMED_JSON'},
    {intradayResponse: intradayResponseFor('2026-09-22', {oversized: true}),
      rejection: 'RESPONSE_READ_OR_SIZE_FAILURE'},
    {intradayFailure: true, rejection: 'NETWORK_FAILURE'},
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, open: 100} : item),
      intradayResponse: intradayResponseFor('2026-09-22'),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    },
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, low: 0} : item),
      intradayResponse: intradayResponseFor('2026-09-22'),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    },
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, close: 0} : item),
      intradayResponse: intradayResponseFor('2026-09-22'),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    }
  ];
  for (const item of cases) {
    const diagnostics = [];
    const {service, calls} = serviceFor({
      market: 'US', instant: '2026-09-24T15:00:00Z',
      rows: item.rows || regularRowsWithSep23ValidSep22Invalid(),
      intradayResponse: item.intradayResponse,
      intradayFailure: item.intradayFailure,
      onDiagnostics: value => diagnostics.push(value)
    });
    const result = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(calls.length, 2);
    assert.equal(result.completedSessions.some(session => session.sessionDate === '2026-09-23'), false);
    assert.equal(result.primaryCompletedSessionDate, '2026-09-21');
    assert.equal(diagnostics[0].precedingIntradayRecoveryAttempted, true);
    assert.equal(diagnostics[0].precedingIntradayRecoveryResult, 'FAILURE');
    assert.equal(diagnostics[0].precedingIntradayRecoveryRejectionCategory, item.rejection);
  }
});

test('valid preceding daily close remains authoritative and avoids preceding-session recovery', async () => {
  const rows = regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
    ? row(item.date, 102, {time: '2026-09-22T13:30:00Z', open: 101, high: 104, low: 99, volume: 1000})
    : item);
  const diagnostics = [];
  const {service, calls} = serviceFor({
    market: 'US', instant: '2026-09-24T15:00:00Z', rows,
    intradayResponse: intradayResponseFor('2026-09-22'),
    onDiagnostics: value => diagnostics.push(value)
  });
  const result = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(calls.length, 1);
  assert.equal(result.completedSessions.at(-1).previousClose, 102);
  assert.equal(diagnostics[0].precedingIntradayRecoveryAttempted, false);
  assert.equal(diagnostics[0].precedingIntradayRecoveryGuardReason, 'PRECEDING_CLOSE_PRESENT');
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

// ── D-006: Fix A — recovery on real Yahoo data (closing print, no-trade minutes, tolerance) ──

test('D-006 real Yahoo intraday shape recovers using the closing print close, not the 15:59 bar', async () => {
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {closingClose: 105.5})
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  const session = snapshot.completedSessions.at(-1);
  assert.equal(session.sessionDate, '2026-09-22');
  assert.equal(session.open, 101);
  assert.equal(session.high, 105.5);
  assert.equal(session.low, 99);
  assert.equal(session.close, 105.5);
  assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
});

test('D-006 missing closing print returns MISSING_FINAL_REGULAR_OBSERVATION even with full regular-grid coverage', async () => {
  const diagnostics = [];
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {closingPrint: false}),
    onDiagnostics: value => diagnostics.push(value)
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, 'MISSING_FINAL_REGULAR_OBSERVATION');
  assert.equal(snapshot.completedSessions.at(-1).sessionDate, '2026-09-21');
});

test('D-006 an extra bar timestamped after the closing print still returns OUTSIDE_EXPECTED_SESSION', async () => {
  const diagnostics = [];
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {extraBarAfterClose: true}),
    onDiagnostics: value => diagnostics.push(value)
  });
  await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, 'OUTSIDE_EXPECTED_SESSION');
});

test('D-006 no-trade minutes are accepted, excluded from high/low, but still count toward coverage', async () => {
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {noTradeMinutes: [50, 51, 200]})
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  const session = snapshot.completedSessions.at(-1);
  assert.equal(session.sessionDate, '2026-09-22');
  assert.equal(session.open, 101);
  assert.equal(session.high, 104);
  assert.equal(session.low, 99);
  assert.equal(session.close, 103);
});

test('D-006 a partially null bar (not all four fields) is still rejected as INVALID_INTRADAY_OHLC', async () => {
  const diagnostics = [];
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {
      mutateBar: (bar, index) => { if (index === 50) bar.high = null; }
    }),
    onDiagnostics: value => diagnostics.push(value)
  });
  await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, 'INVALID_INTRADAY_OHLC');
});

test('D-006 a no-trade opening (09:30) bar is rejected as INVALID_INTRADAY_OHLC', async () => {
  const diagnostics = [];
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {noTradeMinutes: [0]}),
    onDiagnostics: value => diagnostics.push(value)
  });
  await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, 'INVALID_INTRADAY_OHLC');
});

test('D-006 AAPL EQUITY recovers with a partial daily row (open/high/low present, close null)', async () => {
  const {service} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullClose(),
    meta: {
      currency: 'USD', instrumentType: 'EQUITY',
      regularMarketPrice: 999999, regularMarketTime: epoch('2026-09-23T12:00:00Z')
    },
    intradayResponse: intradayResponseFor('2026-09-22')
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: 'AAPL'});
  const session = snapshot.completedSessions.at(-1);
  assert.equal(session.sessionDate, '2026-09-22');
  assert.equal(session.open, 101);
  assert.equal(session.high, 104);
  assert.equal(session.low, 99);
  assert.equal(session.close, 103);
  assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
});

const TOLERANCE_CASES = Object.freeze([
  {field: 'open', dailyValue: 101 * 1.0005, expectSuccess: true},
  {field: 'open', dailyValue: 101 * 1.002, expectSuccess: false},
  {field: 'high', dailyValue: 104 * 0.9995, expectSuccess: true},
  {field: 'high', dailyValue: 104 * 0.998, expectSuccess: false},
  {field: 'low', dailyValue: 99 * 1.0005, expectSuccess: true},
  {field: 'low', dailyValue: 99 * 1.002, expectSuccess: false}
]);

test('D-006 primary-row tolerance: small daily/intraday mismatches recover and keep the daily value; larger ones conflict', async () => {
  for (const {field, dailyValue, expectSuccess} of TOLERANCE_CASES) {
    const rows = preRowsWithSep22NullClose().map((item, index) =>
      index === 0 ? {...item, [field]: dailyValue} : item);
    const diagnostics = [];
    const {service} = serviceFor({
      market: 'US', instant: '2026-09-23T12:00:00Z', rows,
      intradayResponse: intradayResponseFor('2026-09-22'),
      onDiagnostics: value => diagnostics.push(value)
    });
    const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    const label = `${field} ${dailyValue}`;
    if (expectSuccess) {
      const session = snapshot.completedSessions.at(-1);
      assert.equal(session.sessionDate, '2026-09-22', label);
      assert.equal(session[field], dailyValue, label);
      assert.equal(diagnostics[0].intradayRecoveryResult, 'SUCCESS', label);
    } else {
      assert.equal(snapshot.completedSessions.some(item => item.sessionDate === '2026-09-22'), false, label);
      assert.equal(diagnostics[0].intradayRecoveryResult, 'FAILURE', label);
      assert.equal(diagnostics[0].intradayRecoveryRejectionCategory, 'DAILY_INTRADAY_OHLC_CONFLICT', label);
    }
  }
});

test('D-006 preceding-close tolerance: small mismatches recover the primary session; larger ones still exclude it', async () => {
  for (const {field, dailyValue, expectSuccess} of TOLERANCE_CASES) {
    const rows = regularRowsWithSep23ValidSep22Invalid().map(item =>
      item.date === '2026-09-22' ? {...item, [field]: dailyValue} : item);
    const diagnostics = [];
    const {service} = serviceFor({
      market: 'US', instant: '2026-09-24T15:00:00Z', rows,
      intradayResponse: intradayResponseFor('2026-09-22'),
      onDiagnostics: value => diagnostics.push(value)
    });
    const result = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    const label = `${field} ${dailyValue}`;
    if (expectSuccess) {
      assert.equal(result.completedSessions[0].sessionDate, '2026-09-23', label);
      assert.equal(result.completedSessions[0].previousClose, 103, label);
      assert.equal(diagnostics[0].precedingIntradayRecoveryResult, 'SUCCESS', label);
    } else {
      assert.equal(result.completedSessions.some(item => item.sessionDate === '2026-09-23'), false, label);
      assert.equal(result.primaryCompletedSessionDate, '2026-09-21', label);
      assert.equal(diagnostics[0].precedingIntradayRecoveryResult, 'FAILURE', label);
      assert.equal(diagnostics[0].precedingIntradayRecoveryRejectionCategory, 'DAILY_INTRADAY_OHLC_CONFLICT', label);
    }
  }
});

test('D-006 early-close day: the closing print follows the session close time, not a hardcoded 16:00', async () => {
  // The exchange calendar deliberately treats known US early-close dates (e.g. the day
  // after Thanksgiving) as UNSUPPORTED_SPECIAL_SESSION, so no real supported date closes
  // at 13:00. This verifies the mechanism is driven by sessionContext.regularCloseTime
  // generically (not hardcoded to 16:00) via dependency injection of getSessionContext.
  const normalContext = getSessionContext({market: 'US', exchangeDate: '2026-09-22'});
  const earlyCloseTime = new Date(Date.parse(normalContext.regularCloseTime) - 3 * 60 * 60 * 1000).toISOString();
  const earlyContext = {...normalContext, regularCloseTime: earlyCloseTime};
  const sessionContextOverride = params => {
    const context = getSessionContext(params);
    return context.exchangeDate === '2026-09-22'
      ? {...context, regularCloseTime: earlyCloseTime} : context;
  };
  const diagnostics = [];
  const {service, calls} = serviceFor({
    market: 'US', instant: '2026-09-23T12:00:00Z', rows: preRowsWithSep22NullOhlcv(),
    intradayResponse: intradayResponseFor('2026-09-22', {sessionContext: earlyContext, closingClose: 105}),
    sessionContextOverride,
    onDiagnostics: value => diagnostics.push(value)
  });
  const snapshot = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
  const session = snapshot.completedSessions.at(-1);
  assert.equal(session.sessionDate, '2026-09-22');
  assert.equal(session.close, 105);
  assert.equal(diagnostics[0].intradayRecoveryResult, 'SUCCESS');
  const expectedPeriod2 = Math.floor(Date.parse(earlyCloseTime) / 1000);
  assert.match(calls[1][0], new RegExp(`period2=${expectedPeriod2}&interval=1m$`));
});

test('D-006 existing conflict cases are unchanged: exact-magnitude mismatches still conflict', async () => {
  const cases = [
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, open: 100} : item),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    },
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, low: 0} : item),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    },
    {
      rows: regularRowsWithSep23ValidSep22Invalid().map(item => item.date === '2026-09-22'
        ? {...item, close: 0} : item),
      rejection: 'DAILY_INTRADAY_OHLC_CONFLICT'
    }
  ];
  for (const item of cases) {
    const diagnostics = [];
    const {service} = serviceFor({
      market: 'US', instant: '2026-09-24T15:00:00Z', rows: item.rows,
      intradayResponse: intradayResponseFor('2026-09-22'),
      onDiagnostics: value => diagnostics.push(value)
    });
    const result = await service.acquireSnapshot({market: 'US', symbol: '^DJI'});
    assert.equal(result.completedSessions.some(session => session.sessionDate === '2026-09-23'), false);
    assert.equal(diagnostics[0].precedingIntradayRecoveryRejectionCategory, item.rejection);
  }
});

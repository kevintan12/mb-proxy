const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETED_REGULAR_SESSION_KEYS,
  CURRENT_SESSION_OVERLAY_KEYS,
  THREE_SESSION_SNAPSHOT_KEYS,
  createCompletedRegularSession,
  validateCompletedRegularSession,
  createCurrentSessionOverlay,
  validateCurrentSessionOverlay,
  createThreeSessionSnapshot,
  validateThreeSessionSnapshot
} = require('../lib/three-session-snapshot');

function session(day = '04', overrides = {}) {
  return createCompletedRegularSession({
    market: 'SG',
    sessionDate: `2026-09-${day}`,
    open: 5700,
    high: 5800,
    low: 5650,
    close: 5747.7099609375,
    previousClose: 5710.3701171875,
    volume: 123456,
    asOf: `2026-09-${day}T17:00:00+08:00`,
    sourceId: 'sg.yahoo-finance',
    validationState: 'VALIDATED',
    ...overrides
  });
}

function overlay(overrides = {}) {
  return createCurrentSessionOverlay({
    market: 'SG',
    marketState: 'REGULAR',
    sessionDate: '2026-09-07',
    asOf: '2026-09-07T10:00:00+08:00',
    lastPrice: 5760,
    referenceClose: 5747.7099609375,
    volume: 0,
    sourceId: 'sg.yahoo-finance',
    validationState: 'LIVE_VALIDATED',
    ...overrides
  });
}

function snapshotInput(overrides = {}) {
  const first = session('02');
  const second = session('03', {previousClose: first.close});
  const third = session('04', {previousClose: second.close});
  return {
    market: 'SG',
    symbol: ' ^sti ',
    instrumentName: 'Straits Times Index',
    instrumentType: 'INDEX',
    currency: 'SGD',
    marketState: 'REGULAR',
    completedSessions: [first, second, third],
    currentOverlay: overlay({referenceClose: third.close}),
    ...overrides
  };
}

test('creates completed sessions with derived unrounded changes and canonical provenance', () => {
  const record = session();
  const expectedChange = 5747.7099609375 - 5710.3701171875;
  assert.deepEqual(Object.keys(record), COMPLETED_REGULAR_SESSION_KEYS);
  assert.equal(record.absoluteChange, expectedChange);
  assert.equal(record.percentChange, expectedChange / 5710.3701171875 * 100);
  assert.equal(record.asOf, '2026-09-04T09:00:00.000Z');
  assert.equal(record.provenance.applicableMarket, 'SG');
  assert.equal(validateCompletedRegularSession(JSON.parse(JSON.stringify(record)), 'SG').valid, true);
});

test('rejects caller-supplied changes or provenance and validates OHLC/date/source fields', () => {
  const base = {
    market: 'SG', sessionDate: '2026-09-04', open: 5700, high: 5800, low: 5650,
    close: 5747, previousClose: 5710, volume: null,
    asOf: '2026-09-04T17:00:00+08:00', sourceId: 'sg.yahoo-finance',
    validationState: 'VALIDATED'
  };
  assert.throws(() => createCompletedRegularSession({...base, absoluteChange: 37}), /derived/);
  assert.throws(() => createCompletedRegularSession({...base, provenance: {}}), /derived/);
  assert.throws(() => createCompletedRegularSession({...base, high: 5600}), /high|within/);
  assert.throws(() => createCompletedRegularSession({...base, volume: -1}), /volume/);
  assert.throws(() => createCompletedRegularSession({...base, asOf: '2026-09-05T17:00:00+08:00'}), /exchange-local/);
  assert.throws(() => createCompletedRegularSession({...base, sourceId: 'hk.yahoo-finance'}), /source/);
});

test('preserves nullable and zero volume and accepts open string vocabularies', () => {
  assert.equal(session('04', {volume: null, validationState: 'PROVIDER_CHECKED'}).volume, null);
  assert.equal(session('04', {volume: 0}).volume, 0);
  const current = overlay({marketState: 'Singapore Lunch Break', validationState: 'MORNING_SESSION'});
  assert.equal(current.marketState, 'Singapore Lunch Break');
  assert.equal(current.validationState, 'MORNING_SESSION');
});

test('creates runtime overlay separately with isFinal false and derived changes', () => {
  const current = overlay();
  assert.deepEqual(Object.keys(current), CURRENT_SESSION_OVERLAY_KEYS);
  assert.equal(current.isFinal, false);
  assert.equal(current.absoluteChange, current.lastPrice - current.referenceClose);
  assert.equal(current.percentChange, current.absoluteChange / current.referenceClose * 100);
  assert.equal(current.volume, 0);
  assert.equal(validateCurrentSessionOverlay(JSON.parse(JSON.stringify(current)), 'SG').valid, true);
  assert.throws(() => createCurrentSessionOverlay({
    market: 'SG', marketState: 'REGULAR', sessionDate: '2026-09-07',
    asOf: '2026-09-07T10:00:00+08:00', lastPrice: 1, referenceClose: 1,
    volume: null, isFinal: false, sourceId: 'sg.yahoo-finance', validationState: 'VALID'
  }), /derived/);
});

test('derives snapshot identity, oldest-to-newest primary date and completeness', () => {
  const snapshot = createThreeSessionSnapshot(snapshotInput());
  assert.deepEqual(Object.keys(snapshot), THREE_SESSION_SNAPSHOT_KEYS);
  assert.equal(snapshot.symbol, '^STI');
  assert.equal(snapshot.exchangeTimezone, 'Asia/Singapore');
  assert.equal(snapshot.primaryCompletedSessionDate, '2026-09-04');
  assert.equal(snapshot.completeness, 'COMPLETE');
  assert.deepEqual(snapshot.completedSessions.map(item => item.sessionDate), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.notEqual(snapshot.completedSessions, snapshotInput().completedSessions);
  assert.equal(validateThreeSessionSnapshot(JSON.parse(JSON.stringify(snapshot))).valid, true);
});

test('supports US and HK exchange timezones without closing string vocabularies', () => {
  const us = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-07-02', open: 200, high: 210, low: 195,
    close: 205, previousClose: 201, volume: null, asOf: '2026-07-03T00:30:00Z',
    sourceId: 'us.yahoo-finance', validationState: 'provider verified'
  });
  const usSnapshot = createThreeSessionSnapshot({
    market: 'US', symbol: ' aapl ', instrumentName: 'Apple Inc.',
    instrumentType: 'provider-neutral equity', currency: 'USD', marketState: 'After Hours',
    completedSessions: [us], currentOverlay: null
  });
  assert.equal(usSnapshot.exchangeTimezone, 'America/New_York');
  assert.equal(usSnapshot.instrumentType, 'provider-neutral equity');

  const hk = createCompletedRegularSession({
    market: 'HK', sessionDate: '0000-09-05', open: 25000, high: 26000, low: 24900,
    close: 25500, previousClose: 25200, volume: 0, asOf: '0000-09-05T12:00:00Z',
    sourceId: 'hk.yahoo-finance', validationState: 'VALID'
  });
  const hkSnapshot = createThreeSessionSnapshot({
    market: 'HK', symbol: '^hsi', instrumentName: 'Hang Seng Index', instrumentType: 'INDEX',
    currency: 'HKD', marketState: 'Closed for session', completedSessions: [hk], currentOverlay: null
  });
  assert.equal(hkSnapshot.exchangeTimezone, 'Asia/Hong_Kong');
  assert.equal(hkSnapshot.primaryCompletedSessionDate, '0000-09-05');
});

test('derives PARTIAL and UNAVAILABLE without manufacturing sessions', () => {
  const partial = createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('04')], currentOverlay: null, marketState: 'CLOSED'
  }));
  assert.equal(partial.completeness, 'PARTIAL');
  assert.equal(partial.primaryCompletedSessionDate, '2026-09-04');

  const unavailable = createThreeSessionSnapshot(snapshotInput({
    completedSessions: [], currentOverlay: null, marketState: 'HOLIDAY', currency: null
  }));
  assert.equal(unavailable.completeness, 'UNAVAILABLE');
  assert.equal(unavailable.primaryCompletedSessionDate, null);
  assert.deepEqual(unavailable.completedSessions, []);
});

test('rejects too many, duplicate, descending, wrong-market and mismatched overlays', () => {
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('01'), session('02'), session('03'), session('04')]
  })), /zero to three/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('03'), session('03')]
  })), /oldest to newest/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('04'), session('03')]
  })), /oldest to newest/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('03'), session('04')]
  })), /previousClose chain/);
  const hkSession = createCompletedRegularSession({
    market: 'HK', sessionDate: '2026-09-04', open: 25000, high: 26000, low: 24900,
    close: 25500, previousClose: 25200, volume: null,
    asOf: '2026-09-04T16:00:00+08:00', sourceId: 'hk.yahoo-finance', validationState: 'VALID'
  });
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({completedSessions: [hkSession]})), /completed session/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    currentOverlay: overlay({marketState: 'POST'})
  })), /current overlay/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    currentOverlay: overlay({referenceClose: 5700})
  })), /referenceClose/);
  assert.throws(() => createThreeSessionSnapshot(snapshotInput({
    completedSessions: [session('04')],
    currentOverlay: overlay({
      sessionDate: '2026-09-03', asOf: '2026-09-03T10:00:00+08:00',
      referenceClose: session('04').close
    })
  })), /cannot predate/);
});

test('rejects supplied aggregate derivatives and altered canonical output', () => {
  assert.throws(() => createThreeSessionSnapshot({
    ...snapshotInput(), completeness: 'COMPLETE'
  }), /derived/);
  const changed = JSON.parse(JSON.stringify(createThreeSessionSnapshot(snapshotInput())));
  changed.completedSessions[2].provenance.publisher = 'Spoof';
  assert.equal(validateThreeSessionSnapshot(changed).valid, false);
});

test('is deeply immutable, input-independent and has no S.tz dependency', () => {
  const input = snapshotInput();
  const oldS = global.S;
  global.S = {tz: 'Pacific/Honolulu'};
  try {
    const snapshot = createThreeSessionSnapshot(input);
    input.completedSessions.length = 0;
    assert.equal(snapshot.completedSessions.length, 3);
    assert.equal(snapshot.exchangeTimezone, 'Asia/Singapore');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.completedSessions), true);
    assert.equal(Object.isFrozen(snapshot.completedSessions[0].provenance), true);
    assert.equal(Object.isFrozen(snapshot.currentOverlay), true);
  } finally {
    if (oldS === undefined) delete global.S;
    else global.S = oldS;
  }
});

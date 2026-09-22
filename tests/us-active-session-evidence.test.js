const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor,
  parseUsActiveSessionAnchor,
  deriveUsActiveSessionEvidenceWindow,
  isTimestampWithinUsActiveSessionWindow
} = require('../lib/us-active-session-evidence');

function benchmark(marketState, asOf, {
  sessionDate = '2026-09-08',
  completedSessionDate = '2026-09-04',
  completedAsOf = '2026-09-04T20:00:00.000Z',
  hasOverlay = true
} = {}) {
  const completed = createCompletedRegularSession({
    market: 'US', sessionDate: completedSessionDate, open: 100, high: 105, low: 99,
    close: 104, previousClose: 100, volume: 1000,
    asOf: completedAsOf, sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  });
  const overlay = hasOverlay ? createCurrentSessionOverlay({
    market: 'US', marketState, sessionDate, asOf,
    lastPrice: 105, referenceClose: 104, volume: 200,
    sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }) : null;
  return createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState, completedSessions: [completed], currentOverlay: overlay
  });
}

test('derives one exchange-owned active evidence window for PRE, REGULAR and POST', () => {
  for (const [marketState, generatedAt, asOf] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z']
  ]) {
    const window = deriveUsActiveSessionEvidenceWindow({
      marketState,
      generatedAt,
      benchmarkSnapshots: [benchmark(marketState, asOf)]
    });
    assert.deepEqual(window, {
      marketState,
      sessionDate: '2026-09-08',
      startsAtInclusive: '2026-09-08T08:00:00.000Z',
      endsAtInclusive: generatedAt
    });
    assert.equal(Object.isFrozen(window), true);
  }
});

test('accepts only authoritative timestamps inside the active date window', () => {
  const window = deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt: '2026-09-08T15:00:00.000Z',
    benchmarkSnapshots: [benchmark('REGULAR', '2026-09-08T14:55:00.000Z')]
  });
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T07:59:59.999Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T08:00:00.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T14:59:59.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T15:00:00.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-05T14:00:00.000Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T15:00:00.001Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow(null, window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('not-a-timestamp', window), false);
});

test('keeps the 04:00 New York boundary across standard and daylight time', () => {
  for (const fixture of [{
    generatedAt: '2026-03-09T13:00:00.000Z',
    asOf: '2026-03-09T12:55:00.000Z',
    sessionDate: '2026-03-09',
    completedSessionDate: '2026-03-06',
    completedAsOf: '2026-03-06T21:00:00.000Z',
    expectedStart: '2026-03-09T08:00:00.000Z'
  }, {
    generatedAt: '2026-11-02T14:00:00.000Z',
    asOf: '2026-11-02T13:55:00.000Z',
    sessionDate: '2026-11-02',
    completedSessionDate: '2026-10-30',
    completedAsOf: '2026-10-30T20:00:00.000Z',
    expectedStart: '2026-11-02T09:00:00.000Z'
  }]) {
    const window = deriveUsActiveSessionEvidenceWindow({
      marketState: 'PRE',
      generatedAt: fixture.generatedAt,
      benchmarkSnapshots: [benchmark('PRE', fixture.asOf, fixture)]
    });
    assert.equal(window.startsAtInclusive, fixture.expectedStart);
    assert.equal(isTimestampWithinUsActiveSessionWindow(
      new Date(Date.parse(fixture.expectedStart) - 1).toISOString(), window
    ), false);
    assert.equal(isTimestampWithinUsActiveSessionWindow(fixture.expectedStart, window), true);
  }
});

test('accepts the REGULAR open boundary and generatedAt boundary', () => {
  const generatedAt = '2026-09-08T13:30:00.000Z';
  const window = deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt,
    benchmarkSnapshots: [benchmark('REGULAR', generatedAt)]
  });
  assert.equal(window.startsAtInclusive, '2026-09-08T08:00:00.000Z');
  assert.equal(window.endsAtInclusive, generatedAt);
  assert.equal(isTimestampWithinUsActiveSessionWindow(generatedAt, window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T13:30:00.001Z', window), false);
});

test('fails closed when declared and canonical active states disagree', () => {
  for (const [marketState, generatedAt, asOf] of [
    ['PRE', '2026-09-08T13:30:00.000Z', '2026-09-08T12:55:00.000Z'],
    ['REGULAR', '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.000Z'],
    ['POST', '2026-09-08T15:00:00.000Z', '2026-09-08T15:00:00.000Z']
  ]) {
    assert.equal(deriveUsActiveSessionEvidenceWindow({
      marketState,
      generatedAt,
      benchmarkSnapshots: [benchmark(marketState, asOf)]
    }), null);
  }
});

test('requires one matching overlay while allowing other benchmark overlays to be absent', () => {
  for (const [marketState, generatedAt, asOf] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z']
  ]) {
    assert.ok(deriveUsActiveSessionEvidenceWindow({
      marketState,
      generatedAt,
      benchmarkSnapshots: [
        benchmark(marketState, asOf),
        benchmark(marketState, asOf, {hasOverlay: false})
      ]
    }));
  }
});

test('allows zero overlays but rejects every present conflicting overlay state or date', () => {
  assert.ok(deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt: '2026-09-08T15:00:00.000Z',
    benchmarkSnapshots: [benchmark('REGULAR', '2026-09-08T14:55:00.000Z', {hasOverlay: false})]
  }));
  assert.equal(deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt: '2026-09-08T15:00:00.000Z',
    benchmarkSnapshots: [
      benchmark('REGULAR', '2026-09-08T14:55:00.000Z'),
      benchmark('PRE', '2026-09-08T12:55:00.000Z')
    ]
  }), null);
  assert.equal(deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt: '2026-09-08T15:00:00.000Z',
    benchmarkSnapshots: [
      benchmark('REGULAR', '2026-09-08T14:55:00.000Z'),
      {currentOverlay: {marketState: 'REGULAR', sessionDate: '2026-09-07'}}
    ]
  }), null);
});

test('serializes one stable package-owned anchor across later state transitions', () => {
  for (const fixture of [{
    marketState: 'PRE', cutoffAt: '2026-09-08T12:59:59.000Z',
    laterState: 'REGULAR', laterAt: '2026-09-08T13:31:00.000Z'
  }, {
    marketState: 'REGULAR', cutoffAt: '2026-09-08T19:59:59.000Z',
    laterState: 'POST', laterAt: '2026-09-08T20:01:00.000Z'
  }, {
    marketState: 'POST', cutoffAt: '2026-09-08T23:59:59.000Z',
    laterState: 'CLOSED', laterAt: '2026-09-09T00:01:00.000Z'
  }]) {
    const anchor = createUsActiveSessionAnchor(fixture);
    const serialized = serializeUsActiveSessionAnchor(anchor);
    assert.ok(serialized);
    assert.deepEqual(parseUsActiveSessionAnchor(serialized), anchor);
    assert.equal(anchor.marketState, fixture.marketState);
    assert.equal(anchor.endsAtInclusive, fixture.cutoffAt);
    assert.notEqual(fixture.marketState, fixture.laterState);
    assert.ok(Date.parse(fixture.laterAt) > Date.parse(anchor.endsAtInclusive));
    assert.equal(isTimestampWithinUsActiveSessionWindow(anchor.endsAtInclusive, anchor), true);
    assert.equal(isTimestampWithinUsActiveSessionWindow(fixture.laterAt, anchor), false);
  }
});

test('completed and unsupported states do not create an active evidence window', () => {
  for (const marketState of ['CLOSED', 'WEEKEND', 'HOLIDAY', 'UNSUPPORTED_SPECIAL_SESSION']) {
    assert.equal(deriveUsActiveSessionEvidenceWindow({
      marketState,
      generatedAt: '2026-09-08T15:00:00.000Z',
      benchmarkSnapshots: []
    }), null);
  }
});

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
  // 2026-09-08 is the Tuesday after the Monday 2026-09-07 Labor Day holiday, so the
  // previous trading day's close (used by PRE and REGULAR) is Friday 2026-09-04.
  for (const [marketState, generatedAt, asOf, expectedStart] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:30:00.000Z', '2026-09-04T20:00:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-04T20:00:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:00:00.000Z']
  ]) {
    const window = deriveUsActiveSessionEvidenceWindow({
      marketState,
      generatedAt,
      benchmarkSnapshots: [benchmark(marketState, asOf)]
    });
    assert.deepEqual(window, {
      marketState,
      sessionDate: '2026-09-08',
      startsAtInclusive: expectedStart,
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
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-04T19:59:59.999Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-04T20:00:00.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T14:59:59.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T15:00:00.000Z', window), true);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-03T14:00:00.000Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('2026-09-08T15:00:00.001Z', window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow(null, window), false);
  assert.equal(isTimestampWithinUsActiveSessionWindow('not-a-timestamp', window), false);
});

test('keeps the close-anchored boundary across standard and daylight time', () => {
  for (const fixture of [{
    generatedAt: '2026-03-09T13:00:00.000Z',
    asOf: '2026-03-09T12:55:00.000Z',
    sessionDate: '2026-03-09',
    completedSessionDate: '2026-03-06',
    completedAsOf: '2026-03-06T21:00:00.000Z',
    // Friday 2026-03-06 is still standard time (spring-forward is 2026-03-08): 16:00 EST = 21:00 UTC.
    expectedStart: '2026-03-06T21:00:00.000Z'
  }, {
    generatedAt: '2026-11-02T14:00:00.000Z',
    asOf: '2026-11-02T13:55:00.000Z',
    sessionDate: '2026-11-02',
    completedSessionDate: '2026-10-30',
    completedAsOf: '2026-10-30T20:00:00.000Z',
    // Friday 2026-10-30 is still daylight time (fall-back is 2026-11-01): 16:00 EDT = 20:00 UTC.
    expectedStart: '2026-10-30T20:00:00.000Z'
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

test('accepts the REGULAR open boundary and generatedAt boundary, anchored to the previous close', () => {
  const generatedAt = '2026-09-08T13:30:00.000Z';
  const window = deriveUsActiveSessionEvidenceWindow({
    marketState: 'REGULAR',
    generatedAt,
    benchmarkSnapshots: [benchmark('REGULAR', generatedAt)]
  });
  assert.equal(window.startsAtInclusive, '2026-09-04T20:00:00.000Z');
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

test('PRE on a Monday starts at the previous Friday close', () => {
  // 2026-09-14 is an ordinary Monday (no adjacent holiday); the previous trading
  // day is Friday 2026-09-11, close 16:00 EDT = 20:00 UTC.
  const generatedAt = '2026-09-14T12:00:00.000Z';
  const anchor = createUsActiveSessionAnchor({marketState: 'PRE', cutoffAt: generatedAt});
  assert.equal(anchor.sessionDate, '2026-09-14');
  assert.equal(anchor.startsAtInclusive, '2026-09-11T20:00:00.000Z');
});

test('PRE the day after a Monday holiday starts at the prior Friday close', () => {
  // 2026-09-08 is the Tuesday after the Monday 2026-09-07 Labor Day holiday, so the
  // weekend and the holiday are both skipped back to Friday 2026-09-04's close.
  const generatedAt = '2026-09-08T12:00:00.000Z';
  const anchor = createUsActiveSessionAnchor({marketState: 'PRE', cutoffAt: generatedAt});
  assert.equal(anchor.sessionDate, '2026-09-08');
  assert.equal(anchor.startsAtInclusive, '2026-09-04T20:00:00.000Z');
});

test('POST starts at today\'s own close, not the previous trading day\'s', () => {
  const generatedAt = '2026-09-08T21:00:00.000Z';
  const anchor = createUsActiveSessionAnchor({marketState: 'POST', cutoffAt: generatedAt});
  assert.equal(anchor.sessionDate, '2026-09-08');
  assert.equal(anchor.startsAtInclusive, '2026-09-08T20:00:00.000Z');
});

test('REGULAR starts at the previous close, same as PRE, so weekend news is not lost intraday', () => {
  // 2026-09-15 is an ordinary Tuesday; the previous trading day is Monday
  // 2026-09-14, close 16:00 EDT = 20:00 UTC.
  const generatedAt = '2026-09-15T14:00:00.000Z';
  const anchor = createUsActiveSessionAnchor({marketState: 'REGULAR', cutoffAt: generatedAt});
  assert.equal(anchor.sessionDate, '2026-09-15');
  assert.equal(anchor.startsAtInclusive, '2026-09-14T20:00:00.000Z');
});

test('an early-close day is skipped like a holiday, widening the window to the last fully-modeled close', () => {
  // 2026-11-30 is the Monday after Black Friday 2026-11-27 (an UNSUPPORTED_SPECIAL_SESSION_DATES
  // early-close day whose exact close time this checkpoint deliberately does not model) and
  // Thanksgiving 2026-11-26 (a full holiday). The walk-back skips both and the weekend,
  // landing on Wednesday 2026-11-25's ordinary close: 16:00 EST = 21:00 UTC (standard time,
  // since DST ended 2026-11-01).
  const generatedAt = '2026-11-30T12:00:00.000Z';
  const anchor = createUsActiveSessionAnchor({marketState: 'PRE', cutoffAt: generatedAt});
  assert.equal(anchor.sessionDate, '2026-11-30');
  assert.equal(anchor.startsAtInclusive, '2026-11-25T21:00:00.000Z');
});

test('V2 is produced for every newly created anchor', () => {
  for (const [marketState, cutoffAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z']
  ]) {
    const serialized = serializeUsActiveSessionAnchor(createUsActiveSessionAnchor({marketState, cutoffAt}));
    assert.ok(serialized.startsWith('US_ACTIVE_SESSION_V2:'));
  }
});

test('a previously serialized V1 anchor still parses and replays with its original (non-close-anchored) window', () => {
  // Built with the OLD (pre-Step-8K.2) window math: PRE-session-start (04:00 ET) of the
  // same exchange date, which is what US_ACTIVE_SESSION_V1 anchors saved in earlier
  // Replay Packages actually contain. This must keep parsing to the SAME narrow window,
  // never the new V2 close-anchored one, so saved replays are unaffected.
  const legacyBody = {
    marketState: 'PRE',
    sessionDate: '2026-09-08',
    startsAtInclusive: '2026-09-08T08:00:00.000Z',
    endsAtInclusive: '2026-09-08T12:00:00.000Z'
  };
  const v1Anchor = `US_ACTIVE_SESSION_V1:${JSON.stringify(legacyBody)}`;
  const parsed = parseUsActiveSessionAnchor(v1Anchor);
  assert.deepEqual(parsed, legacyBody);
  // The V2 anchor for the identical cutoff is close-anchored and starts far earlier.
  const v2Equivalent = createUsActiveSessionAnchor({
    marketState: legacyBody.marketState, cutoffAt: legacyBody.endsAtInclusive
  });
  assert.notEqual(parsed.startsAtInclusive, v2Equivalent.startsAtInclusive);
  assert.equal(v2Equivalent.startsAtInclusive, '2026-09-04T20:00:00.000Z');
});

test('a tampered or non-canonical V1 anchor still fails closed', () => {
  const tampered = 'US_ACTIVE_SESSION_V1:' + JSON.stringify({
    marketState: 'PRE',
    sessionDate: '2026-09-08',
    startsAtInclusive: '2026-09-08T00:00:00.000Z',
    endsAtInclusive: '2026-09-08T12:00:00.000Z'
  });
  assert.equal(parseUsActiveSessionAnchor(tampered), null);
  assert.equal(parseUsActiveSessionAnchor('not-an-anchor'), null);
  assert.equal(parseUsActiveSessionAnchor(null), null);
});

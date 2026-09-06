const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MARKET_TIME_ZONES,
  COMPLETED_SESSION_TELEMETRY_KEYS,
  createCompletedSessionTelemetry,
  validateCompletedSessionTelemetryInput
} = require('../lib/completed-session-telemetry');

function validInput(overrides = {}) {
  return {
    market: 'SG',
    symbol: '^STI',
    sessionDate: '2026-09-04',
    close: 5747.7099609375,
    closeTime: '2026-09-04T17:00:00+08:00',
    sourceId: 'sg.yahoo-finance',
    ...overrides
  };
}

test('creates valid deterministic US, SG and HK telemetry records', () => {
  const cases = [
    validInput(),
    validInput({
      market: 'US', symbol: '^GSPC', sessionDate: '2026-09-04', close: 6502.08,
      closeTime: '2026-09-04T16:00:00-04:00', sourceId: 'us.yahoo-finance'
    }),
    validInput({
      market: 'HK', symbol: '^HSI', sessionDate: '2026-09-04', close: 25417.98,
      closeTime: '2026-09-04T16:00:00+08:00', sourceId: 'hk.yahoo-finance'
    })
  ];

  for (const input of cases) {
    const record = createCompletedSessionTelemetry(input);
    assert.deepEqual(Object.keys(record), COMPLETED_SESSION_TELEMETRY_KEYS);
    assert.equal(record.market, input.market);
    assert.equal(record.sourceId, input.sourceId);
    assert.equal(record.provenance.applicableMarket, input.market);
    assert.equal(validateCompletedSessionTelemetryInput(input).valid, true);
  }
});

test('normalizes symbols and canonicalizes closeTime to UTC Z', () => {
  const record = createCompletedSessionTelemetry(validInput({symbol: '  d05.si  '}));
  assert.equal(record.symbol, 'D05.SI');
  assert.equal(record.closeTime, '2026-09-04T09:00:00.000Z');
});

test('aligns sessionDate using exchange timezone including US DST and UTC date crossover', () => {
  const record = createCompletedSessionTelemetry(validInput({
    market: 'US',
    symbol: 'AAPL',
    sessionDate: '2026-07-02',
    close: 250,
    closeTime: '2026-07-03T00:30:00Z',
    sourceId: 'us.yahoo-finance'
  }));
  assert.equal(record.closeTime, '2026-07-03T00:30:00.000Z');
  assert.equal(record.sessionDate, '2026-07-02');
  assert.equal(MARKET_TIME_ZONES.US, 'America/New_York');

  const mismatch = validateCompletedSessionTelemetryInput(validInput({
    market: 'US',
    symbol: 'AAPL',
    sessionDate: '2026-07-03',
    closeTime: '2026-07-03T00:30:00Z',
    sourceId: 'us.yahoo-finance'
  }));
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.includes('sessionDate does not match closeTime exchange-local date'));
});

test('aligns astronomical year 0000 and sub-1000 years to canonical YYYY', () => {
  const yearZero = createCompletedSessionTelemetry(validInput({
    sessionDate: '0000-09-05',
    closeTime: '0000-09-05T12:00:00Z'
  }));
  assert.equal(yearZero.sessionDate, '0000-09-05');
  assert.equal(yearZero.closeTime, '0000-09-05T12:00:00.000Z');

  const sub1000 = createCompletedSessionTelemetry(validInput({
    sessionDate: '0099-09-05',
    closeTime: '0099-09-05T12:00:00Z'
  }));
  assert.equal(sub1000.sessionDate, '0099-09-05');
  assert.equal(sub1000.closeTime, '0099-09-05T12:00:00.000Z');
});

test('rejects invalid session dates, timestamps and close values', () => {
  for (const sessionDate of ['2026-02-30', '2026-9-04', 'not-a-date']) {
    assert.equal(validateCompletedSessionTelemetryInput(validInput({sessionDate})).valid, false);
  }
  for (const closeTime of ['2026-09-04T17:00:00', '2026-02-30T17:00:00+08:00', 'not-a-time']) {
    assert.equal(validateCompletedSessionTelemetryInput(validInput({closeTime})).valid, false);
  }
  for (const close of [0, -1, NaN, Infinity, '5747.7']) {
    assert.equal(validateCompletedSessionTelemetryInput(validInput({close})).valid, false);
  }
});

test('rejects unknown and market-incompatible sources', () => {
  assert.equal(validateCompletedSessionTelemetryInput(validInput({sourceId: 'sg.unknown'})).valid, false);
  const mismatch = validateCompletedSessionTelemetryInput(validInput({sourceId: 'us.yahoo-finance'}));
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.includes('source does not support market'));
});

test('derives provenance and rejects caller overrides', () => {
  const record = createCompletedSessionTelemetry(validInput());
  assert.deepEqual(record.provenance, {
    publisher: 'Yahoo',
    authority: 'secondary',
    homepage: 'https://finance.yahoo.com/',
    applicableMarket: 'SG',
    sourceJurisdiction: 'GLOBAL',
    locator: 'source-homepage'
  });
  const spoofed = validateCompletedSessionTelemetryInput(validInput({provenance: {publisher: 'Spoof'}}));
  assert.equal(spoofed.valid, false);
  assert.ok(spoofed.errors.includes('provenance is derived and must not be supplied'));
});

test('returns deeply immutable input-independent records', () => {
  const input = validInput();
  const record = createCompletedSessionTelemetry(input);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.provenance), true);
  assert.notEqual(record.provenance, input.provenance);
  input.symbol = 'MUTATED';
  input.sourceId = 'us.yahoo-finance';
  assert.equal(record.symbol, '^STI');
  assert.equal(record.sourceId, 'sg.yahoo-finance');
  assert.equal(Reflect.set(record.provenance, 'publisher', 'Mutated'), false);
  assert.equal(record.provenance.publisher, 'Yahoo');

  const validation = validateCompletedSessionTelemetryInput(validInput());
  assert.equal(Object.isFrozen(validation), true);
  assert.equal(Object.isFrozen(validation.errors), true);
});

test('uses fixed exchange IANA zones and never depends on global S.tz', () => {
  const previousS = global.S;
  global.S = {tz: 'Pacific/Honolulu'};
  try {
    const record = createCompletedSessionTelemetry(validInput());
    assert.equal(record.sessionDate, '2026-09-04');
    assert.equal(MARKET_TIME_ZONES.SG, 'Asia/Singapore');
    assert.equal(MARKET_TIME_ZONES.HK, 'Asia/Hong_Kong');
  } finally {
    if (previousS === undefined) delete global.S;
    else global.S = previousS;
  }
});

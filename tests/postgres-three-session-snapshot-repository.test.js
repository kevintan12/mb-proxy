const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {createCompletedRegularSession} = require('../lib/three-session-snapshot');
const {
  createPostgresThreeSessionSnapshotRepository
} = require('../lib/postgres-three-session-snapshot-repository');

function session(day = '04', overrides = {}) {
  return createCompletedRegularSession({
    market: 'SG', sessionDate: `2026-09-${day}`, open: 5700, high: 5800, low: 5650,
    close: 5740 + Number(day), previousClose: 5700, volume: null,
    asOf: `2026-09-${day}T09:00:00Z`, sourceId: 'sg.yahoo-finance',
    validationState: 'VALIDATED', ...overrides
  });
}

function createMemoryPostgres() {
  let records = new Map();
  const calls = [];
  let failOn = null;
  const key = (market, symbol, date) => `${market}|${symbol}|${date}`;

  async function execute(sql, parameters, scope) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({sql: normalized, parameters: parameters.slice(), scope});
    if (failOn && normalized.includes(failOn)) throw new Error(`forced ${failOn} failure`);
    if (normalized.includes('pg_advisory_xact_lock')) return {rows: []};
    if (normalized.startsWith('INSERT INTO three_session_snapshot_sessions')) {
      const [market, symbol, sessionDate, open, high, low, close, previousClose,
        volume, asOf, sourceId, validationState] = parameters;
      records.set(key(market, symbol, sessionDate), {
        market, symbol, session_date: sessionDate, open_value: open, high_value: high,
        low_value: low, close_value: close, previous_close_value: previousClose,
        volume_value: volume, as_of_time: asOf, source_id: sourceId,
        validation_state: validationState
      });
      return {rows: []};
    }
    if (normalized.startsWith('DELETE FROM three_session_snapshot_sessions')) {
      const [market, symbol] = parameters;
      const matching = [...records.values()]
        .filter(row => row.market === market && row.symbol === symbol)
        .sort((a, b) => b.session_date.localeCompare(a.session_date));
      matching.slice(3).forEach(row => records.delete(key(row.market, row.symbol, row.session_date)));
      return {rows: []};
    }
    if (normalized.startsWith('SELECT market, symbol, session_date')) {
      const [market, symbol] = parameters;
      return {rows: [...records.values()]
        .filter(row => row.market === market && row.symbol === symbol)
        .sort((a, b) => b.session_date.localeCompare(a.session_date))
        .slice(0, 3)
        .reverse()
        .map(row => ({...row}))};
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  }

  return {
    calls,
    query: (sql, parameters) => execute(sql, parameters, 'read'),
    transaction: async callback => {
      const before = new Map([...records].map(([recordKey, value]) => [recordKey, {...value}]));
      try {
        return await callback((sql, parameters) => execute(sql, parameters, 'transaction'));
      } catch (error) {
        records = before;
        throw error;
      }
    },
    rows: () => [...records.values()].map(row => ({...row})),
    failNextOn(fragment) { failOn = fragment; },
    clearFailure() { failOn = null; }
  };
}

test('validates canonical input before transaction and uses parameterized SQL', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresThreeSessionSnapshotRepository(database);
  await repository.upsert({market: ' sg ', symbol: ' ^sti ', session: session()});
  assert.equal(database.calls.length, 3);
  assert.match(database.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(database.calls[1].sql, /^INSERT INTO three_session_snapshot_sessions/);
  assert.match(database.calls[2].sql, /^DELETE FROM three_session_snapshot_sessions/);
  assert.deepEqual(database.calls[0].parameters, ['SG', '^STI']);
  assert.equal(database.calls.every(call => call.scope === 'transaction'), true);
  assert.equal(database.calls.every(call => !call.sql.includes('^STI')), true);

  const spoofed = JSON.parse(JSON.stringify(session()));
  spoofed.provenance.publisher = 'Spoof';
  const count = database.calls.length;
  await assert.rejects(repository.upsert({market: 'SG', symbol: '^STI', session: spoofed}), /Invalid canonical/);
  assert.equal(database.calls.length, count);
});

test('persists primitive facts only and replaces a complete same-session row', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresThreeSessionSnapshotRepository(database);
  await repository.upsert({market: 'SG', symbol: '^STI', session: session()});
  await repository.upsert({market: 'SG', symbol: '^STI', session: session('04', {
    open: 5710, high: 5900, low: 5700, close: 5800, previousClose: 5744,
    volume: 999, sourceId: 'sg.reuters', validationState: 'REVALIDATED'
  })});
  assert.equal(database.rows().length, 1);
  const row = database.rows()[0];
  assert.equal(row.close_value, 5800);
  assert.equal(row.source_id, 'sg.reuters');
  assert.equal(row.validation_state, 'REVALIDATED');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'absolute_change'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'percent_change'), false);
});

test('retains newest three independently and returns them oldest to newest', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresThreeSessionSnapshotRepository(database);
  for (const day of ['01', '02', '03', '04']) {
    await repository.upsert({market: 'SG', symbol: '^STI', session: session(day)});
  }
  await repository.upsert({market: 'SG', symbol: 'D05.SI', session: session('01')});
  const stiRows = database.rows().filter(row => row.symbol === '^STI');
  assert.deepEqual(stiRows.map(row => row.session_date).sort(), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.equal(database.rows().some(row => row.symbol === 'D05.SI'), true);

  const result = await repository.listLatest({market: ' sg ', symbol: ' ^sti '});
  assert.deepEqual(result.map(item => item.sessionDate), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  const read = database.calls.at(-1);
  assert.match(read.sql, /ORDER BY session_date DESC LIMIT 3.*ORDER BY session_date ASC/);
  assert.deepEqual(read.parameters, ['SG', '^STI']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.every(item => Object.isFrozen(item) && Object.isFrozen(item.provenance)), true);
});

test('keeps upsert and prune atomic and propagates failures', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresThreeSessionSnapshotRepository(database);
  await repository.upsert({market: 'SG', symbol: '^STI', session: session()});
  database.failNextOn('DELETE FROM three_session_snapshot_sessions');
  await assert.rejects(repository.upsert({market: 'SG', symbol: '^STI', session: session('04', {
    close: 5790
  })}), /forced DELETE/);
  database.clearFailure();
  assert.equal(database.rows()[0].close_value, 5744);
});

test('rejects stored rows whose key does not match the requested key', async () => {
  const repository = createPostgresThreeSessionSnapshotRepository({
    query: async () => ({rows: [{
      market: 'HK', symbol: '^HSI', session_date: '2026-09-04',
      open_value: 25000, high_value: 26000, low_value: 24900, close_value: 25500,
      previous_close_value: 25200, volume_value: null,
      as_of_time: '2026-09-04T08:00:00.000Z', source_id: 'hk.yahoo-finance',
      validation_state: 'VALIDATED'
    }]}),
    transaction: async callback => callback(async () => ({rows: []}))
  });
  await assert.rejects(repository.listLatest({market: 'SG', symbol: '^STI'}), /does not match/);
});

test('migration is additive, constrained and stores no derived or overlay fields', () => {
  const migration = fs.readFileSync(path.join(
    __dirname, '..', 'db', 'migrations', '002_three_session_snapshot.sql'
  ), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS three_session_snapshot_sessions/);
  assert.match(migration, /session_date TEXT NOT NULL/);
  assert.match(migration, /as_of_time TEXT NOT NULL/);
  assert.match(migration, /open_value DOUBLE PRECISION NOT NULL/);
  assert.match(migration, /volume_value DOUBLE PRECISION NULL/);
  assert.match(migration, /PRIMARY KEY \(market, symbol, session_date\)/);
  assert.match(migration, /session_date DESC/);
  assert.doesNotMatch(migration, /absolute_change|percent_change|current_overlay/i);
  assert.doesNotMatch(migration, /\bDATE\b|TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE/i);

  const firstMigration = fs.readFileSync(path.join(
    __dirname, '..', 'db', 'migrations', '001_completed_session_telemetry.sql'
  ), 'utf8');
  assert.doesNotMatch(migration, /ALTER TABLE completed_session_telemetry/i);
  assert.match(firstMigration, /CREATE TABLE IF NOT EXISTS completed_session_telemetry/);
});

test('repository remains generic PostgreSQL with no Neon-specific code', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'lib', 'postgres-three-session-snapshot-repository.js'
  ), 'utf8');
  assert.doesNotMatch(source, /@neondatabase|\bneon\b/i);
});

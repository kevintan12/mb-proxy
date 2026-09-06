const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {createCompletedSessionTelemetry} = require('../lib/completed-session-telemetry');
const {
  createPostgresCompletedSessionTelemetryRepository
} = require('../lib/postgres-completed-session-telemetry-repository');

function telemetry(overrides = {}) {
  return createCompletedSessionTelemetry({
    market: 'SG',
    symbol: '^STI',
    sessionDate: '2026-09-04',
    close: 5747.7099609375,
    closeTime: '2026-09-04T09:00:00Z',
    sourceId: 'sg.yahoo-finance',
    ...overrides
  });
}

function createMemoryPostgres() {
  let records = new Map();
  const calls = [];
  let failOn = null;

  function recordKey(market, symbol, sessionDate) {
    return `${market}|${symbol}|${sessionDate}`;
  }

  async function execute(sql, parameters, scope) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    calls.push({sql: normalizedSql, parameters: parameters.slice(), scope});
    if (failOn && normalizedSql.includes(failOn)) throw new Error(`forced ${failOn} failure`);

    if (normalizedSql.includes('pg_advisory_xact_lock')) return {rows: []};
    if (normalizedSql.startsWith('INSERT INTO completed_session_telemetry')) {
      const [market, symbol, sessionDate, close, closeTime, sourceId] = parameters;
      records.set(recordKey(market, symbol, sessionDate), {
        market,
        symbol,
        session_date: sessionDate,
        close_value: close,
        close_time: closeTime,
        source_id: sourceId
      });
      return {rows: []};
    }
    if (normalizedSql.startsWith('DELETE FROM completed_session_telemetry')) {
      const [market, symbol] = parameters;
      const matching = [...records.values()]
        .filter(row => row.market === market && row.symbol === symbol)
        .sort((left, right) => right.session_date.localeCompare(left.session_date));
      for (const row of matching.slice(3)) {
        records.delete(recordKey(row.market, row.symbol, row.session_date));
      }
      return {rows: []};
    }
    if (normalizedSql.startsWith('SELECT market, symbol, session_date')) {
      const [market, symbol] = parameters;
      return {
        rows: [...records.values()]
          .filter(row => row.market === market && row.symbol === symbol)
          .sort((left, right) => right.session_date.localeCompare(left.session_date))
          .slice(0, 3)
          .map(row => ({...row}))
      };
    }
    throw new Error(`unexpected SQL: ${normalizedSql}`);
  }

  return {
    calls,
    query: (sql, parameters) => execute(sql, parameters, 'read'),
    transaction: async callback => {
      const snapshot = new Map([...records].map(([key, value]) => [key, {...value}]));
      try {
        return await callback((sql, parameters) => execute(sql, parameters, 'transaction'));
      } catch (error) {
        records = snapshot;
        throw error;
      }
    },
    failNextOn(sqlFragment) {
      failOn = sqlFragment;
    },
    clearFailure() {
      failOn = null;
    },
    rows() {
      return [...records.values()].map(row => ({...row}));
    }
  };
}

test('accepts canonical records and rejects altered or spoofed records before a transaction', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresCompletedSessionTelemetryRepository(database);
  await repository.upsert(telemetry());
  assert.equal(database.rows().length, 1);

  const spoofed = JSON.parse(JSON.stringify(telemetry()));
  spoofed.provenance.publisher = 'Spoof';
  const callCount = database.calls.length;
  await assert.rejects(repository.upsert(spoofed), /Invalid canonical/);
  assert.equal(database.calls.length, callCount);

  const nonCanonical = JSON.parse(JSON.stringify(telemetry()));
  nonCanonical.symbol = ' ^sti ';
  await assert.rejects(repository.upsert(nonCanonical), /non-canonical symbol/);
});

test('uses parameterized SQL and locks before atomic upsert and prune', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresCompletedSessionTelemetryRepository(database);
  await repository.upsert(telemetry());

  assert.equal(database.calls.length, 3);
  assert.match(database.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(database.calls[1].sql, /^INSERT INTO completed_session_telemetry/);
  assert.match(database.calls[2].sql, /^DELETE FROM completed_session_telemetry/);
  assert.deepEqual(database.calls[0].parameters, ['SG', '^STI']);
  assert.deepEqual(database.calls[1].parameters, [
    'SG', '^STI', '2026-09-04', 5747.7099609375, '2026-09-04T09:00:00.000Z',
    'sg.yahoo-finance'
  ]);
  assert.equal(database.calls.every(call => call.scope === 'transaction'), true);
  assert.equal(database.calls.every(call => !call.sql.includes('^STI')), true);
});

test('retains the latest three sessions independently per market and symbol', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresCompletedSessionTelemetryRepository(database);
  for (const day of ['01', '02', '03', '04']) {
    await repository.upsert(telemetry({
      sessionDate: `2026-09-${day}`,
      close: 5700 + Number(day),
      closeTime: `2026-09-${day}T09:00:00Z`
    }));
  }
  await repository.upsert(telemetry({
    symbol: 'D05.SI', sessionDate: '2026-09-01', close: 40,
    closeTime: '2026-09-01T09:00:00Z'
  }));
  await repository.upsert(telemetry({
    market: 'HK', symbol: '^HSI', sessionDate: '2026-09-01', close: 25000,
    closeTime: '2026-09-01T08:00:00Z', sourceId: 'hk.yahoo-finance'
  }));

  const stiRows = database.rows().filter(row => row.market === 'SG' && row.symbol === '^STI');
  assert.deepEqual(stiRows.map(row => row.session_date).sort(), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.equal(database.rows().some(row => row.symbol === 'D05.SI'), true);
  assert.equal(database.rows().some(row => row.market === 'HK'), true);
});

test('same-session upsert replaces close, closeTime and source', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresCompletedSessionTelemetryRepository(database);
  await repository.upsert(telemetry());
  await repository.upsert(telemetry({
    close: 5750,
    closeTime: '2026-09-04T09:01:00Z',
    sourceId: 'sg.reuters'
  }));

  assert.equal(database.rows().length, 1);
  assert.deepEqual(database.rows()[0], {
    market: 'SG',
    symbol: '^STI',
    session_date: '2026-09-04',
    close_value: 5750,
    close_time: '2026-09-04T09:01:00.000Z',
    source_id: 'sg.reuters'
  });
});

test('reads newest sessions descending with SQL LIMIT 3 and immutable reconstruction', async () => {
  const rows = ['01', '02', '03', '04'].map(day => ({
    market: 'SG',
    symbol: '^STI',
    session_date: `2026-09-${day}`,
    close_value: 5700 + Number(day),
    close_time: `2026-09-${day}T09:00:00.000Z`,
    source_id: 'sg.yahoo-finance'
  })).reverse();
  const calls = [];
  const repository = createPostgresCompletedSessionTelemetryRepository({
    query: async (sql, parameters) => {
      calls.push({sql, parameters});
      return {rows};
    },
    transaction: async callback => callback(async () => ({rows: []}))
  });

  const result = await repository.listLatest({market: ' sg ', symbol: ' ^sti '});
  assert.match(calls[0].sql, /ORDER BY session_date DESC\s+LIMIT 3/);
  assert.deepEqual(calls[0].parameters, ['SG', '^STI']);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(record => record.sessionDate), [
    '2026-09-04', '2026-09-03', '2026-09-02'
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.every(record => Object.isFrozen(record) && Object.isFrozen(record.provenance)), true);
  assert.equal(result[0].provenance.publisher, 'Yahoo');
});

test('propagates transaction failures and rolls back upsert plus prune atomically', async () => {
  const database = createMemoryPostgres();
  const repository = createPostgresCompletedSessionTelemetryRepository(database);
  await repository.upsert(telemetry());
  database.failNextOn('DELETE FROM completed_session_telemetry');

  await assert.rejects(repository.upsert(telemetry({close: 5800})), /forced DELETE/);
  database.clearFailure();
  assert.equal(database.rows().length, 1);
  assert.equal(database.rows()[0].close_value, 5747.7099609375);
});

test('migration uses constrained canonical text storage, primary key and latest index', () => {
  const migration = fs.readFileSync(path.join(
    __dirname, '..', 'db', 'migrations', '001_completed_session_telemetry.sql'
  ), 'utf8');
  assert.match(migration, /session_date TEXT NOT NULL/);
  assert.match(migration, /session_date ~ '\^\[0-9\]\{4\}/);
  assert.match(migration, /close_time TEXT NOT NULL/);
  assert.match(migration, /\\\.\[0-9\]\{3\}Z\$'/);
  assert.match(migration, /PRIMARY KEY \(market, symbol, session_date\)/);
  assert.match(migration, /CHECK \(market IN \('US', 'SG', 'HK'\)\)/);
  assert.match(migration, /close_value > 0/);
  assert.match(migration, /session_date DESC/);
  assert.doesNotMatch(migration, /\bDATE\b|TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE/i);
});

test('repository remains generic PostgreSQL code with no Neon-specific import', () => {
  const repositorySource = fs.readFileSync(path.join(
    __dirname, '..', 'lib', 'postgres-completed-session-telemetry-repository.js'
  ), 'utf8');
  assert.doesNotMatch(repositorySource, /require\(['"](?:@neondatabase|neon)|from ['"](?:@neondatabase|neon)/i);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  POOL_CONFIG,
  PostgresRuntimeError,
  createPostgresRuntime,
  getPostgresRuntime
} = require('../lib/postgres-runtime');
const {
  createPostgresThreeSessionSnapshotRepository
} = require('../lib/postgres-three-session-snapshot-repository');

function fakeDatabase() {
  const poolCalls = [];
  const clientCalls = [];
  const instances = [];
  let released = 0;
  class Pool {
    constructor(config) {
      this.config = config;
      instances.push(this);
    }
    async query(text, parameters) {
      poolCalls.push({text, parameters});
      return {rows: []};
    }
    async connect() {
      return {
        query: async (text, parameters) => {
          clientCalls.push({text, parameters});
          return {rows: []};
        },
        release: () => { released += 1; }
      };
    }
    async end() {}
  }
  return {Pool, poolCalls, clientCalls, instances, released: () => released};
}

test('creates one bounded pool lazily, reuses it and attaches it once', async () => {
  const database = fakeDatabase();
  const attached = [];
  const runtime = createPostgresRuntime({
    environment: {DATABASE_URL: 'postgresql://user:secret@db.example/app'},
    PoolClass: database.Pool,
    attachDatabasePool: pool => attached.push(pool)
  });
  assert.equal(database.instances.length, 0);
  await runtime.query('SELECT $1', [1]);
  await runtime.query('SELECT $1', [2]);
  assert.equal(database.instances.length, 1);
  assert.deepEqual(database.instances[0].config, {
    connectionString: 'postgresql://user:secret@db.example/app',
    ...POOL_CONFIG
  });
  assert.equal(POOL_CONFIG.max, 4);
  assert.equal(attached.length, 1);
  assert.equal(attached[0], database.instances[0]);
});

test('default runtime adapter is a module-level warm-instance singleton', () => {
  assert.equal(getPostgresRuntime(), getPostgresRuntime());
});

test('rejects missing or blank DATABASE_URL before constructing a pool', async () => {
  for (const environment of [{}, {DATABASE_URL: '   '}]) {
    const database = fakeDatabase();
    const runtime = createPostgresRuntime({environment, PoolClass: database.Pool, attachDatabasePool: null});
    await assert.rejects(runtime.query('SELECT 1'), error => {
      assert.equal(error instanceof PostgresRuntimeError, true);
      assert.equal(error.code, 'DATABASE_URL_MISSING');
      assert.doesNotMatch(error.message, /secret|postgresql:\/\//);
      return true;
    });
    assert.equal(database.instances.length, 0);
  }
});

test('delegates queries and runs transactions on one acquired client', async () => {
  const database = fakeDatabase();
  const runtime = createPostgresRuntime({
    environment: {DATABASE_URL: 'postgresql://db/app'},
    PoolClass: database.Pool,
    attachDatabasePool: null
  });
  await runtime.query('SELECT $1', ['value']);
  const result = await runtime.transaction(async client => {
    await client.query('INSERT INTO example VALUES ($1)', [7]);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(database.poolCalls, [{text: 'SELECT $1', parameters: ['value']}]);
  assert.deepEqual(database.clientCalls.map(call => call.text), [
    'BEGIN', 'INSERT INTO example VALUES ($1)', 'COMMIT'
  ]);
  assert.equal(database.released(), 1);
});

test('rolls back and always releases the same client on transaction failure', async () => {
  const database = fakeDatabase();
  const runtime = createPostgresRuntime({
    environment: {DATABASE_URL: 'postgresql://user:topsecret@db/app'},
    PoolClass: database.Pool,
    attachDatabasePool: null
  });
  await assert.rejects(runtime.transaction(async client => {
    await client.query('UPDATE example SET value = 1');
    throw new Error('provider failure postgresql://user:topsecret@db/app');
  }), error => {
      assert.equal(error.code, 'POSTGRES_OPERATION_FAILED');
      assert.equal(error.message, 'PostgreSQL operation failed');
      assert.doesNotMatch(error.message, /topsecret|postgresql:\/\//);
      assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
      return true;
  });
  assert.deepEqual(database.clientCalls.map(call => call.text), [
    'BEGIN', 'UPDATE example SET value = 1', 'ROLLBACK'
  ]);
  assert.equal(database.released(), 1);
});

test('adapter directly satisfies the existing generic repository boundary', async () => {
  const database = fakeDatabase();
  const runtime = createPostgresRuntime({
    environment: {DATABASE_URL: 'postgresql://db/app'},
    PoolClass: database.Pool,
    attachDatabasePool: null
  });
  const repository = createPostgresThreeSessionSnapshotRepository(runtime);
  const result = await repository.listLatest({market: 'SG', symbol: '^STI'});
  assert.deepEqual(result, []);
  assert.match(database.poolCalls[0].text, /three_session_snapshot_sessions/);
});

test('runtime wiring contains no Neon-specific imports or environment names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'postgres-runtime.js'), 'utf8');
  const packageFiles = [
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8')
  ].join('\n');
  assert.doesNotMatch(source, /@neondatabase|NEON_|\bneon\b/i);
  assert.doesNotMatch(source, /db[/\\]migrations|readFile|migration/i);
  assert.doesNotMatch(packageFiles, /@neondatabase|NEON_/i);
  assert.match(source, /DATABASE_URL/);
});

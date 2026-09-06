const POOL_CONFIG = Object.freeze({
  max: 4,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true
});

class PostgresRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PostgresRuntimeError';
    this.code = code;
  }
}

function loadPoolClass() {
  return require('pg').Pool;
}

function loadPoolAttachment() {
  try {
    const vercelFunctions = require('@vercel/functions');
    return typeof vercelFunctions.attachDatabasePool === 'function'
      ? vercelFunctions.attachDatabasePool
      : null;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

function connectionStringFrom(environment) {
  const value = environment && environment.DATABASE_URL;
  if (typeof value !== 'string' || !value.trim()) {
    throw new PostgresRuntimeError(
      'DATABASE_URL_MISSING',
      'PostgreSQL runtime is not configured'
    );
  }
  return value.trim();
}

function operationFailure(cause) {
  if (cause instanceof PostgresRuntimeError) return cause;
  return new PostgresRuntimeError(
    'POSTGRES_OPERATION_FAILED',
    'PostgreSQL operation failed'
  );
}

function createPostgresRuntime({
  environment = process.env,
  PoolClass,
  attachDatabasePool
} = {}) {
  let pool = null;
  let attached = false;

  function getPool() {
    if (pool) return pool;
    const connectionString = connectionStringFrom(environment);
    const RuntimePool = PoolClass || loadPoolClass();
    const candidate = new RuntimePool({connectionString, ...POOL_CONFIG});
    try {
      const attach = attachDatabasePool === undefined
        ? loadPoolAttachment()
        : attachDatabasePool;
      if (attach !== null && typeof attach !== 'function') {
        throw new TypeError('attachDatabasePool must be a function or null');
      }
      if (attach && !attached) {
        attach(candidate);
        attached = true;
      }
      pool = candidate;
      return pool;
    } catch (error) {
      if (typeof candidate.end === 'function') candidate.end().catch(() => {});
      throw operationFailure(error);
    }
  }

  return Object.freeze({
    async query(text, parameters) {
      try {
        return await getPool().query(text, parameters);
      } catch (error) {
        throw operationFailure(error);
      }
    },

    async transaction(callback) {
      if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
      let client;
      let began = false;
      try {
        client = await getPool().connect();
        await client.query('BEGIN');
        began = true;
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client && began) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            // The original failure remains authoritative and credential-safe.
          }
        }
        throw operationFailure(error);
      } finally {
        if (client && typeof client.release === 'function') client.release();
      }
    }
  });
}

let sharedRuntime = null;

function getPostgresRuntime() {
  if (!sharedRuntime) sharedRuntime = createPostgresRuntime();
  return sharedRuntime;
}

module.exports = {
  POOL_CONFIG,
  PostgresRuntimeError,
  createPostgresRuntime,
  getPostgresRuntime
};

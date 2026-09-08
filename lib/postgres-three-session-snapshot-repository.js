const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');
const {
  createCompletedRegularSession,
  validateCompletedRegularSession
} = require('./three-session-snapshot');

const ADVISORY_LOCK_SQL = `
  SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))
`;

const UPSERT_SQL = `
  INSERT INTO three_session_snapshot_sessions (
    market, symbol, session_date, open_value, high_value, low_value,
    close_value, previous_close_value, volume_value, as_of_time,
    source_id, validation_state
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (market, symbol, session_date) DO UPDATE SET
    open_value = EXCLUDED.open_value,
    high_value = EXCLUDED.high_value,
    low_value = EXCLUDED.low_value,
    close_value = EXCLUDED.close_value,
    previous_close_value = EXCLUDED.previous_close_value,
    volume_value = EXCLUDED.volume_value,
    as_of_time = EXCLUDED.as_of_time,
    source_id = EXCLUDED.source_id,
    validation_state = EXCLUDED.validation_state
`;

const PRUNE_SQL = `
  DELETE FROM three_session_snapshot_sessions
  WHERE market = $1
    AND symbol = $2
    AND session_date NOT IN (
      SELECT session_date
      FROM three_session_snapshot_sessions
      WHERE market = $1 AND symbol = $2
      ORDER BY session_date DESC
      LIMIT 3
    )
`;

const LIST_LATEST_SQL = `
  SELECT market, symbol, session_date, open_value, high_value, low_value,
    close_value, previous_close_value, volume_value, as_of_time,
    source_id, validation_state
  FROM (
    SELECT market, symbol, session_date, open_value, high_value, low_value,
      close_value, previous_close_value, volume_value, as_of_time,
      source_id, validation_state
    FROM three_session_snapshot_sessions
    WHERE market = $1 AND symbol = $2
    ORDER BY session_date DESC
    LIMIT 3
  ) latest
  ORDER BY session_date ASC
`;

function normalizeKey(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('three-session snapshot repository key must be an object');
  }
  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!Object.prototype.hasOwnProperty.call(MARKET_TIME_ZONES, market)) throw new TypeError('invalid market');
  if (!symbol) throw new TypeError('symbol is required');
  return {market, symbol};
}

function queryFunction(value, name) {
  if (typeof value === 'function') return value;
  if (value && typeof value.query === 'function') return value.query.bind(value);
  throw new TypeError(`${name} must provide a query function`);
}

function validateSession(session, market) {
  const validation = validateCompletedRegularSession(session, market);
  if (!validation.valid) {
    throw new TypeError(`Invalid canonical completed regular session: ${validation.errors.join('; ')}`);
  }
}

function sessionParameters(market, symbol, session) {
  return [
    market,
    symbol,
    session.sessionDate,
    session.open,
    session.high,
    session.low,
    session.close,
    session.previousClose,
    session.volume,
    session.asOf,
    session.sourceId,
    session.validationState
  ];
}

function reconstructRows(result, market, symbol) {
  const rows = result && Array.isArray(result.rows) ? result.rows.slice(-3) : [];
  return Object.freeze(rows.map(row => {
    if (row.market !== market || row.symbol !== symbol) {
      throw new TypeError('Stored completed regular session key does not match requested key');
    }
    return createCompletedRegularSession({
      market,
      sessionDate: row.session_date,
      open: row.open_value,
      high: row.high_value,
      low: row.low_value,
      close: row.close_value,
      previousClose: row.previous_close_value,
      volume: row.volume_value,
      asOf: row.as_of_time,
      sourceId: row.source_id,
      validationState: row.validation_state
    });
  }));
}

function createPostgresThreeSessionSnapshotRepository({query, transaction} = {}) {
  const readQuery = queryFunction(query, 'query');
  if (typeof transaction !== 'function') throw new TypeError('transaction must be a function');

  return Object.freeze({
    async upsert({market: inputMarket, symbol: inputSymbol, session} = {}) {
      const {market, symbol} = normalizeKey({market: inputMarket, symbol: inputSymbol});
      validateSession(session, market);
      await transaction(async transactionClient => {
        const transactionQuery = queryFunction(transactionClient, 'transaction callback value');
        const keyParameters = [market, symbol];
        await transactionQuery(ADVISORY_LOCK_SQL, keyParameters);
        await transactionQuery(UPSERT_SQL, sessionParameters(market, symbol, session));
        await transactionQuery(PRUNE_SQL, keyParameters);
      });
    },

    async upsertSnapshot({market: inputMarket, symbol: inputSymbol, sessions} = {}) {
      const {market, symbol} = normalizeKey({market: inputMarket, symbol: inputSymbol});
      if (!Array.isArray(sessions) || sessions.length > 3) {
        throw new TypeError('sessions must be an array containing at most three canonical sessions');
      }
      sessions.forEach(session => validateSession(session, market));

      return transaction(async transactionClient => {
        const transactionQuery = queryFunction(transactionClient, 'transaction callback value');
        const keyParameters = [market, symbol];
        await transactionQuery(ADVISORY_LOCK_SQL, keyParameters);
        for (const session of sessions) {
          await transactionQuery(UPSERT_SQL, sessionParameters(market, symbol, session));
        }
        await transactionQuery(PRUNE_SQL, keyParameters);
        const result = await transactionQuery(LIST_LATEST_SQL, keyParameters);
        return reconstructRows(result, market, symbol);
      });
    },

    async listLatest(input) {
      const {market, symbol} = normalizeKey(input);
      const result = await readQuery(LIST_LATEST_SQL, [market, symbol]);
      return reconstructRows(result, market, symbol);
    }
  });
}

module.exports = {
  createPostgresThreeSessionSnapshotRepository
};

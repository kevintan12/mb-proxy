const {
  MARKET_TIME_ZONES,
  createCompletedSessionTelemetry,
  validateCompletedSessionTelemetry
} = require('./completed-session-telemetry');

const ADVISORY_LOCK_SQL = `
  SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))
`;

const UPSERT_SQL = `
  INSERT INTO completed_session_telemetry (
    market, symbol, session_date, close_value, close_time, source_id
  ) VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (market, symbol, session_date) DO UPDATE SET
    close_value = EXCLUDED.close_value,
    close_time = EXCLUDED.close_time,
    source_id = EXCLUDED.source_id
`;

const PRUNE_SQL = `
  DELETE FROM completed_session_telemetry
  WHERE market = $1
    AND symbol = $2
    AND session_date NOT IN (
      SELECT session_date
      FROM completed_session_telemetry
      WHERE market = $1 AND symbol = $2
      ORDER BY session_date DESC
      LIMIT 3
    )
`;

const LIST_LATEST_SQL = `
  SELECT market, symbol, session_date, close_value, close_time, source_id
  FROM completed_session_telemetry
  WHERE market = $1 AND symbol = $2
  ORDER BY session_date DESC
  LIMIT 3
`;

function normalizeKey(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('completed-session telemetry key must be an object');
  }
  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!Object.prototype.hasOwnProperty.call(MARKET_TIME_ZONES, market)) {
    throw new TypeError('invalid market');
  }
  if (!symbol) throw new TypeError('symbol is required');
  return {market, symbol};
}

function queryFunction(value, name) {
  if (typeof value === 'function') return value;
  if (value && typeof value.query === 'function') return value.query.bind(value);
  throw new TypeError(`${name} must provide a query function`);
}

function createPostgresCompletedSessionTelemetryRepository({query, transaction} = {}) {
  const readQuery = queryFunction(query, 'query');
  if (typeof transaction !== 'function') throw new TypeError('transaction must be a function');

  return Object.freeze({
    async upsert(record) {
      const validation = validateCompletedSessionTelemetry(record);
      if (!validation.valid) {
        throw new TypeError(`Invalid canonical completed-session telemetry: ${validation.errors.join('; ')}`);
      }

      await transaction(async transactionClient => {
        const transactionQuery = queryFunction(transactionClient, 'transaction callback value');
        const keyParameters = [record.market, record.symbol];
        await transactionQuery(ADVISORY_LOCK_SQL, keyParameters);
        await transactionQuery(UPSERT_SQL, [
          record.market,
          record.symbol,
          record.sessionDate,
          record.close,
          record.closeTime,
          record.sourceId
        ]);
        await transactionQuery(PRUNE_SQL, keyParameters);
      });
    },

    async listLatest(input) {
      const {market, symbol} = normalizeKey(input);
      const result = await readQuery(LIST_LATEST_SQL, [market, symbol]);
      const rows = result && Array.isArray(result.rows) ? result.rows.slice(0, 3) : [];
      return Object.freeze(rows.map(row => createCompletedSessionTelemetry({
        market: row.market,
        symbol: row.symbol,
        sessionDate: row.session_date,
        close: row.close_value,
        closeTime: row.close_time,
        sourceId: row.source_id
      })));
    }
  });
}

module.exports = {
  createPostgresCompletedSessionTelemetryRepository
};

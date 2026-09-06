const {
  createThreeSessionSnapshot,
  validateThreeSessionSnapshot
} = require('./three-session-snapshot');
const {
  createPostgresThreeSessionSnapshotRepository
} = require('./postgres-three-session-snapshot-repository');
const {getPostgresRuntime} = require('./postgres-runtime');
const {getSessionContext: defaultGetSessionContext} = require('./market-session-calendar');

class RuntimeSnapshotPersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeSnapshotPersistenceError';
    this.code = code;
  }
}

function shiftDate(exchangeDate, days) {
  const [year, month, day] = exchangeDate.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + days);
  return date.toISOString().slice(0, 10);
}

function previousTradingDate(market, exchangeDate, getSessionContext) {
  let candidate = exchangeDate;
  for (let count = 0; count < 16; count += 1) {
    candidate = shiftDate(candidate, -1);
    const context = getSessionContext({market, exchangeDate: candidate});
    if (!context.calendarSupported) {
      throw new RuntimeSnapshotPersistenceError(
        'SNAPSHOT_CALENDAR_UNSUPPORTED',
        'Persisted snapshot crosses an unsupported calendar date'
      );
    }
    if (context.tradingDay) return candidate;
  }
  throw new RuntimeSnapshotPersistenceError(
    'SNAPSHOT_CONTINUITY_INVALID',
    'Unable to establish persisted snapshot continuity'
  );
}

function validateContinuity(market, sessions, getSessionContext) {
  for (let index = 1; index < sessions.length; index += 1) {
    const older = sessions[index - 1];
    const newer = sessions[index];
    if (previousTradingDate(market, newer.sessionDate, getSessionContext) !== older.sessionDate
        || newer.previousClose !== older.close) {
      throw new RuntimeSnapshotPersistenceError(
        'SNAPSHOT_CONTINUITY_INVALID',
        'Persisted snapshot history is not contiguous'
      );
    }
  }
}

function canonicalSessionSignature(session) {
  return JSON.stringify(session);
}

function createRuntimeThreeSessionSnapshotRepository({
  repository,
  runtime,
  getSessionContext = defaultGetSessionContext
} = {}) {
  if (typeof getSessionContext !== 'function') {
    throw new TypeError('getSessionContext must be a function');
  }
  const resolvedRepository = repository || createPostgresThreeSessionSnapshotRepository(
    runtime || getPostgresRuntime()
  );
  if (!resolvedRepository || typeof resolvedRepository.upsert !== 'function'
      || typeof resolvedRepository.listLatest !== 'function') {
    throw new TypeError('repository must provide upsert and listLatest');
  }

  return Object.freeze({
    async persistSnapshot(snapshot) {
      const validation = validateThreeSessionSnapshot(snapshot);
      if (!validation.valid) {
        throw new TypeError('Invalid canonical three-session snapshot');
      }
      try {
        for (const session of snapshot.completedSessions) {
          await resolvedRepository.upsert({
            market: snapshot.market,
            symbol: snapshot.symbol,
            session
          });
        }

        const persisted = await resolvedRepository.listLatest({
          market: snapshot.market,
          symbol: snapshot.symbol
        });
        if (!Array.isArray(persisted) || persisted.length > 3) {
          throw new RuntimeSnapshotPersistenceError(
            'SNAPSHOT_READ_INVALID',
            'Persisted snapshot read returned an invalid collection'
          );
        }
        validateContinuity(snapshot.market, persisted, getSessionContext);

        const acquiredNewest = snapshot.completedSessions[snapshot.completedSessions.length - 1] || null;
        const persistedNewest = persisted[persisted.length - 1] || null;
        if (acquiredNewest
            && (!persistedNewest || persistedNewest.sessionDate !== acquiredNewest.sessionDate)) {
          throw new RuntimeSnapshotPersistenceError(
            'SNAPSHOT_READ_MISMATCH',
            'Persisted snapshot does not match the acquired snapshot'
          );
        }

        const persistedByDate = new Map(persisted.map(session => [session.sessionDate, session]));
        const completedSessions = snapshot.completedSessions.map(session => {
          const stored = persistedByDate.get(session.sessionDate);
          if (!stored || canonicalSessionSignature(stored) !== canonicalSessionSignature(session)) {
            throw new RuntimeSnapshotPersistenceError(
              'SNAPSHOT_READ_MISMATCH',
              'Persisted snapshot does not match the acquired snapshot'
            );
          }
          return stored;
        });
        validateContinuity(snapshot.market, completedSessions, getSessionContext);

        const newest = completedSessions[completedSessions.length - 1] || null;
        const currentOverlay = snapshot.currentOverlay && newest && persistedNewest
          && newest.sessionDate === persistedNewest.sessionDate
          && snapshot.currentOverlay.referenceClose === persistedNewest.close
          ? snapshot.currentOverlay
          : null;

        return createThreeSessionSnapshot({
          market: snapshot.market,
          symbol: snapshot.symbol,
          instrumentName: snapshot.instrumentName,
          instrumentType: snapshot.instrumentType,
          currency: snapshot.currency,
          marketState: snapshot.marketState,
          completedSessions,
          currentOverlay
        });
      } catch (error) {
        if (error instanceof RuntimeSnapshotPersistenceError) throw error;
        throw new RuntimeSnapshotPersistenceError(
          'SNAPSHOT_PERSISTENCE_FAILED',
          'Three-session snapshot persistence failed'
        );
      }
    }
  });
}

module.exports = {
  RuntimeSnapshotPersistenceError,
  createRuntimeThreeSessionSnapshotRepository
};

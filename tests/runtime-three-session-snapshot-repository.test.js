const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createThreeSessionSnapshot,
  validateThreeSessionSnapshot
} = require('../lib/three-session-snapshot');
const {
  createRuntimeThreeSessionSnapshotRepository
} = require('../lib/runtime-three-session-snapshot-repository');

function session(day, close, previousClose) {
  return createCompletedRegularSession({
    market: 'SG', sessionDate: `2026-09-${day}`, open: close - 1,
    high: close + 2, low: close - 2, close, previousClose, volume: Number(day),
    asOf: `2026-09-${day}T09:00:00Z`, sourceId: 'sg.yahoo-finance',
    validationState: 'VALIDATED'
  });
}

function snapshot(overrides = {}) {
  const sessions = [session('02', 102, 101), session('03', 103, 102), session('04', 104, 103)];
  const overlay = createCurrentSessionOverlay({
    market: 'SG', marketState: 'LUNCH', sessionDate: '2026-09-07',
    asOf: '2026-09-07T04:15:00Z', lastPrice: 105, referenceClose: 104,
    volume: null, sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  });
  return createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'Straits Times Index',
    instrumentType: 'INDEX', currency: 'SGD', marketState: 'LUNCH',
    completedSessions: sessions, currentOverlay: overlay, ...overrides
  });
}

function repositoryDouble({listed, failOn} = {}) {
  const calls = [];
  return {
    calls,
    async upsert(value) {
      calls.push({method: 'upsert', value});
      if (failOn === 'upsert') throw new Error('database://user:secret@host');
    },
    async listLatest(value) {
      calls.push({method: 'listLatest', value});
      if (failOn === 'listLatest') throw new Error('database://user:secret@host');
      return listed;
    }
  };
}

test('persists completed sessions oldest to newest, then reads and reconstructs canonically', async () => {
  const input = snapshot();
  const repository = repositoryDouble({listed: input.completedSessions});
  const service = createRuntimeThreeSessionSnapshotRepository({repository});
  const result = await service.persistSnapshot(input);

  assert.deepEqual(repository.calls.map(call => call.method), [
    'upsert', 'upsert', 'upsert', 'listLatest'
  ]);
  assert.deepEqual(repository.calls.slice(0, 3).map(call => call.value.session.sessionDate), [
    '2026-09-02', '2026-09-03', '2026-09-04'
  ]);
  assert.deepEqual(repository.calls[3].value, {market: 'SG', symbol: '^STI'});
  assert.equal(validateThreeSessionSnapshot(result).valid, true);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.completedSessions), true);
});

test('never persists the runtime overlay and reattaches it only against the stored newest close', async () => {
  const input = snapshot();
  const repository = repositoryDouble({listed: input.completedSessions});
  const result = await createRuntimeThreeSessionSnapshotRepository({repository}).persistSnapshot(input);
  for (const call of repository.calls.filter(item => item.method === 'upsert')) {
    assert.deepEqual(Object.keys(call.value), ['market', 'symbol', 'session']);
    assert.equal(call.value.currentOverlay, undefined);
  }
  assert.deepEqual(result.currentOverlay, input.currentOverlay);

  const overlayWithoutHistory = createCurrentSessionOverlay({
    market: 'SG', marketState: 'REGULAR', sessionDate: '2026-09-07',
    asOf: '2026-09-07T02:00:00Z', lastPrice: 105, referenceClose: 104,
    volume: null, sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  });
  const noHistory = createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'STI', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'REGULAR', completedSessions: [],
    currentOverlay: overlayWithoutHistory
  });
  const emptyRepository = repositoryDouble({listed: []});
  const rebuilt = await createRuntimeThreeSessionSnapshotRepository({repository: emptyRepository})
    .persistSnapshot(noHistory);
  assert.equal(rebuilt.currentOverlay, null);

  const partial = createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'STI', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'CLOSED',
    completedSessions: input.completedSessions.slice(0, 2), currentOverlay: null
  });
  const databaseAhead = repositoryDouble({listed: input.completedSessions});
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository: databaseAhead}).persistSnapshot(partial),
    error => error.code === 'SNAPSHOT_READ_MISMATCH'
  );
});

test('rejects missing, altered and non-contiguous persisted history', async () => {
  const input = snapshot();
  const missing = repositoryDouble({listed: input.completedSessions.slice(0, 2)});
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository: missing}).persistSnapshot(input),
    error => error.code === 'SNAPSHOT_READ_MISMATCH'
  );

  const altered = JSON.parse(JSON.stringify(input.completedSessions));
  altered[2].close = 999;
  const alteredRepository = repositoryDouble({listed: altered});
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository: alteredRepository}).persistSnapshot(input),
    error => error.code === 'SNAPSHOT_READ_MISMATCH'
  );

  const gapSessions = [session('02', 102, 101), session('04', 104, 102)];
  const gapSnapshot = createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'STI', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'CLOSED', completedSessions: gapSessions,
    currentOverlay: null
  });
  const gapRepository = repositoryDouble({listed: gapSessions});
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository: gapRepository}).persistSnapshot(gapSnapshot),
    error => error.code === 'SNAPSHOT_CONTINUITY_INVALID'
  );

  const shortInput = createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'STI', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'CLOSED',
    completedSessions: input.completedSessions.slice(1), currentOverlay: null
  });
  const badOlder = session('02', 999, 998);
  const brokenChainRepository = repositoryDouble({
    listed: [badOlder, ...shortInput.completedSessions]
  });
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository: brokenChainRepository})
      .persistSnapshot(shortInput),
    error => error.code === 'SNAPSHOT_CONTINUITY_INVALID'
  );
});

test('fails closed and sanitizes deterministic write/read failures', async () => {
  for (const failOn of ['upsert', 'listLatest']) {
    const input = snapshot();
    const repository = repositoryDouble({listed: input.completedSessions, failOn});
    await assert.rejects(
      createRuntimeThreeSessionSnapshotRepository({repository}).persistSnapshot(input),
      error => {
        assert.equal(error.code, 'SNAPSHOT_PERSISTENCE_FAILED');
        assert.equal(error.message, 'Three-session snapshot persistence failed');
        assert.doesNotMatch(error.message, /secret|database:\/\//);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
        return true;
      }
    );
  }
});

test('rejects non-canonical input before any persistence call', async () => {
  const input = JSON.parse(JSON.stringify(snapshot()));
  input.completedSessions[0].provenance.publisher = 'Spoof';
  const repository = repositoryDouble({listed: []});
  await assert.rejects(
    createRuntimeThreeSessionSnapshotRepository({repository}).persistSnapshot(input),
    /Invalid canonical/
  );
  assert.equal(repository.calls.length, 0);
});

test('runtime snapshot wiring has no route, migration, Claude, or Neon coupling', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'lib', 'runtime-three-session-snapshot-repository.js'
  ), 'utf8');
  assert.doesNotMatch(source, /api\/quote|analysisPackage|claude|@neondatabase|NEON_/i);
});

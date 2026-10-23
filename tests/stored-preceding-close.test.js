// Step 9X: when Yahoo's daily row for the preceding trading day is blank and the
// minute recovery fails, the previous close comes from the stored, validated
// session for exactly that date (switch storedPrecedingCloseEnabled, default on).
const test = require('node:test');
const assert = require('node:assert/strict');

const {createYahooTelemetryAcquisitionService} = require('../lib/yahoo-telemetry-acquisition');
const {createCompletedRegularSession, validateFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {getSessionContext} = require('../lib/market-session-calendar');
const {createRuntimeFiveSessionSnapshotRepository} = require('../lib/runtime-five-session-snapshot-repository');
const {createUsAnalysisPackageOrchestrationService} = require('../lib/us-analysis-package-orchestration');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const YAHOO = require('./fixtures/yahoo-2026-10-23');

// Fri 23 Oct 2026 10:00 SGT = Thu 22 Oct 22:00 New York (CLOSED): expected newest day 22 Oct.
const RUN_23_OCT = '2026-10-23T02:00:00.000Z';
// Sat 24 Oct 2026 22:00 SGT: expected newest day 23 Oct, preceding day 22 Oct (valid row).
const RUN_SATURDAY = '2026-10-24T14:00:00.000Z';
const SNAPSHOT_KEYS = ['market', 'symbol', 'instrumentName', 'instrumentType', 'currency',
  'exchangeTimezone', 'marketState', 'primaryCompletedSessionDate', 'completeness',
  'completedSessions', 'currentOverlay'];
// Stand-in stored 21 Oct closes (the 15:59 minute close in the saved minute data); the
// real stored Neon values were not read.
const STORED_21_OCT_CLOSE = Object.freeze({'^GSPC': 7757.22021484375, CPRI: 15.6899995803833,
  NVDA: 221.8699951171875});

function dateOf(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function dailyBody(symbol, mutate) {
  const fixture = YAHOO.daily[symbol];
  const quote = JSON.parse(JSON.stringify(fixture.quote));
  const timestamp = fixture.timestamp.slice();
  if (mutate) mutate({timestamp, quote});
  return {chart: {result: [{meta: {...fixture.meta}, timestamp,
    indicators: {quote: [quote]}}], error: null}};
}

function dailyCloseOn(symbol, date) {
  const fixture = YAHOO.daily[symbol];
  const index = fixture.timestamp.findIndex(value => dateOf(value) === date);
  return fixture.quote.close[index];
}

function storedSession(symbol, date, close, previousClose, overrides = {}) {
  return createCompletedRegularSession({
    market: 'US', sessionDate: date, open: close, high: close, low: close, close, previousClose,
    volume: null, asOf: getSessionContext({market: 'US', exchangeDate: date}).regularCloseTime,
    sourceId: 'us.yahoo-finance', validationState: 'VALIDATED', ...overrides
  });
}

// What the shared store held on 23 Oct: 15, 16, 19, 20 and 21 Oct, all validated.
function storedHistory(symbol) {
  const dates = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'];
  const sessions = dates.slice(1).map((date, index) =>
    storedSession(symbol, date, dailyCloseOn(symbol, date), dailyCloseOn(symbol, dates[index])));
  sessions.push(storedSession(symbol, '2026-10-21', STORED_21_OCT_CLOSE[symbol],
    dailyCloseOn(symbol, '2026-10-20')));
  return sessions;
}

function minuteResponse(symbol) {
  const fixture = YAHOO.intra21[symbol];
  const body = {chart: {result: [{timestamp: fixture.timestamp, indicators: {quote: [fixture.quote]}}],
    error: null}};
  return {ok: true, status: 200, text: async () => JSON.stringify(body)};
}

function acquisition({symbol = '^GSPC', instant = RUN_23_OCT, mutateDaily, body, lookup,
  minute = 'saved', diagnostics = []} = {}) {
  const calls = {daily: 0, minute: 0, lookup: []};
  const service = createYahooTelemetryAcquisitionService({
    now: () => new Date(instant),
    onDiagnostics: value => diagnostics.push(value),
    ...(lookup === undefined ? {} : {precedingCloseLookup: async input => {
      calls.lookup.push(input);
      return lookup(input);
    }}),
    fetchImpl: async url => {
      if (String(url).includes('interval=1m')) {
        calls.minute++;
        if (minute === 'saved') return minuteResponse(symbol);
        if (typeof minute === 'function') return minute(url);
        return {ok: false, status: 502, text: async () => ''};
      }
      calls.daily++;
      const payload = body || dailyBody(symbol, mutateDaily);
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
  });
  return {
    calls, diagnostics,
    acquire: () => service.acquireSnapshot({market: 'US', symbol})
  };
}

function datesOf(snapshot) {
  return snapshot.completedSessions.map(session => session.sessionDate);
}

function recoveryRecord(diagnostics) {
  return diagnostics.find(value => value.stage === 'yahooCompletedSessionRecovery');
}

const STORE = symbol => async () => storedHistory(symbol);

test('the switch is registered: Admin, STORED_PRECEDING_CLOSE_ENABLED, default on', () => {
  const entry = SETTINGS_REGISTRY.storedPrecedingCloseEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', 'STORED_PRECEDING_CLOSE_ENABLED', true, true]);
  assert.equal(settingValue('storedPrecedingCloseEnabled', {env: {}}), true);
  assert.equal(settingValue('storedPrecedingCloseEnabled',
    {env: {STORED_PRECEDING_CLOSE_ENABLED: 'false'}}), false);
});

test('the saved 23 Oct responses really are the failure: blank 21 Oct row, minute data rejected', async () => {
  for (const symbol of ['^GSPC', 'CPRI']) {
    const run = acquisition({symbol});
    const snapshot = await run.acquire();
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-10-20', symbol);
    assert.deepEqual(datesOf(snapshot), ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'], symbol);
    const record = recoveryRecord(run.diagnostics);
    assert.equal(record.precedingIntradayRecoveryResult, 'FAILURE');
    assert.equal(record.precedingIntradayRecoveryRejectionCategory, 'OUTSIDE_EXPECTED_SESSION');
    assert.equal('precedingCloseSource' in record, false, 'switch off adds no log field');
  }
});

test('switch on: the stored, validated 21 Oct close becomes the 22 Oct previous close', async () => {
  for (const symbol of ['^GSPC', 'CPRI']) {
    const run = acquisition({symbol, lookup: STORE(symbol)});
    const snapshot = await run.acquire();
    assert.equal(snapshot.primaryCompletedSessionDate, '2026-10-22', symbol);
    assert.deepEqual(datesOf(snapshot), ['2026-10-22'], 'the stored day is never added to the history');
    const newest = snapshot.completedSessions[0];
    assert.equal(newest.previousClose, STORED_21_OCT_CLOSE[symbol]);
    assert.equal(newest.close, dailyCloseOn(symbol, '2026-10-22'));
    assert.equal(validateFiveSessionSnapshot(snapshot).valid, true);
    assert.deepEqual(Object.keys(snapshot), SNAPSHOT_KEYS);
    assert.deepEqual(run.calls.lookup, [{market: 'US', symbol, sessionDate: '2026-10-21'}]);
    assert.equal(recoveryRecord(run.diagnostics).precedingCloseSource, 'STORED');
    assert.deepEqual(run.diagnostics.find(value => value.stage === 'yahooStoredPrecedingCloseUsed'), {
      stage: 'yahooStoredPrecedingCloseUsed', market: 'US', symbol,
      precedingExpectedDate: '2026-10-21', storedSessionDate: '2026-10-21',
      storedSourceId: 'us.yahoo-finance', storedValidationState: 'VALIDATED'
    });
  }
});

test('a valid 21 Oct daily row (NVDA) is used as is; the store is never read', async () => {
  const off = await acquisition({symbol: 'NVDA'}).acquire();
  const run = acquisition({symbol: 'NVDA', lookup: async () => { throw new Error('not expected'); }});
  const on = await run.acquire();
  assert.deepEqual(on, off);
  assert.equal(on.primaryCompletedSessionDate, '2026-10-22');
  assert.equal(on.completedSessions.at(-1).previousClose, dailyCloseOn('NVDA', '2026-10-21'));
  assert.deepEqual(run.calls.lookup, []);
  assert.equal(recoveryRecord(run.diagnostics).precedingCloseSource, 'DAILY');
});

test('a successful minute recovery wins over the store (INTRADAY)', async () => {
  const context = getSessionContext({market: 'US', exchangeDate: '2026-10-21'});
  const open = Date.parse(context.regularOpenTime) / 1000;
  const close = Date.parse(context.regularCloseTime) / 1000;
  const timestamp = [];
  const quote = {open: [], high: [], low: [], close: [], volume: []};
  for (let t = open; t <= close; t += 60) {
    timestamp.push(t);
    for (const field of ['open', 'high', 'low', 'close']) quote[field].push(7750);
    quote.volume.push(1);
  }
  const body = {chart: {result: [{timestamp, indicators: {quote: [quote]}}], error: null}};
  const run = acquisition({lookup: async () => { throw new Error('not expected'); },
    minute: () => ({ok: true, status: 200, text: async () => JSON.stringify(body)})});
  const snapshot = await run.acquire();
  assert.equal(snapshot.completedSessions.at(-1).previousClose, 7750);
  assert.deepEqual(run.calls.lookup, []);
  assert.equal(recoveryRecord(run.diagnostics).precedingCloseSource, 'INTRADAY');
});

test('guards: each bad stored session or failed read leaves today\'s result unchanged', async () => {
  const baseline = await acquisition().acquire();
  const history = storedHistory('^GSPC');
  const stored21 = history.at(-1);
  const replace21 = changed => history.slice(0, -1).concat(changed);
  const cases = {
    'no 21 Oct session (wrong date only)': async () => history.slice(0, -1),
    'stored under 22 Oct instead': async () => replace21({...stored21, sessionDate: '2026-10-22'}),
    'stored under 20 Oct only': async () => history.slice(0, -1),
    'not validated': async () => replace21({...stored21, validationState: 'UNVALIDATED'}),
    'not a Yahoo session': async () => replace21({...stored21, sourceId: 'us.other'}),
    'other market': async () => replace21({...stored21,
      provenance: {...stored21.provenance, applicableMarket: 'SG'}}),
    'zero close': async () => replace21({...stored21, close: 0}),
    'negative close': async () => replace21({...stored21, close: -1}),
    'NaN close': async () => replace21({...stored21, close: Number.NaN}),
    'null close': async () => replace21({...stored21, close: null}),
    'two 21 Oct sessions': async () => history.concat(stored21),
    'empty store': async () => [],
    'store returns null': async () => null,
    'store returns an object': async () => ({sessions: history}),
    'store read throws': async () => { throw new Error('store down'); }
  };
  for (const [name, lookup] of Object.entries(cases)) {
    const run = acquisition({lookup});
    const snapshot = await run.acquire();
    assert.deepEqual(snapshot, baseline, name);
    assert.equal(recoveryRecord(run.diagnostics).precedingCloseSource, 'NONE', name);
    assert.equal(run.diagnostics.some(value => value.stage === 'yahooStoredPrecedingCloseUsed'), false, name);
  }
});

test('guards: a present-but-bad 21 Oct close or a duplicate 21 Oct row never reads the store', async () => {
  const index21 = YAHOO.daily['^GSPC'].timestamp.findIndex(value => dateOf(value) === '2026-10-21');
  const variants = {
    'zero daily close': ({quote}) => { quote.close[index21] = 0; },
    'negative daily close': ({quote}) => { quote.close[index21] = -5; },
    'duplicate 21 Oct row': ({timestamp, quote}) => {
      timestamp.splice(index21 + 1, 0, timestamp[index21] + 60);
      for (const field of Object.keys(quote)) quote[field].splice(index21 + 1, 0, quote[field][index21]);
    }
  };
  for (const [name, mutateDaily] of Object.entries(variants)) {
    const off = await acquisition({mutateDaily}).acquire();
    const run = acquisition({mutateDaily, lookup: STORE('^GSPC')});
    assert.deepEqual(await run.acquire(), off, name);
    assert.deepEqual(run.calls.lookup, [], name);
  }
});

test('guards: a blank newest (22 Oct) row is not rescued by the store', async () => {
  const index22 = YAHOO.daily['^GSPC'].timestamp.findIndex(value => dateOf(value) === '2026-10-22');
  const mutateDaily = ({quote}) => {
    for (const field of Object.keys(quote)) quote[field][index22] = null;
  };
  const off = await acquisition({mutateDaily, minute: 'fail'}).acquire();
  const run = acquisition({mutateDaily, minute: 'fail', lookup: STORE('^GSPC')});
  assert.deepEqual(await run.acquire(), off);
  assert.deepEqual(run.calls.lookup, []);
});

test('guards: non-US markets never read the store', async () => {
  const rows = ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
  const body = {chart: {result: [{
    meta: {longName: 'Straits Times Index', instrumentType: 'INDEX', currency: 'SGD'},
    timestamp: rows.map(date => Date.parse(`${date}T01:00:00Z`) / 1000),
    indicators: {quote: [{open: [1, 1, 1, null, 1], high: [2, 2, 2, null, 2], low: [1, 1, 1, null, 1],
      close: [1.5, 1.5, 1.5, null, 1.5], volume: [1, 1, 1, null, 1]}]}
  }], error: null}};
  const lookups = [];
  const make = lookup => createYahooTelemetryAcquisitionService({
    now: () => new Date('2026-10-23T02:00:00Z'),
    ...(lookup ? {precedingCloseLookup: lookup} : {}),
    fetchImpl: async () => ({ok: true, status: 200, json: async () => body})
  });
  const off = await make(null).acquireSnapshot({market: 'SG', symbol: '^STI'});
  const on = await make(async input => { lookups.push(input); return []; })
    .acquireSnapshot({market: 'SG', symbol: '^STI'});
  assert.deepEqual(on, off);
  assert.deepEqual(lookups, []);
});

test('Saturday (expected 23 Oct, valid 22 Oct row) is unchanged and never reads the store', async () => {
  const fixture = YAHOO.daily['^GSPC'];
  const body = dailyBody('^GSPC', ({timestamp, quote}) => {
    // Drop the oldest row and add a made-up valid Fri 23 Oct row.
    timestamp.shift();
    timestamp.push(fixture.timestamp.at(-1) + 86400);
    for (const field of Object.keys(quote)) {
      quote[field].shift();
      quote[field].push(field === 'volume' ? 1000 : field === 'high' ? 7700 : field === 'low' ? 7600 : 7650);
    }
  });
  const off = await acquisition({instant: RUN_SATURDAY, body}).acquire();
  const run = acquisition({instant: RUN_SATURDAY, body, lookup: STORE('^GSPC')});
  const on = await run.acquire();
  assert.deepEqual(on, off);
  assert.equal(on.primaryCompletedSessionDate, '2026-10-23');
  assert.equal(on.completedSessions.at(-1).previousClose, dailyCloseOn('^GSPC', '2026-10-22'));
  assert.deepEqual(run.calls.lookup, []);
});

function inMemorySnapshotStore(initial) {
  const rows = new Map(initial.map(session => [session.sessionDate, session]));
  return {
    rows,
    async upsertSnapshot({sessions}) {
      for (const session of sessions) rows.set(session.sessionDate, session);
      const latest = [...rows.keys()].sort().slice(-5);
      for (const date of [...rows.keys()]) if (!latest.includes(date)) rows.delete(date);
      return Object.freeze(latest.map(date => rows.get(date)));
    }
  };
}

test('readback: the persisted chain stays continuous and the readback equals the acquired snapshot', async () => {
  for (const symbol of ['^GSPC', 'CPRI']) {
    const store = inMemorySnapshotStore(storedHistory(symbol));
    const persistence = createRuntimeFiveSessionSnapshotRepository({repository: store});
    const acquired = await acquisition({symbol, lookup: STORE(symbol)}).acquire();
    const readback = await persistence.persistSnapshot(acquired);
    assert.equal(JSON.stringify(readback), JSON.stringify(acquired), symbol);
    assert.deepEqual([...store.rows.keys()].sort(),
      ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    assert.equal(store.rows.get('2026-10-21').close, STORED_21_OCT_CLOSE[symbol], 'stored day kept as stored');
  }
});

test('readback with the switch off reproduces today\'s mismatch (newest 20 Oct vs stored 21 Oct)', async () => {
  const store = inMemorySnapshotStore(storedHistory('^GSPC'));
  const persistence = createRuntimeFiveSessionSnapshotRepository({repository: store});
  const acquired = await acquisition().acquire();
  await assert.rejects(persistence.persistSnapshot(acquired), error =>
    error.code === 'SNAPSHOT_READ_MISMATCH'
    && error.diagnosticDetails.persistedNewestSessionDate === '2026-10-21');
});

function orchestrationWith({storedSessionReader, factoryArgs}) {
  const unused = name => async () => { throw new Error(`${name} not expected`); };
  return createUsAnalysisPackageOrchestrationService({
    createTelemetryAcquisition: args => {
      factoryArgs.push(args);
      return {async acquireSnapshot() { throw new Error('made-up acquisition failure'); }};
    },
    snapshotPersistence: {persistSnapshot: unused('persistSnapshot')},
    yahooEvidenceAcquisition: {acquireEvidence: unused('acquireEvidence')},
    yahooMostActiveAcquisition: {acquireMostActive: unused('acquireMostActive')},
    yahooLatestNewsDiscovery: {discoverLatestNews: unused('discoverLatestNews')},
    yahooCurrentNewsArticleContentAcquisition: {acquireArticleContent: unused('acquireArticleContent')},
    federalReserveEvidenceAcquisition: {acquireEvidence: unused('fed')},
    yahooRecapResearch: {discoverAndValidateRecap: unused('recap')},
    yahooRecapArticleContentAcquisition: {acquireArticleContent: unused('recapArticle')},
    yahooRecapEvidenceConstruction: {constructEvidence: unused('recapEvidence')},
    yahooRecapArticleContentBounds: {timeoutMs: 4000, maxResponseBytes: 1258291, maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256, maxArticleTextBytes: 8192, maxResultBytes: 12288},
    cnbcRecapResearch: {researchCompletedSessionRecap: unused('cnbcRecap')},
    cnbcNewsResearch: {researchNews: unused('cnbcNews')},
    ...(storedSessionReader ? {storedSessionReader} : {}),
    evidenceRoleClassification: {classifyEvidenceRoles: unused('classify')},
    now: () => new Date(RUN_23_OCT)
  });
}

const ORCHESTRATION_REQUEST = Object.freeze({
  benchmarkAnchors: [{market: 'US', symbol: '^GSPC'}], selectedScope: 'US', initiatingList: 'myStocks',
  userTimezone: 'Asia/Singapore', myStocks: [], watchlist: []
});

async function factoryArgsFor({env, storedSessionReader}) {
  const saved = process.env.STORED_PRECEDING_CLOSE_ENABLED;
  if (env === undefined) delete process.env.STORED_PRECEDING_CLOSE_ENABLED;
  else process.env.STORED_PRECEDING_CLOSE_ENABLED = env;
  const factoryArgs = [];
  try {
    await assert.rejects(orchestrationWith({storedSessionReader, factoryArgs})
      .assemble(ORCHESTRATION_REQUEST), /No validated US telemetry is available/);
  } finally {
    if (saved === undefined) delete process.env.STORED_PRECEDING_CLOSE_ENABLED;
    else process.env.STORED_PRECEDING_CLOSE_ENABLED = saved;
  }
  return factoryArgs;
}

test('orchestration: switch off (or no reader) passes only generatedAt, as at ec47f9a', async () => {
  const reader = {async listLatest() { throw new Error('not expected'); }};
  for (const args of [
    await factoryArgsFor({env: 'false', storedSessionReader: reader}),
    await factoryArgsFor({env: undefined, storedSessionReader: undefined})
  ]) {
    assert.equal(args.length, 1);
    assert.deepEqual(Object.keys(args[0]), ['generatedAt']);
  }
});

test('orchestration: switch on passes a fail-soft lookup over the read-only listLatest', async () => {
  const reads = [];
  const reader = {async listLatest(input) {
    reads.push(input);
    if (input.symbol === 'BROKEN') throw new Error('made-up store failure');
    return storedHistory('^GSPC');
  }};
  const [args] = await factoryArgsFor({env: undefined, storedSessionReader: reader});
  assert.deepEqual(Object.keys(args), ['generatedAt', 'precedingCloseLookup']);
  const found = await args.precedingCloseLookup({market: 'US', symbol: '^GSPC', sessionDate: '2026-10-21'});
  assert.equal(found.at(-1).sessionDate, '2026-10-21');
  assert.equal(await args.precedingCloseLookup({market: 'US', symbol: 'BROKEN', sessionDate: '2026-10-21'}),
    null);
  assert.deepEqual(reads, [{market: 'US', symbol: '^GSPC'}, {market: 'US', symbol: 'BROKEN'}]);
});

test('orchestration: a reader without listLatest is refused at construction', () => {
  assert.throws(() => orchestrationWith({storedSessionReader: {upsertSnapshot() {}}, factoryArgs: []}),
    /storedSessionReader/);
});

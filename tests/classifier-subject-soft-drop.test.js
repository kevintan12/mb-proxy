// Step 9F.4e: a repeated subject on one article is skipped, a name with spaces around
// it is trimmed, and more than five subjects keeps the first five grounded, specific
// survivors, instead of the whole labelling reply failing
// (classifierSubjectSoftDropEnabled). Any other subject fault still fails. Made-up
// articles and replies only: no real article text, no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  invokeClaudeEvidenceRoleClassification,
  invokeClaudeEvidenceSubjectRepair,
  classifierPartialKeepFor,
  completeClaudeEvidenceRoleClassificationOutput,
  createClaudeEvidenceSubjectRepairOutput,
  validateClaudeEvidenceRoleClassificationOutput
} = require('../lib/claude-evidence-role-classification');
const {createUsAnalysisPackageOrchestrationService} = require('../lib/us-analysis-package-orchestration');
const {validateClaudeAnalysisInput} = require('../lib/claude-analysis-contract');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');

const SWITCH = 'CLASSIFIER_SUBJECT_SOFT_DROP_ENABLED';
const OFF = Object.freeze({[SWITCH]: 'off'});
const FAILED_GAP = 'Could not sort the news by what it explains';
const SUBJECT_FAILURE = 'invalid evidence role classification subjects';

async function withEnv(values, operation) {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const plain = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// The labelling module on its own
// ---------------------------------------------------------------------------
function benchmark() {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  });
  return createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'WEEKEND', completedSessions: [session], currentOverlay: null
  });
}

const SIX = ['Acme Widgets', 'Beta Robotics', 'Gamma Foods', 'Delta Air Parts', 'Epsilon Chips', 'Zeta Bank'];
const ARTICLES = [
  ['COMPLETED_SESSION', `Made-up story: ${SIX.join(', ')} move`, `Made-up body naming ${SIX.join(', ')}.`],
  ['COMPLETED_SESSION', 'Made-up Acme Widgets story two', 'Made-up body two about Acme Widgets.'],
  ['SUBSEQUENT_DEVELOPMENT', 'Made-up after-close Acme Widgets note', 'Made-up body three about Acme Widgets.']
];

function classifierInput() {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'WEEKEND',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: benchmark()}],
    evidence: ARTICLES.map(([horizon, title, summary], index) => ({
      reference: `e${index + 1}`, horizon, requiresBroadMarketSubjects: true,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title, summary,
        canonicalUrl: `https://www.cnbc.com/2026/09/11/made-up-soft-${index + 1}.html`,
        publishedAt: horizon === 'COMPLETED_SESSION' ? '2026-09-11T18:00:00Z' : '2026-09-11T20:45:00Z',
        symbols: []
      })
    }))
  };
}

const company = name => ({kind: 'COMPANY', name});
const ACME = [company('Acme Widgets')];
const GOOD = {classifications: [
  {reference: 'e1', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: ACME},
  {reference: 'e2', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], subjects: ACME},
  {reference: 'e3', materiality: 'HIGH', roles: ['MATERIAL_EVENT'], subjects: ACME}
]};
const withChanges = (output, changes) => ({classifications: output.classifications.map(entry =>
  Object.hasOwn(changes, entry.reference) ? {...entry, ...changes[entry.reference]} : entry)});

const REPEAT = [company('Acme Widgets'), company('ACME  WIDGETS')];
const SPACES = [company(' Acme Widgets ')];
const OVER_FIVE = [{kind: 'SECTOR', name: 'US stocks'}, company('Omega Unnamed'), ...SIX.map(company)];
const SOFT_FAULTS = {
  repeat: [REPEAT, ['Acme Widgets'], 'DUPLICATE_SUBJECT'],
  spaces: [SPACES, ['Acme Widgets'], 'UNTRIMMED_SUBJECT_NAME'],
  'more than five': [OVER_FIVE, SIX.slice(0, 5), 'OVER_FIVE_SUBJECTS']
};

function reply(output, extra = {}) {
  return {ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output)}], usage: {}, ...extra}; }};
}

async function runClassifier(replies, env = {}) {
  const bodies = [];
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input: classifierInput(), apiKey: 'test-key',
    env: {CLASSIFIER_RETRY_COUNT: '1', CLASSIFIER_RETRY_GUIDANCE_ENABLED: 'on', ...env},
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, request) => {
      bodies.push(request.body);
      return replies[Math.min(bodies.length - 1, replies.length - 1)];
    }
  });
  return {
    result, calls: bodies.length, bodies, diagnostics, keep: classifierPartialKeepFor(result),
    softFixes: plain(diagnostics.filter(value => value.stage === 'classifierSubjectSoftFix')),
    guidance: plain(diagnostics.filter(value => value.stage === 'classifierRetryGuidance'))
  };
}

const namesOf = (result, index) => result.output.classifications[index].subjects.map(subject => subject.name);

test('Step 9F.4e: each soft fault alone is fixed on its article; one fetch, the log names the reference', async () => {
  for (const [label, [subjects, kept, category]] of Object.entries(SOFT_FAULTS)) {
    const run = await runClassifier([reply(withChanges(GOOD, {e1: {subjects}}))]);
    assert.equal(run.result.ok, true, label);
    assert.equal(run.calls, 1, label);
    assert.deepEqual(namesOf(run.result, 0), kept, label);
    assert.deepEqual(namesOf(run.result, 1), ['Acme Widgets'], label);
    // Roles and materiality never depend on subjects.
    assert.deepEqual(plain(run.result.output.classifications.map(entry => [entry.materiality, entry.roles])),
      GOOD.classifications.map(entry => [entry.materiality, entry.roles]), label);
    assert.deepEqual(run.softFixes, [{
      stage: 'classifierSubjectSoftFix', call: 'classifier', attempt: 0,
      fixes: [{category, references: ['e1']}], fixedReferenceCount: 1
    }], label);
  }
});

test('Step 9F.4e: several faults at once are listed by category, references in supplied order', async () => {
  const output = withChanges(GOOD, {
    e1: {subjects: [company('Acme Widgets'), company('acme widgets'), ...SIX.slice(1).map(company)]},
    e2: {subjects: [company('Acme Widgets '), company('Acme Widgets')]},
    e3: {subjects: REPEAT}
  });
  const run = await runClassifier([reply(output)]);
  assert.equal(run.result.ok, true);
  // A repeat never takes a slot: the five distinct grounded names are kept.
  assert.deepEqual(namesOf(run.result, 0), SIX.slice(0, 5));
  assert.deepEqual(namesOf(run.result, 1), ['Acme Widgets']);
  assert.deepEqual(namesOf(run.result, 2), ['Acme Widgets']);
  assert.deepEqual(run.softFixes[0].fixes, [
    {category: 'DUPLICATE_SUBJECT', references: ['e1', 'e2', 'e3']},
    {category: 'UNTRIMMED_SUBJECT_NAME', references: ['e2']},
    {category: 'OVER_FIVE_SUBJECTS', references: ['e1']}
  ]);
  assert.equal(run.softFixes[0].fixedReferenceCount, 3);
});

test('Step 9F.4e: cut order: generic and ungrounded names never take one of the five slots', async () => {
  const run = await runClassifier([reply(withChanges(GOOD, {e1: {subjects: [
    company('Omega Unnamed'), {kind: 'SECTOR', name: 'Wall Street'}, company('Zeta Bank'),
    company('Acme Widgets'), company('Beta Robotics'), company('Gamma Foods'), company('Delta Air Parts')
  ]}}))]);
  assert.deepEqual(namesOf(run.result, 0), ['Zeta Bank', 'Acme Widgets', 'Beta Robotics', 'Gamma Foods', 'Delta Air Parts']);
  // A COMPANY and a SECTOR with the same name are not a repeat (as before).
  const kinds = await runClassifier([reply(withChanges(GOOD, {e2: {subjects: [
    company('Acme Widgets'), {kind: 'SECTOR', name: 'Acme Widgets'}
  ]}}))]);
  assert.equal(kinds.result.ok, true);
  assert.equal(kinds.result.output.classifications[1].subjects.length, 2);
  assert.deepEqual(kinds.softFixes, []);
});

test('Step 9F.4e: a real shape fault still fails the reply, with the switch on', async () => {
  const faults = {
    'wrong kind': [{kind: 'INDEX', name: 'Acme Widgets'}],
    'extra field': [{kind: 'COMPANY', name: 'Acme Widgets', why: 'x'}],
    'missing name': [{kind: 'COMPANY'}],
    'name not a string': [{kind: 'COMPANY', name: 7}],
    'empty name': [company('')],
    'spaces-only name': [company('   ')],
    'trimmed name over 128 bytes': [company(` ${'é'.repeat(65)} `)],
    'subjects not a list': 'Acme Widgets',
    'a bad seventh entry': [...SIX.map(company), {kind: 'PERSON', name: 'Acme Widgets'}]
  };
  for (const [label, subjects] of Object.entries(faults)) {
    const run = await runClassifier([reply(withChanges(GOOD, {e1: {subjects}}))]);
    assert.equal(run.result.type, 'CONTRACT_FAILURE', label);
    assert.equal(run.result.message, SUBJECT_FAILURE, label);
    assert.equal(run.calls, 2, `${label}: the one retry runs as before`);
    assert.deepEqual(run.guidance[0].failures, [{category: 'INVALID_SUBJECTS', references: ['e1']}], label);
    assert.deepEqual(run.softFixes, [], `${label}: a list that still fails is not counted as fixed`);
  }
  // The 128-byte limit is measured on the trimmed name.
  const edge = await runClassifier([reply(withChanges(GOOD, {e1: {subjects: [company(` ${'a'.repeat(128)} `)]}}))]);
  assert.equal(edge.result.ok, true);
  assert.deepEqual(namesOf(edge.result, 0), [], 'ungrounded, so filtered as before');
});

test('Step 9F.4e: a soft fix beside a real fault: the reply fails, the log still names the fixed reference', async () => {
  const output = withChanges(GOOD, {e1: {subjects: [company('')]}, e2: {subjects: REPEAT}});
  const run = await runClassifier([reply(output), reply(output)]);
  assert.equal(run.result.type, 'CONTRACT_FAILURE');
  assert.equal(run.calls, 2);
  // Guidance names only the real fault; the repeat on e2 is no longer a fault.
  assert.deepEqual(run.guidance[0].failures, [{category: 'INVALID_SUBJECTS', references: ['e1']}]);
  assert.deepEqual(run.softFixes.map(value => [value.attempt, value.fixes]), [
    [0, [{category: 'DUPLICATE_SUBJECT', references: ['e2']}]],
    [1, [{category: 'DUPLICATE_SUBJECT', references: ['e2']}]]
  ]);
  const off = await runClassifier([reply(output), reply(output)], OFF);
  assert.deepEqual(off.guidance[0].failures, [{category: 'INVALID_SUBJECTS', references: ['e1', 'e2']}]);
});

test('Step 9F.4e: switch off: every soft fault fails the whole reply as at ecb44f1, with no new log line', async () => {
  for (const [label, [subjects]] of Object.entries(SOFT_FAULTS)) {
    const output = withChanges(GOOD, {e1: {subjects}});
    const off = await runClassifier([reply(output), reply(output)], OFF);
    assert.equal(off.result.ok, false, label);
    assert.equal(off.result.type, 'CONTRACT_FAILURE', label);
    assert.equal(off.result.message, SUBJECT_FAILURE, label);
    assert.equal(off.calls, 2, `${label}: the guided retry runs`);
    assert.deepEqual(off.guidance[0].failures, [{category: 'INVALID_SUBJECTS', references: ['e1']}], label);
    assert.equal(off.diagnostics.some(value => value.stage === 'classifierSubjectSoftFix'), false, label);
    // The request is the same with the switch on or off.
    const on = await runClassifier([reply(output)]);
    assert.equal(on.bodies[0], off.bodies[0], label);
  }
  // A clean reply: identical results and log lines on and off.
  const on = await runClassifier([reply(GOOD)]);
  const off = await runClassifier([reply(GOOD)], OFF);
  assert.deepEqual(plain(on.result), plain(off.result));
  const untimed = diagnostics => plain(diagnostics).map(({timing, ...rest}) => rest);
  assert.deepEqual(untimed(on.diagnostics), untimed(off.diagnostics));
});

test('Step 9F.4e: the exported checks stay strict; a soft-fixed output passes them unchanged', async () => {
  const input = classifierInput();
  for (const [label, [subjects]] of Object.entries(SOFT_FAULTS)) {
    const raw = withChanges(GOOD, {e1: {subjects}});
    assert.equal(validateClaudeEvidenceRoleClassificationOutput(raw, input).valid, false, label);
    const run = await runClassifier([reply(raw)]);
    // Idempotent: the soft output passes the strict check and the orchestration's re-check.
    assert.equal(validateClaudeEvidenceRoleClassificationOutput(plain(run.result.output), input).valid, true, label);
    assert.deepEqual(plain(completeClaudeEvidenceRoleClassificationOutput(run.result.output, input).output),
      plain(run.result.output), label);
  }
});

test('Step 9F.4e: the partial keep now also covers the after-close fault plus a soft subject fault', async () => {
  const output = withChanges(GOOD, {
    e1: {subjects: REPEAT},
    e3: {roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']}
  });
  const on = await runClassifier([reply(output), reply(output)]);
  assert.equal(on.result.type, 'CONTRACT_FAILURE');
  assert.equal(on.result.message, 'subsequent development cannot be a principal catalyst');
  assert.equal(on.calls, 2, 'no extra call');
  assert.deepEqual([...on.keep.demotedReferences], ['e3']);
  assert.deepEqual(on.keep.output.classifications[2].roles, ['MATERIAL_EVENT']);
  assert.deepEqual(on.keep.output.classifications[0].subjects.map(subject => subject.name), ['Acme Widgets']);
  assert.deepEqual(on.keep.output.classifications[0].roles, ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']);
  const off = await runClassifier([reply(output), reply(output)], OFF);
  assert.equal(off.keep, null, 'off: a mixed fault keeps the whole fallback, as before');
  // A real shape fault beside the after-close fault still keeps nothing.
  const mixed = withChanges(output, {e1: {subjects: [company('')]}});
  assert.equal((await runClassifier([reply(mixed), reply(mixed)])).keep, null);
});

test('Step 9F.4e: the log line holds references and categories only', async () => {
  const run = await runClassifier([reply(withChanges(GOOD, {e1: {subjects: OVER_FIVE}, e2: {subjects: SPACES}}))]);
  const serialized = JSON.stringify(run.softFixes);
  assert.ok(run.softFixes.length === 1);
  assert.deepEqual(Object.keys(run.softFixes[0]), ['stage', 'call', 'attempt', 'fixes', 'fixedReferenceCount']);
  for (const forbidden of ['Acme', 'Zeta', 'Omega', 'US stocks', 'Made-up', 'test-key']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('Step 9F.4e: one code path for both Haiku models', async () => {
  const model = SETTINGS_REGISTRY.claudeModel.envVar;
  const output = withChanges(GOOD, {e1: {subjects: OVER_FIVE}, e2: {subjects: REPEAT}, e3: {subjects: SPACES}});
  const runs = {};
  for (const id of ['haiku-4.5', 'haiku-5.5']) {
    runs[id] = await withEnv({[model]: id, [SETTINGS_REGISTRY.modelChoiceEnabled.envVar]: 'on'},
      () => runClassifier([reply(output)]));
  }
  assert.notEqual(JSON.parse(runs['haiku-4.5'].bodies[0]).model, JSON.parse(runs['haiku-5.5'].bodies[0]).model);
  assert.equal(runs['haiku-4.5'].result.ok, true);
  assert.deepEqual(plain(runs['haiku-4.5'].result), plain(runs['haiku-5.5'].result));
  assert.deepEqual(runs['haiku-4.5'].softFixes, runs['haiku-5.5'].softFixes);
});

// ---------------------------------------------------------------------------
// The subject repair uses the same rules and switch
// ---------------------------------------------------------------------------
function repairInput() {
  return {evidence: [
    {reference: 'e7', title: ARTICLES[0][1], summary: ARTICLES[0][2]},
    {reference: 'e9', title: ARTICLES[1][1], summary: null}
  ]};
}

async function runRepair(repairs, env = {}) {
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeEvidenceSubjectRepair({
    input: repairInput(), apiKey: 'test-key', env, onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => { calls++; return reply({repairs}); }
  });
  return {result, calls, softFixes: plain(diagnostics.filter(value => value.stage === 'classifierSubjectSoftFix'))};
}

test('Step 9F.4e: subject repair: soft faults fixed with the switch on, failed with it off; shape faults fail', async () => {
  const repairs = [{reference: 'e7', subjects: OVER_FIVE}, {reference: 'e9', subjects: [...REPEAT, ...SPACES]}];
  const on = await runRepair(repairs);
  assert.equal(on.result.ok, true);
  assert.equal(on.calls, 1);
  assert.deepEqual(on.result.output.repairs.map(repair => repair.subjects.map(subject => subject.name)),
    [SIX.slice(0, 5), ['Acme Widgets']]);
  assert.deepEqual(on.softFixes, [{
    stage: 'classifierSubjectSoftFix', call: 'subjectRepair', attempt: 0,
    fixes: [
      {category: 'DUPLICATE_SUBJECT', references: ['e9']},
      {category: 'UNTRIMMED_SUBJECT_NAME', references: ['e9']},
      {category: 'OVER_FIVE_SUBJECTS', references: ['e7']}
    ],
    fixedReferenceCount: 2
  }]);
  // The orchestration re-checks the repair output strictly; it passes unchanged.
  assert.deepEqual(plain(createClaudeEvidenceSubjectRepairOutput(on.result.output, repairInput())),
    plain(on.result.output));
  const off = await runRepair(repairs, OFF);
  assert.equal(off.result.type, 'CONTRACT_FAILURE');
  assert.equal(off.result.message, SUBJECT_FAILURE);
  assert.deepEqual(off.softFixes, []);
  const shape = await runRepair([{reference: 'e7', subjects: [company('   ')]}, {reference: 'e9', subjects: []}]);
  assert.equal(shape.result.type, 'CONTRACT_FAILURE');
  assert.deepEqual(shape.softFixes, []);
});

// ---------------------------------------------------------------------------
// The whole package, WEEKEND (Sunday 6 Sep; last close Friday 4 Sep 20:00Z)
// ---------------------------------------------------------------------------
const GENERATED_AT = '2026-09-06T10:00:00.000Z';
const COMPLETED_TIME = '2026-09-04T18:00:00.000Z';
const AFTER_CLOSE_TIME = '2026-09-04T20:48:00.000Z';

function snapshot(symbol) {
  const sessions = [
    ['2026-08-31', 97, 96], ['2026-09-01', 98, 97], ['2026-09-02', 99, 98],
    ['2026-09-03', 100, 99], ['2026-09-04', 105, 100]
  ].map(([sessionDate, close, previousClose], index) => createCompletedRegularSession({
    market: 'US', sessionDate, open: close - 1, high: close + 5, low: close - 5,
    close, previousClose, volume: 900 + index * 25,
    asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }));
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY', currency: 'USD',
    marketState: 'WEEKEND', completedSessions: sessions, currentOverlay: null
  });
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const STORIES = [
  ['Acme Widgets shares jump in made-up session story', COMPLETED_TIME],
  ['Made-up story with no named company', COMPLETED_TIME],
  ['Made-up after-close note on Acme Widgets results', AFTER_CLOSE_TIME]
];

// Every label is valid except one repeated subject on each Acme Widgets story.
function build() {
  const diagnostics = [];
  const calls = {fetch: 0, repair: 0};
  const labels = input => ({classifications: input.evidence.map(({reference, horizon, item}) => {
    if (item.evidenceCategory !== 'news') return {reference, materiality: 'LOW', roles: [], subjects: []};
    const named = item.title.includes('Acme Widgets') ? REPEAT : [];
    if (horizon === 'SUBSEQUENT_DEVELOPMENT') {
      return {reference, materiality: 'HIGH', roles: ['MATERIAL_EVENT'], subjects: named};
    }
    return {reference, materiality: 'HIGH',
      roles: named.length ? ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'] : ['MATERIAL_EVENT'], subjects: named};
  })});
  const dependencies = {
    createTelemetryAcquisition: () => ({async acquireSnapshot({symbol}) { return snapshot(symbol); }}),
    snapshotPersistence: {async persistSnapshot(value) { return value; }},
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) {
      return createEvidenceCollection({market: 'US', items: [createEvidenceItem({
        sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
        title: `${symbol} market data`, summary: `${symbol} factual market data.`,
        canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
        publishedAt: '2026-09-05T20:00:00Z', symbols: [symbol]
      })]});
    }},
    yahooMostActiveAcquisition: {async acquireMostActive() { return {ok: true, type: 'NOT_FOUND', candidates: []}; }},
    yahooLatestNewsDiscovery: {async discoverLatestNews() {
      return {ok: true, type: 'SUCCESS', candidates: STORIES.map(([headline]) => ({
        headline, url: `https://finance.yahoo.com/news/${slug(headline)}.html`, uuid: null, publisher: 'Yahoo Finance'
      }))};
    }},
    yahooCurrentNewsArticleContentAcquisition: {async acquireArticleContent(candidate) {
      const [, publishedAt] = STORIES.find(([headline]) => headline === candidate.headline);
      return {ok: true, type: 'SUCCESS', articleContent: {
        sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url, headline: candidate.headline,
        publisher: 'Yahoo Finance', publishedAt, updatedAt: null,
        articleText: `${candidate.headline}. Made-up article text for a test. `.repeat(20)
      }};
    }},
    federalReserveEvidenceAcquisition: {async acquireEvidence() {
      return createEvidenceCollection({market: 'US', items: [createEvidenceItem({
        sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
        title: 'Federal Reserve policy statement',
        canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm',
        publishedAt: '2026-09-04T18:00:00Z', symbols: []
      })]});
    }},
    yahooRecapResearch: {async discoverAndValidateRecap() {
      return {ok: true, type: 'NOT_FOUND', discovery: null, validation: null};
    }},
    yahooRecapArticleContentAcquisition: {async acquireArticleContent() { throw new Error('not expected'); }},
    yahooRecapEvidenceConstruction: {constructEvidence() { throw new Error('not expected'); }},
    yahooRecapArticleContentBounds: Object.freeze({
      timeoutMs: 4000, maxResponseBytes: 1258291, maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256, maxArticleTextBytes: 8192, maxResultBytes: 12288
    }),
    cnbcRecapResearch: {async researchCompletedSessionRecap() {
      return {ok: true, type: 'NOT_FOUND', constructedEvidence: null};
    }},
    cnbcNewsResearch: {async researchNews() { return {ok: true, type: 'NOT_FOUND'}; }},
    evidenceRoleClassification: {
      // The real labelling module with a made-up reply in place of the network.
      classifyEvidenceRoles(input) {
        return invokeClaudeEvidenceRoleClassification({
          input, apiKey: 'test-key', onDiagnostics: value => diagnostics.push(value),
          fetchImpl: async () => {
            calls.fetch++;
            return reply(labels(input));
          }
        });
      },
      async repairEvidenceSubjects(input) {
        calls.repair++;
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(({reference}) => ({reference, subjects: []}))}};
      }
    },
    now: () => new Date(GENERATED_AT),
    onDiagnostics: value => diagnostics.push(value)
  };
  return {service: createUsAnalysisPackageOrchestrationService(dependencies), diagnostics, calls};
}

const PINNED = Object.freeze({CLASSIFIER_RETRY_COUNT: '1', CLASSIFIER_RETRY_GUIDANCE_ENABLED: 'on'});

async function assemble(switchValue) {
  const built = build();
  const output = await withEnv({...PINNED, [SWITCH]: switchValue}, () => built.service.assemble({
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}], selectedScope: 'US', initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore', myStocks: [], watchlist: []
  }));
  const context = output.marketPackages[0].evidenceContext;
  const refOf = title => context.evidence.find(entry => entry.item.title === title)?.reference;
  return {...built, output, context, refOf, stages: built.diagnostics.map(value => value.stage)};
}

test('Step 9F.4e: WEEKEND, a repeated subject: labels, drivers and focus are kept (nothing for rule 9 to blank)', async () => {
  const run = await assemble('on');
  const [completed, unnamed, note] = STORIES.map(([title]) => run.refOf(title));
  assert.ok(completed && unnamed && note);
  assert.equal(validateClaudeAnalysisInput(run.output), true);
  assert.equal(run.calls.fetch, 1, 'no retry');
  assert.deepEqual(run.context.principalCatalysts, [completed]);
  assert.ok([completed, unnamed, note].every(reference => run.context.materialEvents.includes(reference)));
  assert.deepEqual(plain(run.context.broadMarketFocus.filter(entry => [completed, note].includes(entry.evidenceRef))
    .map(entry => entry.subjects)), [ACME, ACME]);
  assert.equal(run.context.unresolvedGaps.some(gap => gap.includes(FAILED_GAP)), false);
  assert.equal(run.stages.includes('evidenceRoleClassificationFailure'), false);
  assert.equal(run.stages.includes('evidenceRoleClassificationFallback'), false);
  const fix = plain(run.diagnostics.find(value => value.stage === 'classifierSubjectSoftFix'));
  assert.equal(fix.call, 'classifier');
  assert.equal(fix.fixes.length, 1);
  assert.equal(fix.fixes[0].category, 'DUPLICATE_SUBJECT');
  assert.equal(fix.fixes[0].references.length, 2);
});

test('Step 9F.4e: WEEKEND, switch off: the whole fallback of ecb44f1', async () => {
  const run = await assemble('off');
  assert.equal(validateClaudeAnalysisInput(run.output), true);
  assert.equal(run.calls.fetch, 2, 'the first attempt and the one guided retry');
  assert.equal(run.calls.repair, 0);
  assert.deepEqual(run.context.materialEvents, []);
  assert.deepEqual(run.context.principalCatalysts, []);
  assert.deepEqual(run.context.broadMarketFocus, []);
  assert.equal(run.context.unresolvedGaps.filter(gap => gap.includes(FAILED_GAP)).length, 1);
  assert.equal(run.stages.includes('classifierSubjectSoftFix'), false);
  assert.ok(run.diagnostics.some(value => value.stage === 'evidenceRoleClassificationFallback'
    && value.outcome === 'CONSERVATIVE_UNCLASSIFIED'));
});

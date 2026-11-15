// Step 9F.4d: when the labelling step's last attempt fails only because after-close
// items were labelled a principal catalyst, just those items become material events
// and every other label is kept (classifierPartialKeepEnabled). Made-up articles and
// replies only: no real article text, no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  invokeClaudeEvidenceRoleClassification,
  classifierPartialKeepFor
} = require('../lib/claude-evidence-role-classification');
const {createUsAnalysisPackageOrchestrationService} = require('../lib/us-analysis-package-orchestration');
const {validateClaudeAnalysisInput} = require('../lib/claude-analysis-contract');

const SWITCH = 'CLASSIFIER_PARTIAL_KEEP_ENABLED';
const FAILED_GAP = 'Could not sort the news by what it explains';

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

const HORIZONS = ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT', 'SUBSEQUENT_DEVELOPMENT'];

function classifierInput(horizons = HORIZONS) {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'WEEKEND',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: benchmark()}],
    evidence: horizons.map((horizon, index) => ({
      reference: `e${index + 1}`, horizon, requiresBroadMarketSubjects: true,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
        title: `Made-up Acme Widgets story ${index + 1}`, summary: `Made-up body ${index + 1} about Acme Widgets.`,
        canonicalUrl: `https://www.cnbc.com/2026/09/11/made-up-${index + 1}.html`,
        publishedAt: horizon === 'COMPLETED_SESSION' ? '2026-09-11T18:00:00Z' : '2026-09-11T20:45:00Z',
        symbols: []
      })
    }))
  };
}

const ACME = [{kind: 'COMPANY', name: 'Acme Widgets'}];
const GOOD = {classifications: [
  {reference: 'e1', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: ACME},
  {reference: 'e2', materiality: 'LOW', roles: [], subjects: []},
  {reference: 'e3', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], subjects: ACME},
  {reference: 'e4', materiality: 'HIGH', roles: ['MATERIAL_EVENT'], subjects: ACME}
]};
// e3 and e4 are after-close items, so a principal catalyst label on them breaks the rule.
const withRoles = (output, changes) => ({classifications: output.classifications.map(entry =>
  Object.hasOwn(changes, entry.reference) ? {...entry, ...changes[entry.reference]} : entry)});
const BAD = withRoles(GOOD, {
  e3: {roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']},
  e4: {roles: ['PRINCIPAL_CATALYST']}
});

function reply(output, extra = {}) {
  return {ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output)}], usage: {}, ...extra}; }};
}

async function runClassifier(replies, env = {}, input = classifierInput()) {
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeEvidenceRoleClassification({
    input, apiKey: 'test-key', env, onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => replies[Math.min(calls++, replies.length - 1)]
  });
  return {result, calls, diagnostics, keep: classifierPartialKeepFor(result)};
}

test('Step 9F.4d: only the after-close rule broken twice: the failure stands, the kept labels demote just those refs', async () => {
  const {result, calls, keep} = await runClassifier([reply(BAD), reply(BAD)]);
  assert.equal(result.ok, false);
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(result.message, 'subsequent development cannot be a principal catalyst');
  assert.equal(calls, 2, 'no extra call');
  assert.deepEqual(JSON.parse(JSON.stringify(keep.demotedReferences)), ['e3', 'e4']);
  assert.deepEqual(JSON.parse(JSON.stringify(keep.output)), withRoles(BAD, {
    e3: {roles: ['MATERIAL_EVENT']}, e4: {roles: ['MATERIAL_EVENT']}
  }));
  // A valid completed-session principal catalyst (e1) is kept.
  assert.deepEqual(keep.output.classifications[0].roles, ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']);
  assert.equal(keep.classificationCoverage.missingReferenceCount, 0);
});

test('Step 9F.4d: retry count 0 keeps after the first attempt; a success or a fixed retry records nothing', async () => {
  const zero = await runClassifier([reply(BAD)], {CLASSIFIER_RETRY_COUNT: '0'});
  assert.equal(zero.calls, 1);
  assert.deepEqual([...zero.keep.demotedReferences], ['e3', 'e4']);
  const fixed = await runClassifier([reply(BAD), reply(GOOD)]);
  assert.equal(fixed.result.ok, true);
  assert.equal(fixed.keep, null);
  assert.equal((await runClassifier([reply(GOOD)])).keep, null);
});

test('Step 9F.4d: every other failure keeps no labels (mixed, missing, extra, malformed, truncated, bad re-check)', async () => {
  const cases = {
    'mixed with a bad materiality': withRoles(BAD, {e1: {materiality: 'HUGE'}}),
    'mixed with bad roles': withRoles(BAD, {e2: {roles: ['MATERIAL_EVENT', 'MATERIAL_EVENT']}}),
    'missing reference in a completed state': {classifications: BAD.classifications.filter(entry => entry.reference !== 'e2')},
    'unknown reference': {classifications: BAD.classifications.concat({reference: 'e9', materiality: 'LOW', roles: [], subjects: []})},
    'duplicate reference': {classifications: BAD.classifications.concat(BAD.classifications[3])},
    'out of order': {classifications: [BAD.classifications[1], BAD.classifications[0], ...BAD.classifications.slice(2)]},
    'malformed reply': '{"classifications": [',
    'not the reply shape': {labels: []},
    // The after-close rule is the first fault on e4, but its subjects are also invalid:
    // the one re-check after demotion fails, so nothing is kept.
    'bad subjects behind the rule break': withRoles(BAD, {e4: {subjects: [{kind: 'PERSON', name: 'Acme Widgets'}]}}),
    'a completed-session item only': withRoles(GOOD, {e2: {roles: ['PRINCIPAL_CATALYST'], materiality: 'BIG'}})
  };
  for (const [label, output] of Object.entries(cases)) {
    const {result, keep} = await runClassifier([reply(output), reply(output)]);
    assert.equal(result.type, 'CONTRACT_FAILURE', label);
    assert.equal(keep, null, label);
  }
  const truncated = await runClassifier([reply(BAD, {stop_reason: 'max_tokens'})]);
  assert.equal(truncated.calls, 1);
  assert.equal(truncated.keep, null);
  const upstream = await invokeClaudeEvidenceRoleClassification({
    input: classifierInput(), apiKey: 'test-key', fetchImpl: async () => ({ok: false, status: 529, headers: {get: () => null}})
  });
  assert.equal(classifierPartialKeepFor(upstream), null);
  assert.equal(classifierPartialKeepFor(null), null);
  assert.equal(classifierPartialKeepFor({ok: false, type: 'CONTRACT_FAILURE'}), null);
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
// Two completed-session stories and two after-close stories, all made up.
const STORIES = [
  ['Acme Widgets shares jump in made-up session story', COMPLETED_TIME],
  ['Made-up story with no named company', COMPLETED_TIME],
  ['Made-up market close recap: Acme Widgets leads the day', AFTER_CLOSE_TIME],
  ['Made-up after-close note on Acme Widgets results', AFTER_CLOSE_TIME]
];

function build({failure = 'SUBSEQUENT_ONLY'} = {}) {
  const diagnostics = [];
  const calls = {fetch: 0, repair: 0};
  const reply = input => ({classifications: input.evidence.map(({reference, horizon, item}) => {
    if (item.evidenceCategory !== 'news') return {reference, materiality: 'LOW', roles: [], subjects: []};
    const named = item.title.includes('Acme Widgets') ? ACME : [];
    if (horizon === 'SUBSEQUENT_DEVELOPMENT') {
      return {reference, materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: named};
    }
    return named.length
      ? {reference, materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: named}
      // HIGH material news with no subject: eligible for the (skipped) subject repair.
      : {reference, materiality: failure === 'MIXED' ? 'HUGE' : 'HIGH', roles: ['MATERIAL_EVENT'], subjects: []};
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
            return {ok: true, status: 200, headers: {get: () => null},
              async json() { return {content: [{type: 'text', text: JSON.stringify(reply(input))}], usage: {}}; }};
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

const byNumber = refs => [...refs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const PINNED = Object.freeze({CLASSIFIER_RETRY_COUNT: '1', CLASSIFIER_RETRY_GUIDANCE_ENABLED: 'on'});

async function assemble(switchValue, options) {
  const built = build(options);
  const output = await withEnv({...PINNED, [SWITCH]: switchValue}, () => built.service.assemble({
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}], selectedScope: 'US', initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore', myStocks: [], watchlist: []
  }));
  const context = output.marketPackages[0].evidenceContext;
  const refOf = title => context.evidence.find(entry => entry.item.title === title)?.reference;
  return {...built, output, context, refOf, stages: built.diagnostics.map(value => value.stage)};
}

test('Step 9F.4d: WEEKEND, after-close items labelled a cause twice: only they are demoted, the report keeps its labels', async () => {
  const run = await assemble('on');
  const [completed, unnamed, recap, note] = STORIES.map(([title]) => run.refOf(title));
  assert.ok(completed && unnamed && recap && note);
  assert.equal(validateClaudeAnalysisInput(run.output), true);
  assert.equal(run.calls.fetch, 2, 'the first attempt and the one guided retry; nothing added');
  assert.equal(run.calls.repair, 0, 'the subject repair is skipped on this path');
  assert.deepEqual(run.context.principalCatalysts, [completed]);
  assert.deepEqual(byNumber(run.context.materialEvents), byNumber([completed, unnamed, recap, note]));
  assert.deepEqual(byNumber(run.context.broadMarketFocus.map(entry => entry.evidenceRef)),
    byNumber([completed, recap, note]));
  assert.equal(run.context.unresolvedGaps.some(gap => gap.includes(FAILED_GAP)), false);
  assert.equal(run.context.unresolvedGaps.some(gap => gap.includes('Could not sort some of the news')), false);
  const failure = run.diagnostics.find(value => value.stage === 'evidenceRoleClassificationFailure');
  assert.deepEqual(Object.keys(failure), ['stage', 'failureType', 'failureMessage', 'upstreamStatus']);
  assert.deepEqual(JSON.parse(JSON.stringify(run.diagnostics.find(value =>
    value.stage === 'evidenceRoleClassificationPartialKeep'))), {
    stage: 'evidenceRoleClassificationPartialKeep',
    outcome: 'DEMOTED_PRINCIPAL_CATALYST',
    demotedReferences: byNumber([recap, note]),
    demotedReferenceCount: 2,
    keptReferenceCount: run.context.evidence.length - 2,
    subjectRepairSkipped: true
  });
  assert.equal(run.stages.includes('evidenceRoleClassificationFallback'), false);
  assert.equal(run.stages.includes('evidenceSubjectRepair'), false);
  const order = ['evidenceRoleClassificationFailure', 'evidenceRoleClassificationPartialKeep',
    'evidenceRoleClassificationCoverage'].map(name => run.stages.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0] >= 0);
  assert.equal(JSON.stringify(run.diagnostics.filter(value => value.stage === 'evidenceRoleClassificationPartialKeep'))
    .includes('Made-up'), false, 'no article text in the new log line');
});

test('Step 9F.4d: switch off keeps the whole fallback of e4baea5', async () => {
  const run = await assemble('off');
  assert.equal(run.calls.fetch, 2);
  assert.equal(run.calls.repair, 0);
  assert.deepEqual(run.context.materialEvents, []);
  assert.deepEqual(run.context.principalCatalysts, []);
  assert.deepEqual(run.context.broadMarketFocus, []);
  assert.equal(run.context.unresolvedGaps.filter(gap => gap.includes(FAILED_GAP)).length, 1);
  assert.equal(run.stages.includes('evidenceRoleClassificationPartialKeep'), false);
  assert.ok(run.diagnostics.some(value => value.stage === 'evidenceRoleClassificationFallback'
    && value.outcome === 'CONSERVATIVE_UNCLASSIFIED'));
});

test('Step 9F.4d: a mixed fault keeps the whole fallback with the switch on', async () => {
  const run = await assemble('on', {failure: 'MIXED'});
  assert.deepEqual(run.context.materialEvents, []);
  assert.deepEqual(run.context.broadMarketFocus, []);
  assert.equal(run.context.unresolvedGaps.filter(gap => gap.includes(FAILED_GAP)).length, 1);
  assert.equal(run.stages.includes('evidenceRoleClassificationPartialKeep'), false);
  assert.ok(run.stages.includes('evidenceRoleClassificationFallback'));
});

// ---------------------------------------------------------------------------
// Retry count 0: the same WEEKEND package, but with no retry allowed at all.
// The partial keep is computed from the single failed attempt, so it must not
// depend on the guided retry ever happening.
// ---------------------------------------------------------------------------
async function assembleNoRetry(switchValue, options) {
  const built = build(options);
  const output = await withEnv({...PINNED, CLASSIFIER_RETRY_COUNT: '0', [SWITCH]: switchValue}, () => built.service.assemble({
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}], selectedScope: 'US', initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore', myStocks: [], watchlist: []
  }));
  const context = output.marketPackages[0].evidenceContext;
  const refOf = title => context.evidence.find(entry => entry.item.title === title)?.reference;
  return {...built, output, context, refOf, stages: built.diagnostics.map(value => value.stage)};
}

test('Step 9F.4d: retry count 0, switch on: one fetch, the partial keep still applies', async () => {
  const run = await assembleNoRetry('on');
  const [completed, unnamed, recap, note] = STORIES.map(([title]) => run.refOf(title));
  assert.ok(completed && unnamed && recap && note);
  assert.equal(validateClaudeAnalysisInput(run.output), true);
  assert.equal(run.calls.fetch, 1, 'no retry at CLASSIFIER_RETRY_COUNT=0');
  assert.equal(run.calls.repair, 0, 'no subject-repair call');
  assert.deepEqual(run.context.principalCatalysts, [completed]);
  assert.deepEqual(byNumber(run.context.materialEvents), byNumber([completed, unnamed, recap, note]));
  assert.deepEqual(byNumber(run.context.broadMarketFocus.map(entry => entry.evidenceRef)),
    byNumber([completed, recap, note]));
  assert.equal(run.context.unresolvedGaps.some(gap => gap.includes(FAILED_GAP)), false);
  assert.deepEqual(JSON.parse(JSON.stringify(run.diagnostics.find(value =>
    value.stage === 'evidenceRoleClassificationPartialKeep'))), {
    stage: 'evidenceRoleClassificationPartialKeep',
    outcome: 'DEMOTED_PRINCIPAL_CATALYST',
    demotedReferences: byNumber([recap, note]),
    demotedReferenceCount: 2,
    keptReferenceCount: run.context.evidence.length - 2,
    subjectRepairSkipped: true
  });
  assert.equal(run.stages.includes('evidenceRoleClassificationFallback'), false);
  assert.equal(run.stages.includes('evidenceSubjectRepair'), false);
});

test('Step 9F.4d: retry count 0, switch off: whole fallback, identical to e4baea5', async () => {
  const run = await assembleNoRetry('off');
  assert.equal(run.calls.fetch, 1, 'no retry at CLASSIFIER_RETRY_COUNT=0');
  assert.equal(run.calls.repair, 0);
  assert.deepEqual(run.context.materialEvents, []);
  assert.deepEqual(run.context.principalCatalysts, []);
  assert.deepEqual(run.context.broadMarketFocus, []);
  assert.equal(run.context.unresolvedGaps.filter(gap => gap.includes(FAILED_GAP)).length, 1);
  assert.equal(run.stages.includes('evidenceRoleClassificationPartialKeep'), false);
  assert.ok(run.diagnostics.some(value => value.stage === 'evidenceRoleClassificationFallback'
    && value.outcome === 'CONSERVATIVE_UNCLASSIFIED'));
});

// Step 9AE: the Haiku 5.5 writing-depth block (haiku55WriterDepthEnabled). It is in every
// Haiku 5.5 writer request (first call and every retry), straight after the style lines and
// before the request-specific lines; never on Haiku 4.5 and never on any other call; switch off
// gives the Haiku 5.5 request exactly as before; no raw setting value reaches a log line.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {writerDepthGuideApplies, resolveModelChoice} = require('../lib/model-choice');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  buildClaudeEvidenceSubjectRepairRequest
} = require('../lib/claude-evidence-role-classification');
const {buildClaudeBoundedNewsDiscoveryRequest} = require('../lib/claude-bounded-news-discovery');
const {
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequests
} = require('../lib/claude-bounded-cnbc-market-news-discovery');
const {buildClaudeNewsMaterialityRequest} = require('../lib/claude-news-materiality-selection');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {MARKET_STATE_CASES, marketStateCase, providerTransport} = require('./fixtures/market-state-cases');

const BLOCK_START = ' HAIKU 5.5 WRITING DEPTH (every section).';
const SECTION_FOUR_START = ' Section 4: keep the text under the table short.';
const BLOCK_END = 'each Section 6 opportunity still needs its own focus reference.';
const STYLE_END = 'replace any banned word with the plain fact.';
const NEXT_START = ' Request-specific Section 3 telemetry allowlist:';
const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

async function withEnv(values, callback) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function count(text, part) {
  return text.split(part).length - 1;
}

// The writer system text with the block (and its Section 4 line) taken out.
function withoutBlock(system) {
  const start = system.indexOf(BLOCK_START);
  if (start < 0) return system;
  const end = system.indexOf(BLOCK_END, start) + BLOCK_END.length;
  const four = system.indexOf(SECTION_FOUR_START, end);
  const tail = four === end ? system.indexOf('for Section 4.', four) + 'for Section 4.'.length : end;
  return system.slice(0, start) + system.slice(tail);
}

function classifierInput() {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  });
  const snapshot = createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: '^GSPC benchmark', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot}],
    evidence: [1, 2].map(index => ({
      reference: `e${index}`, horizon: 'COMPLETED_SESSION', requiresBroadMarketSubjects: false,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
        title: `Canonical evidence ${index}`, summary: `Bounded evidence summary ${index}.`,
        canonicalUrl: `https://www.cnbc.com/2026/09/11/evidence-${index}.html`,
        publishedAt: '2026-09-11T19:30:00Z', symbols: []
      })
    }))
  };
}

const MATERIALITY_BOUNDS = Object.freeze({
  maxCandidates: 30, maxTitleBytes: 200, maxSummaryBytes: 1000, maxExtractBytes: 1000,
  maxCollectionBytes: 50000
});

function materialityCollection() {
  const candidates = ['c1', 'c2'].map(reference => createNewsEvidenceCandidate({
    reference,
    horizon: {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-07T20:00:00Z',
      endsAtInclusive: '2026-09-08T20:00:00Z'
    },
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: `Candidate ${reference}`, summary: 'Bounded factual candidate summary.', extract: null,
    canonicalUrl: `https://www.cnbc.com/${reference}.html`, publishedAt: '2026-09-08T13:00:00Z',
    symbols: []
  }, {bounds: MATERIALITY_BOUNDS}));
  return createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds: MATERIALITY_BOUNDS});
}

function otherRequests() {
  return {
    classifier: buildClaudeEvidenceRoleClassificationRequest(classifierInput()),
    subjectRepair: buildClaudeEvidenceSubjectRepairRequest({evidence: [{
      reference: 'e28', title: 'Friday stock stories',
      summary: 'Microsoft and Apple advanced while Financials led.'
    }]}),
    recapSearch: buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-09-09'}),
    cnbcSearch: buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate: '2026-09-09'}),
    materiality: buildClaudeNewsMaterialityRequest(materialityCollection(), MATERIALITY_BOUNDS)
  };
}

function reply(output) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }
  };
}

test('Step 9AE: the setting is one Admin on/off switch, default on', () => {
  const entry = SETTINGS_REGISTRY.haiku55WriterDepthEnabled;
  assert.equal(entry.admin, 'Admin');
  assert.equal(entry.boolean, true);
  assert.equal(entry.default, true);
  assert.equal(entry.envVar, 'HAIKU55_WRITER_DEPTH_ENABLED');
});

test('Step 9AE: writerDepthGuideApplies is true only for Haiku 5.5 with the switch on', () => {
  const newer = resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-5.5'}});
  const older = resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-4.5'}});
  assert.equal(writerDepthGuideApplies(newer, {env: {}}), true);
  assert.equal(writerDepthGuideApplies(newer, {env: {HAIKU55_WRITER_DEPTH_ENABLED: 'off'}}), false);
  assert.equal(writerDepthGuideApplies(older, {env: {}}), false);
  assert.equal(writerDepthGuideApplies(older, {env: {HAIKU55_WRITER_DEPTH_ENABLED: 'on'}}), false);
  assert.equal(writerDepthGuideApplies(null, {env: {}}), false);
});

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AE: ${marketState} -- Haiku 5.5 writer carries the block once, in place; switch off and Haiku 4.5 do not`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input));
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    const old = await withEnv({}, () => buildClaudeAnalysisRequest(input));
    const oldOn = await withEnv({CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'},
      () => buildClaudeAnalysisRequest(input));
    const oldOff = await withEnv({CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    const modelOff = await withEnv({MODEL_CHOICE_ENABLED: 'off', CLAUDE_MODEL: 'haiku-5.5'},
      () => buildClaudeAnalysisRequest(input));

    assert.equal(count(on.system, BLOCK_START), 1);
    assert.equal(count(on.system, SECTION_FOUR_START), 1, 'table prompt: Section 4 line present');
    const start = on.system.indexOf(BLOCK_START);
    assert.ok(on.system.slice(0, start).endsWith(STYLE_END), 'block follows the style lines');
    assert.ok(on.system.indexOf(NEXT_START) > start, 'block precedes the request-specific lines');
    assert.equal(off.system.endsWith(withoutBlock(on.system).slice(-200)), true,
      'the end of the system text is unchanged');

    for (const request of [off, old, oldOn, oldOff, modelOff]) {
      assert.equal(count(request.system, BLOCK_START), 0);
      assert.equal(count(request.system, SECTION_FOUR_START), 0);
    }
    assert.equal(withoutBlock(on.system), off.system);
    const {system, ...rest} = on;
    const {system: offSystem, ...offRest} = off;
    assert.equal(JSON.stringify(rest), JSON.stringify(offRest));
    assert.equal(JSON.stringify(oldOn), JSON.stringify(old));
    assert.equal(JSON.stringify(oldOff), JSON.stringify(old));
    assert.equal(JSON.stringify(modelOff), JSON.stringify(old));
  });
}

test('Step 9AE: without the table prompt the block has no Section 4 line', async () => {
  const {input} = marketStateCase(...MARKET_STATE_CASES[3]);
  const request = await withEnv({CLAUDE_MODEL: 'haiku-5.5', SECTION_FOUR_TABLE_ENABLED: 'off'},
    () => buildClaudeAnalysisRequest(input));
  assert.equal(count(request.system, BLOCK_START), 1);
  assert.equal(count(request.system, SECTION_FOUR_START), 0);
});

test('Step 9AE: no other call carries the block on Haiku 5.5', async () => {
  const requests = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => otherRequests());
  for (const [name, value] of Object.entries(requests)) {
    for (const request of [].concat(value)) {
      assert.equal(request.model, 'claude-haiku-5-5', name);
      assert.equal(JSON.stringify(request).includes('HAIKU 5.5 WRITING DEPTH'), false, name);
    }
  }
});

test('Step 9AE: every Haiku 5.5 writer round carries the block (first call, contract retry, section retry)', async () => {
  const {input, output} = marketStateCase(...MARKET_STATE_CASES[1]);
  const empty = structuredClone(output);
  empty.status = 'DEGRADED';
  empty.sections[2] = {...empty.sections[2], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['No usable focus evidence was supplied.']};
  empty.evidenceGaps = ['Section 3 had no usable focus evidence.'];
  const systems = [];
  let call = 0;
  await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      systems.push(JSON.parse(options.body).system);
      call++;
      if (call === 1) {
        return {ok: true, status: 200, headers: {get: () => null},
          async json() { return {content: [{type: 'text', text: 'not a structured reply'}]}; }};
      }
      return reply(call === 2 ? empty : output);
    }
  }));
  assert.ok(systems.length >= 3, `expected at least 3 writer calls, got ${systems.length}`);
  for (const system of systems) {
    assert.equal(count(system, BLOCK_START), 1);
    assert.ok(system.indexOf(BLOCK_START) < system.indexOf(NEXT_START));
  }
  assert.ok(systems.slice(2).some(system => system.length > systems[0].length),
    'a section-retry round appended its instruction after the block');
});

test('Step 9AE: no raw model setting value reaches any log line', async () => {
  const {input, output} = marketStateCase(...MARKET_STATE_CASES[0]);
  const junk = {CLAUDE_MODEL: 'zz-raw-model-9ae', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9ae'};
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(value =>
      typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  }
  const diagnostics = [];
  try {
    await withEnv(junk, () => invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => reply(output),
      onDiagnostics: value => diagnostics.push(value)
    }));
    await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9ae'},
      () => invokeClaudeAnalysis({
        input, apiKey: 'test-key', fetchImpl: async () => reply(output),
        onDiagnostics: value => diagnostics.push(value)
      }));
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
  const all = lines.concat(diagnostics.map(value => JSON.stringify(value))).join('\n');
  assert.ok(lines.some(line => line.includes('modelChoiceFallback')), 'the fallback line was written');
  for (const value of Object.values(junk)) assert.equal(all.includes(value), false, value);
});

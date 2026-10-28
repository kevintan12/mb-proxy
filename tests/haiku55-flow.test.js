// Step 9AE.2: the Haiku 5.5 block asks for connected paragraphs instead of the shared
// short-sentence rules, fuller Sections 6 and 7, and Section 4 company news when no article gives
// a reason (never as a cause). The flow line and the new Section 4 wording are in every Haiku 5.5
// writer request (first call and every retry) with haiku55WriterDepthEnabled on; never on
// Haiku 4.5, with the switch off, or on any other call. The shared style lines are unchanged, and
// the switch-off Haiku 5.5 and Haiku 4.5 requests are the 5e83159 requests exactly.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const FLOW_START = ' SENTENCES AND FLOW: in this request, plain English means everyday words';
const SECTION_FOUR_NEWS = 'This replaces the earlier instruction to write only reasons for the move.';
const NO_FIELD_NAMES = 'Never name data fields, reference codes or these instructions in section text or notes';
const OLD_ONE_IDEA = 'Keep one idea per sentence.';
const NEXT_START = ' Request-specific Section 3 telemetry allowlist:';
const SHARED_STYLE_LINES = [
  'Keep every sentence under 25 words and give each sentence one idea. Do not join two ideas with '
    + '"while", "as", "with" or a semicolon.',
  'use short, direct sentences where practical',
  'Before finishing each section, reread it: split any sentence over 25 words into two, and replace '
    + 'any banned word with the plain fact.'
];
const NEW_PARTS = [FLOW_START, SECTION_FOUR_NEWS, NO_FIELD_NAMES];
const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

// sha256 of JSON.stringify(writer request) at 5e83159, per fixture state: Haiku 5.5 with the
// switch off, and the default model (Haiku 4.5).
const BASELINE_5E83159 = Object.freeze({
  PRE: {off55: '3328e0c44f82a9ea182c751421643a07ae1abd8dbf54e242f4c2864310a124b5',
    default: '48bc9ebfd14006bf5e59fecfbd08d18936a64e6f266bca4a1e76332df04e9adc'},
  REGULAR: {off55: '3ac2b4c8736ab8a0ee79f057912b2993fc03e86a1e67f928eacb6fa7d929235a',
    default: 'b6d7cd2a8bcaf9ac5a8932bb411621fb84cbd0ee3cc573718a91b7ad36f8037d'},
  POST: {off55: 'bb15bbf8cdd1e47fd6dc4be66f051bcc665b939d7eb78b2fed0cf04674ead7f6',
    default: 'd364ae424643462c683d7488f4251ce9dfea9672f19f5e330832c991fb175957'},
  CLOSED: {off55: 'b6d4bb91118d8591f9eb8fa292d69bfdde69df343f501d506b81ff1d94965e14',
    default: '6703e94fb6ac42b4321a9701918e69ce6d6f1b19db9049bd529211d5e8e2a9c9'},
  WEEKEND: {off55: '629607e7bd111c669de7bb487ab9af73bdcbe257d8e7db288814375da0b85eeb',
    default: '95bb910a0a9c4ccef0aa600bd30851b2db717339590e8824b5e7cba041a51558'},
  HOLIDAY: {off55: '13df00fc7f48df4145a035550c3a10a8f718c62929d4b0adcc19a524b24d9de0',
    default: '7552a06d9c68874a2b896c9fb93fe2eb21886f7fe405a3e78b14ff18a9e7d5a4'}
});

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

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
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

function reply(output) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }
  };
}

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AE.2: ${marketState} -- Haiku 5.5 carries the flow and Section 4 wording once; Haiku 4.5 and switch off are the 5e83159 requests`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input));
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    const old = await withEnv({}, () => buildClaudeAnalysisRequest(input));
    const oldNamed = await withEnv({CLAUDE_MODEL: 'haiku-4.5'}, () => buildClaudeAnalysisRequest(input));
    const oldOn = await withEnv({CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'},
      () => buildClaudeAnalysisRequest(input));
    const oldOff = await withEnv({CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    const modelOff = await withEnv({MODEL_CHOICE_ENABLED: 'off', CLAUDE_MODEL: 'haiku-5.5'},
      () => buildClaudeAnalysisRequest(input));

    for (const part of NEW_PARTS) assert.equal(count(on.system, part), 1, part);
    assert.equal(count(on.system, OLD_ONE_IDEA), 0, 'the old one-idea line is gone');
    const block = on.system.indexOf(BLOCK_START);
    assert.ok(block < on.system.indexOf(FLOW_START), 'the flow line is inside the block');
    assert.ok(on.system.indexOf(SECTION_FOUR_NEWS) < on.system.indexOf(NEXT_START),
      'the Section 4 wording precedes the request-specific lines');

    for (const request of [on, off, old, oldNamed, oldOn, oldOff, modelOff]) {
      for (const line of SHARED_STYLE_LINES) assert.equal(count(request.system, line), 1, line);
    }
    for (const request of [off, old, oldNamed, oldOn, oldOff, modelOff]) {
      for (const part of NEW_PARTS) assert.equal(count(request.system, part), 0, part);
    }

    assert.equal(fingerprint(off), BASELINE_5E83159[marketState].off55, 'switch off = 5e83159 Haiku 5.5');
    for (const request of [old, oldNamed, oldOn, oldOff, modelOff]) {
      assert.equal(fingerprint(request), BASELINE_5E83159[marketState].default, 'Haiku 4.5 = 5e83159');
    }
  });
}

test('Step 9AE.2: without the table prompt the flow line is kept and the Section 4 wording is not added', async () => {
  const {input} = marketStateCase(...MARKET_STATE_CASES[3]);
  const request = await withEnv({CLAUDE_MODEL: 'haiku-5.5', SECTION_FOUR_TABLE_ENABLED: 'off'},
    () => buildClaudeAnalysisRequest(input));
  assert.equal(count(request.system, FLOW_START), 1);
  assert.equal(count(request.system, NO_FIELD_NAMES), 1);
  assert.equal(count(request.system, SECTION_FOUR_NEWS), 0);
});

test('Step 9AE.2: no other call carries the new wording on Haiku 5.5', async () => {
  const requests = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => ({
    classifier: buildClaudeEvidenceRoleClassificationRequest(classifierInput()),
    materiality: buildClaudeNewsMaterialityRequest(materialityCollection(), MATERIALITY_BOUNDS),
    subjectRepair: buildClaudeEvidenceSubjectRepairRequest({evidence: [{
      reference: 'e28', title: 'Friday stock stories',
      summary: 'Microsoft and Apple advanced while Financials led.'
    }]}),
    recapSearch: buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-09-09'}),
    cnbcSearch: buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate: '2026-09-09'})
  }));
  for (const [name, value] of Object.entries(requests)) {
    for (const request of [].concat(value)) {
      const text = JSON.stringify(request);
      for (const part of NEW_PARTS) assert.equal(text.includes(part.trim()), false, `${name}: ${part}`);
    }
  }
});

test('Step 9AE.2: every Haiku 5.5 writer round carries the flow and Section 4 wording once', async () => {
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
    for (const part of NEW_PARTS) assert.equal(count(system, part), 1, part);
    assert.equal(count(system, OLD_ONE_IDEA), 0);
  }
  assert.ok(systems.slice(2).some(system => system.length > systems[0].length),
    'a section-retry round was among the calls');
});

test('Step 9AE.2: no raw switch or model value reaches any log line', async () => {
  const {input, output} = marketStateCase(...MARKET_STATE_CASES[3]);
  const junk = {CLAUDE_MODEL: 'zz-raw-model-9ae2', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9ae2'};
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
    await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9ae2'},
      () => invokeClaudeAnalysis({
        input, apiKey: 'test-key', fetchImpl: async () => reply(output),
        onDiagnostics: value => diagnostics.push(value)
      }));
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
  const all = lines.concat(diagnostics.map(value => JSON.stringify(value))).join('\n');
  for (const value of Object.values(junk)) assert.equal(all.includes(value), false, value);
});

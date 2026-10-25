// Step 9AC Stage 1: the one shared model choice (lib/model-choice.js) -- allowed list,
// resolver and fallback log, request fields, cost line, refusal rule, the ?claude=1
// guard and the optional per-request model.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALLOWED_MODELS,
  emitModelCost,
  guardLegacyModel,
  modelCallCost,
  modelRequestFields,
  resolveModelChoice,
  runWithModelChoiceContext
} = require('../lib/model-choice');
const {markTruncatedFailure, retryOnContractFailure} = require('../lib/contract-retry');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  buildClaudeEvidenceSubjectRepairRequest,
  invokeClaudeEvidenceRoleClassification
} = require('../lib/claude-evidence-role-classification');
const {buildClaudeBoundedNewsDiscoveryRequest} = require('../lib/claude-bounded-news-discovery');
const {
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequests
} = require('../lib/claude-bounded-cnbc-market-news-discovery');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {MARKET_STATE_CASES, marketStateCase, providerTransport} = require('./fixtures/market-state-cases');
const handler = require('../api/quote');

const HAIKU_45 = 'claude-haiku-4-5-20251001';
const HAIKU_55 = 'claude-haiku-5-5';
const MODEL_ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'LEGACY_MODEL_GUARD_ENABLED',
  'USER_MODEL_CHOICE_ENABLED'];

// Runs `callback` with the model settings in process.env set to `values` (others
// removed), then restores them.
async function withEnv(values, callback) {
  const saved = Object.fromEntries(MODEL_ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of MODEL_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of MODEL_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

async function captureInfo(callback) {
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.map(String).join(' '));
  try {
    const result = await callback();
    return {result, lines};
  } finally {
    console.info = original;
  }
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

function subjectRepairInput() {
  return {
    evidence: [{
      reference: 'e28', title: 'Friday stock stories',
      summary: 'Microsoft and Apple advanced while Financials led.'
    }]
  };
}

// Every request each builder makes, for one market state's writer input.
function allRequests(writerInput) {
  return {
    writer: buildClaudeAnalysisRequest(writerInput),
    classifier: buildClaudeEvidenceRoleClassificationRequest(classifierInput()),
    subjectRepair: buildClaudeEvidenceSubjectRepairRequest(subjectRepairInput()),
    recapSearch: buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-09-09'}),
    cnbcSearch: buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate: '2026-09-09'})
  };
}

const BD7EF08_LIMITS = {writer: 4000, classifier: 4000, subjectRepair: 2000, recapSearch: 512,
  cnbcSearch: 768, materiality: 4000};
const HAIKU_55_LIMITS = {writer: 5200, classifier: 5200, subjectRepair: 2600, recapSearch: 680,
  cnbcSearch: 1000, materiality: 5200};

test('Step 9AC: the allowed list holds exactly Haiku 4.5 and Haiku 5.5 with Kevin\'s limits', () => {
  assert.deepEqual(Object.keys(ALLOWED_MODELS), ['haiku-4.5', 'haiku-5.5']);
  assert.equal(ALLOWED_MODELS['haiku-4.5'].apiModel, HAIKU_45);
  assert.equal(ALLOWED_MODELS['haiku-5.5'].apiModel, HAIKU_55);
  assert.deepEqual({...ALLOWED_MODELS['haiku-4.5'].maxTokens}, BD7EF08_LIMITS);
  assert.deepEqual({...ALLOWED_MODELS['haiku-5.5'].maxTokens}, HAIKU_55_LIMITS);
  assert.equal(Object.isFrozen(ALLOWED_MODELS['haiku-5.5'].price.long), true);
});

test('Step 9AC: the default is Haiku 4.5; switch off ignores CLAUDE_MODEL', () => {
  assert.equal(resolveModelChoice({env: {}}).apiModel, HAIKU_45);
  assert.equal(resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-5.5'}}).apiModel, HAIKU_55);
  assert.equal(resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-4.5'}}).apiModel, HAIKU_45);
  assert.equal(resolveModelChoice({env: {MODEL_CHOICE_ENABLED: 'off', CLAUDE_MODEL: 'haiku-5.5'}}).apiModel,
    HAIKU_45);
});

test('Step 9AC: unknown, empty, mixed-case and retired values fall back and log the reason only', async () => {
  const retiredModels = {
    ...ALLOWED_MODELS,
    'haiku-5.5': {...ALLOWED_MODELS['haiku-5.5'], status: 'retired'}
  };
  const cases = [
    ['claude-opus-5-5', 'UNKNOWN', ALLOWED_MODELS],
    ['', 'UNKNOWN', ALLOWED_MODELS],
    ['Haiku-5.5', 'UNKNOWN', ALLOWED_MODELS],
    [' haiku-5.5', 'UNKNOWN', ALLOWED_MODELS],
    ['haiku-5.5', 'RETIRED', retiredModels]
  ];
  for (const [value, reason, models] of cases) {
    const {result, lines} = await captureInfo(() => resolveModelChoice({env: {CLAUDE_MODEL: value}, models}));
    assert.equal(result.apiModel, HAIKU_45, value);
    assert.equal(lines.length, 1, value);
    assert.equal(lines[0], `[model-choice] ${JSON.stringify({
      stage: 'modelChoiceFallback', reason, source: 'CLAUDE_MODEL', fallbackModel: 'haiku-4.5'
    })}`);
    if (value.trim()) assert.equal(lines[0].includes(value), false, 'raw value never logged');
  }
  const {lines} = await captureInfo(() => resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-5.5'}}));
  assert.deepEqual(lines, []);
});

test('Step 9AC: inside one request a fallback is logged once', async () => {
  const {lines} = await captureInfo(() => runWithModelChoiceContext({}, () => {
    for (let index = 0; index < 4; index++) resolveModelChoice({env: {CLAUDE_MODEL: 'nope'}});
  }));
  assert.equal(lines.length, 1);
});

test('Step 9AC: the per-request model is read only with userModelChoiceEnabled on', async () => {
  const on = {USER_MODEL_CHOICE_ENABLED: 'on'};
  assert.equal(runWithModelChoiceContext({queryModel: 'haiku-5.5'},
    () => resolveModelChoice({env: {}})).apiModel, HAIKU_45);
  assert.equal(runWithModelChoiceContext({queryModel: 'haiku-5.5'},
    () => resolveModelChoice({env: on})).apiModel, HAIKU_55);
  assert.equal(runWithModelChoiceContext({queryModel: 'haiku-4.5'},
    () => resolveModelChoice({env: {...on, CLAUDE_MODEL: 'haiku-5.5'}})).apiModel, HAIKU_45);
  assert.equal(runWithModelChoiceContext({queryModel: 'haiku-5.5'},
    () => resolveModelChoice({env: {...on, MODEL_CHOICE_ENABLED: 'off'}})).apiModel, HAIKU_45);
  const {result, lines} = await captureInfo(() => runWithModelChoiceContext({queryModel: 'claude-x'},
    () => resolveModelChoice({env: {...on, CLAUDE_MODEL: 'haiku-5.5'}})));
  assert.equal(result.apiModel, HAIKU_55, 'an unknown query value falls back to CLAUDE_MODEL');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('claude-x'), false);
  assert.equal(JSON.parse(lines[0].slice('[model-choice] '.length)).source, 'query');
  assert.equal(runWithModelChoiceContext({queryModel: ['haiku-5.5']},
    () => resolveModelChoice({env: on})).apiModel, HAIKU_45);
});

test('Step 9AC: request fields -- Haiku 4.5 adds nothing, Haiku 5.5 adds thinking off after max_tokens', () => {
  for (const [callKind, limit] of Object.entries(BD7EF08_LIMITS)) {
    assert.deepEqual(modelRequestFields(callKind, {env: {}}), {model: HAIKU_45, max_tokens: limit});
    const fields = modelRequestFields(callKind, {env: {CLAUDE_MODEL: 'haiku-5.5'}});
    assert.deepEqual(Object.keys(fields), ['model', 'max_tokens', 'thinking']);
    assert.deepEqual(fields, {model: HAIKU_55, max_tokens: HAIKU_55_LIMITS[callKind], thinking: {type: 'disabled'}});
  }
  assert.throws(() => modelRequestFields('somethingElse', {env: {}}), TypeError);
});

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AC: ${marketState} -- every request on Haiku 4.5 equals the switch-off request; Haiku 5.5 differs only in model, max_tokens and thinking`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const off = await withEnv({MODEL_CHOICE_ENABLED: 'off'}, () => allRequests(input));
    const on = await withEnv({}, () => allRequests(input));
    const named = await withEnv({CLAUDE_MODEL: 'haiku-4.5'}, () => allRequests(input));
    const newer = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => allRequests(input));
    for (const name of Object.keys(off)) {
      assert.equal(JSON.stringify(on[name]), JSON.stringify(off[name]), name);
      assert.equal(JSON.stringify(named[name]), JSON.stringify(off[name]), name);
      const offList = [].concat(off[name]);
      const newerList = [].concat(newer[name]);
      assert.equal(newerList.length, offList.length);
      for (const [index, request] of newerList.entries()) {
        const before = offList[index];
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.hasOwn(before, 'thinking'), false);
        assert.equal(Object.hasOwn(before, 'effort'), false);
        assert.equal(JSON.stringify(before).includes('"effort"'), false);
        assert.deepEqual(Object.keys(request), [
          ...Object.keys(before).slice(0, 2), 'thinking', ...Object.keys(before).slice(2)
        ]);
        assert.equal(request.model, HAIKU_55);
        assert.equal(request.max_tokens, HAIKU_55_LIMITS[name]);
        assert.deepEqual(request.thinking, {type: 'disabled'});
        const {model, max_tokens, thinking, ...rest} = request;
        const {model: oldModel, max_tokens: oldMax, ...oldRest} = before;
        assert.equal(JSON.stringify(rest), JSON.stringify(oldRest), name);
      }
    }
  });
}

test('Step 9AC: cost -- the 100,000-token line, cache tokens and searches', () => {
  const newer = resolveModelChoice({env: {CLAUDE_MODEL: 'haiku-5.5'}});
  const older = resolveModelChoice({env: {}});
  assert.equal(modelCallCost({input_tokens: 99999, output_tokens: 1000}, newer).priceCard, 'standard');
  assert.equal(modelCallCost({input_tokens: 100000, output_tokens: 1000}, newer).priceCard, 'standard');
  assert.equal(modelCallCost({input_tokens: 100001, output_tokens: 1000}, newer).priceCard, 'long');
  assert.equal(modelCallCost({input_tokens: 60000, cache_read_input_tokens: 30000,
    cache_creation_input_tokens: 10001}, newer).priceCard, 'long');
  assert.deepEqual(modelCallCost({input_tokens: 100000, output_tokens: 2000}, newer), {
    promptTokens: 100000, priceCard: 'standard', inputUsd: 0.01, outputUsd: 0.001, searchUsd: 0, totalUsd: 0.011
  });
  assert.deepEqual(modelCallCost({input_tokens: 100001, output_tokens: 2000}, newer), {
    promptTokens: 100001, priceCard: 'long', inputUsd: 0.050001, outputUsd: 0.005, searchUsd: 0, totalUsd: 0.055001
  });
  assert.deepEqual(modelCallCost({input_tokens: 32166, output_tokens: 2318}, older), {
    promptTokens: 32166, priceCard: 'standard', inputUsd: 0.032166, outputUsd: 0.01159, searchUsd: 0,
    totalUsd: 0.043756
  });
  assert.equal(modelCallCost({input_tokens: 500000}, older).priceCard, 'standard');
  assert.deepEqual(modelCallCost({input_tokens: 2000, output_tokens: 100,
    server_tool_use: {web_search_requests: 2}}, older), {
    promptTokens: 2000, priceCard: 'standard', inputUsd: 0.002, outputUsd: 0.0005, searchUsd: 0.02, totalUsd: 0.0225
  });
  assert.deepEqual(modelCallCost(null, older).totalUsd, 0);
  // Half a micro-dollar rounds up exactly (worked in whole nano-dollars, not floating dollars).
  assert.equal(modelCallCost({output_tokens: 3785}, newer).outputUsd, 0.001893);
  assert.equal(modelCallCost({output_tokens: 1995}, newer).outputUsd, 0.000998);
  assert.equal(modelCallCost({input_tokens: 109592, output_tokens: 3785}, newer).totalUsd, 0.064259);
});

test('Step 9AC: the cost line is written only with the switch on and usage present', async () => {
  const usage = {input_tokens: 1000, output_tokens: 100};
  const on = await captureInfo(() => emitModelCost({call: 'writer', model: HAIKU_45, requestId: 'req_1', usage,
    env: {}}));
  assert.equal(on.lines.length, 1);
  assert.deepEqual(JSON.parse(on.lines[0].slice('[model-cost] '.length)), {
    stage: 'modelCost', call: 'writer', model: HAIKU_45, requestId: 'req_1', promptTokens: 1000,
    priceCard: 'standard', inputUsd: 0.001, outputUsd: 0.0005, searchUsd: 0, totalUsd: 0.0015
  });
  assert.deepEqual((await captureInfo(() => emitModelCost({call: 'writer', model: HAIKU_45, usage,
    env: {MODEL_CHOICE_ENABLED: 'off'}}))).lines, []);
  assert.deepEqual((await captureInfo(() => emitModelCost({call: 'writer', model: HAIKU_45, usage: null,
    env: {}}))).lines, []);
  assert.deepEqual((await captureInfo(() => emitModelCost({call: 'writer', model: 'other', usage,
    env: {}}))).lines, []);
});

function refusedFailure(category) {
  return markTruncatedFailure({ok: false, type: 'CONTRACT_FAILURE', message: 'no text'},
    {stop_reason: 'refusal', stop_details: {category}, content: []});
}

test('Step 9AC: a refusal is never retried and is logged with a whitelisted category', async () => {
  for (const [category, logged] of [['cyber', 'cyber'], ['general_harms', 'general_harms'],
    ['something new', 'other'], [undefined, 'other']]) {
    const events = [];
    let calls = 0;
    const result = await withEnv({}, () => retryOnContractFailure(async () => {
      calls++;
      return refusedFailure(category);
    }, {call: 'writer', onDiagnostics: event => events.push(event)}));
    assert.equal(calls, 1);
    assert.equal(result.type, 'CONTRACT_FAILURE');
    assert.deepEqual(events, [{stage: 'claudeRefusal', call: 'writer', stopReason: 'refusal',
      refusalCategory: logged, retried: false}]);
  }
  let offCalls = 0;
  await withEnv({MODEL_CHOICE_ENABLED: 'off'}, () => retryOnContractFailure(async () => {
    offCalls++;
    return refusedFailure('cyber');
  }, {call: 'writer'}));
  assert.equal(offCalls, 2, 'switch off: retried once, as at bd7ef08');
});

function writerReply(output, content) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() { return {content, usage: {input_tokens: 10, output_tokens: 5}}; }
  };
}

test('Step 9AC: a reply with a leading empty thinking block parses as today (writer)', async () => {
  const {input, output} = marketStateCase(...MARKET_STATE_CASES[1]);
  const text = {type: 'text', text: JSON.stringify(providerTransport(output))};
  const run = content => invokeClaudeAnalysis({input, apiKey: 'test-key',
    fetchImpl: async () => writerReply(output, content)});
  const plain = await run([text]);
  const withThinking = await run([{type: 'thinking', thinking: '', signature: 'sig'}, text]);
  assert.equal(plain.ok, true);
  assert.deepEqual(withThinking, plain);
});

test('Step 9AC: a reply with a leading empty thinking block parses as today (classifier)', async () => {
  const output = {classifications: [
    {reference: 'e1', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], subjects: []},
    {reference: 'e2', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: []}
  ]};
  const text = {type: 'text', text: JSON.stringify(output)};
  const run = content => invokeClaudeEvidenceRoleClassification({input: classifierInput(), apiKey: 'test-key',
    fetchImpl: async () => writerReply(output, content)});
  const plain = await run([text]);
  const withThinking = await run([{type: 'thinking', thinking: '', signature: 'sig'}, text]);
  assert.equal(plain.ok, true);
  assert.deepEqual(withThinking, plain);
});

test('Step 9AC: a writer refusal makes one call, not two', async () => {
  const {input} = marketStateCase(...MARKET_STATE_CASES[1]);
  let calls = 0;
  const events = [];
  const result = await withEnv({}, () => invokeClaudeAnalysis({input, apiKey: 'test-key',
    onDiagnostics: event => events.push(event),
    fetchImpl: async () => {
      calls++;
      return {ok: true, status: 200, headers: {get: () => null},
        async json() { return {content: [], stop_reason: 'refusal', stop_details: {category: 'bio'}}; }};
    }}));
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(events.filter(event => event.stage === 'claudeRefusal').length, 1);
  assert.equal(events.find(event => event.stage === 'claudeRefusal').refusalCategory, 'bio');
});

test('Step 9AC: the ?claude=1 guard forwards only allowed model names', () => {
  const body = {model: 'claude-opus-5-5', stream: true, messages: [{role: 'user', content: 'x'}]};
  const replaced = guardLegacyModel(body, {env: {}});
  assert.equal(replaced.replaced, true);
  assert.deepEqual(replaced.body, {...body, model: HAIKU_45});
  assert.equal(body.model, 'claude-opus-5-5', 'the caller body is not mutated');
  for (const model of [HAIKU_45, HAIKU_55]) {
    const kept = guardLegacyModel({...body, model}, {env: {}});
    assert.equal(kept.replaced, false);
    assert.equal(kept.body.model, model);
  }
  for (const model of ['haiku-4.5', 'CLAUDE-HAIKU-5-5', '', undefined, 42]) {
    assert.equal(guardLegacyModel({...body, model}, {env: {}}).body.model, HAIKU_45);
  }
  const off = guardLegacyModel(body, {env: {LEGACY_MODEL_GUARD_ENABLED: 'off'}});
  assert.equal(off.replaced, false);
  assert.equal(off.body, body);
});

function streamingFetch(calls) {
  return async (url, options) => {
    calls.push({url, options});
    return {
      status: 200, headers: {get() { return 'text/event-stream'; }},
      body: {getReader() { return {async read() { return {done: true}; }}; }}
    };
  };
}

function mockRes() {
  return {
    statusCode: null, headers: {}, chunks: [], ended: false, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    write(value) { this.chunks.push(value); },
    end() { this.ended = true; },
    json(value) { this.body = value; return this; }
  };
}

test('Step 9AC: the ?claude=1 route replaces a model that is not allowed and logs no raw value', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'legacy-key';
  try {
    for (const [env, sent, expected, logCount] of [
      [{}, 'made-up-model-name', HAIKU_45, 1],
      [{}, HAIKU_55, HAIKU_55, 0],
      [{LEGACY_MODEL_GUARD_ENABLED: 'off'}, 'made-up-model-name', 'made-up-model-name', 0]
    ]) {
      const calls = [];
      global.fetch = streamingFetch(calls);
      const {lines} = await withEnv(env, () => captureInfo(() => handler({
        method: 'POST', query: {claude: '1'}, body: {model: sent, messages: []}
      }, mockRes())));
      assert.equal(JSON.parse(calls[0].options.body).model, expected);
      assert.equal(lines.length, logCount);
      for (const line of lines) {
        assert.equal(line, '[claude.legacy] {"stage":"legacyModelReplaced","reason":"NOT_ALLOWED"}');
      }
    }
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('Step 9AC: ?claudeAnalysis=1 uses the model query value only with userModelChoiceEnabled on', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const {input, output} = marketStateCase(...MARKET_STATE_CASES[1]);
  try {
    for (const [env, query, expected] of [
      [{}, 'haiku-5.5', HAIKU_45],
      [{USER_MODEL_CHOICE_ENABLED: 'on'}, 'haiku-5.5', HAIKU_55],
      [{USER_MODEL_CHOICE_ENABLED: 'on'}, undefined, HAIKU_45],
      [{USER_MODEL_CHOICE_ENABLED: 'on', CLAUDE_MODEL: 'haiku-5.5'}, 'haiku-4.5', HAIKU_45],
      [{USER_MODEL_CHOICE_ENABLED: 'on', MODEL_CHOICE_ENABLED: 'off'}, 'haiku-5.5', HAIKU_45]
    ]) {
      const models = [];
      global.fetch = async (url, options) => {
        models.push(JSON.parse(options.body).model);
        return {ok: true, status: 200, headers: {get: () => null},
          async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }};
      };
      const res = mockRes();
      await withEnv(env, () => captureInfo(() => handler({
        method: 'POST', query: {claudeAnalysis: '1', ...(query ? {model: query} : {})}, body: input
      }, res)));
      assert.equal(res.statusCode, 200);
      assert.ok(models.length >= 1);
      assert.deepEqual([...new Set(models)], [expected], JSON.stringify(env));
    }
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

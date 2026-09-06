const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  createClaudeAnalysisInput
} = require('../lib/claude-analysis-contract');
const {
  CLAUDE_ANALYSIS_MODEL,
  CLAUDE_ANALYSIS_MAX_TOKENS,
  CLAUDE_MESSAGES_URL,
  CLAUDE_ANALYSIS_RESULT_TYPES,
  CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA,
  buildClaudeAnalysisRequest,
  invokeClaudeAnalysis
} = require('../lib/claude-analysis-invocation');

function canonicalInput() {
  const item = createEvidenceItem({
    sourceId: 'sg.reuters',
    market: 'SG',
    evidenceCategory: 'news',
    title: 'Market update',
    canonicalUrl: 'https://www.reuters.com/markets/example',
    publishedAt: '2026-09-06T08:00:00Z'
  });
  return createClaudeAnalysisInput({
    evidenceCollection: createEvidenceCollection({market: 'SG', items: [item]})
  });
}

function anthropicResponse(output, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {content: [{type: 'text', text: JSON.stringify(output)}]};
    },
    ...overrides
  };
}

function normalOutput(overrides = {}) {
  return {
    status: 'NORMAL',
    findings: [{text: 'The market advanced.', evidenceRefs: ['e1']}],
    gaps: [],
    ...overrides
  };
}

test('builds a deterministic server-owned request without tools or web search', () => {
  const input = canonicalInput();
  const request = buildClaudeAnalysisRequest(input);

  assert.equal(CLAUDE_ANALYSIS_MODEL, 'claude-haiku-4-5-20251001');
  assert.equal(CLAUDE_ANALYSIS_MAX_TOKENS, 4000);
  assert.equal(request.model, CLAUDE_ANALYSIS_MODEL);
  assert.equal(request.max_tokens, CLAUDE_ANALYSIS_MAX_TOKENS);
  assert.deepEqual(request.messages, [{role: 'user', content: JSON.stringify(input)}]);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema, CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(JSON.stringify(request).includes('web_search'), false);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.messages), true);
  assert.equal(Object.isFrozen(request.output_config.format.schema), true);
});

test('derives the provider schema from 8C.1 while runtime-only constraints remain authoritative', () => {
  assert.deepEqual(
    CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.status,
    CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.status
  );
  assert.deepEqual(
    CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.required,
    CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.required
  );
  assert.equal(Object.hasOwn(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA, 'allOf'), false);
  assert.equal(
    Object.hasOwn(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.gaps.items, 'minLength'),
    false
  );
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.gaps.items.minLength, 1);
});

test('accepts valid NORMAL, DEGRADED and FAILED structured results', async () => {
  const outputs = [
    normalOutput(),
    {
      status: 'DEGRADED',
      findings: [{text: 'One fact is supported.', evidenceRefs: ['e1']}],
      gaps: ['Primary evidence is unavailable.']
    },
    {status: 'FAILED', findings: [], gaps: ['Evidence is insufficient.']}
  ];

  for (const output of outputs) {
    let calls = 0;
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(),
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, CLAUDE_MESSAGES_URL);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['x-api-key'], 'test-key');
        return anthropicResponse(output);
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.type, 'SUCCESS');
    assert.deepEqual(result.output, output);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.output), true);
  }
  assert.deepEqual(CLAUDE_ANALYSIS_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'UPSTREAM_FAILURE', 'CONTRACT_FAILURE'
  ]);
});

test('rejects non-canonical input before making a request', async () => {
  let calls = 0;
  const input = JSON.parse(JSON.stringify(canonicalInput()));
  input.evidence[0].reference = 'e2';
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    fetchImpl: async () => { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.type, 'INPUT_FAILURE');
});

test('classifies malformed and contract-invalid output separately from FAILED', async () => {
  const malformed = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(null, {
      async json() { return {content: [{type: 'text', text: '{bad json'}]}; }
    })
  });
  const unknownReference = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse(normalOutput({
      findings: [{text: 'Unsupported.', evidenceRefs: ['e2']}]
    }))
  });
  const failed = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => anthropicResponse({
      status: 'FAILED', findings: [], gaps: ['Evidence is insufficient.']
    })
  });

  assert.equal(malformed.type, 'CONTRACT_FAILURE');
  assert.equal(unknownReference.type, 'CONTRACT_FAILURE');
  assert.equal(failed.type, 'SUCCESS');
  assert.equal(failed.output.status, 'FAILED');
});

test('rejects model-supplied provenance, URLs and extra fields at runtime', async () => {
  const outputs = [
    {...normalOutput(), canonicalUrl: 'https://example.com/'},
    {
      ...normalOutput(),
      findings: [{
        text: 'Finding.', evidenceRefs: ['e1'], provenance: {publisher: 'Claude'}
      }]
    }
  ];
  for (const output of outputs) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(),
      apiKey: 'test-key',
      fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('keeps network and upstream failures distinct and never retries', async () => {
  let networkCalls = 0;
  const network = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => {
      networkCalls++;
      throw new Error('offline');
    }
  });
  let upstreamCalls = 0;
  const upstream = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => {
      upstreamCalls++;
      return {ok: false, status: 429};
    }
  });

  assert.equal(networkCalls, 1);
  assert.equal(upstreamCalls, 1);
  assert.equal(network.type, 'UPSTREAM_FAILURE');
  assert.equal(network.upstreamStatus, null);
  assert.equal(upstream.type, 'UPSTREAM_FAILURE');
  assert.equal(upstream.upstreamStatus, 429);
});

test('classifies a rejected upstream body read as UPSTREAM_FAILURE', async () => {
  let calls = 0;
  const result = await invokeClaudeAnalysis({
    input: canonicalInput(),
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        async json() { throw new Error('response stream interrupted'); }
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.type, 'UPSTREAM_FAILURE');
  assert.equal(result.upstreamStatus, 200);
});

test('treats malformed Anthropic envelopes as contract failures', async () => {
  for (const envelope of [{}, {content: []}, {content: [{type: 'image', source: {}}]}]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(),
      apiKey: 'test-key',
      fetchImpl: async () => ({ok: true, status: 200, async json() { return envelope; }})
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

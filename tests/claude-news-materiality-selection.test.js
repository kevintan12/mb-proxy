const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {
  CLAUDE_NEWS_MATERIALITY_MODEL,
  CLAUDE_NEWS_MATERIALITY_MAX_TOKENS,
  CLAUDE_NEWS_MATERIALITY_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA,
  NEWS_MATERIALITY_DECISIONS,
  NEWS_MATERIALITY_LEVELS,
  buildClaudeNewsMaterialityRequest,
  createClaudeNewsMaterialityOutput,
  validateClaudeNewsMaterialityOutput,
  invokeClaudeNewsMaterialitySelection
} = require('../lib/claude-news-materiality-selection');

const bounds = Object.freeze({
  maxCandidates: 30,
  maxTitleBytes: 200,
  maxSummaryBytes: 1000,
  maxExtractBytes: 1000,
  maxCollectionBytes: 50000
});

function candidate(reference, overrides = {}, candidateBounds = bounds) {
  return createNewsEvidenceCandidate({
    reference,
    horizon: {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-07T20:00:00Z',
      endsAtInclusive: '2026-09-08T20:00:00Z'
    },
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: `Candidate ${reference}`,
    summary: 'Bounded factual candidate summary.',
    extract: null,
    canonicalUrl: `https://www.cnbc.com/${reference}.html`,
    publishedAt: '2026-09-08T13:00:00Z',
    symbols: [],
    ...overrides
  }, {bounds: candidateBounds});
}

function collection(candidateBounds = bounds, candidates = [candidate('c1'), candidate('c2')]) {
  return createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds: candidateBounds});
}

function validOutput() {
  return {
    selections: [{
      reference: 'c1', decision: 'USE', category: 'news', materiality: 'HIGH',
      reason: 'Material to the broad-market session.'
    }, {
      reference: 'c2', decision: 'SKIP', category: 'news', materiality: 'LOW',
      reason: 'Limited incremental market relevance.'
    }]
  };
}

function response(output, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: name => name === 'request-id' ? 'req_materiality_123' : null},
    async json() {
      return {
        content: [{type: 'text', text: JSON.stringify(output)}],
        usage: {input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 7, service_tier: 'standard'}
      };
    },
    ...overrides
  };
}

test('builds a deterministic candidate-only structured request without tools or report prose', () => {
  const candidates = collection();
  const request = buildClaudeNewsMaterialityRequest(candidates, bounds);
  assert.equal(request.model, CLAUDE_NEWS_MATERIALITY_MODEL);
  assert.equal(request.max_tokens, CLAUDE_NEWS_MATERIALITY_MAX_TOKENS);
  assert.deepEqual(JSON.parse(request.messages[0].content), candidates);
  assert.deepEqual(Object.keys(JSON.parse(request.messages[0].content)), ['market', 'candidates']);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(JSON.stringify(request).includes('web_search'), false);
  assert.equal(request.output_config.format.schema, CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA);
  assert.match(request.system, /metadata only/i);
  assert.match(request.system, /do not write report prose/i);
  assert.equal(Object.isFrozen(request), true);
});

test('canonicalizes valid USE and SKIP full-coverage output immutably', () => {
  const candidates = collection();
  const source = validOutput();
  const output = createClaudeNewsMaterialityOutput(source, candidates, {candidateBounds: bounds});
  assert.deepEqual(output, source);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.selections), true);
  assert.equal(Object.isFrozen(output.selections[0]), true);
  source.selections[0].reason = 'Changed after creation';
  assert.equal(output.selections[0].reason, 'Material to the broad-market session.');
  assert.deepEqual(NEWS_MATERIALITY_DECISIONS, ['USE', 'SKIP']);
  assert.deepEqual(NEWS_MATERIALITY_LEVELS, ['HIGH', 'MEDIUM', 'LOW']);
  assert.equal(validateClaudeNewsMaterialityOutput(output, candidates, {candidateBounds: bounds}).valid, true);
});

test('rejects unknown, duplicate, missing, extra, and out-of-order candidate coverage', () => {
  const candidates = collection();
  const cases = [
    {selections: [{...validOutput().selections[0], reference: 'c9'}, validOutput().selections[1]]},
    {selections: [validOutput().selections[0], {...validOutput().selections[1], reference: 'c1'}]},
    {selections: [validOutput().selections[0]]},
    {selections: [...validOutput().selections, {...validOutput().selections[1], reference: 'c3'}]},
    {selections: [validOutput().selections[1], validOutput().selections[0]]}
  ];
  for (const invalid of cases) {
    assert.throws(() => createClaudeNewsMaterialityOutput(invalid, candidates, {candidateBounds: bounds}));
  }
});

test('rejects malformed decision, category, materiality, reason, and content-bearing output fields', () => {
  const candidates = collection();
  const first = validOutput().selections[0];
  const replacements = [
    {...first, decision: 'KEEP'},
    {...first, category: 'catalyst'},
    {...first, category: 'market-data'},
    {...first, materiality: 'CRITICAL'},
    {...first, reason: '  untrimmed  '},
    {...first, canonicalUrl: 'https://www.cnbc.com/private.html'},
    {...first, provenance: {publisher: 'CNBC'}},
    {...first, title: 'Leaked evidence content'}
  ];
  for (const replacement of replacements) {
    assert.throws(() => createClaudeNewsMaterialityOutput({
      selections: [replacement, validOutput().selections[1]]
    }, candidates, {candidateBounds: bounds}));
  }
});

test('invokes Anthropic exactly once and returns only canonical selection metadata', async () => {
  const calls = [];
  const result = await invokeClaudeNewsMaterialitySelection({
    candidateCollection: collection(), candidateBounds: bounds, apiKey: 'secret',
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(validOutput());
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, validOutput());
  assert.deepEqual(Object.keys(result.output.selections[0]), [
    'reference', 'decision', 'category', 'materiality', 'reason'
  ]);
  assert.equal(JSON.stringify(result.output).includes('https://'), false);
  assert.equal(JSON.stringify(result.output).includes('provenance'), false);
  assert.equal(JSON.stringify(result.output).includes('Candidate c1'), false);
});

test('captures sanitized independent request, usage, request-id, timing, and fetch-count diagnostics', async () => {
  const diagnostics = [];
  let tick = 0;
  let sentBody;
  const result = await invokeClaudeNewsMaterialitySelection({
    candidateCollection: collection(), candidateBounds: bounds, apiKey: 'secret',
    monotonicNow: () => tick++,
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      sentBody = options.body;
      return response(validOutput());
    }
  });
  assert.equal(result.ok, true);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].model, CLAUDE_NEWS_MATERIALITY_MODEL);
  assert.equal(diagnostics[0].requestId, 'req_materiality_123');
  assert.equal(diagnostics[0].fetchCount, 1);
  assert.deepEqual(diagnostics[0].usage, {
    input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 7
  });
  assert.equal(diagnostics[0].requestSize.completeRequestBodyBytes, Buffer.byteLength(sentBody, 'utf8'));
  assert.equal(diagnostics[0].requestSize.candidateCollectionBytes,
    Buffer.byteLength(JSON.stringify(collection()), 'utf8'));
  for (const value of Object.values(diagnostics[0].requestSize)) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0);
  }
  for (const value of Object.values(diagnostics[0].timing)) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0);
  }
  const serialized = JSON.stringify(diagnostics[0]);
  for (const forbidden of ['secret', 'Candidate c1', 'Bounded factual', 'cnbc.com', 'provenance']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(Object.isFrozen(diagnostics[0]), true);
});

test('captures diagnostics and optional usage safely on subsequent contract failure', async () => {
  const diagnostics = [];
  const invalid = validOutput();
  invalid.selections[0].reference = 'unknown';
  const result = await invokeClaudeNewsMaterialitySelection({
    candidateCollection: collection(), candidateBounds: bounds, apiKey: 'secret',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => response(invalid, {
      headers: {get: () => 'invalid request id with spaces'},
      async json() {
        return {content: [{type: 'text', text: JSON.stringify(invalid)}], usage: {input_tokens: 12}};
      }
    })
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].requestId, null);
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 12});
  assert.equal(diagnostics[0].fetchCount, 1);
});

test('blocks an oversized materiality request before fetch with sanitized diagnostics', async () => {
  const largeBounds = {
    maxCandidates: 1,
    maxTitleBytes: 200,
    maxSummaryBytes: 80000,
    maxExtractBytes: 1000,
    maxCollectionBytes: 100000
  };
  const largeCandidate = candidate('c1', {summary: 'x'.repeat(70000)}, largeBounds);
  const largeCollection = collection(largeBounds, [largeCandidate]);
  let calls = 0;
  const diagnostics = [];
  const result = await invokeClaudeNewsMaterialitySelection({
    candidateCollection: largeCollection, candidateBounds: largeBounds, apiKey: 'secret',
    fetchImpl: async () => { calls++; },
    onDiagnostics: value => diagnostics.push(value)
  });
  assert.equal(result.type, 'REQUEST_TOO_LARGE');
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(diagnostics[0]), [
    'model', 'completeRequestBodyBytes', 'limitBytes', 'providerInvocationSkipped', 'fetchCount'
  ]);
  assert.ok(diagnostics[0].completeRequestBodyBytes > CLAUDE_NEWS_MATERIALITY_PROVISIONAL_MAX_REQUEST_BYTES);
  assert.equal(diagnostics[0].limitBytes, 64 * 1024);
  assert.equal(diagnostics[0].providerInvocationSkipped, true);
  assert.equal(diagnostics[0].fetchCount, 0);
  assert.equal(JSON.stringify(diagnostics[0]).includes('xxxxx'), false);
});

test('uses no retry after network or upstream failure', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('network detail'); },
    async () => ({ok: false, status: 429, headers: {get: () => null}})
  ]) {
    let calls = 0;
    const result = await invokeClaudeNewsMaterialitySelection({
      candidateCollection: collection(), candidateBounds: bounds, apiKey: 'secret',
      fetchImpl: async (...args) => {
        calls++;
        return fetchImpl(...args);
      }
    });
    assert.equal(result.type, 'UPSTREAM_FAILURE');
    assert.equal(calls, 1);
  }
});

test('rejects non-canonical input before invocation', async () => {
  let calls = 0;
  const input = JSON.parse(JSON.stringify(collection()));
  input.candidates[0].provenance.publisher = 'Spoofed';
  const result = await invokeClaudeNewsMaterialitySelection({
    candidateCollection: input, candidateBounds: bounds, apiKey: 'secret',
    fetchImpl: async () => { calls++; }
  });
  assert.equal(result.type, 'INPUT_FAILURE');
  assert.equal(calls, 0);
});

test('provider schema exposes metadata fields only and is deeply immutable', () => {
  const serialized = JSON.stringify(CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA);
  assert.deepEqual(CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA.required, ['selections']);
  assert.equal(serialized.includes('canonicalUrl'), false);
  assert.equal(serialized.includes('provenance'), false);
  assert.equal(serialized.includes('title'), false);
  assert.equal(serialized.includes('summary'), false);
  assert.equal(Object.isFrozen(CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA), true);
  assert.equal(Object.isFrozen(CLAUDE_NEWS_MATERIALITY_OUTPUT_JSON_SCHEMA.properties.selections.items), true);
});

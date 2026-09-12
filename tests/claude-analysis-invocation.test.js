const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createThreeSessionSnapshot} = require('../lib/three-session-snapshot');
const {
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT,
  createClaudeAnalysisInput
} = require('../lib/claude-analysis-contract');
const {
  CLAUDE_ANALYSIS_MODEL,
  CLAUDE_ANALYSIS_MAX_TOKENS,
  CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
  CLAUDE_MESSAGES_URL,
  CLAUDE_ANALYSIS_RESULT_TYPES,
  CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA,
  buildClaudeAnalysisRequest,
  invokeClaudeAnalysis
} = require('../lib/claude-analysis-invocation');

function canonicalInput({
  includeSecondEvidence = false,
  evidenceTitle = 'Market update',
  evidenceSummary
} = {}) {
  const item = createEvidenceItem({
    sourceId: 'sg.reuters', market: 'SG', evidenceCategory: 'news', title: evidenceTitle,
    canonicalUrl: 'https://www.reuters.com/markets/example', publishedAt: '2026-09-06T08:00:00Z',
    ...(evidenceSummary === undefined ? {} : {summary: evidenceSummary})
  });
  const evidenceItems = [item];
  if (includeSecondEvidence) evidenceItems.push(createEvidenceItem({
    sourceId: 'sg.cna', market: 'SG', evidenceCategory: 'news', title: 'Second market update',
    canonicalUrl: 'https://www.channelnewsasia.com/business/example', publishedAt: '2026-09-06T09:00:00Z'
  }));
  const session = createCompletedRegularSession({
    market: 'SG', sessionDate: '2026-09-04', open: 5700, high: 5800, low: 5650,
    close: 5747, previousClose: 5710, volume: null, asOf: '2026-09-04T17:00:00+08:00',
    sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  });
  const snapshot = createThreeSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'Straits Times Index', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', initiatingList: 'myStocks', generatedAt: '2026-09-06T18:00:00+08:00',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'SG',
      marketContext: {
        exchangeTimezone: 'Asia/Singapore', marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Weekend; latest completed session remains applicable.'
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
      evidenceCollection: createEvidenceCollection({market: 'SG', items: evidenceItems}),
      evidenceContext: {
        materialEvents: ['e1'], authoritativeFacts: [], principalCatalysts: ['e1'],
        supportingEvidence: ['e1'], conflictingEvidence: [], subsequentDevelopments: [],
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext: {myStocks: [], watchlist: []}
  });
}

function reportContext(input) {
  return {
    header: REPORT_HEADER, selectedScope: 'SG', generatedAt: input.analysisRequest.generatedAt,
    userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF', markets: ['SG']
  };
}

function sections(content = 'Supported analysis.') {
  return REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 10 ? null : index === 4 ? EMPTY_INITIATING_LIST_CONTENT.myStocks : content,
    evidenceRefs: index === 10 || index === 4 || content === null ? [] : ['e1'],
    telemetryRefs: index === 10 || index === 4 || content === null ? [] : ['t1'],
    uncertainties: []
  }));
}

function normalOutput(input, overrides = {}) {
  return {
    status: 'NORMAL', reportContext: reportContext(input), sections: sections(),
    evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: [], ...overrides
  };
}

function anthropicResponse(output, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return {content: [{type: 'text', text: JSON.stringify(output)}]}; },
    ...overrides
  };
}

test('builds one deterministic server-owned request with the full package and no tools', () => {
  const input = canonicalInput();
  const request = buildClaudeAnalysisRequest(input);
  assert.equal(CLAUDE_ANALYSIS_MODEL, 'claude-haiku-4-5-20251001');
  assert.equal(CLAUDE_ANALYSIS_MAX_TOKENS, 4000);
  assert.equal(request.model, CLAUDE_ANALYSIS_MODEL);
  assert.equal(request.max_tokens, CLAUDE_ANALYSIS_MAX_TOKENS);
  assert.deepEqual(request.messages, [{role: 'user', content: JSON.stringify(input)}]);
  assert.equal(JSON.parse(request.messages[0].content).analysisRequest.initiatingList, 'myStocks');
  assert.equal(JSON.parse(request.messages[0].content).marketPackages[0].telemetry.benchmarkSnapshots[0].reference, 't1');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema, CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(JSON.stringify(request).includes('web_search'), false);
  assert.equal(Object.isFrozen(request), true);
});

function canonicalInputAtRequestSize(targetBytes) {
  const minimum = canonicalInput({evidenceSummary: 'x'});
  const minimumBytes = Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(minimum)), 'utf8');
  assert.equal(minimumBytes <= targetBytes, true);
  const input = canonicalInput({evidenceSummary: 'x'.repeat(targetBytes - minimumBytes + 1)});
  assert.equal(Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input)), 'utf8'), targetBytes);
  return input;
}

test('accepts the provisional request-size boundary and rejects one byte above without fetch', async () => {
  const boundaryInput = canonicalInputAtRequestSize(
    CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES
  );
  let boundaryFetches = 0;
  const boundary = await invokeClaudeAnalysis({
    input: boundaryInput,
    apiKey: 'test-key',
    fetchImpl: async () => {
      boundaryFetches++;
      return anthropicResponse(normalOutput(boundaryInput));
    }
  });
  assert.equal(boundary.type, 'SUCCESS', boundary.message);
  assert.equal(boundaryFetches, 1);

  const oversizedInput = canonicalInputAtRequestSize(
    CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1
  );
  const diagnostics = [];
  let oversizedFetches = 0;
  const oversized = await invokeClaudeAnalysis({
    input: oversizedInput,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => { oversizedFetches++; }
  });
  assert.equal(oversized.type, 'REQUEST_TOO_LARGE');
  assert.equal(oversized.message, 'Claude request exceeds provisional size limit');
  assert.equal(oversized.upstreamStatus, null);
  assert.equal(oversizedFetches, 0);
  assert.deepEqual(diagnostics, [{
    model: CLAUDE_ANALYSIS_MODEL,
    completeRequestBodyBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES + 1,
    limitBytes: CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES,
    providerInvocationSkipped: true
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('xxxxx'), false);
  assert.deepEqual(CLAUDE_ANALYSIS_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'CONTRACT_FAILURE'
  ]);
});

test('reports deterministic sanitized request sizes and provider usage on success', async () => {
  const input = canonicalInput({evidenceTitle: '亚洲 market update'});
  const request = buildClaudeAnalysisRequest(input);
  const serializedRequest = JSON.stringify(request);
  const canonicalPackage = JSON.parse(request.messages[0].content);
  const diagnostics = [];
  let sentBody;
  let monotonicTime = 0;
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    monotonicNow: () => monotonicTime++,
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async (url, options) => {
      sentBody = options.body;
      return anthropicResponse(normalOutput(input), {
        async json() {
          return {
            content: [{type: 'text', text: JSON.stringify(normalOutput(input))}],
            usage: {
              input_tokens: 123,
              output_tokens: 45,
              cache_creation_input_tokens: 6,
              cache_read_input_tokens: 7,
              future_numeric_counter: 8,
              service_tier: 'standard',
              nested: {tokens: 9}
            }
          };
        },
        headers: {get(name) { return name === 'request-id' ? 'req_test_123' : null; }}
      });
    }
  });

  assert.equal(result.type, 'SUCCESS');
  assert.equal(sentBody, serializedRequest);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    model: CLAUDE_ANALYSIS_MODEL,
    requestId: 'req_test_123',
    requestSize: {
      systemPromptBytes: Buffer.byteLength(request.system, 'utf8'),
      canonicalPackageBytes: Buffer.byteLength(request.messages[0].content, 'utf8'),
      telemetryBytes: Buffer.byteLength(JSON.stringify(
        canonicalPackage.marketPackages.map(item => item.telemetry)
      ), 'utf8'),
      evidenceContextBytes: Buffer.byteLength(JSON.stringify(
        canonicalPackage.marketPackages.map(item => item.evidenceContext)
      ), 'utf8'),
      portfolioContextBytes: Buffer.byteLength(JSON.stringify(canonicalPackage.portfolioContext), 'utf8'),
      providerSchemaBytes: Buffer.byteLength(JSON.stringify(request.output_config.format.schema), 'utf8'),
      completeRequestBodyBytes: Buffer.byteLength(serializedRequest, 'utf8')
    },
    timing: {
      anthropicFetchMs: 1,
      responseBodyReadParseMs: 1,
      marketBriefValidationMs: 1,
      invocationTotalMs: 7
    },
    usage: {
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 7,
      future_numeric_counter: 8
    }
  });
  const encodedCanonicalPackage = JSON.stringify(request.messages[0].content);
  assert.equal(sentBody.split(encodedCanonicalPackage).length - 1, 1);
  assert.equal(Object.isFrozen(diagnostics[0]), true);
  assert.equal(Object.isFrozen(diagnostics[0].requestSize), true);
  assert.equal(Object.isFrozen(diagnostics[0].timing), true);
  assert.equal(Object.isFrozen(diagnostics[0].usage), true);
  const serializedDiagnostics = JSON.stringify(diagnostics[0]);
  assert.equal(serializedDiagnostics.includes('亚洲 market update'), false);
  assert.equal(serializedDiagnostics.includes('^STI'), false);
  assert.equal(serializedDiagnostics.includes('Analyze only'), false);
  assert.equal(serializedDiagnostics.includes('test-key'), false);
});

test('reports request sizes and optional usage on later contract failure', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[0].evidenceRefs = ['e2'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => anthropicResponse(invalidOutput, {
      async json() {
        return {
          content: [{type: 'text', text: JSON.stringify(invalidOutput)}],
          usage: {input_tokens: 321, service_tier: 'standard'}
        };
      }
    })
  });

  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].requestId, null);
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 321});
  assert.equal(Number.isInteger(diagnostics[0].requestSize.completeRequestBodyBytes), true);
  for (const elapsed of Object.values(diagnostics[0].timing)) {
    assert.equal(typeof elapsed, 'number');
    assert.equal(elapsed >= 0, true);
  }
});

test('reports only sanitized Section 4 structure when populated content lacks evidence', async () => {
  const input = canonicalInput();
  const invalidOutput = normalOutput(input);
  invalidOutput.sections[3].content = 'PRIVATE SECTION PROSE';
  invalidOutput.sections[3].evidenceRefs = [];
  invalidOutput.sections[3].telemetryRefs = ['t1'];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input,
    apiKey: 'test-key',
    onDiagnostics(value) { diagnostics.push(value); },
    fetchImpl: async () => anthropicResponse(invalidOutput, {
      headers: {get: name => name === 'request-id' ? 'req_contract_4' : null},
      async json() {
        return {
          content: [{type: 'text', text: JSON.stringify(invalidOutput)}],
          usage: {input_tokens: 321, output_tokens: 45}
        };
      }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    type: 'CONTRACT_FAILURE',
    message: 'Invalid Claude analysis output: sections[3]: factual content requires supplied evidence',
    upstreamStatus: 200
  });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].contractFailure, {
    sectionIndex: 3,
    sectionName: 'STOCKS & SECTORS IN FOCUS',
    contentIsNull: false,
    evidenceRefCount: 0,
    telemetryRefCount: 1
  });
  assert.equal(diagnostics[0].requestId, 'req_contract_4');
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 321, output_tokens: 45});
  const serialized = JSON.stringify(diagnostics[0]);
  for (const forbidden of [
    'PRIVATE SECTION PROSE', '亚洲 market update', '^STI', 'https://',
    'Analyze only', 'test-key'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.isFrozen(diagnostics[0].contractFailure), true);
});

test('gives Claude explicit validator-sensitive Section 5 and Further Readings instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'determine the initiating list from analysisRequest.initiatingList',
    'if it is myStocks, use only portfolioContext.myStocks',
    'if it is watchlist, use only portfolioContext.watchlist',
    "initiating list's direct evidenceRefs",
    "initiating security's upcomingEvents[].evidenceRefs",
    'only telemetryRefs belonging to securities in that initiating list',
    'Never use securities, evidenceRefs, or telemetryRefs from the non-initiating list',
    'No securities are configured in My Stocks.',
    'No securities are configured in Watchlist.',
    'Section 5 evidenceRefs, telemetryRefs, and uncertainties must all be empty arrays',
    'Section 11 must be exactly {"name":"FURTHER READINGS","content":null,"evidenceRefs":[],"telemetryRefs":[],"uncertainties":[]}',
    'MarketBrief resolves and renders Further Readings separately',
    "evidenceRef values from each market package's evidenceContext.furtherReadings",
    'If none are supplied, top-level furtherReadings must be []',
    'scanning sections in report order',
    "each section's evidenceRefs in listed order",
    'adding each evidence reference only once at its first appearance'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude the exact top-level evidenceGaps status relationship', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'The top-level evidenceGaps array controls report status',
    'NORMAL is permitted only when top-level evidenceGaps is exactly []',
    'any non-empty top-level evidenceGaps array prohibits NORMAL',
    'Section uncertainties are separate',
    'input evidenceContext.unresolvedGaps does not automatically determine output status',
    'Material unresolved gaps requiring supported analysis must use DEGRADED',
    'Use FAILED when the reliable analytical foundation is insufficient and return no normal-analysis content'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude the global NORMAL null-section status rule', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'NORMAL requires non-null content for every analytical section, Sections 1-10',
    'If any analytical section in Sections 1-10 is null, NORMAL must not be used',
    'If a section is null because material evidence is unavailable, status must be DEGRADED',
    'that null section must include a genuine section uncertainty',
    'the corresponding material evidence gap must be included in the top-level evidenceGaps array',
    'Section 11 FURTHER READINGS remains the required null placeholder and does not force DEGRADED'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude evidence-bound Section 9 fallback instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 9 WHAT TO WATCH FOR NEXT',
    'any non-null content must contain at least one valid supplied evidenceRef',
    'every factual or watch-next statement must be grounded in supplied evidence',
    'Do not invent scheduled events, catalysts, dates, earnings, macro releases, or forward-looking developments',
    'If the supplied package does not support a meaningful Section 9, set content to null and status to DEGRADED',
    'include at least one genuine section uncertainty',
    'add the corresponding material evidence gap to the top-level evidenceGaps array'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude time-safe materially relevant subsequent-development instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Review evidenceContext.subsequentDevelopments',
    'only as later/current or forward-looking context',
    'Never cite subsequentDevelopments as causes of the earlier primary completed-session move',
    'When materially relevant',
    'using their supplied evidence references',
    'appropriate forward-looking Sections 7-10',
    'especially Section 9 WHAT TO WATCH FOR NEXT',
    'material risks, opportunities, next-session watch items, and takeaway implications',
    'Do not include subsequentDevelopments when they are immaterial to the report'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude the exact section uncertainty canonicality requirements', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Every section uncertainties entry must be a plain string',
    'non-empty after trimming',
    'already trimmed',
    'unique within that section',
    'Do not use blank strings, whitespace-only strings, placeholders, or duplicates',
    'use [] when a section has no uncertainty',
    'For a DEGRADED section with content: null, include at least one genuine uncertainty'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude plain-language and locked movement presentation instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Write for an informed layperson, not a professional market analyst',
    'Use clear everyday English and avoid unnecessary finance jargon',
    'If a financial term is genuinely useful, explain it briefly in plain language',
    'Preserve analytical depth: simplify wording, not reasoning',
    'Apple fell $8.24 (2.51%) to $319.97.',
    'Apple gained $3.25 (1.00%) to $328.21.',
    'S&P 500 fell by 29.11 points (0.38%) to 7,718.60.',
    'S&P 500 gained 81.11 points (1.06%) to 7,747.71.',
    'absolute movement first, percentage in brackets second, and resulting price or level last',
    'Do not omit absolute movement when the package supplies it',
    'incorporate it naturally into the section prose and explain what is unknown and why it matters',
    'Do not write implementation-style labels such as "Uncertainty:" inside the prose',
    'continue to provide the structured uncertainties arrays separately'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('provider schema is derived without weakening authoritative runtime validation', () => {
  assert.deepEqual(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.required, CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.required);
  assert.equal(Object.hasOwn(
    CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.evidenceGaps.items, 'minLength'
  ), false);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.evidenceGaps.items.minLength, 1);
  assert.equal(Object.hasOwn(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.sections, 'minItems'), false);
  assert.equal(Object.hasOwn(CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA.properties.sections, 'maxItems'), false);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.minItems, 11);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.maxItems, 11);
});

test('accepts valid NORMAL, DEGRADED and FAILED structured reports with one request each', async () => {
  const input = canonicalInput();
  const degradedSections = sections();
  degradedSections[7] = {
    name: REPORT_SECTION_NAMES[7], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: ['Evidence is incomplete.']
  };
  const outputs = [
    normalOutput(input),
    {
      status: 'DEGRADED', reportContext: reportContext(input), sections: degradedSections,
      evidenceReferences: ['e1'], furtherReadings: [], evidenceGaps: ['A material cause is unresolved.']
    },
    {
      status: 'FAILED', reportContext: reportContext(input), sections: sections(null),
      evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Core evidence is insufficient.']
    }
  ];
  for (const output of outputs) {
    let calls = 0;
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, CLAUDE_MESSAGES_URL);
        assert.equal(options.method, 'POST');
        return anthropicResponse(output);
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.type, 'SUCCESS');
    assert.equal(result.output.status, output.status);
  }
  assert.deepEqual(CLAUDE_ANALYSIS_RESULT_TYPES, [
    'SUCCESS', 'INPUT_FAILURE', 'REQUEST_TOO_LARGE', 'UPSTREAM_FAILURE', 'CONTRACT_FAILURE'
  ]);
});

test('derives top-level evidenceReferences from section first-use order', async () => {
  const input = canonicalInput({includeSecondEvidence: true});
  const output = normalOutput(input);
  output.sections[0].evidenceRefs = ['e2', 'e1'];
  output.sections[1].evidenceRefs = ['e2'];
  output.evidenceReferences = ['e1', 'e2'];

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.evidenceReferences, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[1].evidenceRefs, ['e2']);
});

test('still rejects missing, extra or invalid section-level evidenceRefs', async () => {
  const missing = normalOutput(canonicalInput());
  delete missing.sections[0].evidenceRefs;
  const extra = normalOutput(canonicalInput());
  extra.sections[0].evidenceRefs = ['e1', 'e2'];
  const invalid = normalOutput(canonicalInput());
  invalid.sections[0].evidenceRefs = 'e1';

  for (const output of [missing, extra, invalid]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(), apiKey: 'test-key',
      fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('rejects non-canonical input before invoking Anthropic', async () => {
  const input = JSON.parse(JSON.stringify(canonicalInput()));
  input.analysisRequest.reportType = 'SEARCH_ANALYSIS';
  let calls = 0;
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(result.type, 'INPUT_FAILURE');
});

test('classifies malformed or contract-invalid structured reports as CONTRACT_FAILURE', async () => {
  const input = canonicalInput();
  const malformed = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(null, {
      async json() { return {content: [{type: 'text', text: '{bad json'}]}; }
    })
  });
  assert.equal(malformed.type, 'CONTRACT_FAILURE');

  const missing = normalOutput(input);
  missing.sections.pop();
  const extra = normalOutput(input);
  extra.sections.push({...extra.sections[10]});
  const renamed = normalOutput(input);
  renamed.sections[0].name = 'RENAMED SECTION';
  const reordered = normalOutput(input);
  [reordered.sections[0], reordered.sections[1]] = [reordered.sections[1], reordered.sections[0]];

  for (const output of [missing, extra, renamed, reordered]) {
    const invalid = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(invalid.type, 'CONTRACT_FAILURE');
  }
});

test('rejects model-supplied URLs, provenance and unknown references', async () => {
  const input = canonicalInput();
  const outputs = [
    {...normalOutput(input), canonicalUrl: 'https://example.com/'},
    normalOutput(input, {sections: REPORT_SECTION_NAMES.map((name, index) => ({
      name, content: index === 10 ? null : 'Finding.',
      evidenceRefs: index === 10 ? [] : ['e2'], telemetryRefs: index === 10 ? [] : ['t1'],
      uncertainties: []
    }))})
  ];
  for (const output of outputs) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('keeps network, HTTP and response-body failures distinct and never retries', async () => {
  const input = canonicalInput();
  let networkCalls = 0;
  const network = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => {
      networkCalls++;
      throw new Error('offline');
    }
  });
  let upstreamCalls = 0;
  const upstream = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => {
      upstreamCalls++;
      return {ok: false, status: 429};
    }
  });
  const bodyRead = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => ({
      ok: true, status: 200, async json() { throw new Error('interrupted'); }
    })
  });
  assert.equal(networkCalls, 1);
  assert.equal(upstreamCalls, 1);
  assert.equal(network.type, 'UPSTREAM_FAILURE');
  assert.equal(upstream.type, 'UPSTREAM_FAILURE');
  assert.equal(upstream.upstreamStatus, 429);
  assert.equal(bodyRead.type, 'UPSTREAM_FAILURE');
});

test('treats successfully read malformed Anthropic envelopes as contract failures', async () => {
  for (const envelope of [{}, {content: []}, {content: [{type: 'image', source: {}}]}]) {
    const result = await invokeClaudeAnalysis({
      input: canonicalInput(), apiKey: 'test-key',
      fetchImpl: async () => ({ok: true, status: 200, async json() { return envelope; }})
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  EMPTY_INITIATING_LIST_CONTENT,
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput
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
const {projectClaudeAnalysisInput} = require('../lib/claude-model-input-projection');

function canonicalInput({
  includeSecondEvidence = false,
  evidenceTitle = 'Technology sector update',
  evidenceSummary,
  materialEvents = ['e1'],
  principalCatalysts = ['e1'],
  supportingEvidence = ['e1'],
  subsequentDevelopments = [],
  sessionAssociations = [],
  broadMarketFocus = [{evidenceRef: 'e1', subjects: [{kind: 'SECTOR', name: 'Technology'}]}]
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
  const snapshot = createFiveSessionSnapshot({
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
        materialEvents, authoritativeFacts: [], principalCatalysts,
        supportingEvidence, conflictingEvidence: [], subsequentDevelopments,
        sessionAssociations,
        broadMarketFocus,
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
    content: index === 7 ? null : index === 3 ? EMPTY_INITIATING_LIST_CONTENT.myStocks
      : content === null ? null : index === 2 ? 'Supported Technology analysis.' : content,
    evidenceRefs: index === 7 || index === 3 || content === null ? [] : ['e1'],
    telemetryRefs: index === 7 || index === 3 || content === null ? [] : ['t1'],
    uncertainties: []
  }));
}

function normalOutput(input, overrides = {}) {
  const reportSections = sections();
  const firstFocus = input.marketPackages.flatMap(item => item.evidenceContext.broadMarketFocus)[0];
  if (firstFocus) reportSections[2].content = `Supported ${firstFocus.subjects[0].name} analysis.`;
  return {
    status: 'NORMAL', reportContext: reportContext(input), sections: reportSections,
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

test('builds one deterministic server-owned request with a projected package and no tools', () => {
  const input = canonicalInput({
    subsequentDevelopments: ['e1'],
    sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}]
  });
  const original = JSON.stringify(input);
  const request = buildClaudeAnalysisRequest(input);
  const modelInput = JSON.parse(request.messages[0].content);
  assert.equal(CLAUDE_ANALYSIS_MODEL, 'claude-haiku-4-5-20251001');
  assert.equal(CLAUDE_ANALYSIS_MAX_TOKENS, 4000);
  assert.equal(request.model, CLAUDE_ANALYSIS_MODEL);
  assert.equal(request.max_tokens, CLAUDE_ANALYSIS_MAX_TOKENS);
  assert.deepEqual(request.messages, [{role: 'user', content: JSON.stringify(
    projectClaudeAnalysisInput(input)
  )}]);
  assert.equal(JSON.stringify(input), original);
  assert.equal(modelInput.analysisRequest.initiatingList, 'myStocks');
  assert.equal(modelInput.marketPackages[0].telemetry.benchmarkSnapshots[0].reference, 't1');
  assert.deepEqual(modelInput.marketPackages[0].telemetry, input.marketPackages[0].telemetry);
  assert.deepEqual(modelInput.marketPackages[0].evidenceContext.sessionAssociations, [
    {evidenceRef: 'e1', sessionDate: '2026-09-04'}
  ]);
  const projectedItem = modelInput.marketPackages[0].evidenceContext.evidence[0].item;
  assert.deepEqual(Object.keys(projectedItem.provenance), ['publisher', 'authority']);
  assert.equal(projectedItem.sourceId, 'sg.reuters');
  assert.equal(projectedItem.provenance.publisher, 'Reuters');
  assert.equal(projectedItem.provenance.authority, 'secondary');
  assert.equal('canonicalUrl' in projectedItem, false);
  for (const omitted of ['homepage', 'locator', 'applicableMarket', 'sourceJurisdiction']) {
    assert.equal(omitted in projectedItem.provenance, false);
  }
  assert.equal(Object.isFrozen(input.marketPackages[0].evidenceContext.sessionAssociations), true);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema, CLAUDE_ANALYSIS_PROVIDER_JSON_SCHEMA);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(JSON.stringify(request).includes('web_search'), false);
  assert.equal(Object.isFrozen(request), true);
  const projection = projectClaudeAnalysisInput(input);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(
    projection.marketPackages[0].evidenceContext.evidence[0].item.provenance
  ), true);
  assert.deepEqual(projection, projectClaudeAnalysisInput(input));
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
  const input = canonicalInput({evidenceTitle: '亚洲 Technology sector update'});
  const request = buildClaudeAnalysisRequest(input);
  const serializedRequest = JSON.stringify(request);
  const projectedPackage = JSON.parse(request.messages[0].content);
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
      canonicalPackageBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
      projectedModelInputBytes: Buffer.byteLength(request.messages[0].content, 'utf8'),
      telemetryBytes: Buffer.byteLength(JSON.stringify(
        input.marketPackages.map(item => item.telemetry)
      ), 'utf8'),
      evidenceContextBytes: Buffer.byteLength(JSON.stringify(
        input.marketPackages.map(item => item.evidenceContext)
      ), 'utf8'),
      portfolioContextBytes: Buffer.byteLength(JSON.stringify(input.portfolioContext), 'utf8'),
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
  assert.deepEqual(projectedPackage.marketPackages[0].telemetry, input.marketPackages[0].telemetry);
  assert.equal(diagnostics[0].requestSize.projectedModelInputBytes
    < diagnostics[0].requestSize.canonicalPackageBytes, true);
  const serializedDiagnostics = JSON.stringify(diagnostics[0]);
  assert.equal(serializedDiagnostics.includes('亚洲 Technology sector update'), false);
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
  invalidOutput.sections[2].content = 'PRIVATE SECTION PROSE';
  invalidOutput.sections[2].evidenceRefs = [];
  invalidOutput.sections[2].telemetryRefs = ['t1'];
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
    message: 'Invalid Claude analysis output: sections[2]: stocks and sectors require broad-market focus evidence; sections[2]: factual content requires supplied evidence',
    upstreamStatus: 200
  });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].contractFailure, {
    sectionIndex: 2,
    sectionName: 'STOCKS & SECTORS IN FOCUS',
    contentIsNull: false,
    evidenceRefCount: 0,
    telemetryRefCount: 1
  });
  assert.equal(diagnostics[0].requestId, 'req_contract_4');
  assert.deepEqual(diagnostics[0].usage, {input_tokens: 321, output_tokens: 45});
  const serialized = JSON.stringify(diagnostics[0]);
  for (const forbidden of [
    'PRIVATE SECTION PROSE', '亚洲 Technology sector update', '^STI', 'https://',
    'Analyze only', 'test-key'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.isFrozen(diagnostics[0].contractFailure), true);
});

test('gives Claude explicit validator-sensitive Section 4 and Further Readings instructions', () => {
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
    'Section 4 evidenceRefs, telemetryRefs, and uncertainties must all be empty arrays',
    'Section 8 must be exactly {"name":"FURTHER READINGS","content":null,"evidenceRefs":[],"telemetryRefs":[],"uncertainties":[]}',
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

test('adds the exact package benchmark refs to the request-specific Section 3 allowlist', () => {
  const input = canonicalInput();
  const request = buildClaudeAnalysisRequest(input);
  assert.match(request.system,
    /Request-specific Section 3 telemetry allowlist: Section 3 telemetryRefs may contain only these exact benchmark refs: \["t1"\]\./);
  assert.match(request.system, /Do not cite any other telemetry ref in Section 3\./);
  assert.match(request.system,
    /even when a company is both in evidenceContext\.broadMarketFocus and My Stocks or Watchlist/);
  assert.equal(request.system.includes('"t2"'), false);
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
    'NORMAL requires non-null content for every analytical section, Sections 1-7',
    'If any analytical section in Sections 1-7 is null, NORMAL must not be used',
    'If a section is null because material evidence is unavailable, status must be DEGRADED',
    'that null section must include a genuine section uncertainty',
    'the corresponding material evidence gap must be included in the top-level evidenceGaps array',
    'Section 8 FURTHER READINGS remains the required null placeholder and does not force DEGRADED'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude evidence-bound Section 7 fallback instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Hard output constraint for Sections 6-7',
    'content must be either null or a non-empty already-trimmed string',
    'evidenceRefs must contain at least one valid supplied evidence reference',
    'telemetryRefs alone never satisfy this grounding requirement',
    'Every factual claim or qualified interpretation in a populated section must be grounded in its listed supplied evidenceRefs',
    'For Section 7 WHAT TO WATCH FOR NEXT',
    'every factual or watch-next statement must be grounded in one or more valid supplied evidenceRefs listed in Section 7',
    'Cite each scheduled event or catalyst with its supplied supporting evidenceRef',
    'Omit unsupported factual predictions, events, dates, earnings, macro releases, catalysts, or forward-looking developments',
    'do not invent them or attach an unrelated reference',
    'If the supplied package does not support a meaningful Section 7, set content to null, evidenceRefs and telemetryRefs to [], and status to DEGRADED',
    'include at least one genuine section uncertainty',
    'add the corresponding material evidence gap to the top-level evidenceGaps array'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Claude supplied-evidence-only Section 2 macro comparison instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 2 KEY MARKET DRIVERS',
    'explicit current, consensus or expected, and previous comparable values',
    'present that three-way comparison and explain both',
    'surprise versus expectations and the change versus the previous reading',
    'Use only values explicitly supplied in the package',
    'do not invent any missing comparison value',
    'do not force immaterial macro items into a three-number format',
    'do not repeat the same comparison unnecessarily across Sections 1 and 2'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Sections 1-2 concise prioritization and supported causal instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 1 EXECUTIVE MARKET SUMMARY, write two or three concise paragraphs',
    'dominant market story, supported direction and magnitude, overall sentiment and themes',
    'distinction between completed results and developing conditions',
    'Avoid low-value repetition and padding',
    'present only a small prioritized set of the most material supported drivers',
    'distinguish established facts, developing conditions, and qualified interpretation',
    'never invent a driver merely to fill the section',
    'For Section 2 KEY MARKET DRIVERS',
    'Explain supported interactions among drivers where materially relevant',
    'If no principal catalyst supports causality, describe the material drivers without claiming they caused the move',
    'Temporal proximity alone is not causality',
    'never present a SUBSEQUENT_DEVELOPMENT as causing an earlier completed-session move'
  ]) assert.equal(system.includes(requirement), true, requirement);
});

test('gives Section 3 non-causal broad-market session-association instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 3 STOCKS & SECTORS IN FOCUS',
    'Review evidenceContext.sessionAssociations',
    'when materially relevant',
    'independently in broadMarketFocus',
    'associated supplied evidence reference as current-session recap or context',
    'marketContext.primaryCompletedSessionDate',
    'even when that evidence is also a SUBSEQUENT_DEVELOPMENT',
    'broad-market leadership and laggards, notable individual movers, closing-session breadth, sector rotation',
    'Never present post-close session-associated evidence as having caused the earlier completed-session move',
    'never treat session association as PRINCIPAL_CATALYST eligibility',
    'Section 3 must remain broad-market and independent of My Stocks and Watchlist',
    'membership in either list must not determine which broad-market movers Section 3 discusses',
    'Do not require Section 3 to use every associated reference',
    'or use an association that is immaterial',
    'all materially relevant broad-market materialEvents, supportingEvidence, recap and general CNBC evidence',
    'Rank the significant companies and sectors',
    'explaining why each matters and comparing it with the broader market where useful',
    'Do not produce a generic mover list',
    'If the evidence is insufficient, use qualified analysis or the existing null/DEGRADED behavior',
    'When Section 3 uses a session-associated broad-market evidence reference that is also in broadMarketFocus, cite that reference in Section 3 evidenceRefs',
    'Section 3 evidenceRefs may contain only broadMarketFocus references',
    'telemetryRefs may contain only benchmark telemetry references',
    'never portfolio or watchlist stock telemetry',
    'Discuss a My Stocks or Watchlist company in Section 3 only when it is independently present as a validated COMPANY subject in broadMarketFocus',
    "cite that company's focus reference",
    'Do not copy such a reference into Section 4 merely because it is session-associated, broad-market evidence',
    'relevant to market leadership, sectors, movers, breadth, or rotation',
    "Section 4 remains strictly limited to the initiating-list securities' permitted telemetryRefs, permitted direct evidenceRefs, and permitted upcoming-event evidenceRefs",
    'a reference may appear in Section 4 only when it independently satisfies those existing initiating-list eligibility rules'
  ]) {
    assert.equal(system.includes(requirement), true, requirement);
  }
});

test('gives Sections 5-6 interpretation and combined risk/opportunity instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'For Section 5 MARKET INTERPRETATION',
    'supported sentiment, risk appetite, breadth, momentum, and rotation',
    'continuation, reversal, consolidation, or a change in narrative',
    'participation is broad or concentrated',
    'For Section 6 KEY RISKS & OPPORTUNITIES',
    'specific constructive broad-market opportunities in supported sectors, themes, or companies',
    'clearly label or otherwise distinguish risk from opportunity',
    'distinguish positive constructive evidence from a speculative scenario',
    'Each opportunity claim must cite its own relevant broadMarketFocus evidenceRef and name an exact validated subject from that cited focus entry in the Section 6 prose',
    'If no such grounded opportunity can be stated, omit the opportunity; risks-only output remains valid and bullish content is not required',
    'a risk citation cannot support an unrelated opportunity',
    'Never use a rebound, buy-the-dip, oversold condition, or similar price-decline filler as an opportunity without specific constructive evidence',
    'Risks alone may populate Section 6 when no defensible opportunity is supported',
    'Supported opportunities alone may also populate it',
    'If neither is supported, set content to null'
  ]) assert.equal(system.includes(requirement), true, requirement);
});

test('keeps overlapping evidence concise without merging the frozen section roles', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  assert.match(system, /Keep the report sections distinct/);
  assert.match(system, /place each supported fact or conclusion where it adds the most value/);
  assert.match(system, /do not repeat the same sentence or substantially identical explanation/);
  assert.match(system, /Sections 1, 2, 5, 6, and 7/);
});

test('gives Claude time-safe materially relevant subsequent-development instructions', () => {
  const system = buildClaudeAnalysisRequest(canonicalInput()).system;
  for (const requirement of [
    'Review evidenceContext.subsequentDevelopments',
    'only as later/current or forward-looking context',
    'Never cite subsequentDevelopments as causes of the earlier primary completed-session move',
    'When materially relevant',
    'using their supplied evidence references',
    'appropriate forward-looking Sections 6-7',
    'especially Section 7 WHAT TO WATCH FOR NEXT',
    'material risks, opportunities, and next-session watch items',
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
    'clear, normal spoken English for an informed layperson, not a professional market analyst',
    'Prefer common words when they are equally accurate',
    'short, direct sentences where practical',
    'Avoid institutional or analyst-desk jargon',
    'If a technical or financial term is unavoidable, explain it briefly in plain language',
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
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.minItems, 8);
  assert.equal(CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.sections.maxItems, 8);
});

test('accepts valid NORMAL, DEGRADED and FAILED structured reports with one request each', async () => {
  const input = canonicalInput();
  const degradedSections = sections();
  degradedSections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
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

test('deterministically downgrades evidence-limited NORMAL output while preserving strict validation', async () => {
  const input = canonicalInput();
  const output = normalOutput(input);
  output.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []
  };
  const strictValidation = validateClaudeAnalysisOutput(output, input);
  assert.deepEqual(strictValidation.errors, ['NORMAL requires every analysis section']);

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  const message = 'The supplied evidence did not support a reliable KEY RISKS & OPPORTUNITIES section.';
  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.deepEqual(result.output.sections[5], {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: [], telemetryRefs: [],
    uncertainties: [message]
  });
  assert.deepEqual(result.output.evidenceGaps, [message]);
});

test('deterministically nulls impossible Sections 2-4 and recomputes first-use references', async () => {
  const input = canonicalInput({
    includeSecondEvidence: true,
    materialEvents: [],
    principalCatalysts: [],
    broadMarketFocus: []
  });
  const output = normalOutput(input);
  output.sections[0].evidenceRefs = ['e2'];
  output.sections[1].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.sections[1].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.sections[2].uncertainties = ['Model-supplied uncertainty must be replaced.'];
  output.evidenceReferences = ['e1'];

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  const expected = [
    'The supplied evidence did not establish a material market driver.',
    'Validated broad-market company or sector evidence was unavailable.'
  ];
  for (const [offset, message] of expected.entries()) {
    const section = result.output.sections[offset + 1];
    assert.equal(section.content, null);
    assert.deepEqual(section.evidenceRefs, []);
    assert.deepEqual(section.telemetryRefs, []);
    assert.deepEqual(section.uncertainties, [message]);
    assert.equal(result.output.evidenceGaps.includes(message), true);
  }
  assert.deepEqual(result.output.evidenceReferences, ['e2', 'e1']);
});

test('localizes empty broad-market focus to Section 3 without removing valid driver evidence', async () => {
  const input = canonicalInput({broadMarketFocus: []});
  const output = normalOutput(input);

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.equal(result.output.status, 'DEGRADED');
  assert.notEqual(result.output.sections[1].content, null);
  assert.notEqual(result.output.sections[1].content, null);
  assert.deepEqual(result.output.sections[2], {
    name: REPORT_SECTION_NAMES[2],
    content: null,
    evidenceRefs: [],
    telemetryRefs: [],
    uncertainties: ['Validated broad-market company or sector evidence was unavailable.']
  });
});

test('keeps unrelated driver and broad-market hard-gate violations strict', async () => {
  const input = canonicalInput();
  const invalidDriver = normalOutput(input);
  invalidDriver.sections[1].evidenceRefs = [];
  const invalidFocus = normalOutput(input);
  invalidFocus.sections[2].content = 'Generic index commentary.';

  for (const output of [invalidDriver, invalidFocus]) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('does not normalize structurally inconsistent null sections or unusable reports', async () => {
  const input = canonicalInput();
  const referencedNull = normalOutput(input);
  referencedNull.sections[5] = {
    name: REPORT_SECTION_NAMES[5], content: null, evidenceRefs: ['e1'], telemetryRefs: [],
    uncertainties: []
  };
  const allUnavailable = normalOutput(input);
  allUnavailable.sections = allUnavailable.sections.map((section, index) => index === 7
    ? section
    : {...section, content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: []});

  for (const output of [referencedNull, allUnavailable]) {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
    });
    assert.equal(result.type, 'CONTRACT_FAILURE');
  }
});

test('derives top-level evidenceReferences from section first-use order', async () => {
  const input = canonicalInput({includeSecondEvidence: true});
  const output = normalOutput(input);
  output.sections[0].evidenceRefs = ['e2', 'e1'];
  output.sections[1].evidenceRefs = ['e1'];
  output.evidenceReferences = ['e1', 'e2'];

  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output)
  });

  assert.equal(result.type, 'SUCCESS', result.message);
  assert.deepEqual(result.output.evidenceReferences, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[0].evidenceRefs, ['e2', 'e1']);
  assert.deepEqual(result.output.sections[1].evidenceRefs, ['e1']);
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
  extra.sections.push({...extra.sections[7]});
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
      name, content: index === 7 ? null : 'Finding.',
      evidenceRefs: index === 7 ? [] : ['e2'], telemetryRefs: index === 7 ? [] : ['t1'],
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

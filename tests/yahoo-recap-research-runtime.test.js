const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  createYahooRecapResearchRuntime
} = require('../lib/yahoo-recap-research-runtime');

const targetSessionDate = '2026-09-09';
const recapUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html';

function anthropicResponse(results, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: () => null},
    async json() {
      return {
        content: [{
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: results
        }],
        usage: {input_tokens: 10, output_tokens: 5, server_tool_use: {web_search_requests: 1}}
      };
    },
    ...overrides
  };
}

function searchResult() {
  return {
    type: 'web_search_result',
    title: 'Stock market today: September 9 recap',
    url: recapUrl,
    encrypted_content: 'not exposed'
  };
}

function yahooHtml(overrides = {}) {
  const article = {
    '@type': 'NewsArticle',
    headline: 'Stock market today: September 9 recap',
    datePublished: '2026-09-09T20:30:00Z',
    dateModified: '2026-09-09T21:00:00Z',
    mainEntityOfPage: {'@type': 'WebPage', '@id': recapUrl},
    ...overrides
  };
  return `<link rel="canonical" href="${recapUrl}">`
    + `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
}

function yahooResponse(html = yahooHtml(), overrides = {}) {
  return {
    ok: true,
    status: 200,
    url: recapUrl,
    headers: {get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null},
    async text() { return html; },
    ...overrides
  };
}

function runtime(fetchImpl, options = {}) {
  return createYahooRecapResearchRuntime({apiKey: 'server-key', fetchImpl, ...options});
}

test('owns one deeply immutable production bounds bundle', () => {
  assert.deepEqual(YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS, {
    sessionValidationBounds: {
      timeoutMs: 4000,
      maxResponseBytes: 1258291,
      maxHeadlineBytes: 512
    }
  });
  assert.equal(Object.isFrozen(YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS), true);
  assert.equal(Object.isFrozen(YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS.sessionValidationBounds), true);
});

test('rejects non-canonical input before discovery', async () => {
  let calls = 0;
  const service = runtime(async () => { calls++; });
  for (const input of [
    {},
    {targetSessionDate: '2026-02-30'},
    {targetSessionDate, prompt: 'caller controlled'},
    {targetSessionDate, bounds: {maxResponseBytes: Number.MAX_SAFE_INTEGER}}
  ]) {
    assert.deepEqual(await service.discoverAndValidateRecap(input), {
      ok: false,
      type: 'INPUT_FAILURE',
      failureType: 'INPUT_FAILURE',
      message: 'Invalid Yahoo recap research request'
    });
  }
  assert.equal(calls, 0);
});

test('discovery receives only targetSessionDate and successful metadata passes unchanged through validation', async () => {
  const calls = [];
  const service = runtime(async (url, options) => {
    calls.push({url, options});
    if (url === 'https://api.anthropic.com/v1/messages') return anthropicResponse([searchResult()]);
    assert.equal(url, recapUrl);
    return yahooResponse();
  });
  const result = await service.discoverAndValidateRecap({targetSessionDate});
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.messages.length, 1);
  assert.match(request.messages[0].content, /2026-09-09/);
  assert.equal(calls[0].options.headers['x-api-key'], 'server-key');
  assert.deepEqual(result, {
    ok: true,
    type: 'VALIDATED',
    discovery: {
      title: 'Stock market today: September 9 recap',
      url: recapUrl,
      discoveredVia: 'ANTHROPIC_WEB_SEARCH',
      targetSessionDate
    },
    validation: {
      headline: 'Stock market today: September 9 recap',
      url: recapUrl,
      datePublished: '2026-09-09T20:30:00.000Z',
      dateModified: '2026-09-09T21:00:00.000Z',
      targetSessionDate
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.discovery), true);
  assert.equal(Object.isFrozen(result.validation), true);
});

test('uses the exact production response bound at session validation', async () => {
  const measuredPage = yahooHtml().padEnd(1103329, ' ');
  const calls = [];
  const accepted = await runtime(async url => {
    calls.push(url);
    return url === 'https://api.anthropic.com/v1/messages'
      ? anthropicResponse([searchResult()]) : yahooResponse(measuredPage);
  }).discoverAndValidateRecap({targetSessionDate});
  assert.equal(accepted.type, 'VALIDATED');
  assert.equal(calls.length, 2);

  const oversized = yahooHtml().padEnd(1258292, ' ');
  const rejected = await runtime(async url => url === 'https://api.anthropic.com/v1/messages'
    ? anthropicResponse([searchResult()]) : yahooResponse(oversized))
    .discoverAndValidateRecap({targetSessionDate});
  assert.deepEqual(rejected, {
    ok: false,
    type: 'SESSION_VALIDATION_FAILURE',
    failureType: 'RESPONSE_TOO_LARGE',
    message: 'Yahoo recap session validation failed'
  });
});

test('normal discovery absence skips page validation', async () => {
  let calls = 0;
  const result = await runtime(async url => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    return anthropicResponse([]);
  }).discoverAndValidateRecap({targetSessionDate});
  assert.equal(calls, 1);
  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', discovery: null, validation: null});
});

test('discovery failures remain sanitized and stage-distinct with one invocation and no retry', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private discovery failure'); },
    async () => ({ok: false, status: 429, headers: {get: () => null}}),
    async () => anthropicResponse({type: 'web_search_tool_result_error', error_code: 'private'})
  ]) {
    let calls = 0;
    const result = await runtime(async (...args) => { calls++; return fetchImpl(...args); })
      .discoverAndValidateRecap({targetSessionDate});
    assert.equal(result.type, 'DISCOVERY_FAILURE');
    assert.ok(['UPSTREAM_FAILURE', 'SEARCH_TOOL_FAILURE'].includes(result.failureType));
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('session NOT_VALIDATED remains normal optional absence', async () => {
  const calls = [];
  const result = await runtime(async url => {
    calls.push(url);
    return url === 'https://api.anthropic.com/v1/messages'
      ? anthropicResponse([searchResult()])
      : yahooResponse(yahooHtml({datePublished: '2026-09-10T20:30:00Z'}));
  }).discoverAndValidateRecap({targetSessionDate});
  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.type, 'NOT_VALIDATED');
  assert.equal(result.validation, null);
  assert.equal(result.discovery.url, recapUrl);
});

test('session retrieval failures remain sanitized and stage-distinct with one page attempt', async () => {
  let discoveryCalls = 0;
  let pageCalls = 0;
  const result = await runtime(async url => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      discoveryCalls++;
      return anthropicResponse([searchResult()]);
    }
    pageCalls++;
    return yahooResponse('', {ok: false, status: 503});
  }).discoverAndValidateRecap({targetSessionDate});
  assert.deepEqual(result, {
    ok: false,
    type: 'SESSION_VALIDATION_FAILURE',
    failureType: 'HTTP_FAILURE',
    message: 'Yahoo recap session validation failed'
  });
  assert.equal(discoveryCalls, 1);
  assert.equal(pageCalls, 1);
});

test('composes only discovery and validation without candidate, evidence, package, or final synthesis integration', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/yahoo-recap-research-runtime.js'), 'utf8');
  assert.match(source, /createClaudeBoundedNewsDiscoveryService/);
  assert.match(source, /createYahooRecapSessionValidationService/);
  assert.doesNotMatch(source, /analysis-package|us-analysis|evidence-items|news-evidence-candidates|cnbc|invokeClaudeAnalysis/);
});

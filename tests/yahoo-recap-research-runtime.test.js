const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  YAHOO_RECAP_RESEARCH_PRODUCTION_BOUNDS,
  YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS,
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

function searchResult(url = recapUrl, title = 'Stock market today: September 9 recap') {
  return {
    type: 'web_search_result',
    title,
    url,
    encrypted_content: 'not exposed'
  };
}

function yahooHtml(overrides = {}, url = recapUrl) {
  const article = {
    '@type': 'NewsArticle',
    headline: 'Stock market today: September 9 recap',
    datePublished: '2026-09-09T20:30:00Z',
    dateModified: '2026-09-09T21:00:00Z',
    mainEntityOfPage: {'@type': 'WebPage', '@id': url},
    ...overrides
  };
  return `<link rel="canonical" href="${url}">`
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
  assert.equal(YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS, 3);
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
  assert.equal(request.messages[0].content, 'Yahoo US stock market today September 9 2026');
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
  assert.equal(result.discovery, null);
});

test('skips stale candidates and returns the later exact target-session recap', async () => {
  const target = '2026-09-10';
  const staleUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-september-8.html';
  const targetUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-september-10.html';
  const calls = [];
  const result = await runtime(async (url, options) => {
    calls.push(url);
    if (url === 'https://api.anthropic.com/v1/messages') {
      const request = JSON.parse(options.body);
      assert.equal(request.messages[0].content, 'Yahoo US stock market today September 10 2026');
      return anthropicResponse([
        searchResult(staleUrl, 'September 8 recap'),
        searchResult(targetUrl, 'September 10 recap')
      ]);
    }
    if (url === staleUrl) {
      return yahooResponse(yahooHtml({
        headline: 'September 8 recap',
        datePublished: '2026-09-08T20:30:00Z',
        dateModified: '2026-09-08T21:00:00Z'
      }, staleUrl), {url: staleUrl});
    }
    return yahooResponse(yahooHtml({
      headline: 'September 10 recap',
      datePublished: '2026-09-10T20:30:00Z',
      dateModified: '2026-09-10T21:00:00Z'
    }, targetUrl), {url: targetUrl});
  }).discoverAndValidateRecap({targetSessionDate: target});

  assert.deepEqual(calls, ['https://api.anthropic.com/v1/messages', staleUrl, targetUrl]);
  assert.equal(result.type, 'VALIDATED');
  assert.equal(result.discovery.url, targetUrl);
  assert.equal(result.validation.targetSessionDate, target);
});

test('returns optional absence without stale substitution after the bounded attempt ceiling', async () => {
  const target = '2026-09-10';
  const urls = Array.from({length: 4}, (_, index) =>
    `https://finance.yahoo.com/markets/live/stock-market-today-stale-${index + 1}.html`);
  const calls = [];
  const result = await runtime(async url => {
    calls.push(url);
    if (url === 'https://api.anthropic.com/v1/messages') {
      return anthropicResponse(urls.map((value, index) => searchResult(value, `Stale ${index + 1}`)));
    }
    return yahooResponse(yahooHtml({
      headline: `Stale ${urls.indexOf(url) + 1}`,
      datePublished: '2026-09-09T20:30:00Z',
      dateModified: '2026-09-09T21:00:00Z'
    }, url), {url});
  }).discoverAndValidateRecap({targetSessionDate: target});

  assert.deepEqual(result, {ok: true, type: 'NOT_VALIDATED', discovery: null, validation: null});
  assert.equal(calls.length, 1 + YAHOO_RECAP_RESEARCH_MAX_SESSION_VALIDATION_ATTEMPTS);
  assert.deepEqual(calls.slice(1), urls.slice(0, 3));
});

test('does not reuse a prior successful recap on a later stale-only invocation', async () => {
  const target = '2026-09-10';
  const targetUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-target.html';
  const staleUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-stale.html';
  let discoveryInvocation = 0;
  const service = runtime(async url => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      discoveryInvocation++;
      return anthropicResponse([searchResult(
        discoveryInvocation === 1 ? targetUrl : staleUrl,
        discoveryInvocation === 1 ? 'Target recap' : 'Stale recap'
      )]);
    }
    const isTarget = url === targetUrl;
    return yahooResponse(yahooHtml({
      headline: isTarget ? 'Target recap' : 'Stale recap',
      datePublished: isTarget ? '2026-09-10T20:30:00Z' : '2026-09-09T20:30:00Z',
      dateModified: isTarget ? '2026-09-10T21:00:00Z' : '2026-09-09T21:00:00Z'
    }, url), {url});
  });

  const first = await service.discoverAndValidateRecap({targetSessionDate: target});
  const second = await service.discoverAndValidateRecap({targetSessionDate: target});
  assert.equal(first.type, 'VALIDATED');
  assert.equal(first.discovery.url, targetUrl);
  assert.deepEqual(second, {ok: true, type: 'NOT_VALIDATED', discovery: null, validation: null});
});

test('emits sanitized rank-ordered candidate validation outcomes', async () => {
  const target = '2026-09-10';
  const staleUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-stale.html';
  const targetUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-target.html';
  const diagnostics = [];
  await runtime(async url => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      return anthropicResponse([
        searchResult(staleUrl, 'Stale recap'),
        searchResult(targetUrl, 'Target recap')
      ]);
    }
    const isTarget = url === targetUrl;
    return yahooResponse(yahooHtml({
      headline: isTarget ? 'Target recap' : 'Stale recap',
      datePublished: isTarget ? '2026-09-10T20:30:00Z' : '2026-09-09T20:30:00Z',
      dateModified: isTarget ? '2026-09-10T21:00:00Z' : '2026-09-09T21:00:00Z'
    }, url), {url});
  }, {onDiagnostics: value => diagnostics.push(value)})
    .discoverAndValidateRecap({targetSessionDate: target});

  const attempts = diagnostics.filter(value => value.stage === 'yahooRecapSessionCandidateValidation');
  assert.deepEqual(attempts, [{
    stage: 'yahooRecapSessionCandidateValidation',
    rank: 1,
    normalizedYahooUrl: staleUrl,
    path: '/markets/live/stock-market-today-stale.html',
    outcome: 'NOT_VALIDATED',
    failureType: null
  }, {
    stage: 'yahooRecapSessionCandidateValidation',
    rank: 2,
    normalizedYahooUrl: targetUrl,
    path: '/markets/live/stock-market-today-target.html',
    outcome: 'VALIDATED',
    failureType: null
  }]);
  assert.equal(JSON.stringify(attempts).includes('articleBody'), false);
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

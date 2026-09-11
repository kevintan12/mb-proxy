const test = require('node:test');
const assert = require('node:assert/strict');

const {
  YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS,
  createYahooRecapSessionValidationService
} = require('../lib/yahoo-recap-session-validation');

const currentUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html';
const legacyUrl = 'https://finance.yahoo.com/news/live/stock-market-today-example.html';
const bounds = Object.freeze({timeoutMs: 4000, maxResponseBytes: 1024 * 1024, maxHeadlineBytes: 512});

function discovery(url = currentUrl, targetSessionDate = '2026-09-09') {
  return Object.freeze({
    title: 'Stock market today: September 9 recap',
    url,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate
  });
}

function input(overrides = {}) {
  return {
    discovery: discovery(),
    targetSessionDate: '2026-09-09',
    bounds,
    ...overrides
  };
}

function articleHtml(overrides = {}) {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Stock market today: September 9 recap',
    datePublished: '2026-09-09T16:30:00-04:00',
    dateModified: '2026-09-09T17:00:00-04:00',
    url: currentUrl,
    ...overrides
  };
  return `<!doctype html><html><head><link rel="canonical" href="${currentUrl}">`
    + `<script type="application/ld+json">${JSON.stringify(article)}</script></head></html>`;
}

function response(html, {url = currentUrl, status = 200, contentType = 'text/html; charset=utf-8'} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; }},
    async text() { return html; }
  };
}

function service(fetchImpl, options = {}) {
  return createYahooRecapSessionValidationService({fetchImpl, ...options});
}

test('validates matching provider datePublished and returns immutable normalized metadata', async () => {
  let calls = 0;
  const diagnostics = [];
  let tick = 0;
  const result = await service(async (url, options) => {
    calls++;
    assert.equal(url, currentUrl);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    return response(articleHtml());
  }, {onDiagnostics: value => diagnostics.push(value), monotonicNow: () => tick++})
    .validateYahooRecapSession(input());
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true,
    type: 'VALIDATED',
    validation: {
      headline: 'Stock market today: September 9 recap',
      url: currentUrl,
      datePublished: '2026-09-09T20:30:00.000Z',
      dateModified: '2026-09-09T21:00:00.000Z',
      targetSessionDate: '2026-09-09'
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.validation), true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]), [
    'stage', 'elapsedMs', 'responseBytes', 'fetchCount', 'httpStatus', 'contentType', 'outcomeType'
  ]);
  assert.equal(diagnostics[0].fetchCount, 1);
  assert.equal(diagnostics[0].contentType, 'HTML');
  assert.equal(typeof diagnostics[0].responseBytes, 'number');
  assert.equal(typeof diagnostics[0].elapsedMs, 'number');
  assert.equal(JSON.stringify(diagnostics[0]).includes(currentUrl), false);
});

test('uses America/New_York date rather than the UTC calendar date', async () => {
  const html = articleHtml({
    datePublished: '2026-09-10T01:00:00Z',
    dateModified: null
  });
  const result = await service(async () => response(html)).validateYahooRecapSession(input());
  assert.equal(result.type, 'VALIDATED');
  assert.equal(result.validation.datePublished, '2026-09-10T01:00:00.000Z');
});

test('rejects September 10 publication for a September 9 target', async () => {
  const html = articleHtml({
    datePublished: '2026-09-10T12:00:00-04:00',
    dateModified: '2026-09-10T13:00:00-04:00'
  });
  const result = await service(async () => response(html)).validateYahooRecapSession(input());
  assert.deepEqual(result, {ok: true, type: 'NOT_VALIDATED', validation: null});
});

test('dateModified cannot override a mismatched datePublished', async () => {
  const html = articleHtml({
    datePublished: '2026-09-10T10:00:00-04:00',
    dateModified: '2026-09-09T17:00:00-04:00'
  });
  const result = await service(async () => response(html)).validateYahooRecapSession(input());
  assert.equal(result.type, 'NOT_VALIDATED');
});

test('missing or malformed datePublished is not validated', async () => {
  for (const datePublished of [undefined, 'September 9, 2026', '2026-09-09T12:00:00']) {
    const article = {
      '@type': 'NewsArticle', headline: 'September 9', dateModified: '2026-09-09T20:00:00Z', url: currentUrl
    };
    if (datePublished !== undefined) article.datePublished = datePublished;
    const html = `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
    const result = await service(async () => response(html)).validateYahooRecapSession(input());
    assert.equal(result.type, 'NOT_VALIDATED');
  }
});

test('title and URL date text cannot substitute for provider datePublished', async () => {
  const datedUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-september-9-2026.html';
  const datedDiscovery = discovery(datedUrl);
  const html = '<html><head><title>Stock market today: September 9, 2026</title></head></html>';
  const result = await service(async () => response(html, {url: datedUrl}))
    .validateYahooRecapSession(input({discovery: datedDiscovery}));
  assert.equal(result.type, 'NOT_VALIDATED');
});

test('rejects invalid discovery URLs and mutable discovery before fetch', async () => {
  let calls = 0;
  const invalidUrls = [
    'http://finance.yahoo.com/markets/live/stock-market-today-x.html',
    'https://example.com/markets/live/stock-market-today-x.html',
    'https://finance.yahoo.com.example.com/markets/live/stock-market-today-x.html',
    'https://news.finance.yahoo.com/markets/live/stock-market-today-x.html',
    'https://user:pass@finance.yahoo.com/markets/live/stock-market-today-x.html',
    'https://finance.yahoo.com:444/markets/live/stock-market-today-x.html',
    'https://finance.yahoo.com/topic/stock-market-news',
    'not-a-url'
  ];
  for (const url of invalidUrls) {
    const result = await service(async () => { calls++; })
      .validateYahooRecapSession(input({discovery: discovery(url)}));
    assert.equal(result.type, 'INVALID_INPUT');
  }
  const mutable = {...discovery()};
  assert.equal((await service(async () => { calls++; })
    .validateYahooRecapSession(input({discovery: mutable}))).type, 'INVALID_INPUT');
  assert.equal(calls, 0);
});

test('accepts current and legacy Yahoo recap path families', async () => {
  for (const url of [currentUrl, legacyUrl]) {
    const html = articleHtml({url}).replaceAll(currentUrl, url);
    const result = await service(async () => response(html, {url}))
      .validateYahooRecapSession(input({discovery: discovery(url)}));
    assert.equal(result.type, 'VALIDATED');
  }
});

test('fails closed on response and structured canonical URL mismatch', async () => {
  const other = 'https://finance.yahoo.com/markets/live/stock-market-today-other.html';
  const responseMismatch = await service(async () => response(articleHtml(), {url: other}))
    .validateYahooRecapSession(input());
  assert.equal(responseMismatch.type, 'INVALID_RESPONSE');
  const metadataMismatch = await service(async () => response(articleHtml({url: other})))
    .validateYahooRecapSession(input());
  assert.equal(metadataMismatch.type, 'NOT_VALIDATED');
});

test('fails safely on timeout, HTTP failure, and unsuitable content type with no retry', async () => {
  let timeoutCalls = 0;
  const timeoutResult = await service((url, options) => new Promise((resolve, reject) => {
    timeoutCalls++;
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })).validateYahooRecapSession(input({bounds: {...bounds, timeoutMs: 5}}));
  assert.equal(timeoutResult.type, 'TIMEOUT');
  assert.equal(timeoutCalls, 1);

  let httpCalls = 0;
  const httpResult = await service(async () => { httpCalls++; return response('', {status: 503}); })
    .validateYahooRecapSession(input());
  assert.equal(httpResult.type, 'HTTP_FAILURE');
  assert.equal(httpCalls, 1);

  let contentCalls = 0;
  const contentResult = await service(async () => {
    contentCalls++;
    return response('{}', {contentType: 'application/json'});
  }).validateYahooRecapSession(input());
  assert.equal(contentResult.type, 'INVALID_RESPONSE');
  assert.equal(contentCalls, 1);
});

test('rejects oversized bodies atomically', async () => {
  const smallBounds = {...bounds, maxResponseBytes: 100};
  const result = await service(async () => response(articleHtml().padEnd(101, 'x')))
    .validateYahooRecapSession(input({bounds: smallBounds}));
  assert.equal(result.type, 'RESPONSE_TOO_LARGE');
  assert.equal(result.validation, null);
});

test('malformed JSON-LD and invalid optional metadata remain NOT_VALIDATED', async () => {
  const malformed = await service(async () => response(
    '<script type="application/ld+json">not-json</script>'
  )).validateYahooRecapSession(input());
  assert.equal(malformed.type, 'NOT_VALIDATED');
  const invalidModified = await service(async () => response(articleHtml({dateModified: 'not-a-time'})))
    .validateYahooRecapSession(input());
  assert.equal(invalidModified.type, 'NOT_VALIDATED');
});

test('input and diagnostics boundaries reject overrides and do not alter behavior', async () => {
  assert.deepEqual(YAHOO_RECAP_SESSION_VALIDATION_BOUND_KEYS, [
    'timeoutMs', 'maxResponseBytes', 'maxHeadlineBytes'
  ]);
  let calls = 0;
  const invalid = await service(async () => { calls++; }).validateYahooRecapSession({
    ...input(), prompt: 'caller controlled'
  });
  assert.equal(invalid.type, 'INVALID_INPUT');
  assert.equal(calls, 0);
  const valid = await service(async () => response(articleHtml()), {
    onDiagnostics() { throw new Error('diagnostics unavailable'); }
  }).validateYahooRecapSession(input());
  assert.equal(valid.type, 'VALIDATED');
});

test('module performs only one page fetch and exposes no Claude, candidate, evidence, or package output', async () => {
  let fetches = 0;
  const result = await service(async () => {
    fetches++;
    return response(articleHtml());
  }).validateYahooRecapSession(input());
  assert.equal(fetches, 1);
  assert.deepEqual(Object.keys(result), ['ok', 'type', 'validation']);
  assert.deepEqual(Object.keys(result.validation), [
    'headline', 'url', 'datePublished', 'dateModified', 'targetSessionDate'
  ]);
  for (const forbidden of ['candidate', 'evidence', 'package', 'analysis', 'prompt']) {
    assert.equal(Object.hasOwn(result, forbidden), false);
  }
});

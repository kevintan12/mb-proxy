const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS,
  YAHOO_RECAP_ARTICLE_CONTENT_KEYS,
  createYahooRecapArticleContentAcquisitionService
} = require('../lib/yahoo-recap-article-content-acquisition');

const canonicalUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html';
const targetSessionDate = '2026-09-09';
const bounds = Object.freeze({
  timeoutMs: 4000,
  maxResponseBytes: 1258291,
  maxHeadlineBytes: 512,
  maxArticleTextBytes: 8192,
  maxResultBytes: 12288
});

function frozenDiscovery(overrides = {}) {
  return Object.freeze({
    title: 'Stock market today: September 9 recap',
    url: canonicalUrl,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate,
    ...overrides
  });
}

function frozenValidation(overrides = {}) {
  return Object.freeze({
    headline: 'Stock market today: September 9 recap',
    url: canonicalUrl,
    datePublished: '2026-09-09T20:30:00.000Z',
    dateModified: '2026-09-09T21:00:00.000Z',
    targetSessionDate,
    ...overrides
  });
}

function article(overrides = {}) {
  return {
    '@type': 'NewsArticle',
    headline: 'Stock market today: September 9 recap',
    datePublished: '2026-09-09T16:30:00-04:00',
    dateModified: '2026-09-09T17:00:00-04:00',
    mainEntityOfPage: {'@type': 'WebPage', '@id': canonicalUrl},
    articleBody: 'Stocks <b>rose</b> after&nbsp;new data.\nInvestors reassessed risk.',
    ...overrides
  };
}

function html(articleValue = article(), canonical = canonicalUrl) {
  return `<link rel="canonical" href="${canonical}">`
    + `<script type="application/ld+json">${JSON.stringify(articleValue)}</script>`;
}

function response(body = html(), overrides = {}) {
  return {
    ok: true,
    status: 200,
    url: canonicalUrl,
    headers: {get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null},
    async text() { return body; },
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    discovery: frozenDiscovery(),
    validation: frozenValidation(),
    bounds,
    ...overrides
  };
}

function service(fetchImpl) {
  return createYahooRecapArticleContentAcquisitionService({fetchImpl});
}

test('exports the explicit bound and normalized article key contracts', () => {
  assert.deepEqual(YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS, [
    'timeoutMs', 'maxResponseBytes', 'maxHeadlineBytes', 'maxArticleTextBytes', 'maxResultBytes'
  ]);
  assert.deepEqual(YAHOO_RECAP_ARTICLE_CONTENT_KEYS, [
    'sourceId', 'canonicalUrl', 'headline', 'publishedAt', 'updatedAt',
    'targetSessionDate', 'articleText'
  ]);
  assert.equal(Object.isFrozen(YAHOO_RECAP_ARTICLE_CONTENT_BOUND_KEYS), true);
  assert.equal(Object.isFrozen(YAHOO_RECAP_ARTICLE_CONTENT_KEYS), true);
});

test('extracts one immutable provider-owned Yahoo article result', async () => {
  const calls = [];
  const result = await service(async (url, options) => {
    calls.push({url, options});
    return response();
  }).acquireArticleContent(input());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, canonicalUrl);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    ok: true,
    type: 'SUCCESS',
    articleContent: {
      sourceId: 'us.yahoo-finance',
      canonicalUrl,
      headline: 'Stock market today: September 9 recap',
      publishedAt: '2026-09-09T20:30:00.000Z',
      updatedAt: '2026-09-09T21:00:00.000Z',
      targetSessionDate,
      articleText: 'Stocks rose after new data. Investors reassessed risk.'
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.articleContent), true);
});

test('requires exact frozen discovery and validation objects before fetch', async () => {
  let calls = 0;
  const acquire = service(async () => { calls++; }).acquireArticleContent;
  const cases = [
    {discovery: {...frozenDiscovery()}, validation: frozenValidation(), bounds},
    {discovery: frozenDiscovery(), validation: {...frozenValidation()}, bounds},
    {...input(), url: canonicalUrl},
    {...input(), bounds: {...bounds, extra: true}},
    {...input(), discovery: frozenDiscovery({title: ' Stock market today'})},
    {...input(), validation: frozenValidation({headline: ' Stock market today'})},
    {...input(), validation: frozenValidation({url: canonicalUrl.replace('/markets/', '/news/')})},
    {...input(), validation: frozenValidation({targetSessionDate: '2026-09-08'})},
    {...input(), validation: frozenValidation({datePublished: '2026-09-10T20:30:00.000Z'})}
  ];
  for (const value of cases) {
    assert.deepEqual(await acquire(value), {
      ok: false,
      type: 'INVALID_INPUT',
      articleContent: null,
      message: 'Invalid Yahoo recap article request'
    });
  }
  assert.equal(calls, 0);
});

test('rejects invalid Yahoo URL ownership and recap scope before fetch', async () => {
  let calls = 0;
  const acquire = service(async () => { calls++; }).acquireArticleContent;
  const invalidUrls = [
    'http://finance.yahoo.com/markets/live/stock-market-today-example.html',
    'https://evilfinance.yahoo.com/markets/live/stock-market-today-example.html',
    'https://finance.yahoo.com.evil.test/markets/live/stock-market-today-example.html',
    'https://user@finance.yahoo.com/markets/live/stock-market-today-example.html',
    'https://finance.yahoo.com:444/markets/live/stock-market-today-example.html',
    'https://finance.yahoo.com/news/unrelated.html'
  ];
  for (const url of invalidUrls) {
    const result = await acquire({
      discovery: frozenDiscovery({url}),
      validation: frozenValidation({url}),
      bounds
    });
    assert.equal(result.type, 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('accepts Article, NewsArticle, and LiveBlogPosting JSON-LD types', async () => {
  for (const type of ['Article', 'NewsArticle', 'LiveBlogPosting']) {
    const result = await service(async () => response(html(article({'@type': type}))))
      .acquireArticleContent(input());
    assert.equal(result.type, 'SUCCESS');
  }
});

test('requires matching response, canonical, and structured article identity', async () => {
  const other = 'https://finance.yahoo.com/markets/live/stock-market-today-other.html';
  const cases = [
    response(html(), {url: other}),
    response(html(article(), other)),
    response(html(article({mainEntityOfPage: {'@id': other}})))
  ];
  for (const reply of cases) {
    const result = await service(async () => reply).acquireArticleContent(input());
    assert.equal(result.type, 'IDENTITY_MISMATCH');
  }
});

test('manual redirects and HTTP failures fail closed with one request and no retry', async () => {
  for (const reply of [
    response('', {ok: false, status: 302, headers: {get: () => 'text/html'}}),
    response('', {ok: false, status: 503})
  ]) {
    let calls = 0;
    const result = await service(async () => { calls++; return reply; })
      .acquireArticleContent(input());
    assert.equal(result.type, 'HTTP_FAILURE');
    assert.equal(calls, 1);
  }
});

test('network, timeout, and response-body failures are deterministic with no retry', async () => {
  let calls = 0;
  const network = await service(async () => { calls++; throw new Error('private'); })
    .acquireArticleContent(input());
  assert.equal(network.type, 'RETRIEVAL_FAILURE');
  assert.equal(calls, 1);

  calls = 0;
  const timeout = await service(async (url, options) => {
    calls++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      const error = new Error('private timeout');
      error.name = 'AbortError';
      reject(error);
    }));
  }).acquireArticleContent({...input(), bounds: {...bounds, timeoutMs: 5}});
  assert.equal(timeout.type, 'TIMEOUT');
  assert.equal(calls, 1);

  calls = 0;
  const bodyFailure = await service(async () => response('', {
    async text() { calls++; throw new Error('private body'); }
  })).acquireArticleContent(input());
  assert.equal(bodyFailure.type, 'RETRIEVAL_FAILURE');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify([network, timeout, bodyFailure]).includes('private'), false);
});

test('rejects unsuitable content types and oversized raw responses', async () => {
  const invalidType = await service(async () => response('', {
    headers: {get: () => 'application/json'}
  })).acquireArticleContent(input());
  assert.equal(invalidType.type, 'INVALID_CONTENT_TYPE');

  const declared = await service(async () => response('', {
    headers: {get: name => name === 'content-type' ? 'text/html' : '1258292'}
  })).acquireArticleContent(input());
  assert.equal(declared.type, 'RESPONSE_TOO_LARGE');

  const oversized = html().padEnd(1258292, ' ');
  const actual = await service(async () => response(oversized)).acquireArticleContent(input());
  assert.equal(actual.type, 'RESPONSE_TOO_LARGE');
});

test('rejects malformed HTML, malformed JSON-LD, and unsupported article metadata', async () => {
  for (const body of [
    '<html>no structured metadata</html>',
    '<script type="application/ld+json">{bad</script>',
    `<script type="application/ld+json">${JSON.stringify({'@type': 'WebPage'})}</script>`,
    html(article({mainEntityOfPage: undefined}))
  ]) {
    const result = await service(async () => response(body)).acquireArticleContent(input());
    assert.equal(result.type, 'INVALID_METADATA');
  }
});

test('requires provider headline and enforces its byte bound', async () => {
  const missing = await service(async () => response(html(article({headline: ' '}))))
    .acquireArticleContent(input());
  assert.equal(missing.type, 'INVALID_METADATA');

  const longHeadline = 'x'.repeat(513);
  const oversized = await service(async () => response(html(article({headline: longHeadline}))))
    .acquireArticleContent({...input(), validation: frozenValidation({headline: null})});
  assert.equal(oversized.type, 'INVALID_METADATA');
});

test('uses JSON-LD articleBody only and rejects missing or blank bodies', async () => {
  for (const articleBody of [undefined, null, '', '   ', '<b> </b>']) {
    const value = article();
    if (articleBody === undefined) delete value.articleBody;
    else value.articleBody = articleBody;
    const result = await service(async () => response(html(value))).acquireArticleContent(input());
    assert.equal(result.type, 'ARTICLE_BODY_MISSING');
  }
});

test('requires publication and optional modification timestamps to match validation', async () => {
  const cases = [
    article({datePublished: '2026-09-09T16:31:00-04:00'}),
    article({datePublished: 'not-a-date'}),
    article({dateModified: '2026-09-09T17:01:00-04:00'}),
    article({dateModified: 'not-a-date'}),
    article({dateModified: undefined})
  ];
  for (const value of cases) {
    const result = await service(async () => response(html(value))).acquireArticleContent(input());
    assert.equal(result.type, 'INVALID_METADATA');
  }
  const absent = article();
  delete absent.dateModified;
  const accepted = await service(async () => response(html(absent)))
    .acquireArticleContent({...input(), validation: frozenValidation({dateModified: null})});
  assert.equal(accepted.type, 'SUCCESS');
  assert.equal(accepted.articleContent.updatedAt, null);
});

test('enforces article-text and normalized-result bounds atomically without truncation', async () => {
  const articleText = 'x'.repeat(8193);
  const tooMuchText = await service(async () => response(html(article({articleBody: articleText}))))
    .acquireArticleContent(input());
  assert.equal(tooMuchText.type, 'ARTICLE_TEXT_TOO_LARGE');
  assert.equal(tooMuchText.articleContent, null);

  const tooMuchResult = await service(async () => response())
    .acquireArticleContent({...input(), bounds: {...bounds, maxResultBytes: 10}});
  assert.equal(tooMuchResult.type, 'RESULT_TOO_LARGE');
  assert.equal(tooMuchResult.articleContent, null);
});

test('returned content is independent from caller mutation and contains no evidence/package fields', async () => {
  const discovery = frozenDiscovery();
  const validation = frozenValidation();
  const result = await service(async () => response()).acquireArticleContent({
    discovery, validation, bounds
  });
  assert.deepEqual(Object.keys(result.articleContent), YAHOO_RECAP_ARTICLE_CONTENT_KEYS);
  assert.equal('reference' in result.articleContent, false);
  assert.equal('evidenceRef' in result.articleContent, false);
  assert.equal('horizon' in result.articleContent, false);
  assert.equal('provenance' in result.articleContent, false);
  assert.equal('materiality' in result.articleContent, false);
  assert.notEqual(result.articleContent, discovery);
  assert.notEqual(result.articleContent, validation);
});

test('module has no candidate, evidence, package, Claude, or CNBC integration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/yahoo-recap-article-content-acquisition.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /require\([^)]*(?:candidate|evidence|analysis-package|claude|cnbc)/i);
});

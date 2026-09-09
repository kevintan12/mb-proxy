const test = require('node:test');
const assert = require('node:assert/strict');

const {createNewsEvidenceCandidate} = require('../lib/news-evidence-candidates');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
} = require('../lib/cnbc-article-content-acquisition');

const candidateBounds = Object.freeze({
  maxCandidates: 5,
  maxTitleBytes: 200,
  maxSummaryBytes: 300,
  maxExtractBytes: 500,
  maxCollectionBytes: 10000
});
const retrievalBounds = Object.freeze({
  timeoutMs: 100,
  maxResponseBytes: 10000,
  maxArticleTextBytes: 1000,
  maxTitleBytes: 200,
  maxResultBytes: 3000
});
const url = 'https://www.cnbc.com/2026/09/08/market-update.html';

function candidate(overrides = {}) {
  return createNewsEvidenceCandidate({
    reference: 'c1',
    horizon: {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-08T10:00:00Z',
      endsAtInclusive: '2026-09-08T22:00:00Z'
    },
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: 'Markets assess the latest developments',
    summary: 'A bounded RSS summary.',
    extract: null,
    canonicalUrl: url,
    publishedAt: '2026-09-08T12:00:00Z',
    symbols: [],
    ...overrides
  }, {bounds: candidateBounds});
}

function articleHtml(overrides = {}) {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Provider headline is not authoritative here',
    datePublished: '2026-09-08T12:00:00Z',
    dateModified: '2026-09-08T13:30:00+00:00',
    articleBody: 'Markets <b>moved</b> after&nbsp;new data.\nInvestors reassessed risk.',
    ...overrides
  };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(article)}</script></head><body></body></html>`;
}

function response(html = articleHtml(), overrides = {}) {
  const headers = new Map([
    ['content-type', 'text/html; charset=utf-8'],
    ['content-length', String(Buffer.byteLength(html, 'utf8'))]
  ]);
  return {
    ok: true,
    status: 200,
    url,
    headers: {get(name) { return headers.get(name.toLowerCase()) ?? null; }},
    async text() { return html; },
    ...overrides
  };
}

function assertCode(code) {
  return error => error instanceof CnbcArticleContentAcquisitionError && error.code === code;
}

test('extracts bounded CNBC JSON-LD article content with deterministic immutable identity', async () => {
  const input = candidate();
  const original = JSON.stringify(input);
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response()});
  const result = await service.acquireArticleContent({candidate: input, bounds: retrievalBounds});

  assert.deepEqual(Object.keys(result), CNBC_ARTICLE_CONTENT_RESULT_KEYS);
  assert.deepEqual(result, {
    reference: 'c1',
    sourceId: 'us.cnbc',
    canonicalUrl: url,
    publishedAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T13:30:00.000Z',
    title: 'Markets assess the latest developments',
    articleText: 'Markets moved after new data. Investors reassessed risk.',
    provenance: {
      publisher: 'CNBC',
      authority: 'secondary',
      homepage: 'https://www.cnbc.com/',
      applicableMarket: 'US',
      sourceJurisdiction: 'GLOBAL',
      locator: 'source-homepage'
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.provenance), true);
  assert.equal(JSON.stringify(input), original);
  assert.notEqual(result.provenance, input.provenance);
});

test('makes exactly one bounded GET with timeout signal and no retry', async () => {
  const calls = [];
  const service = createCnbcArticleContentAcquisitionService({
    fetchImpl: async (...args) => { calls.push(args); return response(); }
  });
  await service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], url);
  assert.deepEqual({...calls[0][1], signal: undefined}, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'text/html, application/xhtml+xml;q=0.9',
      'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
    },
    signal: undefined
  });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('rejects non-CNBC URLs and altered canonical candidates before fetch', async () => {
  let calls = 0;
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => { calls++; }});
  const valid = candidate();
  for (const invalid of [
    {...valid, canonicalUrl: 'https://example.com/article.html'},
    {...valid, sourceId: 'us.reuters'},
    {...valid, provenance: {...valid.provenance, publisher: 'Spoofed'}}
  ]) {
    await assert.rejects(service.acquireArticleContent({candidate: invalid, bounds: retrievalBounds}), assertCode('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('requires exact positive caller retrieval bounds before fetch', async () => {
  let calls = 0;
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => { calls++; }});
  for (const bounds of [undefined, {...retrievalBounds, timeoutMs: 0}, {...retrievalBounds, extra: 1}]) {
    await assert.rejects(service.acquireArticleContent({candidate: candidate(), bounds}), assertCode('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('fails closed on network, HTTP, response URL and content-type failures without retry', async () => {
  const cases = [
    [async () => { throw new Error('network'); }, 'NETWORK_FAILURE'],
    [async () => response('', {
      headers: {get: name => name === 'content-type' ? 'text/html' : null},
      text: async () => { throw new Error('body read failed'); }
    }), 'NETWORK_FAILURE'],
    [async () => response('', {ok: false, status: 503}), 'HTTP_FAILURE'],
    [async () => response(articleHtml(), {url: 'https://example.com/article'}), 'INVALID_PAGE'],
    [async () => response(articleHtml(), {headers: {get: name => name === 'content-type' ? 'application/json' : null}}), 'INVALID_PAGE']
  ];
  for (const [fetchImpl, code] of cases) {
    let calls = 0;
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async (...args) => {
      calls++;
      return fetchImpl(...args);
    }});
    await assert.rejects(service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}), assertCode(code));
    assert.equal(calls, 1);
  }
});

test('keeps timeout active through fetch and complete body reading', async () => {
  const fetchTimeout = createCnbcArticleContentAcquisitionService({
    fetchImpl: async (requestUrl, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    })
  });
  await assert.rejects(fetchTimeout.acquireArticleContent({
    candidate: candidate(), bounds: {...retrievalBounds, timeoutMs: 5}
  }), assertCode('TIMEOUT'));

  let calls = 0;
  const bodyTimeout = createCnbcArticleContentAcquisitionService({
    fetchImpl: async (requestUrl, options) => {
      calls++;
      return response('', {
        headers: {get: name => name === 'content-type' ? 'text/html' : null},
        text: async () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
        })
      });
    }
  });
  await assert.rejects(bodyTimeout.acquireArticleContent({
    candidate: candidate(), bounds: {...retrievalBounds, timeoutMs: 5}
  }), assertCode('TIMEOUT'));
  assert.equal(calls, 1);
});

test('rejects malformed, non-article and incomplete structured article pages distinctly', async () => {
  const cases = [
    ['<html><body>Not an article</body></html>', 'INVALID_PAGE'],
    ['<script type="application/ld+json">not-json</script>', 'INVALID_PAGE'],
    [articleHtml({'@type': 'WebPage'}), 'INVALID_PAGE'],
    [articleHtml({articleBody: ''}), 'EXTRACTION_FAILURE'],
    [articleHtml({datePublished: 'not-a-date'}), 'EXTRACTION_FAILURE'],
    [articleHtml({datePublished: '2026-09-08T12:00:00'}), 'EXTRACTION_FAILURE'],
    [articleHtml({dateModified: 'not-a-date'}), 'EXTRACTION_FAILURE']
  ];
  for (const [html, code] of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}), assertCode(code));
  }
});

test('extracts an article node nested in an @graph and permits absent dateModified', async () => {
  const graph = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': ['NewsArticle', 'Article'],
      datePublished: '2026-09-08T12:00:00-04:00',
      articleBody: 'A complete factual article body.'
    }]
  });
  const html = `<html><script type='application/ld+json'>${graph}</script></html>`;
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
  assert.equal(result.publishedAt, '2026-09-08T16:00:00.000Z');
  assert.equal(result.updatedAt, null);
});

test('rejects publication, modification and chronological timestamp mismatches', async () => {
  const cases = [
    articleHtml({datePublished: '2026-09-08T23:00:00Z', dateModified: null}),
    articleHtml({dateModified: '2026-09-08T23:00:00Z'}),
    articleHtml({datePublished: '2026-09-08T14:00:00Z', dateModified: '2026-09-08T13:00:00Z'})
  ];
  for (const html of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}), assertCode('HORIZON_MISMATCH'));
  }
});

test('rejects declared and actual response bodies over the caller bound', async () => {
  const declared = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(articleHtml(), {
      headers: {get: name => name === 'content-type' ? 'text/html' : name === 'content-length' ? '10001' : null}
    })
  });
  await assert.rejects(declared.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}), assertCode('CONTENT_TOO_LARGE'));

  const oversized = articleHtml({articleBody: 'x'}).padEnd(10001, ' ');
  const actual = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(oversized)});
  await assert.rejects(actual.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}), assertCode('CONTENT_TOO_LARGE'));
});

test('rejects oversized title, extracted text and total result atomically', async () => {
  const cases = [
    [{...retrievalBounds, maxTitleBytes: 5}, articleHtml()],
    [{...retrievalBounds, maxArticleTextBytes: 5}, articleHtml()],
    [{...retrievalBounds, maxResultBytes: 10}, articleHtml()]
  ];
  for (const [bounds, html] of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(service.acquireArticleContent({candidate: candidate(), bounds}), assertCode('CONTENT_TOO_LARGE'));
  }
});

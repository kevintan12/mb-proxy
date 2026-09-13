const test = require('node:test');
const assert = require('node:assert/strict');

const {createNewsEvidenceCandidate} = require('../lib/news-evidence-candidates');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CnbcArticleContentAcquisitionError,
  createCnbcArticleContentAcquisitionService
} = require('../lib/cnbc-article-content-acquisition');
const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS
} = require('../lib/cnbc-news-research-runtime');

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

function liveBlogHtml({newsArticle = {}, liveBlog = {}, updates = []} = {}) {
  const nodes = [{
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    datePublished: '2026-09-08T11:00:00Z',
    dateModified: '2026-09-08T11:30:00Z',
    ...newsArticle
  }, {
    '@context': 'https://schema.org',
    '@type': 'LiveBlogPosting',
    datePublished: '2026-09-08T11:00:00Z',
    dateModified: '2026-09-08T21:00:00Z',
    liveBlogUpdate: updates,
    ...liveBlog
  }];
  return '<!doctype html><html><head>'
    + nodes.map(node => `<script type="application/ld+json">${JSON.stringify(node)}</script>`).join('')
    + '</head><body></body></html>';
}

function blogUpdate(overrides = {}) {
  return {
    '@type': 'BlogPosting',
    datePublished: '2026-09-08T20:00:00Z',
    dateModified: '2026-09-08T20:15:00Z',
    articleBody: 'Stocks closed higher after a volatile session.',
    ...overrides
  };
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

function assertSizeFailure(sizeFailureType) {
  return error => error instanceof CnbcArticleContentAcquisitionError
    && error.code === 'CONTENT_TOO_LARGE'
    && error.sizeFailureType === sizeFailureType;
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

test('falls back to the first provider-ordered usable LiveBlogPosting update without concatenation', async () => {
  const html = liveBlogHtml({updates: [
    blogUpdate({articleBody: '   '}),
    blogUpdate({
      articleBody: 'Closing <b>summary</b> for the completed session.',
      datePublished: '2026-09-08T20:01:00Z',
      dateModified: '2026-09-08T20:02:00Z'
    }),
    blogUpdate({articleBody: 'Later unrelated update must not be included.'})
  ]});
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});

  assert.equal(result.articleText, 'Closing summary for the completed session.');
  assert.equal(result.publishedAt, '2026-09-08T20:01:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T20:02:00.000Z');
  assert.doesNotMatch(result.articleText, /Later unrelated/);
});

test('falls back when a conventional article body normalizes to unusable content', async () => {
  const html = liveBlogHtml({
    newsArticle: {articleBody: ' \n <b> </b> &nbsp; '},
    updates: [blogUpdate({articleBody: 'Usable closing update.'})]
  });
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});

  assert.equal(result.articleText, 'Usable closing update.');
});

test('keeps usable conventional article precedence over a live-blog update', async () => {
  const html = liveBlogHtml({
    newsArticle: {
      articleBody: 'Conventional article body.',
      datePublished: '2026-09-08T12:01:00Z',
      dateModified: '2026-09-08T12:02:00Z'
    },
    updates: [blogUpdate({
      articleBody: 'Live-blog body must remain fallback-only.',
      datePublished: '2026-09-08T20:01:00Z',
      dateModified: '2026-09-08T20:02:00Z'
    })]
  });
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});

  assert.equal(result.articleText, 'Conventional article body.');
  assert.equal(result.publishedAt, '2026-09-08T12:01:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T12:02:00.000Z');
});

test('does not accept BlogPosting objects outside LiveBlogPosting.liveBlogUpdate', async () => {
  const html = liveBlogHtml({
    liveBlog: {liveBlogUpdate: []},
    updates: []
  }).replace('</head>', `<script type="application/ld+json">${JSON.stringify(blogUpdate())}</script></head>`);
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
  await assert.rejects(
    service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
    assertCode('EXTRACTION_FAILURE')
  );
});

test('treats LiveBlogPosting only as a container and ignores its root articleBody', async () => {
  const liveBlog = {
    '@context': 'https://schema.org',
    '@type': 'LiveBlogPosting',
    datePublished: '2026-09-08T11:00:00Z',
    dateModified: '2026-09-08T21:00:00Z',
    articleBody: 'Root live-blog content must not be extracted.',
    liveBlogUpdate: [blogUpdate({articleBody: ' <b> </b> &nbsp; '})]
  };
  const html = `<html><script type="application/ld+json">${JSON.stringify(liveBlog)}</script></html>`;
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
  await assert.rejects(
    service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
    assertCode('EXTRACTION_FAILURE')
  );
});

test('does not admit nested conventional articles through a live-blog update subtree', async () => {
  const liveBlog = {
    '@context': 'https://schema.org',
    '@type': 'LiveBlogPosting',
    datePublished: '2026-09-08T11:00:00Z',
    dateModified: '2026-09-08T21:00:00Z',
    liveBlogUpdate: [{
      '@type': 'Thing',
      nested: {
        '@type': 'NewsArticle',
        datePublished: '2026-09-08T20:00:00Z',
        articleBody: 'Nested conventional content must be ignored.'
      }
    }]
  };
  const html = `<html><script type="application/ld+json">${JSON.stringify(liveBlog)}</script></html>`;
  const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
  await assert.rejects(
    service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
    assertCode('EXTRACTION_FAILURE')
  );
});

test('fails closed for unusable live-blog updates and malformed selected timestamps', async () => {
  const cases = [
    liveBlogHtml({updates: [blogUpdate({articleBody: ''}), {'@type': 'BlogPosting'}]}),
    liveBlogHtml({updates: [blogUpdate({datePublished: 'not-a-date'}), blogUpdate()]}),
    liveBlogHtml({updates: [blogUpdate({dateModified: 'not-a-date'}), blogUpdate()]})
  ];
  for (const html of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
      assertCode('EXTRACTION_FAILURE')
    );
  }
});

test('preserves conventional Article, NewsArticle and ReportageNewsArticle body extraction', async () => {
  for (const type of ['Article', 'NewsArticle', 'ReportageNewsArticle']) {
    const html = articleHtml({'@type': type, articleBody: `${type} body remains authoritative.`});
    const result = await createCnbcArticleContentAcquisitionService({
      fetchImpl: async () => response(html)
    }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
    assert.equal(result.articleText, `${type} body remains authoritative.`);
  }
});

test('production response ceiling accepts the measured live page size and rejects bytes above it', async () => {
  const bounds = CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.articleRetrievalBounds;
  const representativeBytes = 1143462;
  const base = articleHtml({articleBody: 'Bounded article body.'});
  const representative = base.padEnd(representativeBytes, ' ');
  const accepted = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(representative)
  });
  const result = await accepted.acquireArticleContent({candidate: candidate(), bounds});
  assert.equal(result.articleText, 'Bounded article body.');

  const oversized = base.padEnd(bounds.maxResponseBytes + 1, ' ');
  const rejected = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(oversized)
  });
  await assert.rejects(
    rejected.acquireArticleContent({candidate: candidate(), bounds}),
    assertSizeFailure('RESPONSE_TOO_LARGE')
  );
  assert.equal(bounds.maxArticleTextBytes, 8192);
  assert.equal(bounds.maxResultBytes, 12288);
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
  await assert.rejects(
    declared.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
    assertSizeFailure('RESPONSE_TOO_LARGE')
  );

  const oversized = articleHtml({articleBody: 'x'}).padEnd(10001, ' ');
  const actual = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(oversized)});
  await assert.rejects(
    actual.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
    assertSizeFailure('RESPONSE_TOO_LARGE')
  );
});

test('rejects oversized title, extracted text and total result atomically', async () => {
  const cases = [
    [{...retrievalBounds, maxTitleBytes: 5}, articleHtml(), 'TITLE_TOO_LARGE'],
    [{...retrievalBounds, maxArticleTextBytes: 5}, articleHtml(), 'ARTICLE_TEXT_TOO_LARGE'],
    [{...retrievalBounds, maxResultBytes: 10}, articleHtml(), 'RESULT_TOO_LARGE']
  ];
  for (const [bounds, html, sizeFailureType] of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds}),
      assertSizeFailure(sizeFailureType)
    );
  }
});

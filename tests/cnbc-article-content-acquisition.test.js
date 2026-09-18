const test = require('node:test');
const assert = require('node:assert/strict');

const {createNewsEvidenceCandidate} = require('../lib/news-evidence-candidates');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CNBC_DISCOVERED_ARTICLE_RESULT_KEYS,
  CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES,
  CNBC_RECAP_ARTICLE_CONTENT_RESULT_KEYS,
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

function discovery(overrides = {}) {
  return Object.freeze({
    rank: 2,
    title: 'Search title is discovery metadata only',
    url,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate: '2026-09-08',
    ...overrides
  });
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

function stateArticleHtml({
  header = {}, body = {}, headerModule = {}, bodyModule = {}, extraModules = [],
  statePrefix = '', stateSuffix = ''
} = {}) {
  const headerData = {
    id: 108364684,
    brand: 'cnbc',
    type: 'cnbcnewsstory',
    url,
    headline: 'Provider state headline',
    datePublished: '2026-09-08T12:00:00+0000',
    dateModified: '2026-09-08T13:30:00+0000',
    contentClassification: ['registeredOnly'],
    __typename: 'articleHeader',
    ...header
  };
  const bodyData = {
    id: 108364684,
    brand: 'cnbc',
    type: 'cnbcnewsstory',
    articleBodyText: 'Provider state <b>article</b> body.',
    contentClassification: ['registeredOnly'],
    __typename: 'articleBody',
    ...body
  };
  const state = {
    page: {page: {layout: [{columns: [{modules: [{
      name: 'articleHeader', source: '108364684', data: headerData, ...headerModule
    }]}]}, {columns: [{modules: [{
      name: 'articleBody', source: '108364684', data: bodyData, ...bodyModule
    }, ...extraModules]}]}]}}
  };
  const newsArticle = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: 'Bodyless JSON-LD headline',
    datePublished: '2026-09-08T12:00:00Z'
  };
  return '<!doctype html><html><head>'
    + `<script type="application/ld+json">${JSON.stringify(newsArticle)}</script>`
    + `<script>${statePrefix}window.__s_data=${JSON.stringify(state)}; window.__c_data={};${stateSuffix}</script>`
    + '</head><body></body></html>';
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

function assertExtractionFailure(extractionFailureType) {
  return error => error instanceof CnbcArticleContentAcquisitionError
    && error.code === 'EXTRACTION_FAILURE'
    && error.extractionFailureType === extractionFailureType;
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

test('acquires a discovered CNBC recap from the first usable direct live-blog update', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html';
  const discovery = Object.freeze({
    title: 'Stock market news for Sept. 11, 2026',
    url: recapUrl,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate: '2026-09-11'
  });
  const html = liveBlogHtml({
    newsArticle: {datePublished: '2026-09-10T22:00:00Z'},
    liveBlog: {datePublished: '2026-09-10T22:00:00Z', dateModified: '2026-09-11T21:00:00Z'},
    updates: [
      blogUpdate({articleBody: '   '}),
      blogUpdate({
        datePublished: '2026-09-11T20:15:23Z',
        dateModified: '2026-09-11T20:20:00Z',
        articleBody: 'Stocks closed higher after the session.'
      }),
      blogUpdate({articleBody: 'This later update must not be concatenated.'})
    ]
  });
  const calls = [];
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(html, {url: recapUrl});
    }
  }).acquireRecapArticleContent({discovery, bounds: retrievalBounds});

  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(result), CNBC_RECAP_ARTICLE_CONTENT_RESULT_KEYS);
  assert.equal(result.canonicalUrl, recapUrl);
  assert.equal(result.targetSessionDate, '2026-09-11');
  assert.equal(result.publishedAt, '2026-09-11T20:15:23.000Z');
  assert.equal(result.updatedAt, '2026-09-11T20:20:00.000Z');
  assert.equal(result.selectedArticleType, 'BlogPosting');
  assert.equal(result.articleText, 'Stocks closed higher after the session.');
  assert.equal(result.articleText.includes('later update'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.provenance), true);
});

test('acquires one general discovered page with provider-owned headline and timestamps', async () => {
  const discovered = discovery();
  const calls = [];
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async (...args) => { calls.push(args); return response(); }
  }).acquireDiscoveredArticleContent({discovery: discovered, bounds: retrievalBounds});
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(result), CNBC_DISCOVERED_ARTICLE_RESULT_KEYS);
  assert.equal(result.discoveryRank, 2);
  assert.equal(result.title, 'Provider headline is not authoritative here');
  assert.equal(result.publishedAt, '2026-09-08T12:00:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T13:30:00.000Z');
  assert.equal(result.articleText, 'Markets moved after new data. Investors reassessed risk.');
  assert.equal(result.targetSessionDate, '2026-09-08');
  assert.equal(Object.isFrozen(result), true);
});

test('extracts verified CNBC window.__s_data article modules with matched provider identity', async () => {
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(stateArticleHtml())
  }).acquireDiscoveredArticleContent({discovery: discovery(), bounds: retrievalBounds});

  assert.equal(result.title, 'Provider state headline');
  assert.equal(result.articleText, 'Provider state article body.');
  assert.equal(result.publishedAt, '2026-09-08T12:00:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T13:30:00.000Z');
  assert.equal(result.selectedArticleType, 'NewsArticle');
});

test('keeps conventional JSON-LD and direct live-blog extraction ahead of CNBC state fallback', async () => {
  const conventional = stateArticleHtml().replace(
    '"datePublished":"2026-09-08T12:00:00Z"',
    '"datePublished":"2026-09-08T12:00:00Z","articleBody":"Conventional JSON-LD wins."'
  );
  const conventionalResult = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(conventional)
  }).acquireDiscoveredArticleContent({discovery: discovery(), bounds: retrievalBounds});
  assert.equal(conventionalResult.articleText, 'Conventional JSON-LD wins.');
  assert.equal(conventionalResult.title, 'Bodyless JSON-LD headline');

  const liveBlog = liveBlogHtml({
    newsArticle: {headline: 'Live-blog provider headline'},
    updates: [blogUpdate({articleBody: 'Direct live-blog update wins.'})]
  })
    .replace('</head>', stateArticleHtml().match(/<script>window\.__s_data=[\s\S]*?<\/script>/)[0] + '</head>');
  const liveBlogResult = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(liveBlog)
  }).acquireDiscoveredArticleContent({discovery: discovery(), bounds: retrievalBounds});
  assert.equal(liveBlogResult.articleText, 'Direct live-blog update wins.');
});

test('rejects malformed, ambiguous or unmatched CNBC state modules', async () => {
  const duplicateBody = {
    name: 'articleBody', source: '108364684',
    data: {
      id: 108364684, brand: 'cnbc', type: 'cnbcnewsstory',
      articleBodyText: 'Ambiguous second body.', __typename: 'articleBody'
    }
  };
  const cases = [
    stateArticleHtml({bodyModule: {source: '108364999'}}),
    stateArticleHtml({body: {id: 108364999}}),
    stateArticleHtml({header: {brand: 'other'}}),
    stateArticleHtml({body: {type: 'other'}}),
    stateArticleHtml({extraModules: [duplicateBody]}),
    stateArticleHtml().replace('window.__s_data={', 'window.__s_data={malformed')
  ];
  for (const html of cases) {
    await assert.rejects(
      createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)})
        .acquireDiscoveredArticleContent({discovery: discovery(), bounds: retrievalBounds}),
      assertExtractionFailure('NO_USABLE_BODY')
    );
  }
});

test('rejects unusable state text, headline, URL and header timestamps', async () => {
  const cases = [
    [stateArticleHtml({body: {articleBodyText: ' <b> </b> &nbsp; '}}), 'NO_USABLE_BODY'],
    [stateArticleHtml({body: {articleBodyText: {text: 'not accepted'}}}), 'NO_USABLE_BODY'],
    [stateArticleHtml({header: {headline: '   '}}), 'NO_USABLE_BODY'],
    [stateArticleHtml({header: {url: 'https://www.cnbc.com/2026/09/08/other.html'}}), 'NO_USABLE_BODY'],
    [stateArticleHtml({header: {datePublished: undefined}}), 'INVALID_DATE_PUBLISHED'],
    [stateArticleHtml({header: {datePublished: 'not-a-date'}}), 'INVALID_DATE_PUBLISHED'],
    [stateArticleHtml({header: {dateModified: 'not-a-date'}}), 'INVALID_DATE_MODIFIED']
  ];
  for (const [html, failureType] of cases) {
    await assert.rejects(
      createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)})
        .acquireDiscoveredArticleContent({discovery: discovery(), bounds: retrievalBounds}),
      assertExtractionFailure(failureType)
    );
  }
});

test('applies existing title, article-text and result bounds to CNBC state extraction', async () => {
  const cases = [
    [{...retrievalBounds, maxTitleBytes: 5}, stateArticleHtml(), 'TITLE_TOO_LARGE'],
    [{...retrievalBounds, maxArticleTextBytes: 5}, stateArticleHtml(), 'ARTICLE_TEXT_TOO_LARGE'],
    [{...retrievalBounds, maxResultBytes: 10}, stateArticleHtml(), 'RESULT_TOO_LARGE']
  ];
  for (const [bounds, html, failureType] of cases) {
    await assert.rejects(
      createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)})
        .acquireDiscoveredArticleContent({discovery: discovery(), bounds}),
      assertSizeFailure(failureType)
    );
  }
});

test('emits bounded structural diagnostics for every NO_USABLE_BODY shape without content leakage', async () => {
  const diagnosticKeys = [
    'stage', 'operation', 'discoveryRank', 'failureType', 'recognizedRootTypes',
    'hasArticleBodyString', 'hasLiveBlogUpdateArray', 'directBlogPostingCount',
    'directBlogPostingWithArticleBodyCount', 'directBlogPostingWithTextCount',
    'rootLiveBlogHasArticleBody', 'selectedNodeHasHeadline', 'selectedNodeHasText',
    'selectedNodeHasDescription'
  ];
  const discovery = Object.freeze({
    rank: 2,
    title: 'Search title must not be logged',
    url,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate: '2026-09-08'
  });

  for (const html of [
    articleHtml(),
    liveBlogHtml({updates: [blogUpdate()]})
  ]) {
    const diagnostics = [];
    const service = createCnbcArticleContentAcquisitionService({
      fetchImpl: async () => response(html),
      onDiagnostics: value => diagnostics.push(value)
    });
    await service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
    assert.deepEqual(diagnostics, []);
  }

  const cases = [
    {
      html: liveBlogHtml({updates: [blogUpdate({articleBody: undefined, text: 'private text'})]}),
      expected: {
        recognizedRootTypes: ['NewsArticle', 'LiveBlogPosting'],
        hasArticleBodyString: false,
        hasLiveBlogUpdateArray: true,
        directBlogPostingCount: 1,
        directBlogPostingWithArticleBodyCount: 0,
        directBlogPostingWithTextCount: 1,
        rootLiveBlogHasArticleBody: false,
        selectedNodeHasHeadline: false,
        selectedNodeHasText: false,
        selectedNodeHasDescription: false
      }
    },
    {
      html: liveBlogHtml({updates: [{
        '@type': 'Thing', nested: blogUpdate({articleBody: 'private nested body'})
      }]}),
      expected: {
        recognizedRootTypes: ['NewsArticle', 'LiveBlogPosting'],
        hasArticleBodyString: false,
        hasLiveBlogUpdateArray: true,
        directBlogPostingCount: 0,
        directBlogPostingWithArticleBodyCount: 0,
        directBlogPostingWithTextCount: 0,
        rootLiveBlogHasArticleBody: false,
        selectedNodeHasHeadline: false,
        selectedNodeHasText: false,
        selectedNodeHasDescription: false
      }
    },
    {
      html: liveBlogHtml({liveBlog: {articleBody: 'private root body'}, updates: []}),
      expected: {
        recognizedRootTypes: ['NewsArticle', 'LiveBlogPosting'],
        hasArticleBodyString: false,
        hasLiveBlogUpdateArray: true,
        directBlogPostingCount: 0,
        directBlogPostingWithArticleBodyCount: 0,
        directBlogPostingWithTextCount: 0,
        rootLiveBlogHasArticleBody: true,
        selectedNodeHasHeadline: false,
        selectedNodeHasText: false,
        selectedNodeHasDescription: false
      }
    }
  ];

  const allFailureDiagnostics = [];
  for (const {html, expected} of cases) {
    const diagnostics = [];
    const service = createCnbcArticleContentAcquisitionService({
      fetchImpl: async () => response(html),
      onDiagnostics: value => diagnostics.push(value)
    });
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
      assertExtractionFailure('NO_USABLE_BODY')
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(Object.keys(diagnostics[0]), diagnosticKeys);
    assert.deepEqual(diagnostics[0], {
      stage: 'cnbcArticleExtraction',
      operation: 'SELECTED_ARTICLE',
      discoveryRank: null,
      failureType: 'NO_USABLE_BODY',
      ...expected
    });
    assert.equal(Object.isFrozen(diagnostics[0]), true);
    allFailureDiagnostics.push(diagnostics[0]);
  }

  const missingHeadlineDiagnostics = [];
  const missingHeadlineHtml = articleHtml({
    headline: undefined,
    name: undefined,
    text: 'private text field',
    description: 'private description field'
  });
  const missingHeadlineService = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(missingHeadlineHtml),
    onDiagnostics: value => missingHeadlineDiagnostics.push(value)
  });
  await assert.rejects(
    missingHeadlineService.acquireDiscoveredArticleContent({discovery, bounds: retrievalBounds}),
    assertExtractionFailure('NO_USABLE_BODY')
  );
  assert.deepEqual(Object.keys(missingHeadlineDiagnostics[0]), diagnosticKeys);
  assert.deepEqual(missingHeadlineDiagnostics[0], {
    stage: 'cnbcArticleExtraction',
    operation: 'DISCOVERED_ARTICLE',
    discoveryRank: 2,
    failureType: 'NO_USABLE_BODY',
    recognizedRootTypes: ['NewsArticle'],
    hasArticleBodyString: true,
    hasLiveBlogUpdateArray: false,
    directBlogPostingCount: 0,
    directBlogPostingWithArticleBodyCount: 0,
    directBlogPostingWithTextCount: 0,
    rootLiveBlogHasArticleBody: false,
    selectedNodeHasHeadline: false,
    selectedNodeHasText: true,
    selectedNodeHasDescription: true
  });
  allFailureDiagnostics.push(missingHeadlineDiagnostics[0]);

  const serialized = JSON.stringify(allFailureDiagnostics);
  for (const forbidden of [
    'private text', 'private nested body', 'private root body', 'private description',
    'Markets moved', 'Stocks closed', 'Search title', '<html', 'https://', 'articleBody'
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(serialized.includes('provider payload'), false);
});

test('accepts the expanded bounded global discovery rank and rejects ranks beyond it before fetch', async () => {
  let calls = 0;
  const service = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => { calls++; return response(); }
  });
  const base = {
    title: 'Bounded later-ranked result',
    url,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate: '2026-09-08'
  };
  const result = await service.acquireDiscoveredArticleContent({
    discovery: Object.freeze({rank: 20, ...base}), bounds: retrievalBounds
  });
  assert.equal(result.discoveryRank, 20);
  await assert.rejects(service.acquireDiscoveredArticleContent({
    discovery: Object.freeze({rank: 21, ...base}), bounds: retrievalBounds
  }), assertCode('INVALID_INPUT'));
  assert.equal(calls, 1);
});

test('validates recap session identity from selected publishedAt only', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html';
  const discovery = Object.freeze({
    title: 'Stock market news for Sept. 11, 2026', url: recapUrl,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate: '2026-09-11'
  });
  const html = liveBlogHtml({updates: [blogUpdate({
    datePublished: '2026-09-10T20:15:23Z',
    dateModified: '2026-09-11T20:20:00Z'
  })]});
  const service = createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html, {url: recapUrl})
  });
  await assert.rejects(
    service.acquireRecapArticleContent({discovery, bounds: retrievalBounds}),
    assertCode('SESSION_MISMATCH')
  );
});

test('keeps the conventional candidate-based acquisition contract unchanged', async () => {
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response()
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
  assert.deepEqual(Object.keys(result), CNBC_ARTICLE_CONTENT_RESULT_KEYS);
  assert.equal('targetSessionDate' in result, false);
  assert.equal('selectedArticleType' in result, false);
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
  assert.deepEqual(CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES, [
    'NO_USABLE_BODY', 'INVALID_DATE_PUBLISHED', 'INVALID_DATE_MODIFIED'
  ]);
  const cases = [
    ['<html><body>Not an article</body></html>', 'INVALID_PAGE'],
    ['<script type="application/ld+json">not-json</script>', 'INVALID_PAGE'],
    [articleHtml({'@type': 'WebPage'}), 'INVALID_PAGE'],
    [articleHtml({articleBody: ''}), 'EXTRACTION_FAILURE', 'NO_USABLE_BODY'],
    [articleHtml({datePublished: undefined}), 'EXTRACTION_FAILURE', 'INVALID_DATE_PUBLISHED'],
    [articleHtml({datePublished: 'not-a-date'}), 'EXTRACTION_FAILURE', 'INVALID_DATE_PUBLISHED'],
    [articleHtml({datePublished: '2026-09-08T12:00:00'}), 'EXTRACTION_FAILURE', 'INVALID_DATE_PUBLISHED'],
    [articleHtml({dateModified: 'not-a-date'}), 'EXTRACTION_FAILURE', 'INVALID_DATE_MODIFIED']
  ];
  for (const [html, code, extractionFailureType] of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
      extractionFailureType ? assertExtractionFailure(extractionFailureType) : assertCode(code)
    );
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

test('accepts explicit basic and extended timezone offsets while rejecting ambiguous or malformed forms', async () => {
  for (const [timestamp, expected] of [
    ['2026-09-08T12:00:00+0000', '2026-09-08T12:00:00.000Z'],
    ['2026-09-08T12:00:00-0400', '2026-09-08T16:00:00.000Z'],
    ['2026-09-08T18:00:00+0530', '2026-09-08T12:30:00.000Z'],
    ['2026-09-08T12:00:00+00:00', '2026-09-08T12:00:00.000Z'],
    ['2026-09-08T12:00:00-04:00', '2026-09-08T16:00:00.000Z'],
    ['2026-09-08T12:00:00Z', '2026-09-08T12:00:00.000Z']
  ]) {
    const result = await createCnbcArticleContentAcquisitionService({
      fetchImpl: async () => response(articleHtml({datePublished: timestamp, dateModified: null}))
    }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});
    assert.equal(result.publishedAt, expected);
  }

  for (const timestamp of [
    '2026-09-08T12:00:00',
    '2026-09-08T12:00:00+000',
    '2026-09-08T12:00:00+00000',
    '2026-09-08T12:00:00+2400',
    '2026-09-08T12:00:00+0060'
  ]) {
    const service = createCnbcArticleContentAcquisitionService({
      fetchImpl: async () => response(articleHtml({datePublished: timestamp, dateModified: null}))
    });
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
      assertExtractionFailure('INVALID_DATE_PUBLISHED')
    );
  }
});

test('extracts a CNBC-style recap update with basic UTC offsets', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/10/stock-market-today-live-updates.html';
  const discovery = Object.freeze({
    title: 'Stock market news for Sept. 11, 2026', url: recapUrl,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate: '2026-09-11'
  });
  const html = liveBlogHtml({
    liveBlog: {
      datePublished: '2026-09-10T22:03:32+0000',
      dateModified: '2026-09-11T20:35:11+0000'
    },
    updates: [blogUpdate({
      articleBody: 'Stocks snap four days of losses on Friday.',
      datePublished: '2026-09-11T20:15:23+0000',
      dateModified: '2026-09-11T20:15:23+0000'
    })]
  });
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html, {url: recapUrl})
  }).acquireRecapArticleContent({discovery, bounds: retrievalBounds});

  assert.equal(result.selectedArticleType, 'BlogPosting');
  assert.equal(result.publishedAt, '2026-09-11T20:15:23.000Z');
  assert.equal(result.updatedAt, '2026-09-11T20:15:23.000Z');
  assert.equal(result.articleText, 'Stocks snap four days of losses on Friday.');
});

test('selects the first fully extractable conventional article', async () => {
  const nodes = [{
    '@type': 'NewsArticle',
    articleBody: 'Earlier body with an invalid timestamp.',
    datePublished: 'not-a-date'
  }, {
    '@type': 'ReportageNewsArticle',
    articleBody: 'Later fully extractable conventional body.',
    datePublished: '2026-09-08T12:01:00Z',
    dateModified: '2026-09-08T12:02:00Z'
  }];
  const html = `<html><script type="application/ld+json">${JSON.stringify(nodes)}</script></html>`;
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});

  assert.equal(result.articleText, 'Later fully extractable conventional body.');
  assert.equal(result.publishedAt, '2026-09-08T12:01:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T12:02:00.000Z');
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

test('selects the first fully extractable direct live-blog update', async () => {
  const html = liveBlogHtml({updates: [
    blogUpdate({
      articleBody: 'Earlier body with a missing timestamp.',
      datePublished: undefined
    }),
    blogUpdate({
      articleBody: 'Later fully extractable live-blog body.',
      datePublished: '2026-09-08T20:01:00Z',
      dateModified: '2026-09-08T20:02:00Z'
    }),
    blogUpdate({articleBody: 'Still later content must not be selected.'})
  ]});
  const result = await createCnbcArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({candidate: candidate(), bounds: retrievalBounds});

  assert.equal(result.articleText, 'Later fully extractable live-blog body.');
  assert.equal(result.publishedAt, '2026-09-08T20:01:00.000Z');
  assert.equal(result.updatedAt, '2026-09-08T20:02:00.000Z');
  assert.doesNotMatch(result.articleText, /Still later/);
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
    [liveBlogHtml({updates: [blogUpdate({articleBody: ''}), {'@type': 'BlogPosting'}]}), 'NO_USABLE_BODY'],
    [liveBlogHtml({updates: [blogUpdate({datePublished: 'not-a-date'})]}), 'INVALID_DATE_PUBLISHED'],
    [liveBlogHtml({updates: [blogUpdate({dateModified: 'not-a-date'})]}), 'INVALID_DATE_MODIFIED']
  ];
  for (const [html, extractionFailureType] of cases) {
    const service = createCnbcArticleContentAcquisitionService({fetchImpl: async () => response(html)});
    await assert.rejects(
      service.acquireArticleContent({candidate: candidate(), bounds: retrievalBounds}),
      assertExtractionFailure(extractionFailureType)
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

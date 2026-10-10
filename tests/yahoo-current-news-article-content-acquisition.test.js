const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createYahooCurrentNewsArticleContentAcquisitionService
} = require('../lib/yahoo-current-news-article-content-acquisition');

const candidateUrl = 'https://finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html';
const canonicalUrl = 'https://finance.yahoo.com/markets/articles/nvidia-rallies-on-demand-120000123.html';
const liveCanonicalUrl = 'https://finance.yahoo.com/markets/stocks/articles/nvidia-rallies-on-demand-120000123.html';
const headline = 'Nvidia rallies on demand';

function metadata(overrides = {}) {
  return {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline,
    url: canonicalUrl, mainEntityOfPage: {'@id': canonicalUrl},
    publisher: {name: 'Yahoo Finance'}, datePublished: '2026-09-20T12:00:00Z',
    dateModified: '2026-09-20T12:10:00Z', ...overrides
  };
}

function page({article = metadata(), body = '<p>Markets moved as chip demand strengthened.</p>', extra = ''} = {}) {
  return `<!doctype html><html><head><link rel="canonical" href="${canonicalUrl}"><script type="application/ld+json">${JSON.stringify(article)}</script></head><body><div data-testid="article-content-wrapper"><div data-testid="article-body">${body}</div>${extra}</div></body></html>`;
}

function response(html, {url = candidateUrl, status = 200, contentLength = null} = {}) {
  return {
    ok: status >= 200 && status < 300, status, url,
    headers: {get: name => name.toLowerCase() === 'content-length' ? contentLength : 'text/html; charset=utf-8'},
    text: async () => html
  };
}

test('extracts JSON-LD metadata and verified rendered Yahoo article body', async () => {
  const service = createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page())
  });
  const result = await service.acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.deepEqual(result.articleContent, {
    sourceId: 'us.yahoo-finance', canonicalUrl, headline,
    publisher: 'Yahoo Finance', publishedAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:10:00.000Z',
    articleText: 'Markets moved as chip demand strengthened.'
  });
});

test('prefers JSON-LD articleBody over rendered content', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: metadata({articleBody: 'Structured provider body.'})}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.articleContent.articleText, 'Structured provider body.');
});

test('removes embedded ad, read-more and navigation nodes from rendered article body', async () => {
  const body = '<p>First material paragraph.</p><div data-testid="inarticle-ad"><p>Buy this advertised product.</p></div><div data-testid="read-more"><p>Unrelated read more.</p></div><nav><p>Navigation copy.</p></nav><p>Second material paragraph.</p>';
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({body}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.articleContent.articleText, 'First material paragraph. Second material paragraph.');
});

test('normalizes Singapore candidate URLs and canonical article URLs by stable identity', async () => {
  let requested;
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({fetchImpl: async url => {
    requested = url;
    return response(page());
  }}).acquireArticleContent({
    url: 'https://sg.finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html?x=1',
    headline
  });
  assert.equal(requested, candidateUrl);
  assert.equal(result.articleContent.canonicalUrl, canonicalUrl);
});

test('extracts the current Yahoo nested-category canonical article structure', async () => {
  const liveArticle = metadata({
    url: undefined,
    mainEntityOfPage: {'@id': liveCanonicalUrl}
  });
  const html = page({article: liveArticle}).replace(
    `<link rel="canonical" href="${canonicalUrl}">`,
    `<link href="${liveCanonicalUrl}" rel="canonical">`
  );
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.canonicalUrl, liveCanonicalUrl);
  assert.equal(result.articleContent.articleText, 'Markets moved as chip demand strengthened.');
});

test('accepts harmless headline variation only after strong Yahoo article identity is established', async () => {
  const requestedHeadline = 'Nvidia rallies on demand as AI spending rises';
  const actualHeadline = 'Nvidia rallies on demand as AI spending rises today';
  const strong = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: metadata({headline: actualHeadline})}))
  }).acquireArticleContent({url: candidateUrl, headline: requestedHeadline});
  assert.equal(strong.ok, true);
  assert.equal(strong.articleContent.headline, actualHeadline);

  const withoutCanonical = page({article: metadata({headline: actualHeadline})})
    .replace(`<link rel="canonical" href="${canonicalUrl}">`, '');
  const weak = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(withoutCanonical)
  }).acquireArticleContent({url: candidateUrl, headline: requestedHeadline});
  assert.equal(weak.type, 'NO_USABLE_ARTICLE');
  assert.equal(weak.extractionFailureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');
});

test('rejects a true headline conflict despite matching Yahoo URL identity', async () => {
  const conflict = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page())
  }).acquireArticleContent({
    url: candidateUrl,
    headline: 'Federal Reserve cuts rates after inflation report'
  });
  assert.equal(conflict.type, 'NO_USABLE_ARTICLE');
  assert.equal(conflict.extractionFailureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');
});

test('rejects non-Yahoo URLs, identity mismatches and unusable articles', async () => {
  const service = createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({body: ''}))
  });
  assert.equal((await service.acquireArticleContent({url: 'https://example.com/news/a.html'})).type, 'INVALID_INPUT');
  assert.equal((await service.acquireArticleContent({url: candidateUrl, headline})).type, 'NO_USABLE_ARTICLE');
  const mismatch = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page(), {url: 'https://finance.yahoo.com/news/other-120000999.html'})
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(mismatch.type, 'IDENTITY_MISMATCH');
  assert.equal(mismatch.extractionFailureType, 'CANONICAL_OR_REDIRECT_MISMATCH');
});

test('subtypes sanitized current-news extraction rejections without changing failure behavior', async () => {
  const noMetadata = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: {'@type': 'WebPage'}}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(noMetadata.type, 'NO_USABLE_ARTICLE');
  assert.equal(noMetadata.extractionFailureType, 'NO_COMPATIBLE_ARTICLE_METADATA');

  const wrongIdentity = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: metadata({
      url: 'https://finance.yahoo.com/news/other-story-120000999.html', mainEntityOfPage: undefined
    })}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(wrongIdentity.type, 'NO_USABLE_ARTICLE');
  assert.equal(wrongIdentity.extractionFailureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');

  const wrongHeadline = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page())
  }).acquireArticleContent({url: candidateUrl, headline: 'Different supplied headline'});
  assert.equal(wrongHeadline.type, 'NO_USABLE_ARTICLE');
  assert.equal(wrongHeadline.extractionFailureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');

  const noBody = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({body: ''}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(noBody.type, 'NO_USABLE_ARTICLE');
  assert.equal(noBody.extractionFailureType, 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT');
});

test('enforces raw response, extracted article and normalized result bounds', async () => {
  const raw = await createYahooCurrentNewsArticleContentAcquisitionService({
    maxResponseBytes: 10,
    fetchImpl: async () => response(page(), {contentLength: '11'})
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(raw.type, 'RESPONSE_TOO_LARGE');

  // Step 9F.1f: a longer article is kept with its first maxArticleTextBytes.
  const text = await createYahooCurrentNewsArticleContentAcquisitionService({
    maxArticleTextBytes: 10,
    fetchImpl: async () => response(page({body: '<p>This body is longer than ten bytes.</p>'}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(text.type, 'SUCCESS');
  assert.equal(text.articleContent.articleText, 'This body');

  const normalized = await createYahooCurrentNewsArticleContentAcquisitionService({
    maxResultBytes: 20,
    fetchImpl: async () => response(page())
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(normalized.type, 'RESULT_TOO_LARGE');
});

test('normalizes missing or malformed optional timestamps without weakening identity', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: metadata({datePublished: 'invalid', dateModified: undefined})}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.publishedAt, null);
  assert.equal(result.articleContent.updatedAt, null);
});

// ---- Step 8K.5: Yahoo-hosted partner articles and singular /article/ URLs ----
const partnerCanonical = 'https://www.qz.com/jim-cramer-meta-intel-oil-bond-yields-stocks-092926';

function partnerPage({article = {}, body = '<p>Partner text hosted on Yahoo.</p>', canonical = partnerCanonical} = {}) {
  return page({
    article: metadata({url: undefined, mainEntityOfPage: {'@type': 'WebPage', '@id': partnerCanonical}, ...article}),
    body
  }).replace(`<link rel="canonical" href="${canonicalUrl}">`, canonical ? `<link rel="canonical" href="${canonical}">` : '');
}

test('Step 8K.5 accepts a Yahoo-hosted partner article whose metadata and canonical point at the partner site', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(partnerPage())
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.deepEqual(result.articleContent, {
    sourceId: 'us.yahoo-finance', canonicalUrl: candidateUrl, headline,
    publisher: 'Yahoo Finance', publishedAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:10:00.000Z', articleText: 'Partner text hosted on Yahoo.'
  });
});

test('Step 8K.5 the partner article path needs no headline match and keeps the Yahoo URL as the evidence URL', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(partnerPage({article: {headline: 'A completely different partner headline'}}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.headline, 'A completely different partner headline');
  assert.equal(result.articleContent.canonicalUrl, candidateUrl);
  assert.equal(result.articleContent.canonicalUrl.includes('qz.com'), false);
});

test('Step 8K.5 the partner article path also works with no canonical link and with a JSON-LD article body', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(partnerPage({canonical: null, article: {articleBody: 'Structured partner body.'}}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.articleText, 'Structured partner body.');
});

test('Step 8K.5 the partner article path still requires a valid datePublished, a body and an article node', async () => {
  const run = html => createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(html)
  }).acquireArticleContent({url: candidateUrl, headline});
  const noDate = await run(partnerPage({article: {datePublished: undefined}}));
  assert.equal(noDate.type, 'NO_USABLE_ARTICLE');
  assert.equal(noDate.extractionFailureType, 'NO_COMPATIBLE_ARTICLE_METADATA');
  const badDate = await run(partnerPage({article: {datePublished: 'yesterday-ish'}}));
  assert.equal(badDate.extractionFailureType, 'NO_COMPATIBLE_ARTICLE_METADATA');
  const noBody = await run(partnerPage({body: ''}));
  assert.equal(noBody.extractionFailureType, 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT');
  const noHeadline = await run(partnerPage({article: {headline: ''}}));
  assert.equal(noHeadline.extractionFailureType, 'NO_COMPATIBLE_ARTICLE_METADATA');
  const noArticleNode = await run(page({article: {'@type': 'WebPage'}}));
  assert.equal(noArticleNode.extractionFailureType, 'NO_COMPATIBLE_ARTICLE_METADATA');
});

test('Step 8K.5 the partner article path never bypasses the fetched-page identity checks', async () => {
  const yahooCanonicalOfAnother = partnerPage({canonical: 'https://finance.yahoo.com/news/other-story-120000999.html'});
  const canonicalMismatch = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(yahooCanonicalOfAnother)
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(canonicalMismatch.extractionFailureType, 'CANONICAL_OR_REDIRECT_MISMATCH');
  const redirected = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(partnerPage(), {url: 'https://www.qz.com/elsewhere'})
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(redirected.type, 'IDENTITY_MISMATCH');
  const otherYahoo = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(partnerPage(), {url: 'https://finance.yahoo.com/news/other-120000999.html'})
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(otherYahoo.type, 'IDENTITY_MISMATCH');
});

test('Step 8K.5 a Yahoo article whose metadata names a different Yahoo article is still rejected', async () => {
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(page({article: metadata({
      url: 'https://finance.yahoo.com/news/other-story-120000999.html', mainEntityOfPage: undefined
    })}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(result.extractionFailureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');
});

test('Step 8K.5 accepts the singular /article/ path and still rejects /live/ and other paths', async () => {
  const singularUrl = 'https://finance.yahoo.com/markets/stocks/article/nvidia-rallies-on-demand-120000123.html';
  const html = page({article: metadata({url: undefined, mainEntityOfPage: {'@id': singularUrl}})})
    .replace(`<link rel="canonical" href="${canonicalUrl}">`, `<link rel="canonical" href="${singularUrl}">`);
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => response(html, {url: singularUrl})
  }).acquireArticleContent({url: singularUrl, headline});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.canonicalUrl, singularUrl);
  const service = createYahooCurrentNewsArticleContentAcquisitionService({fetchImpl: async () => response(html)});
  for (const url of [
    'https://finance.yahoo.com/markets/live/stock-market-today-120000123.html',
    'https://finance.yahoo.com/markets/stocks/video/clip-120000123.html',
    'https://finance.yahoo.com/a/b/c/d/article/too-deep-120000123.html'
  ]) {
    assert.equal((await service.acquireArticleContent({url, headline})).type, 'INVALID_INPUT', url);
  }
});

test('Step 9F.1d: an unsuccessful reply carries its status so 429/5xx can be told from 404', async () => {
  for (const status of [404, 429, 503]) {
    const service = createYahooCurrentNewsArticleContentAcquisitionService({
      fetchImpl: async () => response('', {status})
    });
    const result = await service.acquireArticleContent({url: candidateUrl, headline});
    assert.deepEqual([result.type, result.httpStatus], ['HTTP_FAILURE', status]);
  }
});

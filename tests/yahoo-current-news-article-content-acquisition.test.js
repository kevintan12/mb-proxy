const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createYahooCurrentNewsArticleContentAcquisitionService
} = require('../lib/yahoo-current-news-article-content-acquisition');

const candidateUrl = 'https://finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html';
const canonicalUrl = 'https://finance.yahoo.com/markets/articles/nvidia-rallies-on-demand-120000123.html';
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
});

test('enforces raw response, extracted article and normalized result bounds', async () => {
  const raw = await createYahooCurrentNewsArticleContentAcquisitionService({
    maxResponseBytes: 10,
    fetchImpl: async () => response(page(), {contentLength: '11'})
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(raw.type, 'RESPONSE_TOO_LARGE');

  const text = await createYahooCurrentNewsArticleContentAcquisitionService({
    maxArticleTextBytes: 10,
    fetchImpl: async () => response(page({body: '<p>This body is longer than ten bytes.</p>'}))
  }).acquireArticleContent({url: candidateUrl, headline});
  assert.equal(text.type, 'ARTICLE_TEXT_TOO_LARGE');

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

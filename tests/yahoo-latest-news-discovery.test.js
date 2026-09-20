const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YAHOO_LATEST_NEWS_URL,
  createYahooLatestNewsDiscoveryService
} = require('../lib/yahoo-latest-news-discovery');

function response(body, {status = 200, contentLength = null} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => name.toLowerCase() === 'content-length' ? contentLength : 'text/html; charset=utf-8'},
    text: async () => body
  };
}

function story({
  href = 'https://sg.finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html',
  headline = 'Nvidia rallies on demand', type = 'story', module = 'topic-stream',
  publisher = 'Reuters', uuid = '12345678-1234-1234-1234-123456789abc', extra = ''
} = {}) {
  const data = JSON.stringify({
    yContentType: type, yModuleName: module, ySubModuleName: 'fltrd-strs',
    yDestinationContentPartner: publisher, yDestinationContentUUID: uuid,
    yLinkText: headline
  }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<section class="story-item horizontal-story" data-testid="story"><a data-yga="${data}" href="${href}"><h3>${headline}</h3></a>${extra}</section>`;
}

test('extracts only genuine topic-stream story candidates and canonicalizes URLs', async () => {
  let requested;
  const html = `<html>${story()}${story({
    href: 'https://finance.yahoo.com/news/apple-update-130000456.html?guccounter=1',
    headline: 'Apple issues an update', publisher: 'Yahoo Finance',
    uuid: 'abcdef12-1234-1234-1234-123456789abc'
  })}</html>`;
  const result = await createYahooLatestNewsDiscoveryService({fetchImpl: async url => {
    requested = url;
    return response(html);
  }}).discoverLatestNews();
  assert.equal(requested, YAHOO_LATEST_NEWS_URL);
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(result.candidates[0], {
    headline: 'Nvidia rallies on demand',
    url: 'https://finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html',
    uuid: '12345678-1234-1234-1234-123456789abc', publisher: 'Reuters'
  });
  assert.equal(result.candidates[1].url, 'https://finance.yahoo.com/news/apple-update-130000456.html');
});

test('excludes ads, sponsored stories, videos, navigation, topic links and unrelated modules', async () => {
  const html = [
    story({headline: 'Sponsored opportunity', extra: '<span>Sponsored</span>'}),
    story({href: 'https://sg.finance.yahoo.com/video/market-update-123.html'}),
    story({href: 'https://sg.finance.yahoo.com/quote/NVDA/'}),
    story({href: 'https://sg.finance.yahoo.com/topic/stock-market-news/'}),
    story({module: 'navigation'}),
    '<nav><a href="https://sg.finance.yahoo.com/news/navigation-120000123.html">Navigation</a></nav>',
    '<div data-testid="ad-container">Advertisement</div>',
    story({headline: 'Valid current story'})
  ].join('');
  const result = await createYahooLatestNewsDiscoveryService({
    fetchImpl: async () => response(html)
  }).discoverLatestNews();
  assert.deepEqual(result.candidates.map(item => item.headline), ['Valid current story']);
});

test('deduplicates canonical URLs and ignores relative publication labels', async () => {
  const first = story({extra: '<span class="published-date">14 min ago</span>'});
  const second = story({headline: 'Duplicate title'});
  const result = await createYahooLatestNewsDiscoveryService({
    fetchImpl: async () => response(first + second)
  }).discoverLatestNews();
  assert.equal(result.candidates.length, 1);
  assert.equal(Object.hasOwn(result.candidates[0], 'publishedAt'), false);
});

test('fails safely for oversized or non-HTML responses', async () => {
  const oversized = await createYahooLatestNewsDiscoveryService({
    maxResponseBytes: 10,
    fetchImpl: async () => response(story(), {contentLength: '11'})
  }).discoverLatestNews();
  assert.equal(oversized.type, 'RESPONSE_TOO_LARGE');
  const invalid = await createYahooLatestNewsDiscoveryService({fetchImpl: async () => ({
    ok: true, status: 200, headers: {get: () => 'application/json'}, text: async () => '{}'
  })}).discoverLatestNews();
  assert.equal(invalid.type, 'INVALID_CONTENT_TYPE');
});

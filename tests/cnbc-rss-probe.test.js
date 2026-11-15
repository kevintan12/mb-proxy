// Step 9F.6b: the read-only CNBC RSS probe (lib/cnbc-rss-probe.js) and its
// GET ?cnbcRssProbe=1 branch in api/quote.js. Fixtures only, no network.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {handleCnbcRssProbe, probePageCount, pageTime} = require('../lib/cnbc-rss-probe');
const {CNBC_RSS_LIST_URL_PREFIX} = require('../lib/sources/cnbc-rss');

const ON = Object.freeze({CNBC_RSS_PROBE_ENABLED: 'true'});

function item(slug, {title = `Article ${slug}`, pubDate = 'Fri, 16 Oct 2026 16:29:16 GMT'} = {}) {
  return `<item><link>https://www.cnbc.com/2026/10/16/${slug}.html</link><guid>${slug}</guid>`
    + `<metadata:type>cnbcnewsstory</metadata:type><title>${title}</title><pubDate>${pubDate}</pubDate></item>`;
}

function rss(items) {
  return '<?xml version="1.0"?><rss xmlns:metadata="m" version="2.0"><channel><title>L</title>'
    + items.join('') + '</channel></rss>';
}

function html(published, modified) {
  return `<html><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"${published}",`
    + `"dateModified":"${modified}"}</script></html>`;
}

function response(body, status = 200) {
  return {ok: status >= 200 && status < 300, status, headers: {get: () => null}, text: async () => body};
}

// Lists answer from `lists` (by id); any other address is a page, from `pages`.
function fakeFetch({lists = {}, pages = {}} = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.startsWith(CNBC_RSS_LIST_URL_PREFIX)) {
      const body = lists[new URL(url).searchParams.get('id')];
      return typeof body === 'number' ? response('', body) : response(body || rss([]));
    }
    const page = pages[new URL(url).pathname];
    return page ? response(page) : response('', 404);
  };
  return {fetchImpl, calls};
}

const NOW = () => Date.parse('2026-10-18T06:30:00.000Z');

test('Step 9F.6b probe: always "not found" in Production, even when switched on', async () => {
  const {fetchImpl, calls} = fakeFetch();
  for (const env of [{...ON, VERCEL_ENV: 'production'}, {VERCEL_ENV: 'production'}]) {
    const result = await handleCnbcRssProbe({env, fetchImpl, now: NOW});
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, {error: 'endpoint not found'});
  }
  assert.equal(calls.length, 0);
});

test('Step 9F.6b probe: "not found" when switched off (the default), on Preview and locally', async () => {
  const {fetchImpl, calls} = fakeFetch();
  for (const env of [{}, {VERCEL_ENV: 'preview'}, {VERCEL_ENV: 'preview', CNBC_RSS_PROBE_ENABLED: 'false'}]) {
    assert.equal((await handleCnbcRssProbe({env, fetchImpl, now: NOW})).status, 404);
  }
  assert.equal(calls.length, 0);
});

test('Step 9F.6b probe: reports each list, the movers counts, possible misses and the kept candidates', async () => {
  const {fetchImpl} = fakeFetch({lists: {
    100003114: rss([
      item('hedge-funds-bond-market-turmoil', {pubDate: 'Sun, 18 Oct 2026 06:13:05 GMT'}),
      item('stocks-making-the-biggest-moves-midday-crwv-moga', {title: 'Stocks making the biggest moves midday: CoreWeave'}),
      item('midday-stock-movers-ebay-meta', {title: 'eBay and Meta lead the session'}),
      item('rewritten', {title: 'Stocks moving big after hours: Netflix'}),
      item('playing-the-coreweave-disconnect', {title: 'CoreWeave\'s slow moving crisis'}),
      item('channel-time', {pubDate: 'Fri, 16 Oct 2026 18:10 GMT'})
    ]),
    20910258: 403
  }});
  const result = await handleCnbcRssProbe({env: {...ON, VERCEL_ENV: 'preview'}, fetchImpl, now: NOW});
  assert.equal(result.status, 200);
  const body = result.body;
  assert.equal(body.outcome, 'OK');
  assert.equal(body.finderEnabled, true);
  assert.match(body.note, /list updated time/);
  assert.equal(body.lists.length, 7);
  const top = body.lists[0];
  assert.equal(top.listId, '100003114');
  assert.equal(top.httpStatus, 200);
  assert.equal(top.itemCount, 6);
  assert.ok(top.bytes > 0);
  assert.equal(typeof top.durationMs, 'number');
  assert.equal(top.newestListTime, '2026-10-18T06:13:05.000Z');
  assert.equal(top.oldestListTime, '2026-10-16T16:29:16.000Z');
  assert.deepEqual(top.movers, {addressOnly: 1, titleOnly: 1, both: 1});
  assert.deepEqual(top.possibleMisses, [{title: 'CoreWeave\'s slow moving crisis',
    path: '/2026/10/16/playing-the-coreweave-disconnect.html'}]);
  assert.deepEqual([body.lists[1].outcome, body.lists[1].httpStatus], ['HTTP_FAILURE', 403]);
  assert.deepEqual(body.candidates.map(candidate => candidate.path), [
    '/2026/10/16/hedge-funds-bond-market-turmoil.html',
    '/2026/10/16/channel-time.html',
    '/2026/10/16/playing-the-coreweave-disconnect.html'
  ]);
  assert.equal(body.candidates[1].listUpdatedTime, '2026-10-16T18:10:00.000Z');
  assert.equal(body.counts.moversDroppedCount, 3);
  assert.deepEqual(body.pages, []);
  assert.ok(body.readingWindow && body.readingWindow.startsAt);
});

test('Step 9F.6b probe: the page option shows each page\'s own publish time, capped at 3', async () => {
  const slugs = ['a', 'b', 'c', 'd', 'e'];
  const {fetchImpl, calls} = fakeFetch({
    lists: {100003114: rss(slugs.map((slug, index) => item(slug, {pubDate: `Sat, 17 Oct 2026 1${index}:00:00 GMT`})))},
    pages: {
      '/2026/10/16/e.html': html('2026-10-17T05:00:01+0000', '2026-10-17T14:00:00+0000'),
      '/2026/10/16/d.html': html('not a time', '2026-10-17T13:00:00+0000')
    }
  });
  const result = await handleCnbcRssProbe({query: {pages: '9'}, env: ON, fetchImpl, now: NOW});
  const pageCalls = calls.filter(url => !url.startsWith(CNBC_RSS_LIST_URL_PREFIX));
  assert.equal(pageCalls.length, 3);
  assert.equal(result.body.limits.pagesRequested, 3);
  assert.deepEqual(result.body.pages.map(page => [page.path, page.outcome, page.httpStatus]), [
    ['/2026/10/16/e.html', 'OK', 200],
    ['/2026/10/16/d.html', 'NO_PAGE_PUBLISH_TIME', 200],
    ['/2026/10/16/c.html', 'HTTP_FAILURE', 404]
  ]);
  assert.equal(result.body.pages[0].listUpdatedTime, '2026-10-17T14:00:00.000Z');
  assert.equal(result.body.pages[0].pagePublishedRaw, '2026-10-17T05:00:01+0000');
  assert.equal(result.body.pages[0].pagePublishedAt, '2026-10-17T05:00:01.000Z');
  assert.equal(result.body.pages[0].pageModifiedAt, '2026-10-17T14:00:00.000Z');
});

test('Step 9F.6b probe: page count clamps to 0..3 and defaults to 0', () => {
  assert.equal(probePageCount(undefined), 0);
  assert.equal(probePageCount('2'), 2);
  assert.equal(probePageCount('3'), 3);
  assert.equal(probePageCount('100'), 3);
  assert.equal(probePageCount('-1'), 0);
  assert.equal(probePageCount('two'), 0);
  assert.equal(probePageCount('2.7'), 2);
  assert.equal(pageTime('2026-10-18T05:00:01+0000'), '2026-10-18T05:00:01.000Z');
  assert.equal(pageTime('2026-10-18T01:00:01-04:00'), '2026-10-18T05:00:01.000Z');
  assert.equal(pageTime('soon'), null);
});

test('Step 9F.6b probe: never reads an address from the request', async () => {
  const {fetchImpl, calls} = fakeFetch({lists: {100003114: rss([item('one')])}});
  const query = {pages: '3', url: 'https://evil.example/x', id: '20409666', list: 'https://example.com/feed.xml'};
  await handleCnbcRssProbe({query, env: ON, fetchImpl, now: NOW});
  for (const url of calls) {
    assert.equal(new URL(url).hostname.endsWith('cnbc.com'), true, url);
    assert.doesNotMatch(url, /evil|example|20409666/);
  }
});

test('Step 9F.6b probe: with the finder switched off it reports DISABLED and fetches nothing', async () => {
  const {fetchImpl, calls} = fakeFetch();
  const result = await handleCnbcRssProbe({env: {...ON, CNBC_RSS_FINDER_ENABLED: 'off'}, fetchImpl, now: NOW});
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, 'DISABLED');
  assert.equal(result.body.finderEnabled, false);
  assert.equal(calls.length, 0);
});

test('Step 9F.6b probe: an unexpected failure is a 502, not a crash', async () => {
  const result = await handleCnbcRssProbe({env: ON, fetchImpl: 'not a function', now: NOW});
  assert.deepEqual(result, {status: 502, body: {probe: 'cnbc-rss', outcome: 'PROBE_FAILED'}});
});

// The api/quote.js branch: GET only, no-store, and Production answers 404.
function fakeRes() {
  const res = {headers: {}, statusCode: null, body: null};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.end = () => res;
  return res;
}

test('Step 9F.6b probe: api/quote.js answers GET ?cnbcRssProbe=1 with no-store, and 404 in Production', async () => {
  const handler = require('../api/quote');
  const saved = {VERCEL_ENV: process.env.VERCEL_ENV, CNBC_RSS_PROBE_ENABLED: process.env.CNBC_RSS_PROBE_ENABLED};
  try {
    process.env.VERCEL_ENV = 'production';
    process.env.CNBC_RSS_PROBE_ENABLED = 'true';
    const res = fakeRes();
    await handler({method: 'GET', query: {cnbcRssProbe: '1'}}, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, {error: 'endpoint not found'});

    delete process.env.VERCEL_ENV;
    delete process.env.CNBC_RSS_PROBE_ENABLED;
    const off = fakeRes();
    await handler({method: 'GET', query: {cnbcRssProbe: '1'}}, off);
    assert.equal(off.statusCode, 404);
    assert.equal(off.headers['Cache-Control'], 'no-store');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

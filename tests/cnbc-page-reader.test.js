// Step 9F.6c: the CNBC page reader for the shared source reader (readPage in
// lib/cnbc-article-content-acquisition.js) -- CNBC's own page parsing, wire
// stories, live blogs, the switch, the address rule and every failure type.
// The rules shared with every source are in tests/source-reader-contract.test.js.
// Made-up fixtures only; no network and no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CNBC_READER_MAX_RESPONSE_BYTES,
  canonicalCnbcReaderUrl,
  createCnbcArticleContentAcquisitionService
} = require('../lib/cnbc-article-content-acquisition');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');

const KB = 1024;
const URL_A = 'https://www.cnbc.com/2026/09/29/made-up-widget-story.html';
const HEADLINE = 'Made up widget makers rally';
const TEXT = 'Made up body text about widget makers.';

function response(html, {url = URL_A, status = 200, headers = {}, body} = {}) {
  const all = {'content-type': 'text/html; charset=utf-8', ...headers};
  return {
    ok: status >= 200 && status < 300, status, url,
    headers: {get: name => all[name.toLowerCase()] ?? null},
    ...(body ? {body} : {}),
    text: async () => html
  };
}

function reader({fetchImpl, env = {}} = {}) {
  return createCnbcArticleContentAcquisitionService({fetchImpl, env});
}

function serve(html, options) {
  const calls = [];
  return {calls, fetchImpl: async (url, init) => { calls.push({url, init}); return response(html, options); }};
}

function jsonLd(node) {
  return `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
}

// A live-shaped CNBC page: the standard block carries no text; the text, the
// headline and the times sit in CNBC's page-state modules.
function statePage({type = 'cnbcnewsstory', url = URL_A, headline = HEADLINE, text = TEXT,
  publishedAt = '2026-09-28T19:00:00+0000', modifiedAt = '2026-09-28T19:30:00+0000', body = true} = {}) {
  const header = {name: 'articleHeader', source: '9001', data: {id: 9001, brand: 'cnbc', type, url, headline,
    datePublished: publishedAt, dateModified: modifiedAt}};
  const modules = [header];
  if (body) {
    modules.push({name: 'articleBody', source: '9001', data: {id: 9001, brand: 'cnbc', type, articleBodyText: text}});
  }
  const state = {page: {page: {layout: [{columns: [{modules}]}]}}};
  return `<html><head>${jsonLd({'@type': 'NewsArticle', headline, datePublished: publishedAt})}</head><body>`
    + `<script>window.__s_data=${JSON.stringify(state)};window.__c_data={};</script></body></html>`;
}

test('Step 9F.6c CNBC reader: a live-shaped page is read from the page-state modules', async () => {
  const {fetchImpl, calls} = serve(statePage());
  const result = await reader({fetchImpl}).readPage({url: URL_A, headline: 'Any list headline'});
  assert.equal(result.ok, true);
  assert.deepEqual(result.articleContent, {
    sourceId: 'us.cnbc', canonicalUrl: URL_A, headline: HEADLINE, publisher: 'CNBC',
    publishedAt: '2026-09-28T19:00:00.000Z', updatedAt: '2026-09-28T19:30:00.000Z', articleText: TEXT
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_A);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('Step 9F.6c CNBC reader: wire stories with text on the page are read; without text, the normal failure', async () => {
  const read = await reader({fetchImpl: serve(statePage({type: 'wirestory'})).fetchImpl}).readPage({url: URL_A});
  assert.equal(read.ok, true);
  assert.equal(read.articleContent.articleText, TEXT);
  assert.equal(read.articleContent.headline, HEADLINE);
  for (const page of [statePage({type: 'wirestory', text: '   '}), statePage({type: 'wirestory', body: false})]) {
    const result = await reader({fetchImpl: serve(page).fetchImpl}).readPage({url: URL_A});
    assert.deepEqual({...result}, {ok: false, type: 'NO_USABLE_ARTICLE', articleContent: null,
      extractionFailureType: 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT'});
  }
  // Header and body must be the same kind of story; an unknown kind is not read.
  for (const page of [statePage({type: 'cnbcvideo'}),
    statePage({type: 'wirestory'}).replace('"articleBodyText"', '"x":1,"articleBodyText"')
      .replace(/("name":"articleBody","source":"9001","data":\{"id":9001,"brand":"cnbc","type":)"wirestory"/,
        '$1"cnbcnewsstory"')]) {
    const result = await reader({fetchImpl: serve(page).fetchImpl}).readPage({url: URL_A});
    assert.equal(result.type, 'NO_USABLE_ARTICLE');
  }
});

test('Step 9F.6c CNBC reader: the older paid-search page read still rejects wire stories (unchanged)', async () => {
  const service = reader({fetchImpl: serve(statePage({type: 'wirestory'})).fetchImpl});
  await assert.rejects(service.acquireDiscoveredArticleContent({
    discovery: Object.freeze({rank: 1, title: HEADLINE, url: URL_A, discoveredVia: 'ANTHROPIC_WEB_SEARCH',
      targetSessionDate: '2026-09-28'}),
    bounds: {timeoutMs: 4000, maxResponseBytes: 1280 * KB, maxArticleTextBytes: 8 * KB, maxTitleBytes: 512,
      maxResultBytes: 12 * KB}
  }), error => error.code === 'EXTRACTION_FAILURE' && error.extractionFailureType === 'NO_USABLE_BODY');
});

test('Step 9F.6c CNBC reader: a live blog gives its first usable update and that update\'s own time', async () => {
  const page = `<html><head>${jsonLd({'@type': 'LiveBlogPosting', headline: 'Made up live blog',
    liveBlogUpdate: [
      {'@type': 'BlogPosting', headline: 'Latest made up update', datePublished: '2026-09-28T21:00:00+0000',
        articleBody: 'Latest made up update text.'},
      {'@type': 'BlogPosting', headline: 'Older made up update', datePublished: '2026-09-28T18:00:00+0000',
        articleBody: 'Older made up update text.'}
    ]})}</head></html>`;
  const result = await reader({fetchImpl: serve(page).fetchImpl}).readPage({url: URL_A});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.articleText, 'Latest made up update text.');
  assert.equal(result.articleContent.publishedAt, '2026-09-28T21:00:00.000Z');
});

test('Step 9F.6c CNBC reader: publish time formats and the modified time are read, never judged', async () => {
  for (const [value, expected] of [
    ['2026-09-28T19:00:00+0000', '2026-09-28T19:00:00.000Z'],
    ['2026-09-28T15:00:00-0400', '2026-09-28T19:00:00.000Z'],
    ['2026-09-28T19:00:00+00:00', '2026-09-28T19:00:00.000Z'],
    ['2026-09-28T19:00:00Z', '2026-09-28T19:00:00.000Z'],
    ['2026-09-28T19:00:00.5+0000', '2026-09-28T19:00:00.500Z'],
    ['2026-09-28T19:00:00', null],
    ['2026-09-28T19:00:00+000', null],
    ['2026-09-28T19:00:00+2400', null],
    ['2026-02-30T19:00:00+0000', null],
    [null, null]
  ]) {
    const result = await reader({fetchImpl: serve(statePage({publishedAt: value, modifiedAt: undefined})).fetchImpl})
      .readPage({url: URL_A});
    assert.equal(result.ok, true, String(value));
    assert.equal(result.articleContent.publishedAt, expected, String(value));
  }
  for (const [modifiedAt, expected] of [
    ['2026-09-28T18:00:00+0000', null],
    ['not a time', null],
    ['2026-10-30T19:00:00+0000', '2026-10-30T19:00:00.000Z']
  ]) {
    const result = await reader({fetchImpl: serve(statePage({modifiedAt})).fetchImpl}).readPage({url: URL_A});
    assert.equal(result.ok, true, modifiedAt);
    assert.equal(result.articleContent.updatedAt, expected, modifiedAt);
  }
});

test('Step 9F.6c CNBC reader: the switch is on by default; off downloads nothing and answers disabled', async () => {
  assert.equal(SETTINGS_REGISTRY.cnbcPageReaderAlignedEnabled.admin, 'Admin');
  assert.equal(SETTINGS_REGISTRY.cnbcPageReaderAlignedEnabled.envVar, 'CNBC_PAGE_READER_ALIGNED_ENABLED');
  assert.equal(settingValue('cnbcPageReaderAlignedEnabled', {env: {}}), true);
  const env = {CNBC_PAGE_READER_ALIGNED_ENABLED: 'false'};
  const {fetchImpl, calls} = serve(statePage());
  const service = reader({fetchImpl, env});
  assert.deepEqual({...await service.readPage({url: URL_A})}, {ok: false, type: 'DISABLED', articleContent: null});
  assert.equal(calls.length, 0);
  // Read on each call.
  env.CNBC_PAGE_READER_ALIGNED_ENABLED = 'true';
  assert.equal((await service.readPage({url: URL_A})).ok, true);
  assert.equal(calls.length, 1);
});

test('Step 9F.6c CNBC reader: the address is written as the finder writes it; others are refused unfetched', async () => {
  assert.equal(canonicalCnbcReaderUrl(`${URL_A}?__source=made-up#top`), URL_A);
  const {fetchImpl, calls} = serve(statePage());
  const result = await reader({fetchImpl}).readPage({url: `  ${URL_A}?__source=made-up#top `});
  assert.equal(result.articleContent.canonicalUrl, URL_A);
  assert.equal(calls[0].url, URL_A);
  for (const url of ['http://www.cnbc.com/2026/09/29/x.html', 'https://example.com/x.html',
    'https://user:pw@www.cnbc.com/x.html', 'https://cnbc.com.example.com/x.html', '', null, 42]) {
    const before = calls.length;
    const refused = await reader({fetchImpl}).readPage({url});
    assert.equal(refused.type, 'INVALID_INPUT', String(url));
    assert.equal(calls.length, before);
  }
  assert.equal((await reader({fetchImpl}).readPage()).type, 'INVALID_INPUT');
  assert.equal((await reader({fetchImpl}).readPage(null)).type, 'INVALID_INPUT');
});

test('Step 9F.6c CNBC reader: every failure type, with the HTTP status', async () => {
  const cases = [
    [response('', {status: 503}), {type: 'HTTP_FAILURE', httpStatus: 503}],
    [response('', {status: 301}), {type: 'HTTP_FAILURE', httpStatus: 301}],
    [{ok: false}, {type: 'HTTP_FAILURE', httpStatus: null}],
    [null, {type: 'HTTP_FAILURE', httpStatus: null}],
    [response(statePage(), {url: 'https://www.cnbc.com/2026/09/29/another-story.html'}),
      {type: 'NO_USABLE_ARTICLE', extractionFailureType: 'CANONICAL_OR_REDIRECT_MISMATCH'}],
    [response(statePage(), {headers: {'content-type': 'application/json'}}), {type: 'INVALID_CONTENT_TYPE'}],
    [response(statePage(), {headers: {'content-type': null}}), {type: 'INVALID_CONTENT_TYPE'}],
    [response('x', {headers: {'content-length': String(CNBC_READER_MAX_RESPONSE_BYTES + 1)}}),
      {type: 'RESPONSE_TOO_LARGE'}],
    [response('<html><body>No article.</body></html>'),
      {type: 'NO_USABLE_ARTICLE', extractionFailureType: 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT'}],
    [response(`<html>${jsonLd({'@type': 'NewsArticle', articleBody: TEXT})}</html>`),
      {type: 'NO_USABLE_ARTICLE', extractionFailureType: 'NO_COMPATIBLE_ARTICLE_METADATA'}],
    [response(statePage({headline: 'h'.repeat(513)})),
      {type: 'NO_USABLE_ARTICLE', extractionFailureType: 'OTHER_EXTRACTION_REJECTION'}],
    // Text that doubles when written out (quotes) passes the text cut but not the result cap.
    [response(statePage({text: '"'.repeat(16 * KB)})), {type: 'RESULT_TOO_LARGE'}]
  ];
  for (const [served, expected] of cases) {
    const result = await reader({fetchImpl: async () => served}).readPage({url: URL_A});
    assert.equal(result.ok, false, expected.type);
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, expected.type);
    assert.equal(result.articleContent, null);
  }
  const timeout = await reader({fetchImpl: async () => {
    const error = new Error('aborted'); error.name = 'AbortError'; throw error;
  }}).readPage({url: URL_A});
  assert.equal(timeout.type, 'TIMEOUT');
  assert.equal((await reader({fetchImpl: async () => { throw new Error('made up'); }}).readPage({url: URL_A})).type,
    'RETRIEVAL_FAILURE');
  assert.equal((await reader({fetchImpl: async () => ({...response(''), text: async () => {
    throw new Error('made up');
  }})}).readPage({url: URL_A})).type, 'RESPONSE_READ_FAILURE');
  // Never throws, even when the response object misbehaves.
  const odd = await reader({fetchImpl: async () => ({ok: true, status: 200, url: URL_A,
    headers: {get: () => { throw new Error('made up'); }}})}).readPage({url: URL_A});
  assert.equal(odd.ok, false);
});

test('Step 9F.6c CNBC reader: page size limit is 1,536 KB, streamed or declared', async () => {
  assert.equal(CNBC_READER_MAX_RESPONSE_BYTES, 1536 * KB);
  // A 1,300 KB page (over the older 1,280 KB bound) is read.
  const big = statePage().replace('<body>', `<body><!--${'p'.repeat(1300 * KB)}-->`);
  assert.equal((await reader({fetchImpl: serve(big).fetchImpl}).readPage({url: URL_A})).ok, true);
  const chunk = new Uint8Array(512 * KB);
  let sent = 0;
  const body = {getReader: () => ({
    read: async () => (sent++ < 4 ? {done: false, value: chunk} : {done: true}),
    cancel: async () => {}
  })};
  const streamed = await reader({fetchImpl: async () => response('', {body})}).readPage({url: URL_A});
  assert.equal(streamed.type, 'RESPONSE_TOO_LARGE');
});

test('Step 9F.6c CNBC reader: the kept text follows the shared article size setting', async () => {
  const text = 'w'.repeat(30 * KB);
  const result = await reader({fetchImpl: serve(statePage({text})).fetchImpl, env: {ARTICLE_KB: '8'}})
    .readPage({url: URL_A});
  assert.equal(result.ok, true);
  assert.equal(result.articleContent.articleText, 'w'.repeat(8 * KB));
});

test('Step 9F.6c CNBC reader: the page timeout comes from the shared setting, read on each call', async () => {
  // performance.now, not Date.now: other suites fake the wall clock.
  const started = performance.now();
  const result = await reader({env: {PAGE_TIMEOUT_MS: '2000'}, fetchImpl: (url, {signal}) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }))}).readPage({url: URL_A});
  assert.equal(result.type, 'TIMEOUT');
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1900 && elapsed < 3900, String(elapsed));
});

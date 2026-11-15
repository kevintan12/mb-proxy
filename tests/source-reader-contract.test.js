// Step 9F.6c (Kevin, 10 and 18 Oct 2026): the rules every news source's page
// reader must follow. Yahoo's evidence rules are the baseline; a source differs
// only in how it finds candidates and how it parses its own pages. The SAME
// checks run against every page reader listed in READERS -- a new source adds
// itself there. Made-up fixtures only; no network and no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {readSource} = require('../lib/source-reader');
const {downloadWithRetries, readingSettings} = require('../lib/reading-window');
const {
  createYahooCurrentNewsArticleContentAcquisitionService
} = require('../lib/yahoo-current-news-article-content-acquisition');
const {createCnbcArticleContentAcquisitionService} = require('../lib/cnbc-article-content-acquisition');
const {createCnbcRssSource} = require('../lib/sources/cnbc-rss');

const KB = 1024;
const ARTICLE_BYTES = readingSettings({market: 'US', env: {}}).articleKb * KB;
const SUCCESS_KEYS = ['sourceId', 'canonicalUrl', 'headline', 'publisher', 'publishedAt', 'updatedAt',
  'articleText'];
const SHARED_FAILURE_TYPES = new Set(['TIMEOUT', 'RETRIEVAL_FAILURE', 'RESPONSE_READ_FAILURE',
  'HTTP_FAILURE', 'RESPONSE_TOO_LARGE', 'NO_USABLE_ARTICLE', 'INVALID_INPUT', 'INVALID_CONTENT_TYPE',
  'IDENTITY_MISMATCH', 'RESULT_TOO_LARGE', 'DISABLED']);

// Tuesday 29 Sep 2026, 14:00 New York; last close Monday 20:00Z; the reading
// window starts 24 hours before that close (as in tests/source-reader.test.js).
const TRIGGER = '2026-09-29T18:00:00.000Z';
const LAST_CLOSE = Date.parse('2026-09-28T20:00:00.000Z');
const WINDOW_START = LAST_CLOSE - 24 * 3600000;
const iso = ms => new Date(ms).toISOString();
const INSIDE = iso(LAST_CLOSE - 3600000);

function jsonLdPage({headline, url, publishedAt, modifiedAt, text}) {
  const node = {'@context': 'https://schema.org', '@type': 'NewsArticle', headline, url,
    publisher: {name: 'Made Up Wire'}};
  if (publishedAt !== undefined) node.datePublished = publishedAt;
  if (modifiedAt !== undefined) node.dateModified = modifiedAt;
  if (text !== undefined) node.articleBody = text;
  return `<html><head><script type="application/ld+json">${JSON.stringify(node)}</script></head>`
    + '<body><p>Page chrome.</p></body></html>';
}

// Each reader: how to build it with a fake fetch, a valid page address, and
// a page in its own format. Nothing else may differ between sources.
const READERS = [
  {
    name: 'Yahoo',
    pageUrl: slug => `https://finance.yahoo.com/news/${slug}.html`,
    page: jsonLdPage,
    knownGaps: {
      headerReadThrows: 'Known gap found in Step 9F.6c: Yahoo\'s page reader throws when a response '
        + 'header cannot be read (the shared reader records it as FETCH_FAILED / EXCEPTION, not retried). '
        + 'Yahoo\'s reader was off-limits in 9F.6c; fix in a later step.'
    },
    create: fetchImpl => {
      const service = createYahooCurrentNewsArticleContentAcquisitionService({fetchImpl});
      return (url, headline) => service.acquireArticleContent({url, headline});
    }
  },
  {
    name: 'CNBC',
    pageUrl: slug => `https://www.cnbc.com/2026/09/29/${slug}.html`,
    page: jsonLdPage,
    create: fetchImpl => {
      const service = createCnbcArticleContentAcquisitionService({fetchImpl, env: {}});
      return (url, headline) => service.readPage({url, headline});
    }
  },
  // Step 9F.6d Build A: the CNBC source object itself, as the shared reader
  // calls it -- readPage(url, {headline}) handed on to the CNBC page reader.
  {
    name: 'CNBC source object',
    pageUrl: slug => `https://www.cnbc.com/2026/09/29/${slug}.html`,
    page: jsonLdPage,
    create: fetchImpl => {
      const pageReader = createCnbcArticleContentAcquisitionService({fetchImpl, env: {}});
      const source = createCnbcRssSource({fetchImpl, env: {}, pageReader});
      return (url, headline) => source.readPage(url, {headline});
    }
  }
];

function htmlResponse(html, {url, status = 200, headers = {}} = {}) {
  const all = {'content-type': 'text/html; charset=utf-8', ...headers};
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {get: name => all[name.toLowerCase()] ?? null},
    text: async () => html
  };
}

// A fetch that serves `pages` (url -> html or a function) and records calls.
function fakeFetch(pages) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    const page = pages[url];
    if (typeof page === 'function') return page(url, options);
    if (typeof page === 'string') return htmlResponse(page, {url});
    return htmlResponse('', {url, status: 404});
  };
  return {fetchImpl, calls};
}

const HEADLINE = 'Made up markets story about widgets';

function okPage(reader, slug, fields = {}) {
  const url = reader.pageUrl(slug);
  return {url, html: reader.page({headline: HEADLINE, url, publishedAt: INSIDE,
    text: 'Made up body text about widgets.', ...fields})};
}

for (const reader of READERS) {
  test(`source contract (${reader.name}): success shape, clean address, publish and modified times`, async () => {
    const {url, html} = okPage(reader, 'shape', {modifiedAt: '2026-09-28T19:30:00+0000'});
    const {fetchImpl, calls} = fakeFetch({[url]: html});
    const result = await reader.create(fetchImpl)(`${url}?utm=made-up#part`, HEADLINE);
    assert.equal(result.ok, true);
    assert.equal(result.type, 'SUCCESS');
    assert.deepEqual(Object.keys(result.articleContent), SUCCESS_KEYS);
    assert.equal(result.articleContent.canonicalUrl, url);
    assert.doesNotMatch(result.articleContent.canonicalUrl, /[?#]/);
    assert.equal(result.articleContent.headline, HEADLINE);
    assert.equal(result.articleContent.publishedAt, iso(LAST_CLOSE - 3600000));
    assert.equal(result.articleContent.updatedAt, '2026-09-28T19:30:00.000Z');
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.articleContent));
    // No paid call: the only request is the page itself.
    assert.deepEqual(calls, [url]);
  });

  test(`source contract (${reader.name}): "+0000", "-0400", "+00:00", "Z" and fractions are read`, async () => {
    for (const [value, expected] of [
      ['2026-09-28T19:00:00+0000', '2026-09-28T19:00:00.000Z'],
      ['2026-09-28T15:00:00-0400', '2026-09-28T19:00:00.000Z'],
      ['2026-09-28T19:00:00+00:00', '2026-09-28T19:00:00.000Z'],
      ['2026-09-28T19:00:00Z', '2026-09-28T19:00:00.000Z'],
      ['2026-09-28T19:00:00.250+0000', '2026-09-28T19:00:00.250Z']
    ]) {
      const {url, html} = okPage(reader, 'times', {publishedAt: value});
      const result = await reader.create(fakeFetch({[url]: html}).fetchImpl)(url, HEADLINE);
      assert.equal(result.ok, true, value);
      assert.equal(result.articleContent.publishedAt, expected, value);
    }
  });

  test(`source contract (${reader.name}): a missing or unreadable publish time is blank, never a rejection`, async () => {
    for (const value of [undefined, 'yesterday', '2026-09-28T19:00:00', '2026-09-28T19:00:00+000']) {
      const {url, html} = okPage(reader, 'no-time', {publishedAt: value});
      const result = await reader.create(fakeFetch({[url]: html}).fetchImpl)(url, HEADLINE);
      assert.equal(result.ok, true, String(value));
      assert.equal(result.articleContent.publishedAt, null, String(value));
    }
  });

  test(`source contract (${reader.name}): an unreadable modified time never rejects the page`, async () => {
    const {url, html} = okPage(reader, 'bad-modified', {modifiedAt: 'not a time'});
    const result = await reader.create(fakeFetch({[url]: html}).fetchImpl)(url, HEADLINE);
    assert.equal(result.ok, true);
    assert.equal(result.articleContent.updatedAt, null);
  });

  test(`source contract (${reader.name}): the first 16 KB on a whole character, no rejection at 13-40 KB`, async () => {
    for (const kb of [13, 16, 20, 40]) {
      const text = 'w'.repeat(kb * KB - 3) + '€ end';
      const {url, html} = okPage(reader, `long-${kb}`, {text});
      const result = await reader.create(fakeFetch({[url]: html}).fetchImpl)(url, HEADLINE);
      assert.equal(result.ok, true, `${kb} KB`);
      const kept = result.articleContent.articleText;
      assert.ok(Buffer.byteLength(kept, 'utf8') <= ARTICLE_BYTES, `${kb} KB`);
      assert.ok(text.startsWith(kept), `${kb} KB is a prefix`);
      assert.doesNotMatch(kept, /�/);
      if (kb === 13) assert.equal(kept, text);
    }
    // A three-byte character straddling the 16 KB line is dropped whole.
    const text = 'x'.repeat(ARTICLE_BYTES - 1) + '€€ tail';
    const {url, html} = okPage(reader, 'straddle', {text});
    const result = await reader.create(fakeFetch({[url]: html}).fetchImpl)(url, HEADLINE);
    assert.equal(result.articleContent.articleText, 'x'.repeat(ARTICLE_BYTES - 1));
  });

  test(`source contract (${reader.name}): failure types the shared retry recognises, never a throw`, async () => {
    const url = reader.pageUrl('failures');
    const cases = [
      [async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }, 'TIMEOUT'],
      [async () => { throw new Error('made-up network failure'); }, 'RETRIEVAL_FAILURE'],
      [async () => ({...htmlResponse('', {url}), text: async () => { throw new Error('read'); }}),
        'RESPONSE_READ_FAILURE'],
      [async () => htmlResponse('', {url, status: 503}), 'HTTP_FAILURE', 503],
      [async () => htmlResponse('', {url, status: 429}), 'HTTP_FAILURE', 429],
      [async () => htmlResponse('', {url, status: 404}), 'HTTP_FAILURE', 404],
      [async () => htmlResponse('x', {url, headers: {'content-length': String(2 * KB * KB)}}),
        'RESPONSE_TOO_LARGE'],
      [async () => htmlResponse('<html><body>No article here.</body></html>', {url}), 'NO_USABLE_ARTICLE']
    ];
    for (const [fetchImpl, type, httpStatus] of cases) {
      const result = await reader.create(fetchImpl)(url, HEADLINE);
      assert.equal(result.ok, false, type);
      assert.equal(result.type, type);
      assert.ok(SHARED_FAILURE_TYPES.has(result.type));
      if (httpStatus !== undefined) assert.equal(result.httpStatus, httpStatus);
    }
    // Odd inputs and odd fetch results still give a result, never a throw.
    for (const [fetchImpl, input] of [
      [async () => null, url],
      [async () => htmlResponse('', {url}), 'https://example.com/not-this-source.html'],
      [async () => htmlResponse('', {url}), undefined]
    ]) {
      const result = await reader.create(fetchImpl)(input, HEADLINE);
      assert.equal(result.ok, false);
      assert.ok(SHARED_FAILURE_TYPES.has(result.type), result.type);
    }
  });

  // A known gap is listed on the reader (`knownGaps`) and reported as a to-do,
  // never silently skipped.
  test(`source contract (${reader.name}): a failing response header read gives a result, not a throw`,
    reader.knownGaps?.headerReadThrows ? {todo: reader.knownGaps.headerReadThrows} : {}, async () => {
      const url = reader.pageUrl('header-throws');
      const read = reader.create(async () => ({ok: true, status: 200, url,
        headers: {get: () => { throw new Error('made-up header failure'); }}}));
      const result = await read(url, HEADLINE);
      assert.equal(result.ok, false);
      assert.ok(SHARED_FAILURE_TYPES.has(result.type), result.type);
    });

  test(`source contract (${reader.name}): the shared retry helper retries only temporary failures, within the budget`, async () => {
    const url = reader.pageUrl('retries');
    const pauses = [];
    const sleep = async ms => { pauses.push(ms); };
    const attemptsFor = async (respond, options = {}) => {
      let calls = 0;
      const read = reader.create(async () => { calls++; return respond(calls); });
      const download = await downloadWithRetries(() => read(url, HEADLINE), {attempts: 3, sleep, ...options});
      return {calls, download};
    };
    const temporary = [
      () => htmlResponse('', {url, status: 503}),
      () => htmlResponse('', {url, status: 429}),
      () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
      () => { throw new Error('made-up network failure'); },
      () => ({...htmlResponse('', {url}), text: async () => { throw new Error('read'); }})
    ];
    for (const respond of temporary) {
      const {calls, download} = await attemptsFor(respond);
      assert.equal(calls, 3);
      assert.equal(download.attempts, 3);
      assert.equal(download.error, null);
    }
    // Temporary then fine: the second attempt succeeds.
    const {html} = okPage(reader, 'retries');
    const recovered = await attemptsFor(call => call === 1
      ? htmlResponse('', {url, status: 503}) : htmlResponse(html, {url}));
    assert.equal(recovered.calls, 2);
    assert.equal(recovered.download.result.ok, true);
    const final = [
      () => htmlResponse('', {url, status: 404}),
      () => htmlResponse('', {url, status: 301}),
      () => htmlResponse('<html><body>No article here.</body></html>', {url}),
      () => htmlResponse('x', {url, headers: {'content-length': String(2 * KB * KB)}})
    ];
    for (const respond of final) {
      const {calls} = await attemptsFor(respond);
      assert.equal(calls, 1);
    }
    // The budget stops a retry from starting.
    const stopped = await attemptsFor(() => htmlResponse('', {url, status: 503}),
      {budget: {remainingMs: () => 100, spent: () => false}});
    assert.equal(stopped.calls, 1);
    assert.equal(stopped.download.budgetStopped, true);
    assert.deepEqual([...new Set(pauses)].sort((a, b) => a - b), [250, 750]);
  });

  test(`source contract (${reader.name}): the page's own publish time alone admits it through the shared reader`, async () => {
    const pages = {
      inside: {publishedAt: INSIDE},
      before: {publishedAt: iso(WINDOW_START - 1000)},
      after: {publishedAt: iso(Date.parse(TRIGGER) + 1000)},
      none: {publishedAt: undefined},
      modlate: {publishedAt: INSIDE, modifiedAt: iso(Date.parse(TRIGGER) + 86400000)}
    };
    const served = {};
    for (const [slug, fields] of Object.entries(pages)) {
      const {url, html} = okPage(reader, slug, {headline: `${HEADLINE} ${slug}`, ...fields});
      served[url] = html;
    }
    const read = reader.create(fakeFetch(served).fetchImpl);
    const events = [];
    const acquiredItems = [];
    // A test-only source wrapping this reader. It borrows the Yahoo limits row
    // and log names: a source's own row arrives when it is connected (CNBC: 9F.6d).
    const source = {
      sourceId: 'us.yahoo-finance',
      async findCandidates() {
        return {ok: true, candidates: Object.keys(pages).map(slug => ({
          headline: `${HEADLINE} ${slug}`, url: reader.pageUrl(slug), publisher: 'Made Up Wire'
        })), discoveryStats: {}};
      },
      readPage: (url, {headline}) => read(url, headline)
    };
    const {stats} = await readSource({
      source, runContext: {mostActive: []}, market: 'US', mode: 'ACTIVE',
      timed: async (stage, operation) => operation(), emit: event => events.push(event),
      acquisitionStartedAt: TRIGGER,
      marketContext: {exchangeTimezone: 'America/New_York', marketState: 'REGULAR',
        primaryCompletedSessionDate: '2026-09-28'},
      benchmarkSnapshots: [], stockSnapshots: [], classificationPreflightAvailable: false,
      requiredItems: [], horizonFor: () => 'CURRENT_SESSION', windowUnavailableReason: null,
      sessionWindow: null, acquiredItems,
      clock: {monotonicNow: () => 0, sleep: async () => {}},
      limits: {maxArticleAttempts: 12, maxAdmittedArticles: 6, initialCandidateAttempts: 5}
    });
    const decisions = Object.fromEntries(events.filter(event => Array.isArray(event.candidates))
      .flatMap(event => event.candidates).map(entry => [entry.slug.replace('.html', ''), entry.decision]));
    assert.equal(decisions.inside, 'ADMITTED');
    assert.equal(decisions.before, 'REJECTED_BEFORE_READING_WINDOW');
    assert.equal(decisions.after, 'REJECTED_AFTER_READING_WINDOW');
    assert.equal(decisions.none, 'REJECTED_NO_PUBLICATION_TIME');
    assert.equal(decisions.modlate, 'ADMITTED');
    assert.equal(stats.missingOrMalformedPublicationTimeCount, 1);
    assert.equal(acquiredItems.length, 2);
  });
}

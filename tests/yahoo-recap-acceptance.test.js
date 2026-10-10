// Step 9F.1g: the Yahoo recap is accepted by its content, not its address.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  YAHOO_RECAP_MAX_CANDIDATES,
  canonicalYahooRecapUrl,
  isOldStyleRecapAddress,
  orderRecapCandidates,
  reportsIndexClose
} = require('../lib/yahoo-recap-acceptance');
const {createYahooRecapSessionValidationService} = require('../lib/yahoo-recap-session-validation');
const {createYahooRecapResearchRuntime} = require('../lib/yahoo-recap-research-runtime');
const {createReadingBudget} = require('../lib/reading-window');

const targetSessionDate = '2026-09-09';
const oldStyleUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-dow-sp-500-nasdaq-1.html';
const newStyleUrl = 'https://finance.yahoo.com/markets/stocks/articles/wall-street-closes-higher-2.html';
const recapBody = 'US stocks rose on Tuesday. The Dow Jones Industrial Average (^DJI) added 0.5%, '
  + 'the S&P 500 (^GSPC) gained 0.7%, and the Nasdaq Composite (^IXIC) climbed 1.2%.';
const bounds = Object.freeze({timeoutMs: 4000, maxResponseBytes: 1024 * 1024, maxHeadlineBytes: 512});
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

function page(url, overrides = {}, {canonical = url} = {}) {
  const node = {
    '@type': 'NewsArticle',
    headline: 'Stocks close higher',
    datePublished: '2026-09-09T16:05:00-04:00',
    dateModified: '2026-09-09T16:30:00-04:00',
    url,
    articleBody: recapBody,
    ...overrides
  };
  return `<link rel="canonical" href="${canonical}">`
    + `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
}

function htmlResponse(html, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {get: name => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null},
    async text() { return html; }
  };
}

function discovery(url) {
  return Object.freeze({
    title: 'Stock market today', url, discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate
  });
}

function searchResponse(urls) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() {
      return {content: [{type: 'web_search_tool_result', content: urls.map(url => ({
        type: 'web_search_result', title: 'Stock market today', url
      }))}]};
    }
  };
}

test('page check: accepted by content, rejected with a clear reason', async () => {
  const rows = [
    {name: 'address matching the old pattern, right content', url: oldStyleUrl,
      html: page(oldStyleUrl), type: 'VALIDATED'},
    {name: 'address not matching the old pattern, right content (new)', url: newStyleUrl,
      html: page(newStyleUrl), type: 'VALIDATED'},
    {name: 'page says it belongs on another host', url: newStyleUrl,
      html: page(newStyleUrl, {}, {canonical: 'https://www.example.com/markets/recap.html'}),
      type: 'NOT_VALIDATED', reason: 'WRONG_HOST'},
    {name: 'wrong page type', url: newStyleUrl,
      html: page(newStyleUrl, {'@type': 'WebPage'}), type: 'NOT_VALIDATED', reason: 'NOT_ARTICLE_TYPE'},
    {name: 'wrong publish date', url: newStyleUrl,
      html: page(newStyleUrl, {datePublished: '2026-09-08T16:05:00-04:00',
        dateModified: '2026-09-08T16:30:00-04:00'}),
      type: 'NOT_VALIDATED', reason: 'WRONG_PUBLISH_DATE'},
    {name: 'good updated time but wrong publish date', url: oldStyleUrl,
      html: page(oldStyleUrl, {datePublished: '2026-09-08T09:00:00-04:00',
        dateModified: '2026-09-09T16:30:00-04:00'}),
      type: 'NOT_VALIDATED', reason: 'WRONG_PUBLISH_DATE'},
    {name: 'publish date counted in New York time, not UTC', url: newStyleUrl,
      html: page(newStyleUrl, {datePublished: '2026-09-10T01:00:00Z', dateModified: null}),
      type: 'VALIDATED'},
    {name: 'body fails the close check', url: oldStyleUrl,
      html: page(oldStyleUrl, {articleBody: 'Nvidia shares jumped 5% after earnings. Analysts were upbeat.'}),
      type: 'NOT_VALIDATED', reason: 'FAILED_CLOSE_CHECK'},
    {name: 'unreadable updated time does not decide', url: oldStyleUrl,
      html: page(oldStyleUrl, {dateModified: 'yesterday'}), type: 'VALIDATED', dateModified: null}
  ];
  for (const row of rows) {
    const result = await createYahooRecapSessionValidationService({
      fetchImpl: async () => htmlResponse(row.html, row.url)
    }).validateYahooRecapSession({discovery: discovery(row.url), targetSessionDate, bounds});
    assert.equal(result.type, row.type, row.name);
    if (row.reason) assert.equal(result.reason, row.reason, row.name);
    if (row.type === 'VALIDATED') {
      assert.equal(result.validation.url, row.url, row.name);
      if ('dateModified' in row) assert.equal(result.validation.dateModified, row.dateModified, row.name);
    }
  }
});

test('page check: a wrong host is refused before any download', async () => {
  let fetches = 0;
  for (const url of [
    'https://www.example.com/markets/live/stock-market-today-1.html',
    'https://news.yahoo.com/markets/live/stock-market-today-1.html',
    'http://finance.yahoo.com/markets/live/stock-market-today-1.html'
  ]) {
    const result = await createYahooRecapSessionValidationService({
      fetchImpl: async () => { fetches++; }
    }).validateYahooRecapSession({discovery: discovery(url), targetSessionDate, bounds});
    assert.equal(result.type, 'INVALID_INPUT', url);
  }
  assert.equal(fetches, 0);
});

test('address rule: host only, query and fragment dropped, old style only noted', () => {
  assert.equal(canonicalYahooRecapUrl(`${newStyleUrl}?guccounter=1#top`), newStyleUrl);
  assert.equal(canonicalYahooRecapUrl(oldStyleUrl), oldStyleUrl);
  assert.equal(canonicalYahooRecapUrl('https://finance.yahoo.com.evil.test/x.html'), null);
  assert.equal(isOldStyleRecapAddress(oldStyleUrl), true);
  assert.equal(isOldStyleRecapAddress(newStyleUrl), false);
});

test('close check: two or more indexes reported with a move and a size', () => {
  const rows = [
    [recapBody, true],
    ['The Dow Jones Industrial Average (^DJI) dropped 0.7%, the S&P 500 (^GSPC) declined by about 0.8%.', true],
    ['The S & P 500 gained 0.51% to end the session at 7,743.41, while the Nasdaq Composite moved up 0.48%.', true],
    ['The Dow jumped more than 470 points. The S&P 500 ended 0.5% higher.', true],
    ['Stocks <b>rose</b> after&nbsp;data. The S&amp;P 500 rose 1%; the Nasdaq fell 0.2%.', true],
    ['The S&P 500 rose 1% as Nvidia jumped 5%.', false],
    ['The Dow and the S&P 500 rose on Tuesday.', false],
    ['The US stock market finished the session higher.', false],
    ['', false],
    [undefined, false]
  ];
  for (const [body, expected] of rows) assert.equal(reportsIndexClose(body), expected, String(body));
});

test('candidate order: old style first in search order, then others, at most three', () => {
  const candidate = (rank, url) => ({rank, discovery: discovery(url)});
  const ordered = orderRecapCandidates([
    candidate(1, newStyleUrl),
    candidate(2, oldStyleUrl),
    candidate(3, 'https://finance.yahoo.com/news/other-3.html'),
    candidate(4, 'https://finance.yahoo.com/news/live/stock-market-today-4.html')
  ]);
  assert.equal(YAHOO_RECAP_MAX_CANDIDATES, 3);
  assert.deepEqual(ordered.map(item => item.rank), [2, 4, 1]);
});

function recapRuntime(pages, {onDiagnostics} = {}) {
  const fetched = [];
  const fetchImpl = async url => {
    if (url === ANTHROPIC) return searchResponse(pages.map(item => item.url));
    fetched.push(url);
    const item = pages.find(entry => entry.url === url);
    const next = item.responses ? item.responses.shift() : null;
    if (next && next.status !== 200) return htmlResponse('', url, next.status);
    return htmlResponse(item.html, url);
  };
  return {
    fetched,
    runtime: createYahooRecapResearchRuntime({apiKey: 'test-key', fetchImpl, onDiagnostics})
  };
}

test('candidate choice: same recap as before when an old-style one passes, others only as fallback', async () => {
  const rows = [
    {
      name: 'old-style recap still chosen ahead of a better-ranked new-style page',
      pages: [{url: newStyleUrl, html: page(newStyleUrl)}, {url: oldStyleUrl, html: page(oldStyleUrl)}],
      chosen: oldStyleUrl, fetched: [oldStyleUrl]
    },
    {
      name: 'new-style recap chosen when the old-style page fails the content check',
      pages: [
        {url: oldStyleUrl, html: page(oldStyleUrl, {datePublished: '2026-09-08T16:05:00-04:00'})},
        {url: newStyleUrl, html: page(newStyleUrl)}
      ],
      chosen: newStyleUrl, fetched: [oldStyleUrl, newStyleUrl]
    },
    {
      name: 'at most three pages checked',
      pages: [1, 2, 3, 4, 5].map(index => {
        const url = `https://finance.yahoo.com/news/not-a-recap-${index}.html`;
        return {url, html: page(url, {'@type': 'WebPage'})};
      }),
      chosen: null, fetched: [1, 2, 3].map(index => `https://finance.yahoo.com/news/not-a-recap-${index}.html`)
    }
  ];
  for (const row of rows) {
    const diagnostics = [];
    const {fetched, runtime} = recapRuntime(row.pages, {onDiagnostics: value => diagnostics.push(value)});
    const result = await runtime.discoverAndValidateRecap({targetSessionDate}, {sleep: async () => {}});
    assert.equal(result.type, row.chosen ? 'VALIDATED' : 'NOT_VALIDATED', row.name);
    assert.equal(result.discovery?.url ?? null, row.chosen, row.name);
    assert.deepEqual(fetched, row.fetched, row.name);
    const audit = diagnostics.find(value => value.stage === 'yahooRecapCandidateAudit');
    assert.equal(audit.candidates.length, row.pages.length, row.name);
    assert.ok(Buffer.byteLength(JSON.stringify(audit), 'utf8') <= 3400, row.name);
  }
});

test('audit: chosen address and why each other candidate was not', async () => {
  const diagnostics = [];
  const otherUrl = 'https://finance.yahoo.com/news/other-3.html';
  const {runtime} = recapRuntime([
    {url: oldStyleUrl, html: page(oldStyleUrl, {articleBody: 'Apple fell 2%.'})},
    {url: newStyleUrl, html: page(newStyleUrl)},
    {url: otherUrl, html: page(otherUrl)}
  ], {onDiagnostics: value => diagnostics.push(value)});
  const result = await runtime.discoverAndValidateRecap({targetSessionDate});
  assert.equal(result.discovery.url, newStyleUrl);
  const audit = diagnostics.find(value => value.stage === 'yahooRecapCandidateAudit');
  assert.deepEqual(audit, {
    stage: 'yahooRecapCandidateAudit',
    chosenRank: 2,
    chosenSlug: 'wall-street-closes-higher-2.html',
    omittedEntryCount: 0,
    candidates: [
      {rank: 1, slug: 'stock-market-today-dow-sp-500-nasdaq-1.html', oldAddressStyle: true,
        attempts: 1, decision: 'NOT_THE_RECAP', reason: 'FAILED_CLOSE_CHECK'},
      {rank: 2, slug: 'wall-street-closes-higher-2.html', oldAddressStyle: false,
        attempts: 1, decision: 'CHOSEN', reason: null},
      {rank: 3, slug: 'other-3.html', oldAddressStyle: false,
        attempts: 0, decision: 'NOT_CHECKED_RECAP_ALREADY_CHOSEN', reason: null}
    ]
  });
  assert.equal(JSON.stringify(audit).includes('Apple'), false);
});

test('page download retries: temporary failures retried, a 404 tried once', async () => {
  const rows = [
    {name: 'fails once then succeeds', responses: [{status: 503}], attempts: 2, pauses: [250],
      type: 'VALIDATED'},
    {name: 'fails twice then succeeds', responses: [{status: 503}, {status: 429}], attempts: 3,
      pauses: [250, 750], type: 'VALIDATED'},
    {name: 'fails three times', responses: [{status: 500}, {status: 502}, {status: 503}], attempts: 3,
      pauses: [250, 750], type: 'SESSION_VALIDATION_FAILURE', failureType: 'HTTP_FAILURE'},
    {name: 'page not found: one attempt only', responses: [{status: 404}], attempts: 1, pauses: [],
      type: 'SESSION_VALIDATION_FAILURE', failureType: 'HTTP_FAILURE'}
  ];
  for (const row of rows) {
    const diagnostics = [];
    const pauses = [];
    const {fetched, runtime} = recapRuntime([
      {url: oldStyleUrl, html: page(oldStyleUrl), responses: row.responses.slice()}
    ], {onDiagnostics: value => diagnostics.push(value)});
    const result = await runtime.discoverAndValidateRecap({targetSessionDate}, {
      sleep: async ms => { pauses.push(ms); }
    });
    assert.equal(result.type, row.type, row.name);
    if (row.failureType) assert.equal(result.failureType, row.failureType, row.name);
    assert.equal(fetched.length, row.attempts, row.name);
    assert.deepEqual(pauses, row.pauses, row.name);
    const audit = diagnostics.find(value => value.stage === 'yahooRecapCandidateAudit');
    assert.equal(audit.candidates[0].attempts, row.attempts, row.name);
    const validation = diagnostics.find(value => value.stage === 'yahooRecapSessionCandidateValidation');
    assert.equal(validation.attempts, row.attempts, row.name);
  }
});

test('reading budget: no further candidate once the recap budget is spent', async () => {
  let now = 0;
  const diagnostics = [];
  const {fetched, runtime} = recapRuntime([
    {url: oldStyleUrl, html: page(oldStyleUrl, {articleBody: 'Apple fell 2%.'})},
    {url: newStyleUrl, html: page(newStyleUrl)}
  ], {onDiagnostics: value => diagnostics.push(value)});
  const budget = createReadingBudget({budgetMs: 30000, now: () => now});
  const original = runtime.discoverAndValidateRecap;
  now = 0;
  const pending = original({targetSessionDate}, {budget, sleep: async () => {}});
  now = 30000;
  const result = await pending;
  assert.equal(result.type, 'NOT_VALIDATED');
  assert.deepEqual(fetched, [oldStyleUrl]);
  const audit = diagnostics.find(value => value.stage === 'yahooRecapCandidateAudit');
  assert.deepEqual(audit.candidates.map(entry => entry.decision),
    ['NOT_THE_RECAP', 'SKIPPED_READING_BUDGET']);
});

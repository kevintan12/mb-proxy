// Step 9AB Build 1: Further Readings for every source and every state. One list, filled in
// order up to furtherReadingMaxLinks: recaps first on completed days (Yahoo then CNBC), then
// Yahoo or CNBC articles a surviving section cites (Sections 1, 2, 3, 5, 6, 7, then 4), then
// the package's read articles in its best-score-first order (current-session only on live
// days). One link per topic (two or more shared company tags), no duplicate link, recaps exempt.
// Made-up items only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPORT_SECTION_NAMES,
  FURTHER_READING_KINDS,
  resolvedFurtherReadingReferences,
  validateClaudeAnalysisInput
} = require('../lib/claude-analysis-contract');
const {createEvidenceItem} = require('../lib/evidence-items');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {activeUsInput} = require('./fixtures/market-state-cases');

function withEnvSync(values, operation) {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return operation();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const yahoo = (slug, symbols = []) => ({
  sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news', title: `Yahoo ${slug}`,
  canonicalUrl: `https://finance.yahoo.com/news/${slug}.html`, symbols
});
const cnbc = (slug, symbols = []) => ({
  sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: `CNBC ${slug}`,
  canonicalUrl: `https://www.cnbc.com/2026/09/04/${slug}.html`, symbols
});

// A minimal completed-day input: only what the resolver reads.
function completedInput(items, readings, marketState = 'WEEKEND') {
  return {
    analysisRequest: {selectedScope: 'US', generatedAt: '2026-09-06T10:00:00.000Z'},
    marketPackages: [{
      market: 'US',
      marketContext: {marketState},
      evidenceContext: {
        evidence: items.map((item, index) => ({reference: `e${index + 1}`, item})),
        furtherReadings: readings.map(([evidenceRef, kind]) => kind === undefined
          ? {evidenceRef, sessionDate: '2026-09-04'} : {evidenceRef, sessionDate: '2026-09-04', kind})
      }
    }]
  };
}

// Section citations by section number (1-7); a section given null is emptied.
function output(citations) {
  return {sections: REPORT_SECTION_NAMES.map((name, index) => {
    const refs = citations[index + 1];
    return {name, content: refs === null ? null : 'Text.', evidenceRefs: refs || []};
  })};
}

test('Step 9AB: the ceiling and the minimum score are wired; the extras budget is not; no new setting', () => {
  assert.deepEqual(FURTHER_READING_KINDS, ['RECAP', 'READ']);
  const ceiling = SETTINGS_REGISTRY.furtherReadingMaxLinks;
  assert.deepEqual([ceiling.default, ceiling.min, ceiling.max, ceiling.admin, ceiling.wired], [15, 5, 30, 'Admin', true]);
  const minScore = SETTINGS_REGISTRY.furtherReadingExtrasMinScore;
  assert.deepEqual([minScore.default, minScore.min, minScore.max, minScore.admin, minScore.wired], [12, 0, 58, 'Admin', true]);
  assert.equal(SETTINGS_REGISTRY.furtherReadingExtrasBudgetSeconds.wired, false);
  assert.equal(Object.keys(SETTINGS_REGISTRY).some(name => /PerSource/i.test(name)), false);
});

test('Step 9AB: completed days list recaps first (Yahoo, then CNBC), then cited in section order with Section 4 last, then read', () => {
  for (const marketState of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    const input = completedInput([
      cnbc('cnbc-recap'), yahoo('yahoo-recap'), yahoo('read-a'), cnbc('read-b'),
      yahoo('cited-1'), yahoo('cited-4'), cnbc('cited-2'), yahoo('read-c')
    ], [['e1', 'RECAP'], ['e2', 'RECAP'], ['e8', 'READ'], ['e3', 'READ'], ['e4', 'READ'],
      ['e5', 'READ'], ['e6', 'READ'], ['e7', 'READ']], marketState);
    const resolved = resolvedFurtherReadingReferences(
      output({1: ['e5'], 2: ['e7'], 4: ['e6']}), input);
    // Recaps uncited but listed; cited e5 (S1), e7 (S2), then e6 (S4); then the read list order.
    assert.deepEqual(resolved, ['e2', 'e1', 'e5', 'e7', 'e6', 'e8', 'e3', 'e4'], marketState);
  }
});

test('Step 9AB: an emptied section\'s citations do not count; nothing cited still lists recaps and read articles', () => {
  const input = completedInput([yahoo('recap'), yahoo('a'), cnbc('b')],
    [['e1', 'RECAP'], ['e2', 'READ']]);
  assert.deepEqual(resolvedFurtherReadingReferences(output({1: ['e3'], 2: null}), input), ['e1', 'e3', 'e2']);
  assert.deepEqual(resolvedFurtherReadingReferences(output({1: [], 2: null}), input), ['e1', 'e2']);
  const emptied = output({});
  emptied.sections[0] = {...emptied.sections[0], content: null, evidenceRefs: ['e3']};
  assert.deepEqual(resolvedFurtherReadingReferences(emptied, input), ['e1', 'e2']);
});

test('Step 9AB: the ceiling furtherReadingMaxLinks (default 15, clamped 5-30) counts recaps and cuts the tail', () => {
  const items = Array.from({length: 40}, (_, index) => yahoo(`article-${index + 1}`));
  const readings = [['e1', 'RECAP'], ...items.slice(1).map((item, index) => [`e${index + 2}`, 'READ'])];
  const input = completedInput(items, readings);
  const reply = output({1: ['e40', 'e39']});
  const all = ['e1', 'e40', 'e39', ...items.slice(1, 38).map((item, index) => `e${index + 2}`)];
  assert.deepEqual(resolvedFurtherReadingReferences(reply, input), all.slice(0, 15));
  for (const [value, expected] of [['5', 5], ['30', 30], ['2', 5], ['99', 30], ['abc', 15]]) {
    const resolved = withEnvSync({FURTHER_READING_MAX_LINKS: value},
      () => resolvedFurtherReadingReferences(reply, input));
    assert.deepEqual(resolved, all.slice(0, expected), value);
  }
  // A ceiling is a limit, not a target: three candidates give three links.
  const small = completedInput(items.slice(0, 3), [['e1', 'READ'], ['e2', 'READ'], ['e3', 'READ']]);
  assert.deepEqual(resolvedFurtherReadingReferences(output({}), small), ['e1', 'e2', 'e3']);
});

test('Step 9AB: one link per topic (two or more shared company tags) and per link; recaps are exempt', () => {
  const input = completedInput([
    yahoo('recap-apple', ['AAPL', 'NVDA']),
    cnbc('apple-nvidia-crown', ['NVDA', 'AAPL']),
    yahoo('apple-overtakes-nvidia', ['AAPL', 'NVDA']),
    yahoo('apple-alone', ['AAPL']),
    yahoo('macro-one'), yahoo('macro-two'),
    {...yahoo('macro-one'), title: 'Same link again'}
  ], [['e1', 'RECAP'], ['e4', 'READ'], ['e5', 'READ'], ['e6', 'READ'], ['e7', 'READ']]);
  const resolved = resolvedFurtherReadingReferences(output({1: ['e2', 'e3']}), input);
  // e1 (recap) never blocks e2; e3 shares two companies with e2; e4 shares only one, so it is
  // kept; e7 repeats e5's link; untagged articles are kept.
  assert.deepEqual(resolved, ['e1', 'e2', 'e4', 'e5', 'e6']);
});

test('Step 9AB: single-company stories are never merged; two shared companies merge, one does not', () => {
  const input = completedInput([
    yahoo('apple-iphone', ['AAPL']),
    cnbc('apple-lawsuit', ['AAPL']),
    yahoo('apple-msft-cloud', ['AAPL', 'MSFT']),
    yahoo('apple-msft-nvda-ai', ['NVDA', 'MSFT', 'AAPL']),
    yahoo('apple-nvda-chips', ['AAPL', 'NVDA']),
    yahoo('msft-nvda-amzn', ['AMZN', 'NVDA', 'MSFT']),
    yahoo('amzn-goog', ['AMZN', 'GOOG'])
  ], [['e1', 'READ'], ['e2', 'READ'], ['e3', 'READ'], ['e4', 'READ'], ['e5', 'READ'],
    ['e6', 'READ'], ['e7', 'READ']]);
  // e1 and e2 name one company each: both kept. e4 shares AAPL and MSFT with e3: merged.
  // e5 shares only AAPL with e3 (e4 was not listed): kept. e6 shares MSFT only with e3 and
  // NVDA only with e5: kept. e7 shares only AMZN with e6: kept.
  assert.deepEqual(resolvedFurtherReadingReferences(output({}), input),
    ['e1', 'e2', 'e3', 'e5', 'e6', 'e7']);
  // A recap never blocks a later link, even with the same companies.
  const recapFirst = completedInput([yahoo('recap', ['AAPL', 'MSFT']), yahoo('story', ['MSFT', 'AAPL'])],
    [['e1', 'RECAP'], ['e2', 'READ']]);
  assert.deepEqual(resolvedFurtherReadingReferences(output({}), recapFirst), ['e1', 'e2']);
});

test('Step 9AB: a cited item outside the package list must be a Yahoo or CNBC news article with a usable link', () => {
  const input = completedInput([
    cnbc('cited-cnbc'),
    {...yahoo('quote'), evidenceCategory: 'market-data', canonicalUrl: 'https://finance.yahoo.com/quote/AAPL/'},
    {sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy', title: 'Fed',
      canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm', symbols: []},
    {...yahoo('topic'), canonicalUrl: 'https://finance.yahoo.com/topic/latestnews/'},
    {...cnbc('not-https'), canonicalUrl: 'http://www.cnbc.com/2026/09/04/not-https.html'},
    yahoo('cited-yahoo')
  ], []);
  assert.deepEqual(resolvedFurtherReadingReferences(output({1: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']}), input),
    ['e1', 'e6']);
});

test('Step 9AB: an older package entry with no kind counts as a read article', () => {
  const input = completedInput([yahoo('old-recap'), cnbc('old-news'), yahoo('cited')],
    [['e1'], ['e2']]);
  assert.deepEqual(resolvedFurtherReadingReferences(output({1: ['e3']}), input), ['e3', 'e1', 'e2']);
});

test('Step 9AB: one ticker -- an article Section 4 alone cites is listed after the broad-market citations', () => {
  const input = completedInput([yahoo('broad'), yahoo('nvda-only', ['NVDA']), yahoo('read')],
    [['e3', 'READ']]);
  assert.deepEqual(resolvedFurtherReadingReferences(output({4: ['e2'], 6: ['e1']}), input),
    ['e1', 'e2', 'e3']);
});

test('Step 9AB: live days list cited Yahoo and CNBC (any session), then current-session read articles; no recap first', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
  ]) {
    const extra = (title, slug, publishedAt, sourceId = 'us.yahoo-finance') => createEvidenceItem({
      sourceId, market: 'US', evidenceCategory: 'news', title, summary: `${title}.`,
      canonicalUrl: sourceId === 'us.cnbc' ? `https://www.cnbc.com/2026/09/08/${slug}.html`
        : `https://finance.yahoo.com/news/${slug}.html`,
      publishedAt, symbols: [], ...(sourceId === 'us.cnbc' ? {} : {publisher: 'Yahoo Finance'})
    });
    const base = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt, additionalItems: [
      extra('Earlier-session story', 'earlier-session', '2026-09-04T19:30:00.000Z'),
      extra('CNBC story', 'cnbc-story', currentPublishedAt, 'us.cnbc'),
      extra('Uncited current story', 'uncited-current', currentPublishedAt),
      extra('Uncited earlier story', 'uncited-earlier', '2026-09-04T19:00:00.000Z')
    ]});
    const input = structuredClone(base);
    const evidence = input.marketPackages[0].evidenceContext.evidence;
    const ref = title => evidence.find(entry => entry.item.title === title).reference;
    input.marketPackages[0].evidenceContext.furtherReadings = [
      {evidenceRef: ref('Uncited earlier story'), sessionDate: '2026-09-04', kind: 'RECAP'},
      {evidenceRef: ref('Uncited current story'), sessionDate: '2026-09-04', kind: 'READ'}
    ];
    const reply = output({1: [ref('Earlier-session story')], 2: [ref('CNBC story')]});
    assert.deepEqual(resolvedFurtherReadingReferences(reply, input),
      [ref('Earlier-session story'), ref('CNBC story'), ref('Uncited current story')], marketState);
  }
});

test('Step 9AB: the package check accepts the two-key entry and a known kind, and refuses anything else', () => {
  const input = structuredClone(activeUsInput());
  const context = input.marketPackages[0].evidenceContext;
  const sessionDate = input.marketPackages[0].marketContext.primaryCompletedSessionDate;
  const withReadings = readings => {
    const copy = structuredClone(input);
    copy.marketPackages[0].evidenceContext.furtherReadings = readings;
    return copy;
  };
  const ref = context.evidence[0].reference;
  assert.equal(validateClaudeAnalysisInput(withReadings([{evidenceRef: ref, sessionDate}])), true);
  for (const kind of ['RECAP', 'READ']) {
    assert.equal(validateClaudeAnalysisInput(withReadings([{evidenceRef: ref, sessionDate, kind}])), true, kind);
  }
  assert.equal(validateClaudeAnalysisInput(withReadings([{evidenceRef: ref, sessionDate, kind: 'EXTRA'}])), false);
  assert.equal(validateClaudeAnalysisInput(withReadings([{evidenceRef: ref, kind: 'READ', sessionDate}])), false);
  assert.equal(validateClaudeAnalysisInput(withReadings([{evidenceRef: ref, sessionDate, kind: 'READ', note: 'x'}])), false);
});

// ---------------------------------------------------------------------------
// The package side. A small copy of tests/cnbc-completed-shared-reader.test.js's
// harness (copied, not moved, so that file stays untouched): made-up Yahoo and
// CNBC lists and pages, no recap, a classifier that labels nothing.
// ---------------------------------------------------------------------------
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createUsAnalysisPackageOrchestrationService} = require('../lib/us-analysis-package-orchestration');

const PACKAGE_GENERATED_AT = '2026-09-06T10:00:00.000Z'; // Sunday: WEEKEND, last close Fri 4 Sep
const PRE_GENERATED_AT = '2026-09-08T12:00:00.000Z';
const COMPLETED_TIME = '2026-09-04T18:00:00.000Z';

async function withEnv(values, operation) {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function packageSnapshot(symbol, marketState) {
  const sessions = [
    ['2026-08-31', 97, 96], ['2026-09-01', 98, 97], ['2026-09-02', 99, 98],
    ['2026-09-03', 100, 99], ['2026-09-04', 105, 100]
  ].map(([sessionDate, close, previousClose], index) => createCompletedRegularSession({
    market: 'US', sessionDate, open: close - 1, high: close + 5, low: close - 5,
    close, previousClose, volume: 900 + index * 25,
    asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }));
  const pre = marketState === 'PRE';
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY', currency: 'USD',
    marketState, completedSessions: sessions,
    currentOverlay: pre ? createCurrentSessionOverlay({
      market: 'US', marketState: 'PRE', sessionDate: '2026-09-08', asOf: '2026-09-08T11:30:00.000Z',
      lastPrice: 106, referenceClose: 105, volume: 1200, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    }) : null
  });
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const madeUpText = (kb, label) => `${label} made-up article text. `.repeat(Math.ceil(kb * 1024 / 30)).slice(0, kb * 1024);

function fakeCnbcSource(headlines) {
  const candidates = headlines.map(headline => ({
    headline, url: `https://www.cnbc.com/2026/09/04/${slug(headline)}.html`, publisher: 'CNBC',
    listedAt: COMPLETED_TIME, listId: '100003114', cnbcId: slug(headline), contentType: 'cnbcnewsstory'
  }));
  return Object.freeze({
    sourceId: 'us.cnbc',
    async findCandidates() {
      return {ok: true, candidates, discoveryStats: {outcome: 'OK', lists: []}};
    },
    async readPage(url, {headline} = {}) {
      return {ok: true, type: 'SUCCESS', articleContent: {
        sourceId: 'us.cnbc', canonicalUrl: url, headline, publisher: 'CNBC',
        publishedAt: COMPLETED_TIME, updatedAt: null, articleText: madeUpText(2, headline)
      }};
    }
  });
}

const YAHOO_HEADLINES = [
  'Fed rate decision and inflation data send stocks and Treasury yields lower',
  'Oil prices jump as the S&P 500 slips',
  'A made-up feature about a garden show',
  'Nasdaq and Dow fall as tech stocks slide on earnings',
  'A made-up profile of a weekend market'
];
const CNBC_HEADLINES = ['Stocks fall as oil and inflation worries grow', 'A made-up CNBC travel story'];

async function assemblePackage({marketState = 'WEEKEND', env = {}} = {}) {
  const pre = marketState === 'PRE';
  const pools = [];
  const service = createUsAnalysisPackageOrchestrationService({
    createTelemetryAcquisition: () => ({async acquireSnapshot({symbol}) { return packageSnapshot(symbol, marketState); }}),
    snapshotPersistence: {async persistSnapshot(value) { return value; }},
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) {
      return createEvidenceCollection({market: 'US', items: [createEvidenceItem({
        sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
        title: `${symbol} market data`, summary: `${symbol} factual market data.`,
        canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
        publishedAt: '2026-09-05T20:00:00Z', symbols: [symbol]
      })]});
    }},
    yahooMostActiveAcquisition: {async acquireMostActive() { return {ok: true, type: 'NOT_FOUND', candidates: []}; }},
    yahooLatestNewsDiscovery: {async discoverLatestNews() {
      return {ok: true, type: 'SUCCESS', candidates: YAHOO_HEADLINES.map(headline => ({
        headline, url: `https://finance.yahoo.com/news/${slug(headline)}.html`, uuid: null, publisher: 'Yahoo Finance'
      }))};
    }},
    yahooCurrentNewsArticleContentAcquisition: {async acquireArticleContent(candidate) {
      return {ok: true, type: 'SUCCESS', articleContent: {
        sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url, headline: candidate.headline,
        publisher: 'Yahoo Finance', publishedAt: pre ? '2026-09-08T11:00:00.000Z' : COMPLETED_TIME,
        updatedAt: null, articleText: madeUpText(2, candidate.headline)
      }};
    }},
    federalReserveEvidenceAcquisition: {async acquireEvidence() {
      return createEvidenceCollection({market: 'US', items: []});
    }},
    yahooRecapResearch: {async discoverAndValidateRecap() {
      return {ok: true, type: 'NOT_FOUND', discovery: null, validation: null};
    }},
    yahooRecapArticleContentAcquisition: {async acquireArticleContent() { throw new Error('not expected'); }},
    yahooRecapEvidenceConstruction: {constructEvidence() { throw new Error('not expected'); }},
    yahooRecapArticleContentBounds: Object.freeze({
      timeoutMs: 4000, maxResponseBytes: 1258291, maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256, maxArticleTextBytes: 8192, maxResultBytes: 12288
    }),
    cnbcRecapResearch: {async researchCompletedSessionRecap() {
      return {ok: true, type: 'NOT_FOUND', constructedEvidence: null};
    }},
    cnbcNewsResearch: {async researchNews() { return {ok: true, type: 'NOT_FOUND'}; }},
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return {ok: true, type: 'SUCCESS', output: {classifications: input.evidence.map(({reference}) => ({
          reference, materiality: 'LOW', roles: [], subjects: []
        }))}};
      },
      async repairEvidenceSubjects(input) {
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(({reference}) => ({reference, subjects: []}))}};
      }
    },
    now: () => new Date(pre ? PRE_GENERATED_AT : PACKAGE_GENERATED_AT),
    onDiagnostics: () => {},
    cnbcNewsSource: fakeCnbcSource(CNBC_HEADLINES),
    onCandidatePool: value => pools.push(value)
  });
  const result = await withEnv({
    CNBC_SHARED_READER_COMPLETED_ENABLED: 'on', ARTICLE_SLOTS_ENABLED: 'on', SLOT_SPILLOVER_ENABLED: 'on',
    CNBC_NO_SPECIAL_CONDITIONS_ENABLED: 'on', ARTICLE_TEXT_BUDGET_ENABLED: 'on', SCORE_TRY_ORDER_ENABLED: 'on',
    ...env
  }, () => service.assemble({
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}], selectedScope: 'US', initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore', myStocks: [], watchlist: []
  }));
  const context = result.marketPackages[0].evidenceContext;
  const scoreByUrl = new Map(pools.flatMap(({pool}) => pool.map(entry => [entry.url, entry.score])));
  const news = context.evidence.filter(entry => entry.item.evidenceCategory === 'news');
  return {context, news, scoreByUrl};
}

test('Step 9AB: a completed package offers every read Yahoo and CNBC article at or over the minimum score, best score first', async () => {
  const {context, news, scoreByUrl} = await assemblePackage();
  assert.ok(news.some(entry => entry.item.sourceId === 'us.yahoo-finance'));
  assert.ok(news.some(entry => entry.item.sourceId === 'us.cnbc'));
  for (const reading of context.furtherReadings) {
    assert.deepEqual(Object.keys(reading), ['evidenceRef', 'sessionDate', 'kind']);
    assert.equal(reading.kind, 'READ', 'no recap was found');
  }
  const offered = context.furtherReadings.map(reading => reading.evidenceRef);
  const itemOf = reference => news.find(entry => entry.reference === reference).item;
  const scores = offered.map(reference => scoreByUrl.get(itemOf(reference).canonicalUrl));
  assert.ok(scores.every(score => Number.isFinite(score) && score >= 12), JSON.stringify(scores));
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), 'best score first');
  const expected = news.filter(entry => scoreByUrl.get(entry.item.canonicalUrl) >= 12).map(entry => entry.reference);
  assert.deepEqual(offered.slice().sort(), expected.slice().sort());
  assert.ok(news.some(entry => scoreByUrl.get(entry.item.canonicalUrl) < 12), 'a weak article is left out');
});

test('Step 9AB: furtherReadingExtrasMinScore sets which read articles are offered (0: all of them; 58: none)', async () => {
  const all = await assemblePackage({env: {FURTHER_READING_EXTRAS_MIN_SCORE: '0'}});
  assert.deepEqual(all.context.furtherReadings.map(reading => reading.evidenceRef).sort(),
    all.news.map(entry => entry.reference).sort());
  const none = await assemblePackage({env: {FURTHER_READING_EXTRAS_MIN_SCORE: '58'}});
  assert.deepEqual(none.context.furtherReadings, []);
});

test('Step 9AB: a Pre-market package offers its read Yahoo articles too (live days had an empty list before)', async () => {
  const {context, news} = await assemblePackage({marketState: 'PRE', env: {FURTHER_READING_EXTRAS_MIN_SCORE: '0'}});
  assert.ok(news.length > 0);
  assert.ok(news.every(entry => entry.item.sourceId === 'us.yahoo-finance'), 'no CNBC on live days');
  assert.deepEqual(context.furtherReadings.map(reading => reading.evidenceRef).sort(),
    news.map(entry => entry.reference).sort());
  assert.ok(context.furtherReadings.every(reading => reading.kind === 'READ'));
});

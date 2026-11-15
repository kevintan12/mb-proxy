// Step 9F.6d Build B: CNBC news in Closed, Weekend and Holiday reports through
// the shared source reader (cnbcSharedReaderCompletedEnabled). Made-up lists,
// pages and text only: no real CNBC content, no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS} = require('../lib/cnbc-news-research-runtime');
const {createCnbcArticleContentAcquisitionService} = require('../lib/cnbc-article-content-acquisition');
const {
  CNBC_RSS_LIST_URL_PREFIX,
  createCnbcRssSource,
  isExcludedFamily,
  selectCnbcRssCandidates
} = require('../lib/sources/cnbc-rss');
const {
  CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
  createUsAnalysisPackageOrchestrationService
} = require('../lib/us-analysis-package-orchestration');

const GENERATED_AT = '2026-09-06T10:00:00.000Z'; // Sunday: WEEKEND, last close Fri 4 Sep 20:00Z
const COMPLETED_TIME = '2026-09-04T18:00:00.000Z';
const AFTER_CLOSE_TIME = '2026-09-05T12:00:00.000Z';
const SWITCH = 'CNBC_SHARED_READER_COMPLETED_ENABLED';

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

function request() {
  return {
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}],
    selectedScope: 'US',
    initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore',
    myStocks: [],
    watchlist: []
  };
}

function snapshot(symbol, marketState = 'CLOSED') {
  const sessions = [
    ['2026-08-31', 97, 96], ['2026-09-01', 98, 97], ['2026-09-02', 99, 98],
    ['2026-09-03', 100, 99], ['2026-09-04', 105, 100]
  ].map(([sessionDate, close, previousClose], index) => createCompletedRegularSession({
    market: 'US', sessionDate, open: close - 1, high: close + 5, low: close - 5,
    close, previousClose, volume: 900 + index * 25,
    asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  }));
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY', currency: 'USD',
    marketState, completedSessions: sessions, currentOverlay: null
  });
}

// A PRE snapshot for Tuesday 8 Sep (the completed sessions end Friday 4 Sep; 7 Sep is a holiday).
function preSnapshot(symbol) {
  const base = snapshot(symbol);
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: base.instrumentName, instrumentType: base.instrumentType,
    currency: base.currency, marketState: 'PRE', completedSessions: base.completedSessions,
    currentOverlay: createCurrentSessionOverlay({
      market: 'US', marketState: 'PRE', sessionDate: '2026-09-08', asOf: '2026-09-08T11:30:00.000Z',
      lastPrice: 106, referenceClose: 105, volume: 1200, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    })
  });
}

function yahooEvidence(symbol) {
  return createEvidenceCollection({market: 'US', items: [createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data',
    title: `${symbol} market data`, summary: `${symbol} factual market data.`,
    canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    publishedAt: '2026-09-05T20:00:00Z', symbols: [symbol]
  })]});
}

function fedEvidence() {
  return createEvidenceCollection({market: 'US', items: [createEvidenceItem({
    sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
    title: 'Federal Reserve policy statement',
    canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm',
    publishedAt: '2026-09-05T18:00:00Z', symbols: []
  })]});
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yahooCandidate = headline => ({
  headline, url: `https://finance.yahoo.com/news/${slug(headline)}.html`, uuid: null, publisher: 'Yahoo Finance'
});
const cnbcCandidate = (headline, listedAt = COMPLETED_TIME) => ({
  headline, url: `https://www.cnbc.com/2026/09/04/${slug(headline)}.html`, publisher: 'CNBC',
  listedAt, listId: '100003114', cnbcId: slug(headline), contentType: 'cnbcnewsstory'
});
const madeUpText = (kb, label) => `${label} made-up article text. `.repeat(Math.ceil(kb * 1024 / 30)).slice(0, kb * 1024);

// A made-up CNBC source in the shared reader's shape. `pages` maps an address
// to {publishedAt, kb} (missing: no usable article).
function fakeCnbcSource({listingOutcome = 'OK', candidates = [], pages = {}} = {}) {
  const calls = {find: 0, pages: []};
  const source = Object.freeze({
    sourceId: 'us.cnbc',
    async findCandidates() {
      calls.find++;
      const ok = listingOutcome === 'OK';
      return {ok, candidates: ok ? candidates : [], discoveryStats: {outcome: listingOutcome, lists: []}};
    },
    async readPage(url, {headline} = {}) {
      calls.pages.push(url);
      const page = pages[url];
      if (!page) {
        return {ok: false, type: 'NO_USABLE_ARTICLE', articleContent: null,
          extractionFailureType: 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT'};
      }
      return {ok: true, type: 'SUCCESS', articleContent: {
        sourceId: 'us.cnbc', canonicalUrl: url, headline, publisher: 'CNBC',
        publishedAt: page.publishedAt || COMPLETED_TIME, updatedAt: null,
        articleText: madeUpText(page.kb || 2, headline)
      }};
    }
  });
  return {source, calls};
}

function cnbcStories(count, {publishedAt = COMPLETED_TIME, kb = 2, prefix = 'Oil prices move markets in made-up CNBC story'} = {}) {
  const candidates = Array.from({length: count}, (_, index) => cnbcCandidate(`${prefix} ${index + 1}`));
  const pages = Object.fromEntries(candidates.map(candidate => [candidate.url, {publishedAt, kb}]));
  return {candidates, pages};
}

// The paid search's result shape (as today), `count` made-up items.
function paidResult(horizons, count) {
  const horizon = horizons.find(entry => entry.classification === 'COMPLETED_SESSION');
  const candidates = Array.from({length: count}, (_, index) => createNewsEvidenceCandidate({
    reference: `c${index + 1}`, horizon, sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: `Paid CNBC item ${index + 1}`, summary: `Paid summary ${index + 1}.`,
    extract: `Paid extract ${index + 1}.`, canonicalUrl: `https://www.cnbc.com/2026/09/04/paid-${index + 1}.html`,
    publishedAt: COMPLETED_TIME, symbols: []
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds}));
  return {
    ok: true, type: 'SUCCESS',
    candidateCollection: createNewsEvidenceCandidateCollection({market: 'US', candidates},
      {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds}),
    selections: [],
    retrievedArticles: candidates.map(candidate => ({reference: candidate.reference})),
    constructedEvidence: candidates.map(candidate => ({
      candidateReference: candidate.reference, horizon: candidate.horizon,
      evidenceItem: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: candidate.title,
        summary: candidate.extract, canonicalUrl: candidate.canonicalUrl,
        publishedAt: candidate.publishedAt, symbols: []
      })
    }))
  };
}

function build({
  cnbcNewsSource, yahooCount = 12, yahooKb = 2, paidCount = 1, classifier = 'OK',
  now = GENERATED_AT, marketState = 'CLOSED', snapshotFor = null, onCandidatePool
} = {}) {
  const diagnostics = [];
  const calls = {paid: 0, yahooPages: [], mostActive: 0};
  const yahooCandidates = Array.from({length: yahooCount}, (_, index) =>
    yahooCandidate(`Oil story number ${index + 1} in made-up Yahoo news`));
  const dependencies = {
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) { return snapshotFor ? snapshotFor(symbol) : snapshot(symbol, marketState); }
    }),
    snapshotPersistence: {async persistSnapshot(value) { return value; }},
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) { return yahooEvidence(symbol); }},
    yahooMostActiveAcquisition: {async acquireMostActive() {
      calls.mostActive++;
      return {ok: true, type: 'NOT_FOUND', candidates: []};
    }},
    yahooLatestNewsDiscovery: {async discoverLatestNews() {
      return {ok: true, type: 'SUCCESS', candidates: yahooCandidates};
    }},
    yahooCurrentNewsArticleContentAcquisition: {async acquireArticleContent(candidate) {
      calls.yahooPages.push(candidate.url);
      return {ok: true, type: 'SUCCESS', articleContent: {
        sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url, headline: candidate.headline,
        publisher: 'Yahoo Finance', publishedAt: marketState === 'PRE' ? '2026-09-08T11:00:00.000Z' : COMPLETED_TIME,
        updatedAt: null, articleText: madeUpText(yahooKb, candidate.headline)
      }};
    }},
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return fedEvidence(); }},
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
    cnbcNewsResearch: {async researchNews({horizons}) {
      calls.paid++;
      return paidCount === 0 ? {ok: true, type: 'NOT_FOUND'} : paidResult(horizons, paidCount);
    }},
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        if (classifier === 'FAIL') return {ok: false, type: 'CONTRACT_FAILURE', message: 'made-up failure'};
        return {ok: true, type: 'SUCCESS', output: {classifications: input.evidence.map(({reference}) => ({
          reference, materiality: 'LOW', roles: [], subjects: []
        }))}};
      },
      async repairEvidenceSubjects(input) {
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(({reference}) => ({reference, subjects: []}))}};
      }
    },
    now: () => new Date(now),
    onDiagnostics: value => diagnostics.push(value),
    ...(cnbcNewsSource ? {cnbcNewsSource} : {}),
    ...(onCandidatePool ? {onCandidatePool} : {})
  };
  return {service: createUsAnalysisPackageOrchestrationService(dependencies), diagnostics, calls};
}

// The switches these tests assume, pinned so a flipped environment switch
// (the switch-flip suite runs) never changes what they test. A test passes
// its own value to override one.
const PINNED = Object.freeze({
  [SWITCH]: 'on', ARTICLE_SLOTS_ENABLED: 'on', SLOT_SPILLOVER_ENABLED: 'on',
  CNBC_NO_SPECIAL_CONDITIONS_ENABLED: 'on', ARTICLE_TEXT_BUDGET_ENABLED: 'on',
  CNBC_RSS_FINDER_ENABLED: 'on', CNBC_PAGE_READER_ALIGNED_ENABLED: 'on'
});

async function run(options = {}, env = {}) {
  const built = build(options);
  const output = await withEnv({...PINNED, ...env}, () => built.service.assemble(request()));
  const context = output.marketPackages[0].evidenceContext;
  const evidence = context.evidence;
  const bySource = sourceId => evidence.filter(entry => entry.item.sourceId === sourceId
    && entry.item.evidenceCategory === 'news');
  return {...built, output, context, evidence, cnbc: bySource('us.cnbc'), yahooNews: bySource('us.yahoo-finance')};
}

// The diagnostics with the per-run timing numbers taken out (they differ run to run).
const withoutTimings = diagnostics => JSON.stringify(diagnostics.map(value => value.timing
  ? {timing: Object.keys(value.timing)} : value));
const stage = (diagnostics, name) => diagnostics.filter(value => value.stage === name);
const refNumber = entry => Number(entry.reference.slice(1));

test('Step 9F.6d Build B: CNBC is read first, keeps 3 articles after the base evidence and before Yahoo; Yahoo gets 7', async () => {
  const {candidates, pages} = cnbcStories(5);
  const {source, calls: cnbcCalls} = fakeCnbcSource({candidates, pages});
  const result = await run({cnbcNewsSource: source});
  assert.equal(result.cnbc.length, 3);
  assert.equal(result.yahooNews.length, 7);
  assert.equal(result.calls.paid, 0, 'no paid search when the lists loaded');
  assert.equal(cnbcCalls.find, 1);
  assert.equal(result.calls.mostActive, 1, 'Most Active is fetched once for both sources');
  const base = result.evidence.filter(entry => entry.item.evidenceCategory !== 'news');
  assert.ok(Math.max(...base.map(refNumber)) < Math.min(...result.cnbc.map(refNumber)));
  assert.ok(Math.max(...result.cnbc.map(refNumber)) < Math.min(...result.yahooNews.map(refNumber)));
  assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), false);
  const summary = stage(result.diagnostics, 'sourceNewsReading')[0];
  assert.deepEqual([summary.sourceId, summary.listingOutcome, summary.generalSlots, summary.spareSlots,
    summary.maxAdmittedArticles, summary.acquiredCurrentSessionCount], ['us.cnbc', 'OK', 3, 0, 3, 3]);
  const yahoo = stage(result.diagnostics, 'activeYahooAcquisition')[0];
  assert.deepEqual([yahoo.generalSlots, yahoo.spareSlots, yahoo.maxAdmittedArticles], [7, 0, 7]);
  // CNBC's reading comes before Yahoo's in the log, and CNBC news lands in Further Readings.
  const stages = result.diagnostics.map(value => value.stage);
  assert.ok(stages.indexOf('sourceNewsReading') < stages.indexOf('activeYahooAcquisition'));
  assert.equal(stage(result.diagnostics, 'cnbcPaidSearchFallback').length, 0);
  const furtherReadings = result.context.furtherReadings.map(entry => entry.evidenceRef);
  for (const entry of result.cnbc) assert.ok(furtherReadings.includes(entry.reference));
});

test('Step 9F.6d Build B: whatever CNBC leaves unused goes to Yahoo (CNBC 3/2/1/0 gives Yahoo 7/8/9/10)', async () => {
  for (const [usable, yahooExpected] of [[3, 7], [2, 8], [1, 9], [0, 10]]) {
    const {candidates, pages} = cnbcStories(4);
    const usablePages = Object.fromEntries(Object.entries(pages).slice(0, usable));
    const {source} = fakeCnbcSource({candidates, pages: usablePages});
    const result = await run({cnbcNewsSource: source});
    assert.equal(result.cnbc.length, usable, `CNBC ${usable}`);
    assert.equal(result.yahooNews.length, yahooExpected, `CNBC ${usable}`);
    assert.equal(stage(result.diagnostics, 'activeYahooAcquisition')[0].maxAdmittedArticles, yahooExpected);
    assert.equal(result.calls.paid, 0);
    assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), usable === 0);
  }
});

test('Step 9F.6d Build B: the 150 KB budget drops Yahoo, never CNBC', async () => {
  const {candidates, pages} = cnbcStories(3, {kb: 16});
  const {source} = fakeCnbcSource({candidates, pages});
  const result = await run({cnbcNewsSource: source, yahooKb: 16}, {ARTICLE_TEXT_BUDGET_BYTES_PLANNED: String(80 * 1024)});
  assert.equal(result.cnbc.length, 3, 'all 3 CNBC articles are kept');
  const drop = stage(result.diagnostics, 'writerTextBudgetDrop')[0];
  assert.ok(drop.droppedCount > 0);
  assert.equal(drop.dropped.every(entry => !entry.headline.includes('CNBC')), true);
  assert.equal('overBudget' in drop, false, 'under budget after the Yahoo drops: no overBudget field');
  assert.equal(result.yahooNews.length, 7 - drop.droppedCount);
});

test('Step 9F.6d Build B: still over the budget after every Yahoo drop is sent and logged as overBudget', async () => {
  const {candidates, pages} = cnbcStories(3, {kb: 16});
  const {source} = fakeCnbcSource({candidates, pages});
  const result = await run({cnbcNewsSource: source, yahooCount: 0},
    {ARTICLE_TEXT_BUDGET_BYTES_PLANNED: String(32 * 1024)});
  assert.equal(result.cnbc.length, 3);
  const drop = stage(result.diagnostics, 'writerTextBudgetDrop');
  assert.equal(drop.length, 1, 'logged even though nothing was dropped');
  assert.deepEqual([drop[0].droppedCount, drop[0].overBudget], [0, true]);
  // Switch off: no CNBC reading and no overBudget line (as before).
  const off = await run({cnbcNewsSource: source, yahooCount: 0},
    {ARTICLE_TEXT_BUDGET_BYTES_PLANNED: String(32 * 1024), [SWITCH]: 'off'});
  assert.equal(stage(off.diagnostics, 'writerTextBudgetDrop').length, 0);
});

test('Step 9F.6d Build B: every list failed, so the paid search runs once and keeps its first 3', async () => {
  for (const listingOutcome of ['ALL_LISTS_FAILED', 'FAILED']) {
    const {source, calls: cnbcCalls} = fakeCnbcSource({listingOutcome});
    const result = await run({cnbcNewsSource: source, paidCount: 5});
    assert.equal(result.calls.paid, 1, listingOutcome);
    assert.deepEqual(stage(result.diagnostics, 'cnbcPaidSearchFallback'),
      [{stage: 'cnbcPaidSearchFallback', reason: listingOutcome}]);
    assert.deepEqual(result.cnbc.map(entry => entry.item.title),
      ['Paid CNBC item 1', 'Paid CNBC item 2', 'Paid CNBC item 3']);
    assert.equal(result.yahooNews.length, 7);
    assert.equal(cnbcCalls.pages.length, 0);
  }
});

test('Step 9F.6d Build B: the paid fallback finding nothing leaves the gap line and gives Yahoo 10', async () => {
  const {source} = fakeCnbcSource({listingOutcome: 'ALL_LISTS_FAILED'});
  const result = await run({cnbcNewsSource: source, paidCount: 0});
  assert.equal(result.calls.paid, 1);
  assert.equal(result.cnbc.length, 0);
  assert.equal(result.yahooNews.length, 10);
  assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true);
  assert.deepEqual(stage(result.diagnostics, 'cnbcNewsResearchIntegration'), [{
    stage: 'cnbcNewsResearchIntegration', outcome: 'NOT_FOUND', failureType: 'NOT_FOUND',
    method: 'PAID_SEARCH_FALLBACK'
  }]);
});

test('Step 9F.6d Build B: lists loaded but nothing qualified is a real "no CNBC news" (no paid call)', async () => {
  // Published before the reading window: every CNBC page is rejected after download.
  const {candidates, pages} = cnbcStories(4, {publishedAt: '2026-09-01T12:00:00.000Z'});
  const {source, calls: cnbcCalls} = fakeCnbcSource({candidates, pages});
  const result = await run({cnbcNewsSource: source});
  assert.equal(cnbcCalls.pages.length, 4);
  assert.equal(result.calls.paid, 0);
  assert.equal(result.cnbc.length, 0);
  assert.equal(result.yahooNews.length, 10);
  assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true);
  assert.deepEqual(stage(result.diagnostics, 'cnbcNewsResearchIntegration'), [{
    stage: 'cnbcNewsResearchIntegration', outcome: 'NOT_FOUND', failureType: 'NOT_FOUND', method: 'SHARED_READER'
  }]);
  // A list that loaded with no candidates at all: the same answer.
  const empty = await run({cnbcNewsSource: fakeCnbcSource({candidates: []}).source});
  assert.equal(empty.calls.paid, 0);
  assert.equal(empty.yahooNews.length, 10);
});

// Made-up RSS lists and pages for the real CNBC source (finder + page reader).
function rssList(items) {
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Made up</title>'
    + items.map(item => `<item><title>${item.title}</title><link>${item.url}</link>`
      + '<pubDate>Fri, 04 Sep 2026 18:00:00 GMT</pubDate></item>').join('') + '</channel></rss>';
}

function realCnbcSource({env, listItems, pageFetch}) {
  const fetchCalls = [];
  const fetchImpl = async url => {
    fetchCalls.push(url);
    if (url.startsWith(CNBC_RSS_LIST_URL_PREFIX)) {
      return {ok: true, status: 200, url, headers: {get: name => name === 'content-type' ? 'application/rss+xml' : null},
        text: async () => rssList(listItems)};
    }
    return pageFetch(url);
  };
  const pageReader = createCnbcArticleContentAcquisitionService({fetchImpl, env});
  return {source: createCnbcRssSource({fetchImpl, env, pageReader, excludeLiveBlog: true}), fetchCalls};
}

test('Step 9F.6d Build B: finder off and page reader off each leave the gap line, Yahoo 10 and no paid call', async () => {
  const listItems = [{title: 'Oil prices move markets in a made-up CNBC story', url: 'https://www.cnbc.com/2026/09/04/made-up-a.html'}];
  const pageFetch = async () => { throw new Error('no page download expected'); };
  for (const env of [{CNBC_RSS_FINDER_ENABLED: 'off'}, {CNBC_PAGE_READER_ALIGNED_ENABLED: 'off'}]) {
    const {source, fetchCalls} = realCnbcSource({env, listItems, pageFetch});
    const result = await run({cnbcNewsSource: source});
    const label = Object.keys(env)[0];
    assert.equal(result.calls.paid, 0, label);
    assert.equal(result.cnbc.length, 0, label);
    assert.equal(result.yahooNews.length, 10, label);
    assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true, label);
    assert.equal(fetchCalls.some(url => !url.startsWith(CNBC_RSS_LIST_URL_PREFIX)), false, label);
    if (label === 'CNBC_RSS_FINDER_ENABLED') assert.equal(fetchCalls.length, 0);
    else assert.equal(fetchCalls.length, 7);
  }
});

test('Step 9F.6d Build B: the live blog is skipped before download (as an excluded family)', async () => {
  const liveBlog = 'https://www.cnbc.com/2026/09/04/stock-market-today-live-updates.html';
  const lists = [{listId: '100003114', outcome: 'OK', items: [
    {url: liveBlog, title: 'Stock market today: made-up live blog', listedAt: COMPLETED_TIME, cnbcId: '1', contentType: 'cnbcnewsstory'},
    {url: 'https://www.cnbc.com/2026/09/04/made-up-b.html', title: 'Made-up story', listedAt: COMPLETED_TIME, cnbcId: '2', contentType: 'cnbcnewsstory'}
  ]}];
  const skipped = selectCnbcRssCandidates(lists, {maxCandidates: 40, excludeLiveBlog: true});
  assert.deepEqual(skipped.candidates.map(candidate => candidate.url), ['https://www.cnbc.com/2026/09/04/made-up-b.html']);
  assert.deepEqual([skipped.counts.excludedFamilyCount, skipped.counts.liveBlogSkippedCount], [1, 1]);
  // Left out (the probe, Build A): exactly as before, no new count.
  const before = selectCnbcRssCandidates(lists, {maxCandidates: 40});
  assert.equal(before.candidates.length, 2);
  assert.equal('liveBlogSkippedCount' in before.counts, false);
  assert.equal(isExcludedFamily({url: liveBlog, contentType: 'cnbcnewsstory'}), false);
  assert.equal(isExcludedFamily({url: liveBlog, contentType: 'cnbcnewsstory'}, {excludeLiveBlog: true}), true);
  assert.equal(isExcludedFamily({url: 'https://www.cnbc.com/2026/09/04/stock-market-today-recap.html',
    contentType: 'cnbcnewsstory'}, {excludeLiveBlog: true}), false);
  // End to end: the real source never downloads it.
  const {source, fetchCalls} = realCnbcSource({env: {}, listItems: [{title: 'Made-up live blog', url: liveBlog}],
    pageFetch: async () => { throw new Error('no page download expected'); }});
  const result = await run({cnbcNewsSource: source});
  assert.equal(fetchCalls.includes(liveBlog), false);
  assert.equal(stage(result.diagnostics, 'sourceNewsReading')[0].liveBlogSkippedCount, 7);
});

test('Step 9F.6d Build B: a failed classifier keeps CNBC news, like Yahoo (switch off: dropped as before)', async () => {
  const {candidates, pages} = cnbcStories(3);
  const on = await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source, classifier: 'FAIL'});
  assert.equal(on.cnbc.length, 3);
  assert.equal(on.yahooNews.length, 7);
  assert.equal(stage(on.diagnostics, 'evidenceRoleClassificationFallback').length, 1);
  const off = await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source, classifier: 'FAIL'}, {[SWITCH]: 'off'});
  assert.equal(off.cnbc.length, 0, 'switch off: today\'s drop on classifier failure');
  // Paid-fallback CNBC too (no special case).
  const fallback = await run({cnbcNewsSource: fakeCnbcSource({listingOutcome: 'ALL_LISTS_FAILED'}).source,
    paidCount: 2, classifier: 'FAIL'});
  assert.equal(fallback.cnbc.length, 2);
  assert.equal(fallback.yahooNews.length, 8);
});

test('Step 9F.6d Build B: after-close CNBC news is kept apart as a subsequent development', async () => {
  const {candidates, pages} = cnbcStories(2, {publishedAt: AFTER_CLOSE_TIME});
  const result = await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source});
  assert.equal(result.cnbc.length, 2);
  assert.ok(result.cnbc.every(entry => result.context.subsequentDevelopments.includes(entry.reference)));
  assert.ok(result.cnbc.every(entry => !result.context.supportingEvidence.includes(entry.reference)));
});

test('Step 9F.6d Build B: switch off, or no CNBC source, is the old paid path exactly', async () => {
  const {candidates, pages} = cnbcStories(3);
  const noSource = await run({});
  const switchOff = await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source}, {[SWITCH]: 'off'});
  const noSourceSwitchOn = await run({}, {[SWITCH]: 'on'});
  for (const result of [noSource, switchOff, noSourceSwitchOn]) {
    assert.equal(result.calls.paid, 1);
    assert.equal(stage(result.diagnostics, 'sourceNewsReading').length, 0);
    assert.equal(result.yahooNews.length, 10);
  }
  assert.equal(JSON.stringify(switchOff.output), JSON.stringify(noSource.output));
  assert.equal(withoutTimings(switchOff.diagnostics), withoutTimings(noSource.diagnostics));
  assert.equal(JSON.stringify(noSourceSwitchOn.output), JSON.stringify(noSource.output));
  assert.equal(withoutTimings(noSourceSwitchOn.diagnostics), withoutTimings(noSource.diagnostics));
});

test('Step 9F.6d Build B: Pre-market is untouched (CNBC never read, same output with the switch on or off)', async () => {
  const runPre = async env => {
    const {candidates, pages} = cnbcStories(3);
    const fake = fakeCnbcSource({candidates, pages});
    const result = await run({cnbcNewsSource: fake.source, now: '2026-09-08T12:00:00.000Z',
      marketState: 'PRE', snapshotFor: preSnapshot}, env);
    return {result, fake};
  };
  const on = await runPre({[SWITCH]: 'on'});
  const off = await runPre({[SWITCH]: 'off'});
  for (const {result, fake} of [on, off]) {
    assert.equal(fake.calls.find, 0);
    assert.equal(result.calls.paid, 0);
    assert.equal(result.output.marketPackages[0].marketContext.marketState, 'PRE');
  }
  assert.equal(JSON.stringify(on.result.output), JSON.stringify(off.result.output));
  assert.equal(withoutTimings(on.result.diagnostics), withoutTimings(off.result.diagnostics));
});

test('Step 9F.6d Build B: the candidate pool hook gets the CNBC pool too', async () => {
  const pools = [];
  const {candidates, pages} = cnbcStories(2);
  await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source, onCandidatePool: value => pools.push(value)});
  assert.deepEqual(pools.map(value => value.sourceId), ['us.yahoo-finance', 'us.cnbc']);
  assert.equal(pools[1].pool.length, 2);
});

test('Step 9F.6d Build B: a bad CNBC source is refused when the service is built', () => {
  assert.throws(() => build({cnbcNewsSource: {sourceId: 'us.cnbc', findCandidates() {}}}), TypeError);
  assert.throws(() => build({cnbcNewsSource: {sourceId: 'us.yahoo-finance', findCandidates() {}, readPage() {}}}), TypeError);
});

// Build B fix: the "no CNBC news" gap is decided after the slot cut, so no
// CNBC article kept always gives the gap line, from the lists or the fallback.
// With cnbcSlots 0 CNBC has no slots to leave unused, so Yahoo's cap is its
// own 7 (the Build A slot rule; the same as with the switch off).
test('Step 9F.6d Build B fix: cnbcSlots 0 with the paid fallback finding results gives the gap line (Yahoo 7, as switch off)', async () => {
  const off = await run({paidCount: 5}, {CNBC_SLOTS: '0', [SWITCH]: 'off'});
  assert.equal(stage(off.diagnostics, 'activeYahooAcquisition')[0].maxAdmittedArticles, 7);
  for (const listingOutcome of ['ALL_LISTS_FAILED', 'FAILED']) {
    const {source} = fakeCnbcSource({listingOutcome});
    const result = await run({cnbcNewsSource: source, paidCount: 5}, {CNBC_SLOTS: '0'});
    assert.equal(result.calls.paid, 1, listingOutcome);
    assert.equal(result.cnbc.length, 0, listingOutcome);
    assert.equal(result.yahooNews.length, 7, listingOutcome);
    assert.equal(stage(result.diagnostics, 'activeYahooAcquisition')[0].maxAdmittedArticles, 7);
    assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true, listingOutcome);
    assert.deepEqual(stage(result.diagnostics, 'cnbcNewsResearchIntegration'), [{
      stage: 'cnbcNewsResearchIntegration', outcome: 'NOT_FOUND', failureType: 'NOT_FOUND',
      method: 'PAID_SEARCH_FALLBACK'
    }]);
  }
});

test('Step 9F.6d Build B fix: cnbcSlots 0 with working lists gives the gap line (Yahoo 7, no paid call)', async () => {
  const {candidates, pages} = cnbcStories(5);
  const {source} = fakeCnbcSource({candidates, pages});
  const result = await run({cnbcNewsSource: source}, {CNBC_SLOTS: '0'});
  assert.equal(result.calls.paid, 0);
  assert.equal(result.cnbc.length, 0);
  assert.equal(result.yahooNews.length, 7);
  assert.equal(stage(result.diagnostics, 'activeYahooAcquisition')[0].maxAdmittedArticles, 7);
  assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true);
  assert.equal(stage(result.diagnostics, 'cnbcPaidSearchFallback').length, 0);
});

test('Step 9F.6d Build B fix: cnbcSlots 3 is unchanged (lists and fallback keep 3, no gap line, Yahoo 7)', async () => {
  const {candidates, pages} = cnbcStories(5);
  const lists = await run({cnbcNewsSource: fakeCnbcSource({candidates, pages}).source}, {CNBC_SLOTS: '3'});
  const fallback = await run({cnbcNewsSource: fakeCnbcSource({listingOutcome: 'ALL_LISTS_FAILED'}).source,
    paidCount: 5}, {CNBC_SLOTS: '3'});
  for (const result of [lists, fallback]) {
    assert.equal(result.cnbc.length, 3);
    assert.equal(result.yahooNews.length, 7);
    assert.equal(result.context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), false);
    assert.equal(stage(result.diagnostics, 'cnbcNewsResearchIntegration').length, 0);
  }
});

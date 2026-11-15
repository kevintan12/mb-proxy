// Step 9V.3: since-the-close fixes (switch sinceCloseFixesEnabled, default on). Free tests only:
// no network, no paid call. Every address, page and reply here is made up.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {withEnv} = require('./fixtures/step-8w-switches');
const {MARKET_STATE_CASES, activeUsInput} = require('./fixtures/market-state-cases');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {
  isCnbcLiveBlogPath,
  isUnrecognisedCnbcLiveBlogPath,
  isDeterministicCnbcRecapUrl,
  otherCnbcLiveBlogUrl
} = require('../lib/cnbc-deterministic-recap-discovery');
const {createCnbcRecapResearchRuntime} = require('../lib/cnbc-recap-research-runtime');
const {isExcludedFamily, selectCnbcRssCandidates} = require('../lib/sources/cnbc-rss');
const {canonicalCnbcMarketNewsUrl} = require('../lib/claude-bounded-cnbc-market-news-discovery');
const {createEvidenceItem, validateEvidenceItemInput} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createClaudeAnalysisInput, splitReportSentences} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {sinceCloseCoverage, isSinceClosePointerSentence} = require('../lib/section-rules');

const ENV = 'SINCE_CLOSE_FIXES_ENABLED';
const on = fn => withEnv(ENV, 'on', fn);
const off = fn => withEnv(ENV, 'off', fn);

const OLD_NAME = 'stock-market-today-live-updates.html';
const NEW_NAME = 'stock-market-today-live-update.html';

// --- switch -----------------------------------------------------------------

test('Step 9V.3: sinceCloseFixesEnabled is a registered Admin on/off setting, on by default, next to completedSinceCloseEnabled', () => {
  const entry = SETTINGS_REGISTRY.sinceCloseFixesEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('sinceCloseFixesEnabled', {env: {}}), true);
  assert.equal(settingValue('sinceCloseFixesEnabled', {env: {[ENV]: 'false'}}), false);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('sinceCloseFixesEnabled'), names.indexOf('completedSinceCloseEnabled') + 1);
});

// --- Fix 1: the live-blog address rule ---------------------------------------

test('Step 9V.3: switch on, both live-blog names are recognised; near misses are not', () => on(() => {
  for (const path of [`/2026/10/22/${OLD_NAME}`, `/2026/10/22/${NEW_NAME}`]) {
    assert.equal(isCnbcLiveBlogPath(path), true, path);
  }
  for (const path of [
    '/2026/10/22/stock-market-today-live-updatess.html', '/2026/10/22/stock-market-today-live_update.html',
    '/2026/10/22/stock-market-today-live-blog.html', '/2026/10/stock-market-today-live-update.html',
    '/26/10/22/stock-market-today-live-update.html', '/2026/10/22/x/stock-market-today-live-update.html',
    `/2026/10/22/${NEW_NAME}/`, `/2026/10/22/${NEW_NAME.toUpperCase()}`, ''
  ]) {
    assert.equal(isCnbcLiveBlogPath(path), false, path);
  }
  assert.equal(isCnbcLiveBlogPath(`/2026/10/22/${NEW_NAME}/`, {trailingSlash: true}), true);
  assert.equal(isCnbcLiveBlogPath(`/2026/10/22/${NEW_NAME.toUpperCase()}`, {ignoreCase: true}), true);
}));

test('Step 9V.3: switch off, only the old name is recognised, exactly as before', () => off(() => {
  assert.equal(isCnbcLiveBlogPath(`/2026/10/22/${OLD_NAME}`), true);
  assert.equal(isCnbcLiveBlogPath(`/2026/10/22/${NEW_NAME}`), false);
  assert.equal(isDeterministicCnbcRecapUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`, '2026-10-23'), false);
}));

test('Step 9V.3: the built recap address under either name is accepted only for its own session date', () => on(() => {
  assert.equal(isDeterministicCnbcRecapUrl(`https://www.cnbc.com/2026/10/22/${OLD_NAME}`, '2026-10-23'), true);
  assert.equal(isDeterministicCnbcRecapUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`, '2026-10-23'), true);
  assert.equal(isDeterministicCnbcRecapUrl(`https://www.cnbc.com/2026/10/21/${NEW_NAME}`, '2026-10-23'), false);
  assert.equal(isDeterministicCnbcRecapUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`, '2026-10-24'), false);
  assert.equal(otherCnbcLiveBlogUrl(`https://www.cnbc.com/2026/10/22/${OLD_NAME}`),
    `https://www.cnbc.com/2026/10/22/${NEW_NAME}`);
  assert.equal(otherCnbcLiveBlogUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`),
    `https://www.cnbc.com/2026/10/22/${OLD_NAME}`);
  assert.equal(otherCnbcLiveBlogUrl('https://www.cnbc.com/2026/10/22/other.html'), null);
}));

test('Step 9V.3: a live-blog-looking address the rule does not know is flagged; known names and articles are not', () => on(() => {
  assert.equal(isUnrecognisedCnbcLiveBlogPath('/2026/10/22/stock-market-today-live-blog.html'), true);
  assert.equal(isUnrecognisedCnbcLiveBlogPath('/2026/10/22/markets-live-updates-today.html'), true);
  assert.equal(isUnrecognisedCnbcLiveBlogPath(`/2026/10/22/${NEW_NAME}`), false);
  assert.equal(isUnrecognisedCnbcLiveBlogPath(`/2026/10/22/${OLD_NAME}`), false);
  assert.equal(isUnrecognisedCnbcLiveBlogPath('/2026/10/22/apple-nvidia-market-cap.html'), false);
}));

// --- Fix 1: the CNBC news list ------------------------------------------------

function cnbcList(urls) {
  return [{listId: 'made-up-list', outcome: 'OK', httpStatus: 200, items: urls.map((url, index) => ({
    url, title: `Made-up headline ${index + 1}`, listedAt: '2026-10-23T21:00:00.000Z',
    cnbcId: `id-${index + 1}`, contentType: 'cnbcnewsstory', sponsored: false
  }))}];
}

test('Step 9V.3: switch on, the renamed live blog is skipped before download and an unknown live-blog address is counted', () => on(() => {
  const liveBlog = `https://www.cnbc.com/2026/10/22/${NEW_NAME}`;
  assert.equal(isExcludedFamily({url: liveBlog}, {excludeLiveBlog: true}), true);
  const {candidates, counts} = selectCnbcRssCandidates(cnbcList([
    liveBlog, 'https://www.cnbc.com/2026/10/23/stock-market-today-live-blog.html',
    'https://www.cnbc.com/2026/10/23/apple-nvidia-market-cap.html'
  ]), {maxCandidates: 10, excludeLiveBlog: true});
  assert.equal(counts.liveBlogSkippedCount, 1);
  assert.equal(counts.liveBlogUnrecognisedCount, 1);
  assert.deepEqual(counts.liveBlogUnrecognisedPaths, ['/2026/10/23/stock-market-today-live-blog.html']);
  assert.equal(candidates.some(candidate => candidate.url === liveBlog), false);
}));

test('Step 9V.3: switch off, the renamed live blog passes the list as before and nothing new is counted', () => off(() => {
  const liveBlog = `https://www.cnbc.com/2026/10/22/${NEW_NAME}`;
  assert.equal(isExcludedFamily({url: liveBlog}, {excludeLiveBlog: true}), false);
  const {candidates, counts} = selectCnbcRssCandidates(cnbcList([liveBlog,
    'https://www.cnbc.com/2026/10/23/stock-market-today-live-blog.html']), {maxCandidates: 10, excludeLiveBlog: true});
  assert.equal(counts.liveBlogSkippedCount, 0);
  assert.equal(Object.hasOwn(counts, 'liveBlogUnrecognisedCount'), false);
  assert.equal(candidates.some(candidate => candidate.url === liveBlog), true);
}));

test('Step 9V.3: the unknown-address count needs the live-blog option and is absent when zero', () => on(() => {
  const lists = cnbcList(['https://www.cnbc.com/2026/10/23/stock-market-today-live-blog.html']);
  assert.equal(Object.hasOwn(selectCnbcRssCandidates(lists, {maxCandidates: 10}).counts,
    'liveBlogUnrecognisedCount'), false);
  assert.equal(Object.hasOwn(selectCnbcRssCandidates(cnbcList(['https://www.cnbc.com/2026/10/23/a.html']),
    {maxCandidates: 10, excludeLiveBlog: true}).counts, 'liveBlogUnrecognisedCount'), false);
}));

test('Step 9V.3: the paid CNBC search path rejects the live blog under either name (switch on)', async () => {
  await on(() => assert.equal(canonicalCnbcMarketNewsUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`), null));
  await off(() => assert.equal(canonicalCnbcMarketNewsUrl(`https://www.cnbc.com/2026/10/22/${NEW_NAME}`),
    `https://www.cnbc.com/2026/10/22/${NEW_NAME}`));
});

test('Step 9V.3: a CNBC recap with no readable publish time is allowed under the new name only with the switch on', async () => {
  const input = {sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title: 'Made-up recap',
    canonicalUrl: `https://www.cnbc.com/2026/10/22/${NEW_NAME}`, publishedAt: null, symbols: []};
  await on(() => assert.equal(validateEvidenceItemInput(input).valid, true));
  await off(() => assert.equal(validateEvidenceItemInput(input).valid, false));
  await on(() => assert.equal(validateEvidenceItemInput({...input,
    canonicalUrl: 'https://www.cnbc.com/2026/10/22/stock-market-today-live-blog.html'}).valid, false));
});

// --- Fix 1: the recap fetch ---------------------------------------------------

const TARGET = '2026-09-16';
const OLD_URL = `https://www.cnbc.com/2026/09/15/${OLD_NAME}`;
const NEW_URL = `https://www.cnbc.com/2026/09/15/${NEW_NAME}`;
const HORIZONS = [
  {classification: 'COMPLETED_SESSION', startsAtExclusive: '2026-09-15T20:00:00.000Z',
    endsAtInclusive: '2026-09-16T20:00:00.000Z'},
  {classification: 'SUBSEQUENT_DEVELOPMENT', startsAtExclusive: '2026-09-16T20:00:00.000Z',
    endsAtInclusive: '2026-09-17T20:00:00.000Z'}
];
const LIVE_BLOG_HTML = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'LiveBlogPosting',
  headline: 'Made-up stocks close higher',
  datePublished: '2026-09-16T12:00:00Z',
  liveBlogUpdate: [{
    '@type': 'BlogPosting', datePublished: '2026-09-16T20:06:00Z',
    dateModified: '2026-09-16T20:10:00Z', articleBody: 'Made-up: US stocks closed higher Wednesday.'
  }]
})}</script>`;

function recapFetch(answers) {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const status = answers[url] ?? 404;
    return status === 200
      ? {ok: true, status, url, headers: {get: name => name === 'content-type' ? 'text/html' : null},
        async text() { return LIVE_BLOG_HTML; }}
      : {ok: false, status, url, headers: {get: () => null}};
  };
  return {fetchImpl, requests};
}

async function researchRecap(answers) {
  const {fetchImpl, requests} = recapFetch(answers);
  const diagnostics = [];
  const service = createCnbcRecapResearchRuntime({fetchImpl, onDiagnostics: value => diagnostics.push(value)});
  const result = await service.researchCompletedSessionRecap({targetSessionDate: TARGET, horizons: HORIZONS});
  return {result, requests, diagnostics};
}

test('Step 9V.3: missing old-name CNBC page tries the new name once and never invokes Claude (switch on)', () => on(async () => {
  const {result, requests, diagnostics} = await researchRecap({});
  assert.equal(result.type, 'ARTICLE_ACQUISITION_FAILURE');
  assert.equal(result.failureType, 'HTTP_FAILURE');
  assert.deepEqual(requests, [OLD_URL, NEW_URL]);
  assert.equal(requests.some(url => url.includes('anthropic')), false);
  assert.deepEqual(diagnostics.find(d => d.stage === 'cnbcRecapAddress'),
    {stage: 'cnbcRecapAddress', provider: 'CNBC', outcome: 'NOT_RECOGNISED', firstStatus: 404, otherStatus: 404});
}));

test('Step 9V.3: the old name not found and the new name found: the recap is taken under the new name and logged', () => on(async () => {
  const {result, requests, diagnostics} = await researchRecap({[NEW_URL]: 200});
  assert.equal(result.type, 'SUCCESS', JSON.stringify(result));
  assert.deepEqual(requests, [OLD_URL, NEW_URL]);
  assert.equal(result.constructedEvidence.evidenceItem.canonicalUrl, NEW_URL);
  assert.equal(result.constructedEvidence.horizon, null);
  assert.deepEqual(diagnostics.filter(d => d.stage === 'cnbcRecapAddress'),
    [{stage: 'cnbcRecapAddress', provider: 'CNBC', outcome: 'OTHER_NAME_TAKEN', firstStatus: 404}]);
}));

test('Step 9V.3: a moved old name (301) also tries the new name; a server error (503) does not', () => on(async () => {
  const moved = await researchRecap({[OLD_URL]: 301, [NEW_URL]: 200});
  assert.equal(moved.result.type, 'SUCCESS');
  assert.deepEqual(moved.requests, [OLD_URL, NEW_URL]);
  const failed = await researchRecap({[OLD_URL]: 503, [NEW_URL]: 200});
  assert.equal(failed.result.failureType, 'HTTP_FAILURE');
  assert.deepEqual(failed.requests, [OLD_URL]);
  assert.equal(failed.diagnostics.some(d => d.stage === 'cnbcRecapAddress'), false);
}));

test('Step 9V.3: the old name found is read as before with one request and no new log line', () => on(async () => {
  const {result, requests, diagnostics} = await researchRecap({[OLD_URL]: 200, [NEW_URL]: 200});
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(requests, [OLD_URL]);
  assert.equal(result.constructedEvidence.evidenceItem.canonicalUrl, OLD_URL);
  assert.equal(diagnostics.some(d => d.stage === 'cnbcRecapAddress'), false);
}));

test('Step 9V.3: switch off, a missing old-name page is one request and no new log line, exactly as before', () => off(async () => {
  const {result, requests, diagnostics} = await researchRecap({[NEW_URL]: 200});
  assert.equal(result.failureType, 'HTTP_FAILURE');
  assert.deepEqual(requests, [OLD_URL]);
  assert.equal(diagnostics.some(d => d.stage === 'cnbcRecapAddress'), false);
}));

// --- Fixes 3 to 5: completed-day writer request and finished report -------------

const COMPLETED_TIMES = {
  CLOSED: '2026-09-04T22:00:00.000Z', WEEKEND: '2026-09-06T10:00:00.000Z', HOLIDAY: '2026-09-07T16:00:00.000Z'
};

function snapshot(symbol, marketState, instrumentType = 'INDEX') {
  const facts = [
    ['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]
  ];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`, instrumentType,
    currency: 'USD', marketState, currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2,
        close, previousClose, volume: 1000 + index,
        asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
      }))
  });
}

function item(sourceId, title, canonicalUrl, publishedAt, evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols: [],
    ...(sourceId === 'us.yahoo-finance' ? {publisher: 'Yahoo Finance'} : {})
  });
}

// e1 Yahoo recap, e2 CNBC session news, e3 Federal Reserve, e4 Broadcom (focus), e5 Netflix (after
// the close, focus, home Section 3, 4:30 pm ET), e6 Treasury yields (after the close, home Section 1,
// 5:15 pm ET; left out with allSectionThree).
function completedInput({marketState = 'CLOSED', afterClose = true, allSectionThree = false} = {}) {
  const evidence = [
    item('us.yahoo-finance', 'Made-up stocks close higher',
      'https://finance.yahoo.com/markets/live/stock-market-today-made-up.html', '2026-09-04T21:00:00Z'),
    item('us.cnbc', 'Made-up market news for Sept. 4',
      'https://www.cnbc.com/2026/09/04/made-up-market-news.html', '2026-09-04T19:30:00Z'),
    item('us.federal-reserve', 'Made-up Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', 'monetary-policy'),
    item('us.cnbc', 'Broadcom leads made-up semiconductor shares',
      'https://www.cnbc.com/2026/09/04/broadcom-made-up.html', '2026-09-04T19:00:00Z'),
    ...(afterClose ? [
      item('us.yahoo-finance', 'Netflix gives a made-up weaker forecast',
        'https://finance.yahoo.com/news/netflix-made-up.html', '2026-09-04T20:30:00Z')
    ] : []),
    ...(afterClose && !allSectionThree ? [
      item('us.yahoo-finance', 'Made-up Treasury yields edge up in evening trading',
        'https://finance.yahoo.com/news/treasury-made-up.html', '2026-09-04T21:15:00Z')
    ] : [])
  ];
  const sinceClose = !afterClose ? [] : allSectionThree ? ['e5'] : ['e5', 'e6'];
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks', generatedAt: COMPLETED_TIMES[marketState],
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {benchmarkSnapshots: [snapshot('^GSPC', marketState)],
        stockSnapshots: [snapshot('MSFT', marketState, 'EQUITY')]},
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', ...(afterClose ? ['e5'] : [])],
        authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'],
        supportingEvidence: ['e2', 'e3', 'e4'],
        conflictingEvidence: [],
        subsequentDevelopments: ['e1', ...sinceClose],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          ...(afterClose ? [{evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Netflix'}]}] : [])
        ],
        unresolvedGaps: [],
        furtherReadings: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        sinceCloseDevelopments: sinceClose
      }
    }],
    portfolioContext: {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2'], upcomingEvents: []}],
      watchlist: []
    }
  });
}

const SCOPE_SENTENCE = 'the rest of this paragraph applies only to subsequentDevelopments with no sinceCloseHomeSection.';

for (const marketState of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
  test(`Step 9V.3: ${marketState} with since-close items gets the scoped later-news line once, every old phrase kept`, () => on(async () => {
    const system = buildClaudeAnalysisRequest(completedInput({marketState})).system;
    assert.equal(system.split(SCOPE_SENTENCE).length, 2);
    for (const phrase of ['especially Section 7 WHAT TO WATCH FOR NEXT',
      'Do not include subsequentDevelopments when they are immaterial to the report',
      'Never cite subsequentDevelopments as causes of the earlier primary completed-session move']) {
      assert.equal(system.includes(phrase), true, phrase);
    }
    const offSystem = await off(() => buildClaudeAnalysisRequest(completedInput({marketState})).system);
    assert.equal(offSystem.includes(SCOPE_SENTENCE), false);
    assert.equal(system.replace(/Items marked sinceLastClose with a sinceCloseHomeSection [^;]+; the rest of this paragraph applies only to subsequentDevelopments with no sinceCloseHomeSection\. /, ''), offSystem);
  }));
}

test('Step 9V.3: a completed day with no since-close items keeps the later-news line exactly as before', () => on(async () => {
  const input = completedInput({afterClose: false});
  const system = buildClaudeAnalysisRequest(input).system;
  assert.equal(system.includes(SCOPE_SENTENCE), false);
  assert.equal(system, await off(() => buildClaudeAnalysisRequest(input).system));
}));

test('Step 9V.3: PRE, REGULAR and POST writer requests are byte-identical with the switch on or off', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES.slice(0, 3)) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const withOn = await on(() => JSON.stringify(buildClaudeAnalysisRequest(input)));
    const withOff = await off(() => JSON.stringify(buildClaudeAnalysisRequest(input)));
    assert.equal(withOn, withOff, marketState);
  }
});

// --- Fixes 3 and 5: the coverage check ---------------------------------------

function sections(contents, sectionThreeRefs = []) {
  return Array.from({length: 8}, (_, index) => ({
    content: contents[index] ?? null, evidenceRefs: index === 2 ? sectionThreeRefs : []
  }));
}

// The 24 Oct shape (made-up words): one Section 1 item, four Section 3 items.
const OCT_ITEMS = [
  {evidenceRef: 'e39', homeSectionIndex: 0, publishedEt: 'Fri 23 Oct, 4:06 pm ET'},
  {evidenceRef: 'e40', homeSectionIndex: 2, publishedEt: 'Fri 23 Oct, 9:37 pm ET'},
  {evidenceRef: 'e41', homeSectionIndex: 2, publishedEt: 'Fri 23 Oct, 5:39 pm ET'},
  {evidenceRef: 'e42', homeSectionIndex: 2, publishedEt: 'Fri 23 Oct, 5:12 pm ET'},
  {evidenceRef: 'e49', homeSectionIndex: 2, publishedEt: 'Fri 23 Oct, 9:10 pm ET'}
];
const OCT_S1 = 'The three major indexes closed lower on Friday. Technology stocks held up. Oil rose.';
const OCT_S3 = 'Apple briefly passed Nvidia in market value. Following the close, a made-up commentator named '
  + 'Nvidia as a buy. Cybersecurity shares rose.';

test('Step 9V.3: the 24 Oct shape warns for the missing Section 1 paragraph and the two untimed Section 3 items', () => {
  const result = sinceCloseCoverage(sections([OCT_S1, 'x', OCT_S3], ['e37', 'e40', 'e41']), OCT_ITEMS,
    splitReportSentences);
  assert.deepEqual(result, {sectionOne: 'MISSING', untimedSectionThreeRefs: ['e40', 'e41'],
    warnings: ['SINCE_CLOSE_PARAGRAPH_MISSING', 'SINCE_CLOSE_TIME_MISSING'], warningCount: 3});
});

test('Step 9V.3: after the CNBC fix (all items in Section 3) the same text still warns, and a pointer sentence clears it', () => {
  const items = OCT_ITEMS.slice(1);
  assert.equal(sinceCloseCoverage(sections([OCT_S1]), items, splitReportSentences).sectionOne, 'MISSING');
  const pointer = `${OCT_S1} After the close, Nvidia and Alphabet were in the news (see Stocks & Sectors in Focus).`;
  assert.deepEqual(sinceCloseCoverage(sections([pointer]), items, splitReportSentences),
    {sectionOne: 'POINTER', untimedSectionThreeRefs: [], warnings: [], warningCount: 0});
});

test('Step 9V.3: Section 1 items need their own publish time; a pointer or an unlisted time does not count', () => {
  const pointerOnly = `${OCT_S1} After the close, Nvidia was in the news.`;
  assert.equal(sinceCloseCoverage(sections([pointerOnly]), OCT_ITEMS, splitReportSentences).sectionOne, 'MISSING');
  const wrongTime = `${OCT_S1} At 4:07 pm ET on Friday, CNBC reported that stocks closed lower.`;
  assert.equal(sinceCloseCoverage(sections([wrongTime]), OCT_ITEMS, splitReportSentences).sectionOne, 'MISSING');
  const timed = `${OCT_S1} At 4:06 pm ET on Friday, CNBC reported that stocks closed lower.`;
  assert.equal(sinceCloseCoverage(sections([timed]), OCT_ITEMS, splitReportSentences).sectionOne, 'TIMED_ITEM');
});

test('Step 9V.3: pointer wording accepted and rejected', () => {
  for (const sentence of ['After the close, Netflix reported results.', 'Since the last close, Netflix cut its forecast.',
    "Following Friday's close, two companies reported.", 'More in Stocks and Sectors in Focus.']) {
    assert.equal(isSinceClosePointerSentence(sentence), true, sentence);
  }
  for (const sentence of ['Stocks closed higher.', 'After the closing bell, trading was quiet.',
    'The close was strong.', 'Close to half of stocks rose.']) {
    assert.equal(isSinceClosePointerSentence(sentence), false, sentence);
  }
});

test('Step 9V.3: an empty Section 1 counts as missing; timed Section 3 items and uncited items are not flagged', () => {
  const result = sinceCloseCoverage(sections([null, 'x',
    'At 9:37 pm ET on Friday, a made-up outlet reported Nvidia news. Apple led.'], ['e40', 'e41']),
  OCT_ITEMS.slice(1), splitReportSentences);
  assert.deepEqual(result, {sectionOne: 'SECTION_EMPTY', untimedSectionThreeRefs: ['e41'],
    warnings: ['SINCE_CLOSE_PARAGRAPH_MISSING', 'SINCE_CLOSE_TIME_MISSING'], warningCount: 2});
});

// --- Fixes 3 and 5 in a full invocation (stand-in writer, no network) ----------

const EMPTY = {content: null, evidenceRefs: '', telemetryRefs: '', uncertainties: 'No data available for this run.'};

function reply({s1, s3}, {sectionOneRefs = 'e2|e3|e6'} = {}) {
  return {
    status: 'DEGRADED', evidenceGaps: ['Not enough data to cover every part of this report.'],
    s1: {content: s1, evidenceRefs: sectionOneRefs, telemetryRefs: 't1', uncertainties: ''},
    s2: {content: 'Federal Reserve policy context shaped the completed session.', evidenceRefs: 'e2|e3',
      telemetryRefs: '', uncertainties: ''},
    s3: s3 ? {content: s3, evidenceRefs: 'e4|e5', telemetryRefs: '', uncertainties: ''} : {...EMPTY},
    s4: {...EMPTY}, s5: {...EMPTY}, s6: {...EMPTY}, s7: {...EMPTY}, s8: {}
  };
}

async function invokeWith(input, transport) {
  const diagnostics = [];
  const requests = [];
  const envelope = {id: 'planted', content: [{type: 'text', text: JSON.stringify(transport)}],
    usage: {input_tokens: 1, output_tokens: 1}};
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'planted-no-network', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => {
      requests.push(options?.body);
      return {ok: true, status: 200, headers: {get: () => null}, clone() { return this; },
        text: async () => JSON.stringify(envelope), json: async () => envelope};
    }
  });
  return {result, diagnostics, requests};
}

test('Step 9V.3: a finished report missing the Section 1 paragraph logs one warning line and is not changed', () => on(async () => {
  const transport = reply({s1: 'Stocks closed higher on Friday.',
    s3: 'Broadcom led semiconductor shares in the session. Netflix gave a weaker forecast.'});
  const withOn = await invokeWith(completedInput(), transport);
  const withOff = await off(() => invokeWith(completedInput(), transport));
  assert.equal(withOn.result.ok, true, withOn.result.message);
  assert.deepEqual(withOn.result, withOff.result);
  const lines = withOn.diagnostics.filter(d => d.stage === 'completedSinceCloseCoverage');
  assert.deepEqual(lines, [{stage: 'completedSinceCloseCoverage', marketState: 'CLOSED', itemCount: 2,
    sectionOneItemCount: 1, sectionThreeItemCount: 1, sectionOne: 'MISSING',
    warnings: ['SINCE_CLOSE_PARAGRAPH_MISSING', 'SINCE_CLOSE_TIME_MISSING'],
    untimedSectionThreeRefs: ['e5'], warningCount: 2}]);
  assert.equal(withOff.diagnostics.some(d => d.stage === 'completedSinceCloseCoverage'), false);
}));

test('Step 9V.3: all items in Section 3 with the pointer sentence and timed Section 3 logs no warning', () => on(async () => {
  const {result, diagnostics} = await invokeWith(completedInput({allSectionThree: true}), reply({
    s1: 'Stocks closed higher on Friday. After the close, Netflix reported results (see Stocks & Sectors in Focus).',
    s3: 'Broadcom led semiconductor shares in the session. At 4:30 pm ET on Friday, Yahoo Finance reported that '
      + 'Netflix gave a weaker forecast.'
  }, {sectionOneRefs: 'e2|e3'}));
  assert.equal(result.ok, true, result.message);
  const [line] = diagnostics.filter(d => d.stage === 'completedSinceCloseCoverage');
  assert.deepEqual([line.sectionOne, line.warnings, line.warningCount], ['POINTER', [], 0]);
}));

test('Step 9V.3: no warning line on an active day, with no since-close items, or with completedSinceCloseEnabled off', () => on(async () => {
  const none = await invokeWith(completedInput({afterClose: false}), reply({s1: 'Stocks closed higher on Friday.'},
    {sectionOneRefs: 'e2|e3'}));
  assert.equal(none.diagnostics.some(d => d.stage === 'completedSinceCloseCoverage'), false);
  const parentOff = await withEnv('COMPLETED_SINCE_CLOSE_ENABLED', 'off', () => invokeWith(completedInput(),
    reply({s1: 'Stocks closed higher on Friday.'})));
  assert.equal(parentOff.diagnostics.some(d => d.stage === 'completedSinceCloseCoverage'), false);
}));

// Step 9F.6a.3: the shared source reader driven by a fake source -- every
// decision path, retries, the reading budget stop, the caps, the try-last
// order, both modes -- plus the Yahoo adapter and the shared run context.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createEvidenceItem} = require('../lib/evidence-items');
const {
  SOURCE_LIMIT_SETTINGS,
  sourceLimits,
  readRunContext,
  readSource
} = require('../lib/source-reader');
const {createYahooNewsSource, YAHOO_NEWS_SOURCE_ID} = require('../lib/sources/yahoo-news');
const {settingValue} = require('../lib/settings-registry');

// Tuesday 29 Sep 2026, 14:00 New York. The last close is Monday 16:00 New York
// (20:00Z), so the reading window starts 24 hours before it.
const TRIGGER = '2026-09-29T18:00:00.000Z';
const LAST_CLOSE = Date.parse('2026-09-28T20:00:00.000Z');
const WINDOW_START = LAST_CLOSE - 24 * 3600000;
const iso = ms => new Date(ms).toISOString();
const urlFor = name => `https://news.example.test/articles/${name}.html`;

// `pages` maps a short name to what readPage does for it: 'OK', 'OK@<iso>',
// 'TIMEOUT', 'HTTP_404', 'MISMATCH', 'NO_TIME', 'THROW', 'NO_BODY', 'OTHER'.
function fakeSource(pages, {sourceId = YAHOO_NEWS_SOURCE_ID, ageLabels = {}, onRead} = {}) {
  const reads = [];
  const findCalls = [];
  const source = {
    sourceId,
    async findCandidates(input) {
      findCalls.push(input);
      return {
        ok: true,
        candidates: Object.keys(pages).map(name => ({
          headline: `Fake headline ${name}`, url: urlFor(name), publisher: 'Fake Wire',
          edition: 'US', ...(ageLabels[name] ? {ageLabel: ageLabels[name]} : {})
        })),
        discoveryStats: {listingOutcome: 'SUCCESS', listingPageCount: 1}
      };
    },
    async readPage(url, {headline}) {
      const name = Object.keys(pages).find(key => urlFor(key) === url);
      reads.push({name, headline});
      if (onRead) onRead(name);
      const kind = pages[name];
      if (kind === 'THROW') throw new Error('reader failed');
      if (kind === 'TIMEOUT') return {ok: false, type: 'TIMEOUT'};
      if (kind === 'HTTP_404') return {ok: false, type: 'HTTP_FAILURE', httpStatus: 404};
      if (kind === 'MISMATCH') {
        return {ok: false, type: 'EXTRACTION_FAILURE', extractionFailureType: 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH'};
      }
      if (kind === 'NO_BODY') {
        return {ok: false, type: 'EXTRACTION_FAILURE', extractionFailureType: 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT'};
      }
      if (kind === 'OTHER') return {ok: false, type: 'SOMETHING_ELSE'};
      const publishedAt = kind === 'NO_TIME' ? null
        : kind.startsWith('OK@') ? kind.slice(3) : iso(LAST_CLOSE - 3600000);
      return {ok: true, type: 'SUCCESS', articleContent: {
        headline, canonicalUrl: url, publisher: 'Fake Wire', publishedAt,
        articleText: `${headline}. Body text.`
      }};
    }
  };
  return {source, reads, findCalls};
}

function runReader(source, overrides = {}) {
  const events = [];
  const timings = [];
  const acquiredItems = [];
  const promise = readSource({
    source,
    runContext: {mostActive: []},
    market: 'US',
    mode: 'ACTIVE',
    timed: async (stage, operation) => { timings.push(stage); return operation(); },
    emit: event => events.push(event),
    acquisitionStartedAt: TRIGGER,
    marketContext: {exchangeTimezone: 'America/New_York', marketState: 'REGULAR',
      primaryCompletedSessionDate: '2026-09-28'},
    benchmarkSnapshots: [],
    stockSnapshots: [],
    classificationPreflightAvailable: false,
    requiredItems: [],
    horizonFor: () => 'CURRENT_SESSION',
    windowUnavailableReason: null,
    sessionWindow: null,
    acquiredItems,
    clock: {monotonicNow: () => 0, sleep: async () => {}},
    limits: {maxArticleAttempts: 12, maxAdmittedArticles: 6, initialCandidateAttempts: 5},
    ...overrides
  });
  return promise.then(result => ({result, events, timings, acquiredItems}));
}

function decisions(events) {
  return Object.fromEntries(events.filter(event => event.stage === 'activeYahooCandidateAudit')
    .flatMap(event => event.candidates)
    .map(entry => [entry.slug.replace('.html', ''), entry]));
}

test('Step 9F.6a.3 shared reader: every decision path in an active state', async () => {
  const duplicate = createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: 'Already in the evidence', summary: 'Already in the evidence.',
    canonicalUrl: urlFor('dup'), publishedAt: iso(LAST_CLOSE - 7200000), symbols: [],
    publisher: 'Fake Wire'
  });
  const {source, reads, findCalls} = fakeSource({
    ok: 'OK', timeout: 'TIMEOUT', notfound: 'HTTP_404', mismatch: 'MISMATCH', notime: 'NO_TIME',
    early: `OK@${iso(WINDOW_START - 1000)}`, late: `OK@${iso(Date.parse(TRIGGER) + 1000)}`,
    dup: 'OK', thrown: 'THROW', nobody: 'NO_BODY', other: 'OTHER'
  });
  const {result, events, timings, acquiredItems} = await runReader(source, {requiredItems: [duplicate]});

  assert.equal(findCalls.length, 1);
  assert.equal(findCalls[0].market, 'US');
  assert.equal(findCalls[0].triggerAt, TRIGGER);
  assert.equal(findCalls[0].window.startsAt, iso(WINDOW_START));
  // The listing headline is handed to the page reader with every download.
  for (const read of reads) assert.equal(read.headline, `Fake headline ${read.name}`);

  const byName = decisions(events);
  assert.equal(byName.ok.decision, 'ADMITTED');
  assert.equal(byName.timeout.decision, 'FETCH_FAILED');
  assert.equal(byName.timeout.failureType, 'TIMEOUT');
  assert.equal(byName.timeout.attempts, 3);
  assert.equal(byName.notfound.decision, 'FETCH_FAILED');
  assert.equal(byName.notfound.attempts, 1);
  assert.equal(byName.mismatch.decision, 'EXTRACTION_FAILED');
  assert.equal(byName.mismatch.failureType, 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH');
  assert.equal(byName.notime.decision, 'REJECTED_NO_PUBLICATION_TIME');
  assert.equal(byName.early.decision, 'REJECTED_BEFORE_READING_WINDOW');
  assert.equal(byName.late.decision, 'REJECTED_AFTER_READING_WINDOW');
  assert.equal(byName.dup.decision, 'REJECTED_DUPLICATE');
  assert.equal(byName.thrown.decision, 'FETCH_FAILED');
  assert.equal(byName.thrown.failureType, 'EXCEPTION');
  assert.equal(byName.nobody.decision, 'EXTRACTION_FAILED');
  assert.equal(byName.other.decision, 'EXTRACTION_FAILED');
  assert.equal(byName.other.failureType, 'SOMETHING_ELSE');

  assert.equal(acquiredItems.length, 1);
  assert.equal(result.items, acquiredItems);
  assert.deepEqual(result.horizons, ['CURRENT_SESSION']);
  assert.equal(acquiredItems[0].sourceId, YAHOO_NEWS_SOURCE_ID);

  const summary = events[0];
  assert.equal(summary.stage, 'activeYahooAcquisition');
  assert.equal(summary, result.stats);
  // The source's own listing counts sit right after the candidate count.
  assert.deepEqual(Object.keys(summary).slice(0, 7), ['stage', 'outcome', 'mostActiveCount',
    'latestNewsCandidateCount', 'listingOutcome', 'listingPageCount', 'staleByLabelCount']);
  assert.equal(summary.articleFetchAttemptCount, 11);
  assert.equal(summary.downloadAttemptCount, 13);
  assert.equal(summary.articleFetchRequestFailureCount, 3);
  assert.equal(summary.articleExtractionFailureCount, 3);
  assert.equal(summary.articleIdentityHeadlineMismatchCount, 1);
  assert.equal(summary.articleBodyUnavailableCount, 1);
  assert.equal(summary.otherArticleExtractionRejectionCount, 1);
  assert.equal(summary.backfillUsed, true);
  assert.equal('subsequentDevelopmentCount' in summary, false);
  assert.deepEqual(timings, ['yahooLatestNewsDiscoveryMs',
    ...Array(11).fill('yahooCurrentNewsArticleAcquisitionMs')]);
});

test('Step 9F.6a.3 shared reader: completed state keeps after-close articles apart', async () => {
  const afterClose = iso(LAST_CLOSE + 3600000);
  const {source} = fakeSource({before: 'OK', after: `OK@${afterClose}`});
  const {events, result} = await runReader(source, {
    mode: 'COMPLETED',
    horizonFor: publishedAt => publishedAt > LAST_CLOSE ? 'SUBSEQUENT_DEVELOPMENT' : 'COMPLETED_SESSION'
  });
  const byName = decisions(events);
  assert.equal(byName.before.decision, 'ADMITTED');
  assert.equal('afterClose' in byName.before, false);
  assert.equal(byName.after.decision, 'ADMITTED');
  assert.equal(byName.after.afterClose, true);
  assert.deepEqual(result.horizons, ['COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT']);
  assert.equal(events[0].subsequentDevelopmentCount, 1);
  assert.equal(Object.keys(events[0]).at(-1), 'subsequentDevelopmentCount');
});

test('Step 9F.6a.3 shared reader: no horizon means window unavailable, counted by reason', async () => {
  const {source} = fakeSource({one: 'OK', two: 'OK'});
  const overlay = await runReader(source, {
    horizonFor: () => null, windowUnavailableReason: 'BENCHMARK_OVERLAY_INVALID'
  });
  assert.equal(decisions(overlay.events).one.decision, 'REJECTED_WINDOW_UNAVAILABLE');
  assert.equal(overlay.events[0].benchmarkOverlayInvalidCount, 2);
  assert.equal(overlay.events[0].activeWindowUnavailableCount, 0);
  const missing = await runReader(fakeSource({one: 'OK'}).source, {horizonFor: () => null});
  assert.equal(missing.events[0].activeWindowUnavailableCount, 1);
  assert.equal(missing.events[0].outcome, 'NOT_FOUND');
});

test('Step 9F.6a.3 shared reader: admit cap, attempt cap and reading budget', async () => {
  const admitted = await runReader(fakeSource({a: 'OK', b: 'OK', c: 'OK'}).source,
    {limits: {maxArticleAttempts: 12, maxAdmittedArticles: 1, initialCandidateAttempts: 5}});
  assert.equal(decisions(admitted.events).b.decision, 'SKIPPED_MAX_ADMITTED');

  const attempts = await runReader(fakeSource({a: 'HTTP_404', b: 'OK'}).source,
    {limits: {maxArticleAttempts: 1, maxAdmittedArticles: 6, initialCandidateAttempts: 5}});
  assert.equal(decisions(attempts.events).b.decision, 'SKIPPED_MAX_ATTEMPTS');

  // Each download uses up more than the whole budget; the next one never starts.
  let now = 0;
  const budgetMs = settingValue(SOURCE_LIMIT_SETTINGS[YAHOO_NEWS_SOURCE_ID].readingBudgetSeconds) * 1000;
  const {source} = fakeSource({a: 'OK', b: 'OK'}, {onRead: () => { now += budgetMs + 1; }});
  const budget = await runReader(source, {clock: {monotonicNow: () => now, sleep: async () => {}}});
  assert.equal(decisions(budget.events).a.decision, 'ADMITTED');
  assert.equal(decisions(budget.events).b.decision, 'SKIPPED_READING_BUDGET');
  assert.equal(budget.events[0].readingBudgetStopped, true);
});

test('Step 9F.6a.3 shared reader: a label older than the window is tried last', async () => {
  const {source, reads} = fakeSource({old: 'OK', fresh: 'OK'}, {ageLabels: {old: '9 days ago'}});
  const {events} = await runReader(source);
  assert.deepEqual(reads.map(read => read.name), ['fresh', 'old']);
  assert.equal(decisions(events).old.labelOld, true);
  assert.equal(events[0].staleByLabelCount, 1);
});

test('Step 9F.6a.3 shared reader: a failing candidate search reads nothing', async () => {
  const source = {
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() { throw new Error('listing failed'); },
    async readPage() { throw new Error('must not be called'); }
  };
  const {events, acquiredItems} = await runReader(source);
  assert.equal(acquiredItems.length, 0);
  assert.equal(events[0].latestNewsCandidateCount, 0);
  assert.equal(events[0].outcome, 'NOT_FOUND');
  assert.equal(events[1].stage, 'activeYahooCandidateAudit');
  assert.deepEqual(events[1].candidates, []);
});

test('Step 9F.6a.3 shared reader: rejects an unknown source, mode or horizon', async () => {
  await assert.rejects(runReader(fakeSource({a: 'OK'}, {sourceId: 'xx.unknown'}).source), TypeError);
  await assert.rejects(runReader(fakeSource({a: 'OK'}).source, {mode: 'SOMETIMES'}), TypeError);
  await assert.rejects(runReader(fakeSource({a: 'OK'}).source, {horizonFor: null}), TypeError);
});

test('Step 9F.6a.3 shared reader: Yahoo limits come from the settings registry', () => {
  assert.deepEqual(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {}}), {
    maxArticleAttempts: 12, maxAdmittedArticles: 6, initialCandidateAttempts: 5
  });
  assert.equal(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {YAHOO_MAX_ADMITTED_ARTICLES: '4'}})
    .maxAdmittedArticles, 4);
  assert.throws(() => sourceLimits('xx.unknown'), TypeError);
});

test('Step 9F.6a.3 shared run context: Most Active fetched once, failures give an empty list', async () => {
  const timings = [];
  const timed = async (stage, operation) => { timings.push(stage); return operation(); };
  const ok = await readRunContext({timed, yahooMostActiveAcquisition: {
    async acquireMostActive() { return {ok: true, candidates: [{symbol: 'NVDA'}]}; }
  }});
  assert.deepEqual(ok.mostActive, [{symbol: 'NVDA'}]);
  assert.deepEqual(timings, ['yahooMostActiveAcquisitionMs']);
  const failed = await readRunContext({timed, yahooMostActiveAcquisition: {
    async acquireMostActive() { throw new Error('down'); }
  }});
  assert.deepEqual(failed.mostActive, []);
});

test('Step 9F.6a.3 Yahoo source: listing counts sanitised, failures empty, headline passed on', async () => {
  const calls = [];
  const yahoo = createYahooNewsSource({
    yahooLatestNewsDiscovery: {async discoverLatestNews() {
      return {ok: true, candidates: [{url: 'u'}], usOutcome: 'X'.repeat(40), usSectionCount: 2,
        usCandidateCount: 1.5, singaporeCandidateCount: 3, crossEditionDuplicateCount: 'n'};
    }},
    yahooCurrentNewsArticleContentAcquisition: {async acquireArticleContent(input) {
      calls.push(input);
      return {ok: true};
    }}
  });
  assert.equal(yahoo.sourceId, 'us.yahoo-finance');
  const found = await yahoo.findCandidates({market: 'US'});
  assert.equal(found.ok, true);
  assert.deepEqual(found.candidates, [{url: 'u'}]);
  assert.deepEqual(found.discoveryStats, {
    usNewsOutcome: 'X'.repeat(32), usNewsSectionCount: 2, usNewsCandidateCount: 0,
    singaporeNewsCandidateCount: 3, crossEditionDuplicateCount: 0
  });
  await yahoo.readPage('https://finance.yahoo.com/news/a.html', {headline: 'A headline'});
  assert.deepEqual(calls, [{url: 'https://finance.yahoo.com/news/a.html', headline: 'A headline'}]);

  const failing = createYahooNewsSource({
    yahooLatestNewsDiscovery: {async discoverLatestNews() { throw new Error('down'); }},
    yahooCurrentNewsArticleContentAcquisition: {}
  });
  assert.deepEqual(await failing.findCandidates({market: 'US'}), {
    ok: false, candidates: [], discoveryStats: {
      usNewsOutcome: 'NOT_CONFIGURED', usNewsSectionCount: 0, usNewsCandidateCount: 0,
      singaporeNewsCandidateCount: 0, crossEditionDuplicateCount: 0
    }
  });
});

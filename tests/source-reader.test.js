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
  // Step 9F.2e.5: article slots off gives the previous caps exactly.
  const off = {ARTICLE_SLOTS_ENABLED: 'off'};
  assert.deepEqual(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: off}), {
    maxArticleAttempts: 12, maxAdmittedArticles: 6, initialCandidateAttempts: 5
  });
  assert.equal(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {...off, YAHOO_MAX_ADMITTED_ARTICLES: '4'}})
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

test('Step 9F.6a.4 shared reader: the pool lists every candidate in ranked order with its decision', async () => {
  const {source} = fakeSource({a: 'OK', b: 'HTTP_404', old: 'OK', c: 'OK', d: 'OK'},
    {ageLabels: {old: '9 days ago'}});
  const {result, events} = await runReader(source,
    {limits: {maxArticleAttempts: 12, maxAdmittedArticles: 2, initialCandidateAttempts: 5}});
  const audit = events.filter(event => event.stage === 'activeYahooCandidateAudit')
    .flatMap(event => event.candidates);
  assert.ok(Object.isFrozen(result.pool));
  assert.equal(result.pool.length, 5);
  assert.deepEqual(result.pool.map(entry => [entry.rank, entry.decision]),
    audit.map(entry => [entry.rank, entry.decision]));
  const byName = Object.fromEntries(result.pool.map(entry => [entry.url.split('/').at(-1).replace('.html', ''), entry]));
  assert.deepEqual(byName.a, {
    sourceId: 'us.yahoo-finance', rank: 1, url: urlFor('a'), headline: 'Fake headline a',
    publisher: 'Fake Wire', listedAt: null, ageLabel: null, edition: 'US', tier: 5, subTier: '3b',
    labelOld: false, opened: true, attempts: 1, publishedAt: iso(LAST_CLOSE - 3600000), decision: 'ADMITTED',
    // Step 9F.2e.1: the shadow score (nothing scores for a fake headline).
    score: 0,
    scoreBreakdown: {usMacro: 0, mostActive: 0, portfolio: 0, wirePublishers: 0, includeWords: 0,
      asiaEurope: 0, benchmarkOrGeneric: 0, ai: 0},
    recencyPoints: 0, recencyBasis: 'unknown', ageHours: null, dropReason: null, portfolioSlotEligible: false
  });
  assert.equal(byName.b.decision, 'FETCH_FAILED');
  assert.equal(byName.b.publishedAt, null);
  // Two admitted (a, c): d and the label-old candidate are never opened.
  assert.equal(byName.d.opened, false);
  assert.equal(byName.d.attempts, null);
  assert.equal(byName.d.decision, 'SKIPPED_MAX_ADMITTED');
  assert.equal(byName.old.labelOld, true);
  assert.equal(byName.old.ageLabel, '9 days ago');
  assert.equal(byName.old.opened, false);
  // The pool is not logged.
  assert.equal(JSON.stringify(events).includes(urlFor('a')), false);
});

test('Step 9F.6a.5 audit: every candidate audit event names its source once', async () => {
  const pages = Object.fromEntries(Array.from({length: 14}, (_, index) => [`story${index}`, 'HTTP_404']));
  const {events} = await runReader(fakeSource(pages).source);
  const audit = events.filter(event => event.stage === 'activeYahooCandidateAudit');
  assert.equal(audit.length, 2);
  for (const event of audit) {
    assert.deepEqual(Object.keys(event).slice(0, 4), ['stage', 'sourceId', 'part', 'parts']);
    assert.equal(event.sourceId, 'us.yahoo-finance');
    assert.equal(event.candidates.some(entry => 'sourceId' in entry), false);
  }
  // The reading summary is unchanged: no source id there.
  assert.equal('sourceId' in events[0], false);
});

test('Step 9F.6a.5 audit: the source id is counted, so no event passes the byte limit at the edge', () => {
  const {auditEvents, AUDIT_MAX_EVENT_BYTES} = require('../lib/source-audit');
  const entry = (rank, pad) => ({rank, tier: 5, subTier: '3b', headline: 'x'.repeat(pad),
    publisher: 'Fake Wire', slug: `story-${rank}`, edition: 'US', ageLabel: null, decision: 'SKIPPED_MAX_ATTEMPTS'});
  let closest = 0;
  const partCounts = new Set();
  // Five candidates, the last one growing a byte at a time across the limit.
  for (let pad = 0; pad <= 1600; pad++) {
    const entries = [entry(1, 300), entry(2, 300), entry(3, 300), entry(4, 300), entry(5, pad)];
    const events = auditEvents(entries, null, null,
      {stage: 'activeYahooCandidateAudit', sourceId: 'us.yahoo-finance'});
    partCounts.add(events.length);
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify({...event, generationId: '0'.repeat(36)}), 'utf8');
      assert.ok(bytes <= AUDIT_MAX_EVENT_BYTES, `pad ${pad}: ${bytes} bytes`);
      closest = Math.max(closest, bytes);
    }
    assert.deepEqual(events.flatMap(event => event.candidates), entries);
  }
  // The splitter counts a separator for every candidate, so it stops a few
  // bytes short of the limit; the sweep still reaches within 10 bytes of it.
  assert.ok(closest >= AUDIT_MAX_EVENT_BYTES - 10, `closest to the limit was ${closest}`);
  assert.deepEqual([...partCounts], [1, 2]);
});

// Step 9F.2e.1: the shadow score. Every candidate gets its score next to its
// tier in the audit and the pool, from the same names the tier ranking uses
// (both lists, Most Active) and the trigger time. The tier order still decides
// what is opened; nothing about the reading changes. Step 9F.2e.4a: that is
// now the switch-off path; with the switch on the same scores set the order.
test('Step 9F.2e.1 shared reader: shadow score in the audit and pool, tier order unchanged', async () => {
  const listing = [
    {name: 'acme', headline: 'Acme Inc opens a new plant', publisher: 'Barchart', ageLabel: '2h ago'},
    {name: 'wire', headline: 'Fed holds rates as Treasury yields climb', publisher: 'Reuters', ageLabel: '8h ago'},
    {name: 'zeta', headline: 'Zeta Corp shares jump in heavy trading', publisher: 'Zacks'},
    {name: 'beta', headline: 'Beta Holdings names a new chief', publisher: 'Zacks'},
    {name: 'drop', headline: 'Australian developer axes Sydney data centre plan', publisher: 'Reuters'},
    {name: 'howto', headline: 'How to trade volatile markets', publisher: 'Yahoo Finance'}
  ];
  const reads = [];
  const source = {
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() {
      return {ok: true, candidates: listing.map(entry => ({
        headline: entry.headline, url: urlFor(entry.name), publisher: entry.publisher, edition: 'US',
        ...(entry.ageLabel ? {ageLabel: entry.ageLabel} : {})
      })), discoveryStats: {}};
    },
    async readPage(url, {headline}) {
      reads.push(url.split('/').at(-1).replace('.html', ''));
      return {ok: true, type: 'SUCCESS', articleContent: {headline, canonicalUrl: url, publisher: 'Fake Wire',
        publishedAt: iso(LAST_CLOSE - 3600000), articleText: `${headline}. Body text.`}};
    }
  };
  const acme = {symbol: 'ACME', instrumentName: 'Acme Inc'};
  const beta = {symbol: 'BETA', instrumentName: 'Beta Holdings'};
  const inputs = {
    runContext: {mostActive: [{symbol: 'ZETA', shortName: 'Zeta Corp', longName: 'Zeta Corp'}]},
    stockSnapshots: [acme, beta],
    portfolioSlotSnapshots: [acme]
  };
  const {result, events} = await runReader(source, {...inputs, env: {SCORE_TRY_ORDER_ENABLED: 'off'}});
  const audit = decisions(events);
  // Tier order (1a acme, beta; 2w wire; 1b zeta), not score order, decides what is opened.
  assert.deepEqual(reads, ['acme', 'beta', 'wire', 'zeta']);
  assert.deepEqual([audit.acme.rank, audit.beta.rank, audit.wire.rank, audit.zeta.rank], [1, 2, 3, 4]);
  // Scores and points summaries.
  assert.equal(audit.acme.score, 8 + 4);
  assert.equal(audit.acme.scoreParts, 'portfolio 8, recency 4');
  assert.equal(audit.wire.score, 20 + 5 + 2);
  assert.equal(audit.wire.scoreParts, 'macro 20, wire 5, recency 2');
  assert.equal(audit.zeta.score, 12);
  assert.equal(audit.zeta.scoreParts, 'most-active 12');
  assert.equal(audit.beta.scoreParts, 'portfolio 8');
  // The score's drop rule: wire points do not protect; "how to" drops. Only
  // dropped headlines carry scoreDrop.
  assert.equal(audit.drop.scoreDrop, true);
  assert.equal(audit.drop.scoreParts, 'wire 5');
  assert.equal(audit.howto.scoreDrop, true);
  assert.equal('scoreDrop' in audit.wire, false);
  assert.equal(audit.drop.decision, 'SKIPPED_BELOW_RELEVANCE_FLOOR');
  // The listed fields sit right after the tier fields.
  assert.deepEqual(Object.keys(audit.acme).slice(0, 5), ['rank', 'tier', 'subTier', 'score', 'scoreParts']);
  // The pool: full breakdown, drop reason and starting-list eligibility.
  const pool = Object.fromEntries(result.pool.map(entry => [entry.url.split('/').at(-1).replace('.html', ''), entry]));
  assert.equal(pool.wire.score, 27);
  assert.equal(pool.wire.scoreBreakdown.wirePublishers, 5);
  assert.equal(pool.wire.recencyBasis, 'ageLabel');
  assert.equal(pool.wire.ageHours, 8);
  assert.equal(pool.drop.dropReason, 'DROP_LIST');
  assert.equal(pool.howto.dropReason, 'HOW_TO');
  assert.equal(pool.acme.portfolioSlotEligible, true);
  assert.equal(pool.beta.portfolioSlotEligible, false);
  assert.equal(pool.zeta.portfolioSlotEligible, false);
  // Step 9F.2e.4a: switch on (the default), the same scores set the order:
  // wire 27, acme 12 (2h) before zeta 12 (no label), then beta 8.
  reads.length = 0;
  const scored = await runReader(source, inputs);
  assert.deepEqual(reads, ['wire', 'acme', 'zeta', 'beta']);
  assert.deepEqual(scored.result.pool.map(entry => [entry.rank, entry.score]), result.pool.map(entry => [entry.rank, entry.score]));
});

test('Step 9F.2e.1 shared reader: a long points summary is cut to the audit limit', async () => {
  const {AUDIT_FIELD_LIMITS} = require('../lib/source-audit');
  const headline = 'Acme Inc and Zeta Corp surge as Fed flags inflation; Nikkei dips while stocks rally';
  const source = {
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() {
      return {ok: true, candidates: [{headline, url: urlFor('max'), publisher: 'Reuters', edition: 'US',
        ageLabel: '1h ago'}], discoveryStats: {}};
    },
    async readPage() { return {ok: false, type: 'HTTP_FAILURE', httpStatus: 404}; }
  };
  const {events} = await runReader(source, {
    runContext: {mostActive: [{symbol: 'ZETA', shortName: 'Zeta Corp', longName: 'Zeta Corp'}]},
    stockSnapshots: [{symbol: 'ACME', instrumentName: 'Acme Inc'}]
  });
  const entry = decisions(events).max;
  assert.equal(entry.score, 20 + 12 + 8 + 5 + 3 + 1 + 4);
  assert.ok(entry.scoreParts.length <= AUDIT_FIELD_LIMITS.scorePartsCharacters);
  assert.ok(entry.scoreParts.startsWith('macro 20, most-active 12, portfolio 8, wire 5'));
});

// Step 9F.2e.3.4b: the reader now takes its try order, stop rule and
// per-article classifier fit check from the shared selection step. Every
// decision and every count the audit and the reading summary list must still
// be produced; these runs together reach each one at least once.
function scriptedSource(rows) {
  const reads = [];
  const source = {
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() {
      return {ok: true, candidates: rows.map(row => ({
        headline: row.headline || `Fake headline ${row.name}`, url: urlFor(row.name),
        publisher: row.publisher || 'Fake Wire', edition: 'US', ...(row.ageLabel ? {ageLabel: row.ageLabel} : {})
      })), discoveryStats: {listingOutcome: 'SUCCESS'}};
    },
    async readPage(url, {headline}) {
      const row = rows.find(entry => urlFor(entry.name) === url);
      reads.push(row.name);
      if (row.onRead) row.onRead();
      const kind = row.page || 'OK';
      if (kind === 'THROW') throw new Error('reader failed');
      if (kind === 'TIMEOUT') return {ok: false, type: 'TIMEOUT'};
      if (kind === 'HTTP_404') return {ok: false, type: 'HTTP_FAILURE', httpStatus: 404};
      if (kind.startsWith('EXTRACT:')) {
        return {ok: false, type: 'EXTRACTION_FAILURE', extractionFailureType: kind.slice(8)};
      }
      if (kind === 'OTHER') return {ok: false, type: 'SOMETHING_ELSE'};
      const publishedAt = kind === 'NO_TIME' ? null
        : kind.startsWith('OK@') ? kind.slice(3) : iso(LAST_CLOSE - 3600000);
      return {ok: true, type: 'SUCCESS', articleContent: {
        headline: kind === 'BAD_ITEM' ? '' : headline, canonicalUrl: url, publisher: 'Fake Wire', publishedAt,
        articleText: `${headline}. Body text.`
      }};
    }
  };
  return {source, reads};
}

function evidenceNamed(name) {
  return createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: `Evidence ${name}`, summary: `Evidence ${name}.`, canonicalUrl: urlFor(name),
    publishedAt: iso(LAST_CLOSE - 7200000), symbols: [], publisher: 'Fake Wire'
  });
}

test('Step 9F.2e.3.4b shared reader: every audit decision and summary count is still produced', async () => {
  const budgetMs = settingValue(SOURCE_LIMIT_SETTINGS[YAHOO_NEWS_SOURCE_ID].readingBudgetSeconds) * 1000;
  const runs = [];
  const run = async (rows, overrides) => {
    const scripted = scriptedSource(rows);
    const outcome = await runReader(scripted.source, overrides);
    runs.push(outcome);
    return {...outcome, reads: scripted.reads};
  };
  const limits = (maxArticleAttempts, maxAdmittedArticles) =>
    ({limits: {maxArticleAttempts, maxAdmittedArticles, initialCandidateAttempts: 5}});

  // 1. Every page outcome, a dropped (tier 4a) headline and an old label.
  const main = await run([
    {name: 'ok'}, {name: 'timeout', page: 'TIMEOUT'}, {name: 'notfound', page: 'HTTP_404'},
    {name: 'thrown', page: 'THROW'}, {name: 'nometa', page: 'EXTRACT:NO_COMPATIBLE_ARTICLE_METADATA'},
    {name: 'mismatch', page: 'EXTRACT:ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH'},
    {name: 'nobody', page: 'EXTRACT:NO_ARTICLE_BODY_CONTAINER_OR_TEXT'},
    {name: 'canonical', page: 'EXTRACT:CANONICAL_OR_REDIRECT_MISMATCH'},
    {name: 'oddextract', page: 'EXTRACT:SOMETHING_NEW'}, {name: 'other', page: 'OTHER'},
    {name: 'notime', page: 'NO_TIME'}, {name: 'early', page: `OK@${iso(WINDOW_START - 1000)}`},
    {name: 'late', page: `OK@${iso(Date.parse(TRIGGER) + 1000)}`}, {name: 'dup'},
    {name: 'baditem', page: 'BAD_ITEM'}, {name: 'old', ageLabel: '9 days ago'},
    {name: 'drop', headline: 'Australian developer axes Sydney data centre plan', publisher: 'Reuters'}
  ], {requiredItems: [evidenceNamed('dup')], runContext: {mostActive: [{symbol: 'ZZZZ'}]}, ...limits(20, 6)});
  const mainAudit = decisions(main.events);
  assert.equal(main.reads.at(-1), 'old', 'the old-label article is tried last');
  assert.equal(main.reads.includes('drop'), false, 'the tier 4a article is never opened');
  assert.equal(mainAudit.drop.decision, 'SKIPPED_BELOW_RELEVANCE_FLOOR');
  assert.equal(mainAudit.baditem.decision, 'REJECTED_OTHER');
  // labelOld is written before any download, so it sits before the download fields.
  assert.deepEqual(Object.keys(mainAudit.old).slice(-4), ['decision', 'labelOld', 'attempts', 'publishedAt']);

  // 2. The 50-item classifier limit (pre-check off): 49 required + 1 admitted.
  const required = Array.from({length: 49}, (_, index) => evidenceNamed(`req${index}`));
  const full = await run([{name: 'first'}, {name: 'second'}], {requiredItems: required});
  assert.equal(decisions(full.events).first.decision, 'ADMITTED');
  assert.equal(decisions(full.events).second.decision, 'REJECTED_CLASSIFIER_PREFLIGHT');
  // 3. Pre-check on, the request cannot be built: a misfit, never a crash.
  const broken = await run([{name: 'one'}], {classificationPreflightAvailable: true, marketContext: {}});
  assert.equal(decisions(broken.events).one.decision, 'REJECTED_CLASSIFIER_PREFLIGHT');
  assert.equal(broken.events[0].classifierPreflightRejectedCount, 1);
  assert.equal(broken.events[0].otherEvidenceConstructionRejectedCount, 1);
  // 4. No horizon: window unavailable, by reason.
  await run([{name: 'one'}], {horizonFor: () => null, windowUnavailableReason: 'BENCHMARK_OVERLAY_INVALID'});
  await run([{name: 'one'}], {horizonFor: () => null});
  // 5. Completed state with an after-close article.
  await run([{name: 'before'}, {name: 'after', page: `OK@${iso(LAST_CLOSE + 3600000)}`}], {
    mode: 'COMPLETED',
    horizonFor: publishedAt => publishedAt > LAST_CLOSE ? 'SUBSEQUENT_DEVELOPMENT' : 'COMPLETED_SESSION'
  });
  // 6. The three stop reasons (only the budget sets readingBudgetStopped), and
  // a retry stopped by the budget.
  const admittedCap = await run([{name: 'a'}, {name: 'b'}], limits(12, 1));
  assert.equal(admittedCap.events[0].readingBudgetStopped, false);
  const attemptsCap = await run([{name: 'a', page: 'HTTP_404'}, {name: 'b'}], limits(1, 6));
  assert.equal(attemptsCap.events[0].readingBudgetStopped, false);
  let now = 0;
  const spent = await run([{name: 'a', onRead: () => { now += budgetMs + 1; }}, {name: 'b'}],
    {clock: {monotonicNow: () => now, sleep: async () => {}}});
  assert.equal(spent.events[0].readingBudgetStopped, true);
  let later = 0;
  const retry = await run([{name: 'slow', page: 'TIMEOUT', onRead: () => { later += budgetMs - 1; }}],
    {clock: {monotonicNow: () => later, sleep: async () => {}}});
  assert.equal(decisions(retry.events).slow.retriesStoppedByBudget, true);

  const seenDecisions = new Set(runs.flatMap(outcome => Object.values(decisions(outcome.events))
    .map(entry => entry.decision)));
  assert.deepEqual([...seenDecisions].sort(), [
    'ADMITTED', 'EXTRACTION_FAILED', 'FETCH_FAILED', 'REJECTED_AFTER_READING_WINDOW',
    'REJECTED_BEFORE_READING_WINDOW', 'REJECTED_CLASSIFIER_PREFLIGHT', 'REJECTED_DUPLICATE',
    'REJECTED_NO_PUBLICATION_TIME', 'REJECTED_OTHER', 'REJECTED_WINDOW_UNAVAILABLE',
    'SKIPPED_BELOW_RELEVANCE_FLOOR', 'SKIPPED_MAX_ADMITTED', 'SKIPPED_MAX_ATTEMPTS', 'SKIPPED_READING_BUDGET'
  ]);
  const auditFields = new Set(runs.flatMap(outcome => Object.values(decisions(outcome.events))
    .flatMap(entry => Object.keys(entry))));
  for (const field of ['labelOld', 'attempts', 'retriesStoppedByBudget', 'failureType', 'publishedAt',
    'afterClose', 'scoreDrop']) {
    assert.ok(auditFields.has(field), `audit field ${field} produced`);
  }
  // Every count in the reading summary is non-zero (or true) in at least one run.
  const summaries = runs.map(outcome => outcome.events[0]);
  for (const key of Object.keys(summaries.find(summary => 'subsequentDevelopmentCount' in summary))) {
    if (key === 'stage' || key === 'listingOutcome') continue;
    // Step 9F.2e.4a: a label, not a count.
    if (key === 'tryOrder') {
      assert.ok(summaries.every(summary => summary.tryOrder === 'SCORE'));
      continue;
    }
    if (key === 'outcome') {
      assert.deepEqual([...new Set(summaries.map(summary => summary.outcome))].sort(), ['NOT_FOUND', 'SUCCESS']);
      continue;
    }
    assert.ok(summaries.some(summary => summary[key] === true || summary[key] > 0), `count ${key} produced`);
  }
});

// Step 9F.2e.4a: the score try order behind its Admin switch. Only the order
// the reader tries articles in changes; with the switch off the reader runs
// exactly as before (no new log fields).
const listings = require('./fixtures/yahoo-listings');

function listingSource(candidates, trigger) {
  const reads = [];
  const source = {
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() {
      return {ok: true, candidates, discoveryStats: {listingOutcome: 'SUCCESS'}};
    },
    async readPage(url, {headline}) {
      reads.push(headline);
      return {ok: true, type: 'SUCCESS', articleContent: {headline, canonicalUrl: url, publisher: 'Fake Wire',
        publishedAt: iso(Date.parse(trigger) - 3600000), articleText: `${headline}. Body text.`}};
    }
  };
  return {source, reads};
}

function run2026_10_12(env, candidates = listings.listing2026_10_12()) {
  const {source, reads} = listingSource(candidates, listings.TRIGGER_2026_10_12);
  return runReader(source, {
    acquisitionStartedAt: listings.TRIGGER_2026_10_12,
    runContext: {mostActive: listings.MOST_ACTIVE_2026_10_12},
    stockSnapshots: listings.PORTFOLIO_2026_10_12,
    env
  }).then(outcome => ({...outcome, reads, candidates}));
}

const auditEntriesOf = events => events.filter(event => event.stage === 'activeYahooCandidateAudit')
  .flatMap(event => event.candidates);

test('Step 9F.2e.4a shared reader: the 12 Oct 2026 listing is tried by score with the switch on', async () => {
  // Step 9F.2e.4b: this fixture predates the AI-theme split; it asserts the
  // Step 9F.2e.4a AI-at-20 result, so the AI-theme value is set to 20
  // explicitly (either/or with the macro value -- see lib/article-score.js).
  const on = await run2026_10_12({RANKING_POINTS_AI_THEME: '20'});
  const headlineOfRow = row => listings.LOGGED_ROWS_2026_10_12[row - 1][4];
  assert.deepEqual(on.reads, [1, 3, 5, 6, 4, 7].map(headlineOfRow));
  assert.equal(on.acquiredItems.length, 6);
  const off = await run2026_10_12({SCORE_TRY_ORDER_ENABLED: 'off'});
  assert.deepEqual(off.reads, [1, 2, 3, 4, 5, 6].map(headlineOfRow));
  // The same rows are dropped either way.
  const dropped = outcome => auditEntriesOf(outcome.events)
    .filter(entry => entry.decision === 'SKIPPED_BELOW_RELEVANCE_FLOOR').map(entry => entry.slug).sort();
  assert.equal(dropped(on).length, 3);
  assert.deepEqual(dropped(on), dropped(off));
});

test('Step 9F.2e.4a shared reader: the switch is on by default and reads true/1/on and false/0/off', async () => {
  const firstRead = async env => (await run2026_10_12(env)).reads[2];
  const scoreThird = listings.LOGGED_ROWS_2026_10_12[4][4];
  const tierThird = listings.LOGGED_ROWS_2026_10_12[2][4];
  // Step 9F.2e.4b: this fixture predates the AI-theme split; it asserts the
  // Step 9F.2e.4a AI-at-20 result, so the AI-theme value is set to 20
  // explicitly on every "on" run.
  for (const value of [undefined, 'true', '1', 'on', 'ON ', 'maybe', '']) {
    const env = {RANKING_POINTS_AI_THEME: '20', ...(value === undefined ? {} : {SCORE_TRY_ORDER_ENABLED: value})};
    assert.equal(await firstRead(env), scoreThird, `value ${JSON.stringify(value)}`);
  }
  for (const value of ['false', '0', 'off', ' Off']) {
    assert.equal(await firstRead({SCORE_TRY_ORDER_ENABLED: value}), tierThird, `value ${value}`);
  }
});

test('Step 9F.2e.4a shared reader: tryOrder and tryRank are logged with the switch on only', async () => {
  const on = await run2026_10_12({});
  const off = await run2026_10_12({SCORE_TRY_ORDER_ENABLED: 'off'});
  const onSummary = on.events[0];
  const offSummary = off.events[0];
  // On: tryOrder sits right after staleByLabelCount; nothing else in the summary changes.
  const onKeys = Object.keys(onSummary);
  assert.equal(onSummary.tryOrder, 'SCORE');
  assert.equal(onKeys[onKeys.indexOf('staleByLabelCount') + 1], 'tryOrder');
  assert.deepEqual(onKeys.filter(key => key !== 'tryOrder'), Object.keys(offSummary));
  assert.equal('tryOrder' in offSummary, false);
  // On: tryRank right after rank on every row that is in the try order, 1..n
  // in download order; dropped rows have none.
  const onAudit = auditEntriesOf(on.events);
  for (const entry of onAudit) {
    if (entry.decision === 'SKIPPED_BELOW_RELEVANCE_FLOOR') {
      assert.equal('tryRank' in entry, false);
    } else {
      assert.deepEqual(Object.keys(entry).slice(0, 3), ['rank', 'tryRank', 'tier']);
    }
  }
  const tried = onAudit.filter(entry => 'tryRank' in entry).sort((a, b) => a.tryRank - b.tryRank);
  assert.deepEqual(tried.map(entry => entry.tryRank), tried.map((entry, index) => index + 1));
  assert.equal(tried.length, 71);
  const {auditSlug} = require('../lib/source-audit');
  const slugOfRead = headline => auditSlug(on.candidates.find(item => item.headline === headline).url);
  assert.deepEqual(tried.slice(0, on.reads.length).map(entry => entry.slug), on.reads.map(slugOfRead));
  // The audit rows stay in tier order (rank) either way.
  assert.deepEqual(onAudit.map(entry => entry.rank), onAudit.map((entry, index) => index + 1));
  // Off: no tryRank anywhere; every audit row is the same apart from tryRank.
  const offAudit = auditEntriesOf(off.events);
  assert.equal(offAudit.some(entry => 'tryRank' in entry), false);
  const withoutTryRank = ({tryRank, ...rest}) => rest;
  const decisionless = ({decision, attempts, publishedAt, ...rest}) => rest;
  assert.deepEqual(onAudit.map(withoutTryRank).map(decisionless), offAudit.map(decisionless));
});

test('Step 9F.2e.4a shared reader: a 74-candidate audit stays under the event byte limit, on and off', async () => {
  const {AUDIT_MAX_EVENT_BYTES} = require('../lib/source-audit');
  for (const env of [{}, {SCORE_TRY_ORDER_ENABLED: 'off'}]) {
    // Long headlines so every audit row is near its field limits.
    const candidates = listings.listing2026_10_12().map((item, index) => ({
      ...item, headline: `${item.headline} ${'x'.repeat(80)}`.slice(0, 200), publisher: `${item.publisher} Long Publisher Name`,
      url: `${item.url.replace('.html', '')}-${'y'.repeat(60)}-${index}.html`
    }));
    const {events} = await run2026_10_12(env, candidates);
    const audit = events.filter(event => event.stage === 'activeYahooCandidateAudit');
    assert.ok(audit.length >= 8);
    for (const event of audit) {
      const bytes = Buffer.byteLength(JSON.stringify({...event, generationId: '0'.repeat(36)}), 'utf8');
      assert.ok(bytes <= AUDIT_MAX_EVENT_BYTES, `${bytes} bytes`);
      assert.equal(event.parts, audit.length);
    }
    assert.equal(audit.flatMap(event => event.candidates).length, 74);
  }
});

// Step 9F.2e.5: article slots on (the default) -- the admit cap is the general
// slots plus the spare slots passed on, the attempt cap is the slots-on row.
test('Step 9F.2e.5 shared reader: Yahoo limits with the article slots on', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {}}))), {
    maxArticleAttempts: 18, maxAdmittedArticles: 10, initialCandidateAttempts: 5,
    articleSlots: {generalSlots: 7, spareSlots: 3}
  });
  for (const value of ['on', 'true', '1', 'maybe', '']) {
    assert.equal(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {ARTICLE_SLOTS_ENABLED: value}}).maxAdmittedArticles, 10, value);
  }
  for (const value of ['off', 'false', '0', 'OFF']) {
    assert.equal(sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {ARTICLE_SLOTS_ENABLED: value}}).maxAdmittedArticles, 6, value);
  }
});

test('Step 9F.2e.5 shared reader: the same slot caps in a completed state, with the slots in the summary', async () => {
  const pages = Object.fromEntries(Array.from({length: 13}, (_, index) => [`s${String(index).padStart(2, '0')}`, 'OK']));
  for (const mode of ['ACTIVE', 'COMPLETED']) {
    const {events, acquiredItems} = await runReader(fakeSource(pages).source, {
      mode, horizonFor: () => mode === 'COMPLETED' ? 'COMPLETED_SESSION' : 'CURRENT_SESSION',
      limits: sourceLimits(YAHOO_NEWS_SOURCE_ID, {env: {}})
    });
    assert.equal(acquiredItems.length, 10, mode);
    const summary = events.find(event => event.stage === 'activeYahooAcquisition');
    assert.deepEqual([summary.generalSlots, summary.spareSlots, summary.maxArticleAttempts, summary.maxAdmittedArticles],
      [7, 3, 18, 10], mode);
    assert.equal(Object.values(decisions(events)).filter(entry => entry.decision === 'SKIPPED_MAX_ADMITTED').length, 3, mode);
  }
});

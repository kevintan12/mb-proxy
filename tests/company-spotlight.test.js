// Step 9W Build A: the company spotlight. Made-up companies and headlines only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSpotlight, spotlightSettings, priceLineItem, sp500MovePctFrom, hasCompanyEventWord, REASON
} = require('../lib/company-spotlight');
const {scoreArticle} = require('../lib/article-score');
const {applyWriterTextBudgetToNewsItems} = require('../lib/article-selection');
const {readRunContext, readSource} = require('../lib/source-reader');
const {createYahooMostActiveAcquisitionService} = require('../lib/yahoo-most-active-acquisition');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {withEnv} = require('./fixtures/step-9w-switches');

const ANCHORS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const SETTINGS = Object.freeze({
  maxCompanies: 5, relativeMovePct: 3, minMarketCapUsdBn: 50, minOutlets: 3,
  anchorSymbols: ANCHORS, anchorGuaranteed: 1
});
const AS_OF = '2026-10-23T15:00:00.000Z';
const row = (symbol, movePct, marketCapUsdBn, name = `${symbol} Madeup Corp`) => ({
  symbol, shortName: name, longName: name, price: 100, movePct, marketCapUsdBn, asOf: AS_OF
});
const anchor = (symbol, movePct, name = `${symbol} Anchor Inc`) => ({symbol, name, price: 200, movePct, asOf: AS_OF});
const symbols = result => result.companies.map(company => company.symbol);

test('Step 9W: settings rows, defaults and ranges as approved', () => {
  const expect = {
    spotlightMaxCompanies: [5, 2, 8], spotlightRelativeMovePct: [3, 1.5, 8],
    spotlightMinMarketCapUsdBn: [50, 10, 500], spotlightMinOutlets: [3, 2, 6],
    spotlightAnchorGuaranteed: [1, 0, 2], spotlightSlots: [2, 0, 3],
    rankingPointsSpotlight: [12, 0, 20], rankingPointsCompanyEvent: [4, 0, 8]
  };
  for (const [name, [value, min, max]] of Object.entries(expect)) {
    const entry = SETTINGS_REGISTRY[name];
    assert.deepEqual([entry.default, entry.min, entry.max, entry.admin], [value, min, max, 'Admin'], name);
    assert.ok(entry.envVar && entry.description);
  }
  assert.deepEqual([...settingValue('spotlightAnchorSymbols')], ANCHORS);
  assert.equal(SETTINGS_REGISTRY.screenerCount.admin, 'Fixed');
  assert.equal(settingValue('screenerCount'), 25);
  assert.equal(settingValue('companySpotlightEnabled', {env: {}}), true);
  assert.equal(settingValue('companySpotlightEnabled', {env: {COMPANY_SPOTLIGHT_ENABLED: 'false'}}), false);
  assert.deepEqual(spotlightSettings({env: {}}), {...SETTINGS, anchorSymbols: settingValue('spotlightAnchorSymbols')});
});

test('Step 9W signal 1: the move against the S&P 500 (either direction) at or past the threshold', () => {
  const result = buildSpotlight({
    screenerRows: [row('UPCO', 3.6, 80), row('DNCO', -2.4, 80), row('SMCO', 2.5, 80), row('EXCO', 3.5, 80)],
    sp500MovePct: 0.6, settings: {...SETTINGS, anchorGuaranteed: 0}
  });
  // UPCO 3.0 better, DNCO 3.0 worse, EXCO 2.9 (no), SMCO 1.9 (no).
  assert.deepEqual(symbols(result).sort(), ['DNCO', 'UPCO']);
  for (const company of result.companies) assert.deepEqual([...company.reasons], [REASON.BIG_MOVE]);
  // No S&P 500 move: signal 1 is skipped entirely.
  assert.deepEqual(symbols(buildSpotlight({screenerRows: [row('UPCO', 9, 80)], sp500MovePct: null,
    settings: SETTINGS})), []);
});

test('Step 9W size floor: below-floor or unknown-size companies never enter; anchors count as meeting it', () => {
  const result = buildSpotlight({
    screenerRows: [row('SMALL', 12, 49.9), row('NOSIZE', 12, null), row('BIG', 12, 50)],
    anchorQuotes: [anchor('TSLA', 8)],
    sp500MovePct: 0, settings: {...SETTINGS, anchorGuaranteed: 0}
  });
  assert.deepEqual(symbols(result), ['BIG', 'TSLA']);
});

test('Step 9W signal 3: distinct listed headlines naming the company', () => {
  const headlines = [
    'Outletco shares jump after upgrade', 'Outletco shares jump after upgrade',
    'Why Outletco matters', 'Outletco hires a new chief', 'Twoco beats', 'Twoco misses'
  ];
  const result = buildSpotlight({
    screenerRows: [row('OUTL', 0.1, 60, 'Outletco Inc'), row('TWOC', 0.1, 60, 'Twoco Inc'),
      row('TINY', 0.1, 5, 'Tinyco Inc')],
    poolHeadlines: headlines.concat(['Tinyco 1', 'Tinyco 2', 'Tinyco 3']), sp500MovePct: 0,
    settings: {...SETTINGS, anchorGuaranteed: 0}
  });
  assert.deepEqual(symbols(result), ['OUTL']);
  assert.equal(result.companies[0].outlets, 3);
  assert.deepEqual([...result.companies[0].reasons], [REASON.OUTLETS]);
});

test('Step 9W anchors: the biggest relative mover is guaranteed once; several big movers up to the cap; none', () => {
  const quotes = [anchor('AAPL', 0.2), anchor('MSFT', -0.9), anchor('GOOGL', -2.1), anchor('AMZN', 0.1)];
  const one = buildSpotlight({anchorQuotes: quotes, sp500MovePct: 0.6, settings: SETTINGS});
  assert.deepEqual(symbols(one), ['GOOGL']);
  assert.deepEqual([...one.companies[0].reasons], [REASON.ANCHOR_GUARANTEED]);
  const none = buildSpotlight({anchorQuotes: quotes, sp500MovePct: 0.6, settings: {...SETTINGS, anchorGuaranteed: 0}});
  assert.deepEqual(symbols(none), []);
  const many = buildSpotlight({
    anchorQuotes: ANCHORS.map((symbol, index) => anchor(symbol, 5 + index)),
    screenerRows: [row('BIGCO', -9, 500)], sp500MovePct: 0, settings: SETTINGS
  });
  // TSLA guaranteed; then by size of move: META 10, BIGCO 9 and NVDA 9 (symbol order), AMZN 8.
  assert.deepEqual(symbols(many), ['TSLA', 'META', 'BIGCO', 'NVDA', 'AMZN']);
  assert.equal(many.companies.filter(company => company.reasons.includes(REASON.ANCHOR_GUARANTEED)).length, 1);
  assert.equal(many.companies.length, 5);
});

test('Step 9W list companies are left out of the spotlight; the guarantee passes to the next anchor', () => {
  const result = buildSpotlight({
    anchorQuotes: [anchor('NVDA', -6), anchor('GOOGL', -2)], screenerRows: [row('LISTCO', 9, 90)],
    sp500MovePct: 0, listSymbols: ['NVDA', 'LISTCO'], settings: SETTINGS
  });
  assert.deepEqual(symbols(result), ['GOOGL']);
});

test('Step 9W scoring: spotlight points; the event booster only for a named spotlight or list company', () => {
  const spot = [{symbol: 'GOOGL', shortName: 'Alphabet Inc.', longName: 'Alphabet Inc.'}];
  const list = [{symbol: 'CPRT', shortName: 'Copart, Inc.', longName: 'Copart, Inc.'}];
  const opts = {triggerAt: AS_OF, env: {}, spotlightIdentities: spot, eventIdentities: spot.concat(list)};
  const named = scoreArticle({headline: 'Alphabet earnings beat'}, opts);
  assert.equal(named.matched.spotlight, 12);
  assert.equal(named.matched.companyEvent, 4);
  assert.equal(scoreArticle({headline: 'Copart results lift shares'}, opts).matched.companyEvent, 4);
  const unnamed = scoreArticle({headline: 'Some company earnings beat'}, opts);
  assert.equal(unnamed.matched.spotlight, 0);
  assert.equal(unnamed.matched.companyEvent, 0);
  assert.ok(hasCompanyEventWord('Merger talk') && !hasCompanyEventWord('Dealer stocks'));
  // Switch off (no identities): the same matched keys and score as before 9W.
  const off = scoreArticle({headline: 'Alphabet earnings beat'}, {triggerAt: AS_OF, env: {}});
  assert.deepEqual(Object.keys(off.matched), ['usMacro', 'mostActive', 'portfolio', 'wirePublishers',
    'includeWords', 'asiaEurope', 'benchmarkOrGeneric', 'ai']);
  assert.equal(named.score - off.score, 16);
});

test('Step 9W price line: market-data evidence with existing keys only, never a news item', () => {
  const company = buildSpotlight({anchorQuotes: [anchor('GOOGL', -2.1, 'Alphabet Inc.')], sp500MovePct: 0.6,
    settings: SETTINGS}).companies[0];
  const item = priceLineItem(company, {sp500MovePct: 0.6});
  assert.deepEqual(Object.keys(item), ['sourceId', 'market', 'evidenceCategory', 'title', 'summary',
    'canonicalUrl', 'publishedAt', 'symbols', 'provenance']);
  assert.equal(item.evidenceCategory, 'market-data');
  assert.match(item.summary, /Alphabet Inc\. \(GOOGL\) shares fell 2\.10% .* while the S&P 500 rose 0\.60% \(2\.70 percentage points worse/);
  assert.throws(() => priceLineItem({...company, price: null}));
});

test('Step 9W S&P 500 move: live overlay in REGULAR, otherwise the latest completed session', () => {
  const sessions = [{percentChange: 0.4}, {percentChange: -1.2}];
  assert.equal(sp500MovePctFrom([{symbol: '^GSPC', completedSessions: sessions,
    currentOverlay: {marketState: 'REGULAR', percentChange: -0.56}}]), -0.56);
  assert.equal(sp500MovePctFrom([{symbol: '^GSPC', completedSessions: sessions,
    currentOverlay: {marketState: 'POST', percentChange: 0.1}}]), -1.2);
  assert.equal(sp500MovePctFrom([{symbol: '^IXIC', completedSessions: sessions}]), null);
});

test('Step 9W 150 KB rule: spotlight articles are given up by score with the general ones, portfolio last', () => {
  const big = 'x'.repeat(60 * 1024);
  const items = [1, 2, 3, 4].map(n => ({title: `t${n}`, summary: big}));
  const meta = [
    {slot: 'PORTFOLIO', score: 1, ageHours: 1}, {slot: 'SPOTLIGHT', score: 5, ageHours: 1},
    {slot: 'GENERAL', score: 30, ageHours: 1}, {slot: 'GENERAL', score: 9, ageHours: 1}
  ];
  const fit = applyWriterTextBudgetToNewsItems({items, meta, budgetBytes: 150 * 1024});
  assert.deepEqual(fit.dropped.map(entry => entry.headline), ['t2', 't4']);
  assert.deepEqual(fit.items.map(item => item.title), ['t1', 't3']);
});

// --- the shared reader -------------------------------------------------------

const TRIGGER = '2026-10-23T15:00:00.000Z';
const urlFor = name => `https://news.example.test/articles/${name}.html`;

function headlineSource(headlines) {
  return {
    sourceId: 'us.yahoo-finance',
    async findCandidates() {
      return {ok: true, candidates: Object.entries(headlines).map(([name, headline]) => ({
        headline, url: urlFor(name), publisher: 'Fake Wire', edition: 'US'}))};
    },
    async readPage(url, {headline}) {
      return {ok: true, type: 'SUCCESS', articleContent: {headline, canonicalUrl: url, publisher: 'Fake Wire',
        publishedAt: '2026-10-23T14:00:00.000Z', articleText: `${headline}. Body.`}};
    }
  };
}

function runReader(source, {spotlightInputs = null, spotlightContext = null, limits} = {}) {
  const events = [];
  return readSource({
    source,
    runContext: {mostActive: [], ...(spotlightInputs ? {spotlightInputs} : {})},
    ...(spotlightContext ? {spotlightContext} : {}),
    market: 'US', mode: 'ACTIVE',
    timed: async (stage, operation) => operation(),
    emit: event => events.push(event),
    acquisitionStartedAt: TRIGGER,
    marketContext: {exchangeTimezone: 'America/New_York', marketState: 'REGULAR', primaryCompletedSessionDate: '2026-10-22'},
    benchmarkSnapshots: [], stockSnapshots: [], classificationPreflightAvailable: false, requiredItems: [],
    horizonFor: () => 'CURRENT_SESSION', acquiredItems: [], acquiredMeta: [],
    clock: {monotonicNow: () => 0, sleep: async () => {}},
    limits: limits || {maxArticleAttempts: 12, maxAdmittedArticles: 2, initialCandidateAttempts: 5}
  }).then(result => ({result, events}));
}

const HEADLINES = {
  macro1: 'Fed holds rates as Treasury yields rise', macro2: 'Oil jumps as inflation fears grow',
  macro3: 'Fed officials weigh rates path', goog1: 'Alphabet shares slide on cloud worries',
  goog2: 'Alphabet earnings preview', tsla: 'Tesla deal talk lifts shares', other: 'Random company news'
};
const INPUTS = Object.freeze({
  screenerRows: [], screenerOutcomes: {}, anchorCount: 7,
  anchorQuotes: [anchor('GOOGL', -3.0, 'Alphabet Inc.'), anchor('TSLA', 4.5, 'Tesla, Inc.')]
});
const CONTEXT = Object.freeze({sp500MovePct: 0.6, listIdentities: [], extraHeadlines: []});

test('Step 9W reader: spotlight slots take one article per company on top of the general slots', async () => {
  await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'on', async () => {
    const {result} = await runReader(headlineSource(HEADLINES), {spotlightInputs: INPUTS, spotlightContext: CONTEXT});
    assert.deepEqual(result.spotlight.companies.map(company => company.symbol), ['TSLA', 'GOOGL']);
    // Spotlight points move the Alphabet and Tesla headlines up; 2 general + at most 2 spotlight.
    assert.ok(result.items.length <= 4);
    const titles = result.items.map(item => item.title);
    assert.equal(titles.filter(title => /Alphabet/.test(title)).length, 1, 'one per company in the first pass');
    assert.ok(result.spotlight.slotsFilled <= 2);
  });
});

test('Step 9W reader: switch off, no inputs, or CNBC gives exactly the pre-9W reading', async () => {
  const plain = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'off', () =>
    runReader(headlineSource(HEADLINES), {spotlightInputs: INPUTS, spotlightContext: CONTEXT}));
  const none = await runReader(headlineSource(HEADLINES));
  assert.equal(plain.result.spotlight, undefined);
  assert.deepEqual(JSON.stringify(plain.result.items), JSON.stringify(none.result.items));
  assert.deepEqual(JSON.stringify(plain.events), JSON.stringify(none.events));
  const cnbc = {...headlineSource(HEADLINES), sourceId: 'us.cnbc'};
  const cnbcRead = await runReader(cnbc, {spotlightInputs: INPUTS, spotlightContext: CONTEXT});
  assert.equal(cnbcRead.result.spotlight, undefined);
});

test('Step 9W run context: screener and chart failures fall back silently; switch off fetches nothing new', async () => {
  const calls = [];
  const failing = createYahooMostActiveAcquisitionService({fetchImpl: async url => {
    calls.push(url);
    if (url.includes('most_actives')) return {ok: false, status: 500};
    throw new Error('network down');
  }});
  const timed = async (stage, operation) => operation();
  const on = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'on', () => readRunContext({yahooMostActiveAcquisition: failing, timed}));
  assert.deepEqual(on.mostActive, []);
  assert.deepEqual([...on.spotlightInputs.screenerRows], []);
  assert.deepEqual([...on.spotlightInputs.anchorQuotes], []);
  assert.equal(calls.length, 1 + 2 + 7);
  calls.length = 0;
  const off = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'off', () => readRunContext({yahooMostActiveAcquisition: failing, timed}));
  assert.deepEqual(Object.keys(off), ['mostActive']);
  assert.equal(calls.length, 1);
  // A fake without the spotlight methods: exactly the old run context.
  const old = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'on', () =>
    readRunContext({yahooMostActiveAcquisition: {acquireMostActive: async () => ({ok: true, candidates: []})}, timed}));
  assert.deepEqual(Object.keys(old), ['mostActive']);
});

// Step 9W Build A.1: an empty spotlight is no spotlight, and spotlight-only
// short company names. Made-up headlines; company names as Yahoo writes them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSpotlight, spotlightNameForms, spotlightNamesCompany, spotlightSymbolsNamed, identityOf
} = require('../lib/company-spotlight');
const {scoreArticle} = require('../lib/article-score');
const {scoreTryOrder} = require('../lib/article-selection');
const {headlineMatchesIdentity} = require('../lib/headline-matching');
const {readSource} = require('../lib/source-reader');
const {withEnv} = require('./fixtures/step-9w-switches');

const AS_OF = '2026-10-23T15:00:00.000Z';
const ANCHORS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const SETTINGS = Object.freeze({
  maxCompanies: 5, relativeMovePct: 3, minMarketCapUsdBn: 50, minOutlets: 3,
  anchorSymbols: ANCHORS, anchorGuaranteed: 1
});
const company = (symbol, name) => ({symbol, shortName: name, longName: name});
const YAHOO_NAMES = [
  company('AMZN', 'Amazon.com, Inc.'), company('GOOGL', 'Alphabet Inc.'),
  company('CRWD', 'CrowdStrike Holdings, Inc.'), company('PANW', 'Palo Alto Networks, Inc.'),
  company('BE', 'Bloom Energy Corporation'), company('TSLA', 'Tesla, Inc.'), company('META', 'Meta Platforms, Inc.')
];
const LIST = [company('CPRT', 'Copart, Inc.')];

function spotlightIdentities(companies, seen = companies) {
  const forms = spotlightNameForms(seen);
  return companies.map(item => identityOf({...item, ...forms.get(item.symbol)}));
}

// --- empty spotlight ---------------------------------------------------------

test('Step 9W A.1: an empty spotlight gives the same score, keys and order as no spotlight', () => {
  const headlines = ['Copart results lift shares', 'Fed holds rates', 'Copart deal talk', 'Random news'];
  for (const headline of headlines) {
    const none = scoreArticle({headline}, {triggerAt: AS_OF, env: {}});
    const empty = scoreArticle({headline}, {triggerAt: AS_OF, env: {}, spotlightIdentities: [], eventIdentities: LIST});
    assert.deepEqual(empty, none, headline);
    assert.equal(empty.matched.companyEvent, undefined, 'no event points for a list company');
  }
  const candidates = headlines.map((headline, index) => ({headline, url: `https://x.test/${index}`, publisher: 'Wire'}));
  const base = {candidates, mostActive: [], portfolioSnapshots: [{symbol: 'CPRT', instrumentName: 'Copart, Inc.'}],
    labelWindow: null, generationTime: AS_OF, env: {}};
  assert.deepEqual(scoreTryOrder({...base, spotlightIdentities: [], eventIdentities: LIST}).order,
    scoreTryOrder(base).order);
});

test('Step 9W A.1: a non-empty spotlight gives event points only for a named spotlight or list company', () => {
  const spot = spotlightIdentities([company('AMZN', 'Amazon.com, Inc.')]);
  const opts = {triggerAt: AS_OF, env: {}, spotlightIdentities: spot, eventIdentities: spot.concat(LIST)};
  assert.equal(scoreArticle({headline: 'Amazon earnings beat'}, opts).matched.companyEvent, 4);
  assert.equal(scoreArticle({headline: 'Amazon earnings beat'}, opts).matched.spotlight, 12);
  assert.equal(scoreArticle({headline: 'Copart results lift shares'}, opts).matched.companyEvent, 4);
  assert.equal(scoreArticle({headline: 'Copart results lift shares'}, opts).matched.spotlight, 0);
  assert.equal(scoreArticle({headline: 'Some company earnings beat'}, opts).matched.companyEvent, 0);
  assert.equal(scoreArticle({headline: 'Amazon shares jump'}, opts).matched.companyEvent, 0);
});

// --- the reader with failed or empty inputs ----------------------------------

const TRIGGER = '2026-10-23T15:00:00.000Z';
const HEADLINES = {
  macro1: 'Fed holds rates as Treasury yields rise', macro2: 'Oil jumps as inflation fears grow',
  list1: 'Copart results lift shares', list2: 'Copart deal talk grows', amzn: 'Amazon shares jump on cloud',
  other: 'Random company news'
};

function headlineSource(headlines) {
  return {
    sourceId: 'us.yahoo-finance',
    async findCandidates() {
      return {ok: true, candidates: Object.entries(headlines).map(([name, headline]) => ({
        headline, url: `https://news.example.test/articles/${name}.html`, publisher: 'Fake Wire', edition: 'US'}))};
    },
    async readPage(url, {headline}) {
      return {ok: true, type: 'SUCCESS', articleContent: {headline, canonicalUrl: url, publisher: 'Fake Wire',
        publishedAt: '2026-10-23T14:00:00.000Z', articleText: `${headline}. Body.`}};
    }
  };
}

async function runReader({spotlightInputs = null, spotlightContext = null} = {}) {
  const events = [];
  const result = await readSource({
    source: headlineSource(HEADLINES),
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
    limits: {maxArticleAttempts: 12, maxAdmittedArticles: 2, initialCandidateAttempts: 5}
  });
  return {result, events};
}

const CONTEXT = Object.freeze({sp500MovePct: 0.6, listIdentities: LIST, extraHeadlines: []});
const failedInputs = overrides => Object.freeze({
  screenerRows: [], anchorQuotes: [], anchorCount: 7,
  screenerOutcomes: {mostActives: 'FAILURE', dayGainers: 'FAILURE', dayLosers: 'FAILURE'}, ...overrides
});

test('Step 9W A.1 reader: screener failure, anchor failure, both, or nobody qualifying read as before 9W', async () => {
  const before = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'off', () => runReader());
  const cases = {
    bothFailed: failedInputs({}),
    screenersFailed: failedInputs({anchorQuotes: [{symbol: 'AMZN', name: 'Amazon.com, Inc.', price: 200, movePct: 0.7, asOf: AS_OF}]}),
    anchorsFailed: failedInputs({screenerRows: [{symbol: 'SMAL', shortName: 'Small Madeup Corp', longName: 'Small Madeup Corp',
      price: 5, movePct: 9, marketCapUsdBn: 1, asOf: AS_OF}], screenerOutcomes: {mostActives: 'SUCCESS'}})
  };
  // bothFailed: no companies at all; screenersFailed: one anchor price, but no S&P 500 move, so no
  // guarantee and no big move; anchorsFailed: one screener row, below the size floor.
  for (const [label, inputs] of Object.entries(cases)) {
    const context = label === 'screenersFailed' ? {...CONTEXT, sp500MovePct: null} : CONTEXT;
    const on = await withEnv('COMPANY_SPOTLIGHT_ENABLED', 'on', () =>
      runReader({spotlightInputs: inputs, spotlightContext: context}));
    assert.equal(on.result.spotlight.companies.length, 0, label);
    assert.equal(on.result.spotlight.active, false, label);
    assert.equal(JSON.stringify(on.result.items), JSON.stringify(before.result.items), label);
    assert.equal(JSON.stringify(on.result.meta), JSON.stringify(before.result.meta), label);
    assert.equal(JSON.stringify(on.result.pool), JSON.stringify(before.result.pool), label);
    assert.equal(JSON.stringify(on.events), JSON.stringify(before.events), label);
  }
});

// --- short names --------------------------------------------------------------

test('Step 9W A.1 short names: Amazon, Google/Alphabet, CrowdStrike, Palo Alto, Bloom, Tesla', () => {
  const ids = Object.fromEntries(spotlightIdentities(YAHOO_NAMES).map(item => [item.symbol, item]));
  const named = [
    ['Amazon shares jump', 'AMZN'], ["Amazon's cloud unit grows", 'AMZN'], ['Amazon.com, Inc. files report', 'AMZN'],
    ['Google unveils new AI model', 'GOOGL'], ['Alphabet slides', 'GOOGL'],
    ['CrowdStrike beats estimates', 'CRWD'], ['Palo Alto raises outlook', 'PANW'],
    ['Bloom soars on data-center deal', 'BE'], ['Bloom Energy jumps', 'BE'], ['Tesla deliveries rise', 'TSLA'],
    ['Meta-owned app grows', 'META']
  ];
  for (const [headline, symbol] of named) {
    assert.ok(spotlightNamesCompany(headline, ids[symbol]), `${headline} -> ${symbol}`);
  }
  assert.ok(!headlineMatchesIdentity('Amazon shares jump', company('AMZN', 'Amazon.com, Inc.')), 'shared matcher unchanged');
  assert.ok(!headlineMatchesIdentity('Google unveils new AI model', company('GOOGL', 'Alphabet Inc.')));
  assert.ok(!headlineMatchesIdentity('Palo Alto raises outlook', company('PANW', 'Palo Alto Networks, Inc.')));
  assert.deepEqual(spotlightSymbolsNamed('Amazon and Google lead tech', Object.values(ids)), ['AMZN', 'GOOGL']);
});

test('Step 9W A.1 guards: whole words, capital letter, common words, shared forms, longer names', () => {
  const ids = Object.fromEntries(spotlightIdentities(YAHOO_NAMES).map(item => [item.symbol, item]));
  for (const [headline, symbol] of [
    ['Metaverse bets fade', 'META'], ['Bloomberg survey shows calm', 'BE'], ['Spring flowers bloom early', 'BE'],
    ['Amazonian rainforest report', 'AMZN'], ['Teslas on the road', 'TSLA'], ['Googled answers', 'GOOGL']
  ]) {
    assert.ok(!spotlightNamesCompany(headline, ids[symbol]), `${headline} must not name ${symbol}`);
  }
  // Common one-word short forms are not used (the shared matcher keeps its own matches).
  const forms = spotlightNameForms([company('TGT', 'Target Corporation'), company('GM', 'General Motors Company'),
    company('AMAT', 'Applied Materials, Inc.')]);
  assert.deepEqual([...forms.get('TGT').forms], []);
  assert.deepEqual([...forms.get('GM').forms], ['General Motors']);
  assert.ok(!spotlightNamesCompany('Analysts lift price target', identityOf({...company('XTGT', 'Target Holdings Group'),
    ...spotlightNameForms([company('XTGT', 'Target Holdings Group')]).get('XTGT')})));
  // Two companies with the same short form: neither gets it.
  const pair = [company('PNA', 'Pinnacle Networks, Inc.'), company('PNB', 'Pinnacle Energy Corporation')];
  const pairIds = spotlightIdentities(pair);
  assert.deepEqual(spotlightSymbolsNamed('Pinnacle shares jump', pairIds), []);
  assert.deepEqual(spotlightSymbolsNamed('Pinnacle Networks shares jump', pairIds), ['PNA']);
  // A different company whose longer name contains the short form (the shared
  // matcher's own full-name matches are unchanged and not guarded here).
  const bloom = spotlightIdentities([company('BE', 'Bloom Energy Corporation')],
    [company('BE', 'Bloom Energy Corporation'), company('BLM', 'Bloom Lake Mining Corp')])[0];
  assert.deepEqual([...bloom.blockers], ['Bloom Lake Mining']);
  assert.ok(!spotlightNamesCompany('Bloom Lake Mining earnings', bloom));
  assert.ok(spotlightNamesCompany('Bloom jumps while Bloom Lake Mining slips', bloom));
  // A short form that would be another anchor's alias stays with the anchor.
  const aliasForms = spotlightNameForms([company('AMZN', 'Amazon.com, Inc.'), company('AMZX', 'Amazon Corp')]);
  assert.deepEqual([...aliasForms.get('AMZX').forms], []);
});

test('Step 9W A.1: list companies are matched by the shared matcher only', () => {
  const spot = spotlightIdentities([company('TSLA', 'Tesla, Inc.')]);
  const list = [company('PANW', 'Palo Alto Networks, Inc.')];
  const opts = {triggerAt: AS_OF, env: {}, portfolioIdentities: list, spotlightIdentities: spot,
    eventIdentities: spot.concat(list)};
  const shortOnly = scoreArticle({headline: 'Palo Alto earnings beat'}, opts);
  assert.equal(shortOnly.matched.portfolio, 0);
  assert.equal(shortOnly.matched.companyEvent, 0);
  const fullName = scoreArticle({headline: 'Palo Alto Networks earnings beat'}, opts);
  assert.ok(fullName.matched.portfolio > 0);
  assert.equal(fullName.matched.companyEvent, 4);
  // A list company is never in the spotlight, so short names never reach it.
  const built = buildSpotlight({screenerRows: [{...list[0], price: 100, movePct: 9, marketCapUsdBn: 100, asOf: AS_OF}],
    sp500MovePct: 0, listSymbols: ['PANW'], listIdentities: list, settings: SETTINGS});
  assert.deepEqual(built.companies, []);
});

test('Step 9W A.1: the headline count uses short names', () => {
  const rows = [{...company('AMZN', 'Amazon.com, Inc.'), price: 100, movePct: 0.5, marketCapUsdBn: 2000, asOf: AS_OF}];
  const built = buildSpotlight({screenerRows: rows, sp500MovePct: 0, settings: {...SETTINGS, anchorGuaranteed: 0},
    poolHeadlines: ['Amazon shares jump', 'Amazon cloud deal', 'Why Amazon matters', 'Amazonian report']});
  assert.deepEqual(built.companies.map(item => [item.symbol, item.outlets]), [['AMZN', 3]]);
  assert.deepEqual([...built.companies[0].forms], ['Amazon']);
});

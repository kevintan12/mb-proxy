// Step 9F.6b: the CNBC RSS finder (lib/sources/cnbc-rss.js). Fixtures only, no
// network: every fetch is a stand-in.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {
  CNBC_RSS_SOURCE_ID,
  CNBC_RSS_LIST_URL_PREFIX,
  listUpdatedTime,
  moversMatch,
  isBiggestMoversPage,
  isPossibleMoversMiss,
  isExcludedFamily,
  selectCnbcRssCandidates,
  createCnbcRssSource
} = require('../lib/sources/cnbc-rss');
const {settingValue} = require('../lib/settings-registry');

const LIST_IDS = ['100003114', '20910258', '10000664', '15839069', '15839135', '19854910', '10001147'];

function item({link, title, pubDate = 'Fri, 16 Oct 2026 16:29:16 GMT', type = 'cnbcnewsstory', id = null,
  description = 'Summary.'}) {
  return '<item>'
    + `<link>${link}</link>`
    + `<guid isPermaLink="false">${id || `g-${link}`}</guid>`
    + `<metadata:type>${type}</metadata:type>`
    + (id ? `<metadata:id>${id}</metadata:id>` : '')
    + '<metadata:sponsored>false</metadata:sponsored>'
    + `<title>${title}</title>`
    + `<description><![CDATA[${description}]]></description>`
    + `<pubDate>${pubDate}</pubDate>`
    + '</item>';
}

function rss(items, {channelTime = 'Fri, 16 Oct 2026 18:10 GMT'} = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<rss xmlns:metadata="http://search.cnbc.com/rss/2.0/modules/siteContentMetadata" version="2.0">'
    + `<channel><title>List</title><lastBuildDate>${channelTime}</lastBuildDate><pubDate>${channelTime}</pubDate>`
    + items.join('') + '</channel></rss>';
}

function response(body, {status = 200, headers = {}} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => headers[name.toLowerCase()] ?? null},
    text: async () => body
  };
}

// A fetch stand-in: `bodies` maps a list id to a body string, a {status} or a
// function; unlisted ids get an empty list.
function fakeFetch(bodies = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    const id = new URL(url).searchParams.get('id');
    const entry = bodies[id];
    if (typeof entry === 'function') return entry(options);
    if (entry && typeof entry === 'object') return response('', entry);
    return response(entry === undefined ? rss([]) : entry);
  };
  return {fetchImpl, calls};
}

const article = (slug, extra = {}) => item({
  link: `https://www.cnbc.com/2026/10/16/${slug}.html`, title: `Article ${slug}`, ...extra
});

async function find({bodies, env = {}, window = null} = {}) {
  const {fetchImpl, calls} = fakeFetch(bodies);
  const result = await createCnbcRssSource({fetchImpl, env}).findCandidates({market: 'US', window, triggerAt: null});
  return {result, calls};
}

test('Step 9F.6b CNBC RSS: reads the 7 fixed lists in parallel with the MarketBrief agent', async () => {
  const {result, calls} = await find({bodies: {100003114: rss([article('one')])}});
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('id')), LIST_IDS);
  assert.ok(calls.every(call => call.url.startsWith(CNBC_RSS_LIST_URL_PREFIX)));
  assert.ok(calls.every(call => call.options.headers['User-Agent'] === 'MarketBrief/1.0 evidence-acquisition'));
  assert.ok(!LIST_IDS.includes('20409666'), 'Market Insider is not read');
  assert.equal(result.ok, true);
  assert.equal(result.discoveryStats.outcome, 'OK');
  assert.deepEqual(result.candidates, [{
    headline: 'Article one',
    url: 'https://www.cnbc.com/2026/10/16/one.html',
    publisher: 'CNBC',
    listedAt: '2026-10-16T16:29:16.000Z',
    listId: '100003114',
    cnbcId: 'g-https://www.cnbc.com/2026/10/16/one.html',
    contentType: 'cnbcnewsstory'
  }]);
  assert.equal(CNBC_RSS_SOURCE_ID, 'us.cnbc');
  assert.equal(Object.isFrozen(result.candidates[0]), true);
});

test('Step 9F.6b CNBC RSS: both list time formats, offsets, and bad times', () => {
  assert.equal(listUpdatedTime('Sun, 18 Oct 2026 06:13:05 GMT'), '2026-10-18T06:13:05.000Z');
  assert.equal(listUpdatedTime('Fri, 16 Oct 2026 18:10 GMT'), '2026-10-16T18:10:00.000Z');
  assert.equal(listUpdatedTime('16 Oct 2026 18:10:00 UTC'), '2026-10-16T18:10:00.000Z');
  assert.equal(listUpdatedTime('Fri, 16 Oct 2026 14:10:00 -0400'), '2026-10-16T18:10:00.000Z');
  assert.equal(listUpdatedTime('Sat, 17 Oct 2026 02:10 +0800'), '2026-10-16T18:10:00.000Z');
  for (const bad of ['', 'yesterday', '2026-10-16T18:10:00Z', 'Sat, 16 Oct 2026 18:10 GMT',
    'Fri, 31 Sep 2026 18:10 GMT', 'Fri, 16 Oct 2026 25:10 GMT', 'Fri, 16 Oct 2026 18:10', null]) {
    assert.equal(listUpdatedTime(bad), null, String(bad));
  }
});

test('Step 9F.6b CNBC RSS: an item with an unreadable list time is kept, last, and counted', async () => {
  const {result} = await find({bodies: {100003114: rss([
    article('no-time', {pubDate: 'sometime'}),
    article('old', {pubDate: 'Thu, 15 Oct 2026 10:00 GMT'}),
    article('new', {pubDate: 'Fri, 16 Oct 2026 20:00:00 GMT'})
  ])}});
  assert.deepEqual(result.candidates.map(candidate => candidate.headline),
    ['Article new', 'Article old', 'Article no-time']);
  assert.equal(result.candidates[2].listedAt, null);
  assert.equal(result.discoveryStats.unparsableListTimeCount, 1);
});

test('Step 9F.6b CNBC RSS: entities and CDATA become plain text', async () => {
  const {result} = await find({bodies: {100003114: rss([
    item({link: 'https://www.cnbc.com/2026/10/17/trump-diesel.html',
      title: 'Trump&apos;s diesel deal &amp; Putin&#8217;s &#x201C;win&#x201D;'}),
    item({link: 'https://www.cnbc.com/2026/10/17/cdata.html',
      title: '<![CDATA[AT&amp;T <b>beats</b> &quot;estimates&quot;]]>'})
  ])}});
  assert.deepEqual(result.candidates.map(candidate => candidate.headline),
    ['Trump\'s diesel deal & Putin’s “win”', 'AT&T beats "estimates"']);
});

test('Step 9F.6b CNBC RSS: bad XML, an oversize list and a timeout fail that list only', async () => {
  const oversize = rss([article('big')]).padEnd(513 * 1024, ' ');
  const {result} = await find({bodies: {
    100003114: '<rss><channel><item></rss>',
    20910258: oversize,
    10000664: response => new Promise((resolve, reject) => {
      response.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    }),
    15839069: rss([article('survivor')])
  }, env: {CNBC_RSS_TIMEOUT_MS: '1000'}});
  const outcomes = Object.fromEntries(result.discoveryStats.lists.map(list => [list.listId, list.outcome]));
  assert.equal(outcomes['100003114'], 'INVALID_FEED');
  assert.equal(outcomes['20910258'], 'RESPONSE_TOO_LARGE');
  assert.equal(outcomes['10000664'], 'TIMEOUT');
  assert.equal(outcomes['15839069'], 'OK');
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(candidate => candidate.headline), ['Article survivor']);
});

test('Step 9F.6b CNBC RSS: a declared oversize length is refused before reading', async () => {
  const {result} = await find({bodies: {
    100003114: () => response(rss([article('x')]), {headers: {'content-length': String(600 * 1024)}})
  }});
  assert.equal(result.discoveryStats.lists[0].outcome, 'RESPONSE_TOO_LARGE');
});

test('Step 9F.6b CNBC RSS: 403 and 429 on one list each while the others work', async () => {
  const {result} = await find({bodies: {
    100003114: {status: 403}, 20910258: {status: 429}, 10000664: rss([article('works')])
  }});
  const lists = result.discoveryStats.lists;
  assert.deepEqual(lists.slice(0, 2).map(list => [list.outcome, list.httpStatus]),
    [['HTTP_FAILURE', 403], ['HTTP_FAILURE', 429]]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(candidate => candidate.headline), ['Article works']);
});

test('Step 9F.6b CNBC RSS: every list failing gives ok false and no candidates', async () => {
  const bodies = Object.fromEntries(LIST_IDS.map(id => [id, {status: 503}]));
  const {result} = await find({bodies});
  assert.equal(result.ok, false);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.discoveryStats.outcome, 'ALL_LISTS_FAILED');
  const thrown = await createCnbcRssSource({fetchImpl: async () => { throw new Error('down'); }, env: {}})
    .findCandidates({});
  assert.equal(thrown.ok, false);
  assert.ok(thrown.discoveryStats.lists.every(list => list.outcome === 'NETWORK_FAILURE'));
});

test('Step 9F.6b CNBC RSS: duplicates across lists by address and by CNBC id', async () => {
  const {result} = await find({bodies: {
    100003114: rss([article('shared', {id: '1001'}), article('own', {id: '1002'})]),
    20910258: rss([
      item({link: 'https://www.cnbc.com/2026/10/16/shared.html?__source=rss#top', title: 'Again', id: '9999'}),
      item({link: 'https://www.cnbc.com/2026/10/16/renamed.html', title: 'Same id', id: '1002'})
    ])
  }});
  assert.deepEqual(result.candidates.map(candidate => candidate.url), [
    'https://www.cnbc.com/2026/10/16/shared.html', 'https://www.cnbc.com/2026/10/16/own.html'
  ]);
  assert.equal(result.discoveryStats.duplicateCount, 2);
});

test('Step 9F.6b CNBC RSS: the cap keeps the newest list times', async () => {
  const items = Array.from({length: 60}, (_, index) => article(`a${index}`, {
    pubDate: new Date(Date.UTC(2026, 9, 16, 0, index)).toUTCString()
  }));
  const {result} = await find({bodies: {100003114: rss(items)}, env: {CNBC_RSS_MAX_CANDIDATES: '10'}});
  assert.equal(result.candidates.length, 10);
  assert.equal(result.candidates[0].headline, 'Article a59');
  assert.equal(result.candidates[9].headline, 'Article a50');
  assert.equal(result.discoveryStats.keptBeforeCapCount, 60);
  const defaults = await find({bodies: {100003114: rss(items)}});
  assert.equal(defaults.result.candidates.length, 40);
});

test('Step 9F.6b CNBC RSS: list time before the reading window start is dropped before download', async () => {
  const window = {startsAt: '2026-10-15T20:00:00.000Z', endsAt: '2026-10-18T06:00:00.000Z'};
  const {result} = await find({window, bodies: {100003114: rss([
    article('inside', {pubDate: 'Fri, 16 Oct 2026 10:00:00 GMT'}),
    article('edge', {pubDate: 'Thu, 15 Oct 2026 20:00:00 GMT'}),
    article('before', {pubDate: 'Thu, 15 Oct 2026 19:59:59 GMT'}),
    article('unknown', {pubDate: 'n/a'})
  ])}});
  assert.deepEqual(result.candidates.map(candidate => candidate.headline),
    ['Article inside', 'Article edge', 'Article unknown']);
  assert.equal(result.discoveryStats.beforeWindowDroppedCount, 1);
  const noWindow = await find({bodies: {100003114: rss([article('before', {pubDate: 'Thu, 01 Oct 2026 10:00 GMT'})])}});
  assert.equal(noWindow.result.candidates.length, 1);
});

test('Step 9F.6b CNBC RSS: excluded address families, videos and non-CNBC links', async () => {
  const links = [
    'https://www.cnbc.com/select/how-to-rebuild-your-credit-after-bankruptcy/',
    'https://www.cnbc.com/video/2026/10/16/lvmhs-antoine-arnault.html',
    'https://www.cnbc.com/investingclub/2026/10/17/ai-stocks-plunge.html',
    'https://www.cnbc.com/pro/2026/10/16/some-pro-story.html',
    'https://www.cnbc.com/make-it/2026/10/17/great-pumpkin-farm.html'
  ];
  for (const link of links) assert.equal(isExcludedFamily({url: link, contentType: 'cnbcnewsstory'}), true, link);
  assert.equal(isExcludedFamily({url: 'https://www.cnbc.com/2026/10/16/clip.html', contentType: 'cnbcvideo'}), true);
  assert.equal(isExcludedFamily({url: 'https://www.cnbc.com/2026/10/16/us-budget-deficit-2026.html',
    contentType: 'wirestory'}), false);
  const {result} = await find({bodies: {100003114: rss([
    ...links.map((link, index) => item({link, title: `Excluded ${index}`})),
    item({link: 'https://www.cnbc.com/2026/10/16/clip.html', title: 'Clip', type: 'cnbcvideo'}),
    item({link: 'http://www.cnbc.com/2026/10/16/plain-http.html', title: 'Plain http'}),
    item({link: 'https://example.com/2026/10/16/elsewhere.html', title: 'Elsewhere'}),
    item({link: 'https://www.cnbc.com/2026/10/16/live.html', title: 'Live blog', type: 'live_story'}),
    article('kept')
  ])}});
  assert.deepEqual(result.candidates.map(candidate => candidate.headline), ['Live blog', 'Article kept']);
  assert.equal(result.discoveryStats.excludedFamilyCount, 6);
  assert.equal(result.discoveryStats.unusableCount, 2);
});

// Real CNBC addresses and titles seen on 18 Oct 2026.
const MOVERS_CASES = [
  ['/2026/10/16/stocks-making-the-biggest-moves-midday-crwv-moga-jbht-aa.html',
    'Stocks making the biggest moves midday: CoreWeave, Moog, J.B. Hunt, Alcoa & more', true, true],
  ['/2026/10/16/stocks-making-the-biggest-moves-premarket-tsla-spcx-aa-crwv.html',
    'Stocks making the biggest moves premarket: Tesla, SpaceX, Alcoa, CoreWeave, Travelers & more', true, true],
  ['/2026/10/15/stocks-making-the-biggest-moves-after-hours-ibkr-jbht-aa.html',
    'Stocks making the biggest moves after hours: Interactive Brokers, J.B. Hunt, Alcoa', true, true],
  // The old address-only rule (7fd754c) missed these two.
  ['/2026/10/14/stocks-moving-premarket-bank-of-america-blackrock-asml.html',
    'Stocks making the biggest moves premarket: Bank of America, BlackRock, ASML & more', true, true],
  ['/2026/10/12/midday-stock-movers-ebay-meta-ionq-lumentum.html',
    'Stocks making the biggest moves midday: eBay, Sandisk, Meta & more', true, true],
  // Trailing "-on-more-" ending: caught by address and title.
  ['/2026/10/02/stocks-making-the-biggest-moves-midday-tsla-avgo-nke-on-more-.html',
    'Stocks making the biggest moves midday: Tesla, Broadcom, Nike, ON & more', true, true],
  // Title only (an unfamiliar address).
  ['/2026/10/20/market-movers-roundup-xyz.html', 'Stocks moving big after hours: Netflix, Tesla', false, true]
];

test('Step 9F.6b CNBC RSS: biggest-movers pages are caught by address or title', () => {
  for (const [pathName, title, address, titleMatch] of MOVERS_CASES) {
    const url = `https://www.cnbc.com${pathName}`;
    assert.deepEqual({...moversMatch({url, title})}, {address, title: titleMatch, movers: true}, pathName);
    assert.equal(isBiggestMoversPage({url, title}), true);
  }
  // Address only (title rewritten).
  assert.deepEqual({...moversMatch({url: 'https://www.cnbc.com/2026/10/13/stocks-making-the-biggest-moves-premarket-jpm.html',
    title: 'JPMorgan, Micron and UnitedHealth lead early trading'})}, {address: true, title: false, movers: true});
});

test('Step 9F.6b CNBC RSS: lookalikes and real market articles are not movers pages', () => {
  const notMovers = [
    // The lookalike the old rule's test also let through.
    ['https://www.cnbc.com/2026/09/11/stocks-making-the-biggest-moves-weekly-roundup.html', 'Unrelated similarly named article'],
    ['https://www.cnbc.com/2026/10/15/stock-market-today-live-updates.html',
      'Nasdaq slides 2% Friday to post worst week since June'],
    ['https://www.cnbc.com/2026/10/18/hedge-funds-bond-market-turmoil.html',
      'Why hedge funds could be making a bond market shock more likely'],
    ['https://www.cnbc.com/2026/10/12/the-bull-market-just-turned-four-after-climbing-a-wall-of-worry.html',
      'The bull market turned 4 years old on Monday. Investors are wondering what comes next'],
    ['https://www.cnbc.com/2026/10/16/playing-the-coreweave-disconnect.html',
      "How to trade CoreWeave's slow moving crisis"]
  ];
  for (const [url, title] of notMovers) assert.equal(isBiggestMoversPage({url, title}), false, url);
  // The loose net flags the last one for review, but the strict rule keeps it.
  assert.equal(isPossibleMoversMiss({url: notMovers[4][0], title: notMovers[4][1]}), true);
  assert.equal(isPossibleMoversMiss({url: notMovers[2][0], title: notMovers[2][1]}), false);
  assert.equal(isPossibleMoversMiss({url: `https://www.cnbc.com${MOVERS_CASES[0][0]}`, title: MOVERS_CASES[0][1]}), false);
});

test('Step 9F.6b CNBC RSS: movers pages are dropped and counted by which rule matched', async () => {
  const items = MOVERS_CASES.map(([pathName, title]) => item({link: `https://www.cnbc.com${pathName}`,
    title: title.replace(/&/g, '&amp;')}));
  items.push(item({link: 'https://www.cnbc.com/2026/10/13/stocks-making-the-biggest-moves-premarket-jpm.html',
    title: 'Early trading leaders'}));
  items.push(article('market-story'));
  const {result} = await find({bodies: {100003114: rss(items)}});
  assert.deepEqual(result.candidates.map(candidate => candidate.headline), ['Article market-story']);
  assert.equal(result.discoveryStats.moversDroppedCount, 8);
  assert.equal(result.discoveryStats.moversByBothCount, 6);
  assert.equal(result.discoveryStats.moversByTitleOnlyCount, 1);
  assert.equal(result.discoveryStats.moversByAddressOnlyCount, 1);
});

test('Step 9F.6b CNBC RSS: switch off means zero fetch calls and no candidates', async () => {
  const {result, calls} = await find({bodies: {100003114: rss([article('one')])},
    env: {CNBC_RSS_FINDER_ENABLED: 'false'}});
  assert.equal(calls.length, 0);
  assert.deepEqual(result, {ok: false, candidates: [], discoveryStats: {outcome: 'DISABLED', lists: []}});
  assert.equal(settingValue('cnbcRssFinderEnabled', {env: {}}), true);
});

test('Step 9F.6b CNBC RSS: an empty list and a malformed channel', async () => {
  const {result} = await find({bodies: {100003114: '<?xml version="1.0"?><feed></feed>'}});
  assert.equal(result.discoveryStats.lists[0].outcome, 'INVALID_FEED');
  assert.equal(result.ok, true, 'the other (empty) lists were read');
  assert.deepEqual(result.candidates, []);
  const selection = selectCnbcRssCandidates([], {maxCandidates: 40});
  assert.equal(selection.counts.candidateCount, 0);
});

// The new files load no Anthropic, Postgres or CNBC acquisition module, checked
// on the source text and on what a fresh Node process actually loads.
test('Step 9F.6b CNBC RSS: the new files load no Anthropic, Postgres or CNBC acquisition module', () => {
  const root = path.join(__dirname, '..');
  const forbidden = /claude|anthropic|postgres|cnbc-(?:article|search|news|recap|us|deterministic|retrieved|market)|neon/i;
  for (const file of ['lib/sources/cnbc-rss.js', 'lib/cnbc-rss-probe.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);
    for (const name of requires) assert.doesNotMatch(name, forbidden, `${file} requires ${name}`);
  }
  const child = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(root, 'lib/cnbc-rss-probe.js'))});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `], {encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const loaded = JSON.parse(child.stdout).map(file => path.relative(root, file).replace(/\\/g, '/'));
  assert.ok(loaded.includes('lib/sources/cnbc-rss.js'));
  for (const file of loaded) {
    if (file.startsWith('node_modules/')) {
      assert.match(file, /^node_modules\/(fast-xml-parser|strnum|@nodable|path-expression-matcher)\//, file);
      continue;
    }
    assert.doesNotMatch(file, forbidden, file);
  }
});

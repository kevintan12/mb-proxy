const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YAHOO_LATEST_NEWS_URL,
  createYahooLatestNewsDiscoveryService
} = require('../lib/yahoo-latest-news-discovery');

function response(body, {status = 200, contentLength = null} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => name.toLowerCase() === 'content-length' ? contentLength : 'text/html; charset=utf-8'},
    text: async () => body
  };
}

function story({
  href = 'https://sg.finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html',
  headline = 'Nvidia rallies on demand', type = 'story', module = 'topic-stream',
  publisher = 'Reuters', uuid = '12345678-1234-1234-1234-123456789abc', extra = ''
} = {}) {
  const data = JSON.stringify({
    yContentType: type, yModuleName: module, ySubModuleName: 'fltrd-strs',
    yDestinationContentPartner: publisher, yDestinationContentUUID: uuid,
    yLinkText: headline
  }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<section class="story-item horizontal-story" data-testid="story"><a data-yga="${data}" href="${href}"><h3>${headline}</h3></a>${extra}</section>`;
}

test('extracts only genuine topic-stream story candidates and canonicalizes URLs', async () => {
  let requested;
  const html = `<html>${story()}${story({
    href: 'https://finance.yahoo.com/news/apple-update-130000456.html?guccounter=1',
    headline: 'Apple issues an update', publisher: 'Yahoo Finance',
    uuid: 'abcdef12-1234-1234-1234-123456789abc'
  })}</html>`;
  const result = await createYahooLatestNewsDiscoveryService({fetchImpl: async url => {
    requested = url;
    return response(html);
  }}).discoverLatestNews();
  assert.equal(requested, YAHOO_LATEST_NEWS_URL);
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(result.candidates[0], {
    headline: 'Nvidia rallies on demand',
    url: 'https://finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html',
    uuid: '12345678-1234-1234-1234-123456789abc', publisher: 'Reuters'
  });
  assert.equal(result.candidates[1].url, 'https://finance.yahoo.com/news/apple-update-130000456.html');
});

test('excludes ads, sponsored stories, videos, navigation, topic links and unrelated modules', async () => {
  const html = [
    story({headline: 'Sponsored opportunity', extra: '<span>Sponsored</span>'}),
    story({href: 'https://sg.finance.yahoo.com/video/market-update-123.html'}),
    story({href: 'https://sg.finance.yahoo.com/quote/NVDA/'}),
    story({href: 'https://sg.finance.yahoo.com/topic/stock-market-news/'}),
    story({module: 'navigation'}),
    '<nav><a href="https://sg.finance.yahoo.com/news/navigation-120000123.html">Navigation</a></nav>',
    '<div data-testid="ad-container">Advertisement</div>',
    story({headline: 'Valid current story'})
  ].join('');
  const result = await createYahooLatestNewsDiscoveryService({
    fetchImpl: async () => response(html)
  }).discoverLatestNews();
  assert.deepEqual(result.candidates.map(item => item.headline), ['Valid current story']);
});

test('deduplicates canonical URLs and ignores relative publication labels', async () => {
  const first = story({extra: '<span class="published-date">14 min ago</span>'});
  const second = story({headline: 'Duplicate title'});
  const result = await createYahooLatestNewsDiscoveryService({
    fetchImpl: async () => response(first + second)
  }).discoverLatestNews();
  assert.equal(result.candidates.length, 1);
  assert.equal(Object.hasOwn(result.candidates[0], 'publishedAt'), false);
});

test('fails safely for oversized or non-HTML responses', async () => {
  const oversized = await createYahooLatestNewsDiscoveryService({
    maxResponseBytes: 10,
    fetchImpl: async () => response(story(), {contentLength: '11'})
  }).discoverLatestNews();
  assert.equal(oversized.type, 'RESPONSE_TOO_LARGE');
  const invalid = await createYahooLatestNewsDiscoveryService({fetchImpl: async () => ({
    ok: true, status: 200, headers: {get: () => 'application/json'}, text: async () => '{}'
  })}).discoverLatestNews();
  assert.equal(invalid.type, 'INVALID_CONTENT_TYPE');
});

// ---- Step 8K.3: US edition and merged discovery ----
const {
  YAHOO_US_MARKET_NEWS_URL,
  createYahooLatestNewsDiscoveryService: createSingaporeDiscoveryService,
  createYahooUsMarketNewsDiscoveryService,
  createYahooMultiEditionNewsDiscoveryService
} = require('../lib/yahoo-latest-news-discovery');

function usStory({
  path = 'markets/stocks/articles/nvidia-buyback-fuel-rally-120000123.html',
  headline = 'Nvidia buyback could fuel the next rally', module = 'ai-topic-stream',
  publisher = 'Yahoo Finance', uuid = '22345678-1234-1234-1234-123456789abc', extra = ''
} = {}) {
  return story({
    href: `https://finance.yahoo.com/${path}`, headline, module, publisher, uuid,
    extra: `${extra}<span class="published-date">3h ago</span>`
  });
}

function routedFetch({us, sg}) {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url);
    const handler = url === YAHOO_US_MARKET_NEWS_URL ? us : sg;
    return typeof handler === 'function' ? handler() : handler;
  };
  return {fetchImpl, requested};
}

test('Step 8K.3 / 8K.5 the US parser accepts any module and the article fetcher path shapes only (singular article yes, live no)', async () => {
  const html = [
    usStory({module: 'topic-content-module', headline: 'Bond yields move higher'}),
    usStory({module: 'ai-storyline-0373', headline: 'Rates weigh on tech',
      path: 'economy/policy/articles/rates-weigh-tech-120000124.html'}),
    usStory({module: 'a-module-nobody-has-seen', headline: 'Any future module works',
      path: 'technology/ai/articles/future-module-120000125.html'}),
    usStory({headline: 'Singular article page', path: 'markets/stocks/article/singular-120000126.html'}),
    usStory({headline: 'Live blog page', path: 'markets/live/stock-market-today-120000127.html'}),
    story({href: 'https://sg.news.yahoo.com/wire-story-120000128.html', headline: 'SG news host', module: 'ai-topic-stream'}),
    story({href: 'https://finance.yahoo.com/quote/NVDA/', headline: 'Quote page', module: 'ai-topic-stream'}),
    story({type: 'video', module: 'ai-topic-stream', href: 'https://finance.yahoo.com/markets/stocks/articles/v-1.html'}),
    usStory({headline: 'Sponsored piece', extra: '<span>Sponsored</span>',
      path: 'markets/stocks/articles/sponsored-120000129.html'})
  ].join('');
  const result = await createYahooUsMarketNewsDiscoveryService({
    fetchImpl: async () => response(html)
  }).discoverUsMarketNews();
  assert.equal(result.type, 'SUCCESS');
  assert.deepEqual(result.candidates.map(item => item.headline),
    ['Bond yields move higher', 'Rates weigh on tech', 'Any future module works', 'Singular article page']);
  assert.equal(result.sectionCount, 9);
  assert.equal(result.candidates[0].url,
    'https://finance.yahoo.com/markets/stocks/articles/nvidia-buyback-fuel-rally-120000123.html');
  assert.equal(Object.hasOwn(result.candidates[0], 'publishedAt'), false);
});

test('Step 8K.3 a US page with sections but no accepted story reports SHAPE_CHANGED', async () => {
  const html = usStory({path: 'weird/new/layout/here/now/abc.html'}) + '<section class="story-item">no analytics</section>';
  const result = await createYahooUsMarketNewsDiscoveryService({
    fetchImpl: async () => response(html)
  }).discoverUsMarketNews();
  assert.equal(result.ok, false);
  assert.equal(result.type, 'SHAPE_CHANGED');
  assert.equal(result.sectionCount, 2);
  assert.deepEqual(result.candidates, []);
});

test('Step 8K.3 the US page uses its own larger response bound and rejects oversized pages', async () => {
  const bigPad = 'x'.repeat(1_300_000);
  const ok = await createYahooUsMarketNewsDiscoveryService({
    fetchImpl: async () => response(usStory() + `<!--${bigPad}-->`)
  }).discoverUsMarketNews();
  assert.equal(ok.type, 'SUCCESS');
  const tooLarge = await createYahooUsMarketNewsDiscoveryService({
    maxResponseBytes: 100, fetchImpl: async () => response(usStory())
  }).discoverUsMarketNews();
  assert.equal(tooLarge.type, 'RESPONSE_TOO_LARGE');
  assert.equal(tooLarge.sectionCount, 0);
});

test('Step 8K.3 merged discovery fetches both editions in parallel and merges US first with edition tags', async () => {
  const {fetchImpl, requested} = routedFetch({
    us: response(usStory({headline: 'US story one'}) + usStory({
      headline: 'US story two', path: 'markets/stocks/articles/us-two-120000200.html',
      uuid: '32345678-1234-1234-1234-123456789abc'
    })),
    sg: response(story({headline: 'SG story one', href: 'https://sg.finance.yahoo.com/news/sg-one-120000900.html', uuid: '52345678-1234-1234-1234-123456789abc'}))
  });
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.deepEqual(requested.slice().sort(), [YAHOO_LATEST_NEWS_URL, YAHOO_US_MARKET_NEWS_URL].sort());
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(item => [item.edition, item.headline]),
    [['US', 'US story one'], ['US', 'US story two'], ['SG', 'SG story one']]);
  assert.equal(result.usOutcome, 'SUCCESS');
  assert.equal(result.usCandidateCount, 2);
  assert.equal(result.singaporeCandidateCount, 1);
  assert.equal(result.crossEditionDuplicateCount, 0);
});

test('Step 8K.3 both editions are requested before either response is awaited', async () => {
  const order = [];
  let releaseUs;
  const usGate = new Promise(resolve => { releaseUs = resolve; });
  const fetchImpl = async url => {
    order.push(`start:${url === YAHOO_US_MARKET_NEWS_URL ? 'US' : 'SG'}`);
    if (url === YAHOO_US_MARKET_NEWS_URL) { await usGate; return response(usStory()); }
    releaseUs();
    return response(story());
  };
  await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.deepEqual(order.sort(), ['start:SG', 'start:US']);
});

test('Step 8K.3 a Singapore entry matching a US entry by URL, UUID, numeric id or headline is dropped and the US entry kept', async () => {
  const usHtml = [
    usStory({headline: 'Same UUID story', uuid: 'aaaaaaaa-1234-1234-1234-123456789abc',
      path: 'markets/stocks/articles/same-uuid-111111111.html'}),
    usStory({headline: 'Same numeric id story', uuid: 'bbbbbbbb-1234-1234-1234-123456789abc',
      path: 'markets/stocks/articles/same-id-222222222.html'}),
    usStory({headline: 'Tech stocks gain on Anthropic IPO optimism, offsetting high oil',
      uuid: 'cccccccc-1234-1234-1234-123456789abc', path: 'markets/stocks/articles/tech-gain-333333333.html'}),
    usStory({headline: 'Same URL story', uuid: 'dddddddd-1234-1234-1234-123456789abc',
      path: 'news/same-url-444444444.html'})
  ].join('');
  const sgHtml = [
    story({headline: 'A different title entirely', uuid: 'aaaaaaaa-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/other-slug-555555555.html'}),
    story({headline: 'Another different title', uuid: 'eeeeeeee-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/some-slug-222222222.html'}),
    story({headline: 'Tech Stocks Gain on Anthropic IPO Optimism - Offsetting High Oil!',
      uuid: 'ffffffff-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/tech-gain-sg-666666666.html'}),
    story({headline: 'Same URL story SG copy', uuid: '99999999-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/same-url-444444444.html'}),
    story({headline: 'Genuinely SG-only story', uuid: '88888888-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/sg-only-777777777.html'})
  ].join('');
  const {fetchImpl} = routedFetch({us: response(usHtml), sg: response(sgHtml)});
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.equal(result.crossEditionDuplicateCount, 4);
  assert.deepEqual(result.candidates.map(item => [item.edition, item.headline]), [
    ['US', 'Same UUID story'], ['US', 'Same numeric id story'],
    ['US', 'Tech stocks gain on Anthropic IPO optimism, offsetting high oil'], ['US', 'Same URL story'],
    ['SG', 'Genuinely SG-only story']
  ]);
});

test('Step 8K.3 short headlines never match on the normalized-headline key', async () => {
  const {fetchImpl} = routedFetch({
    us: response(usStory({headline: 'Oil up', uuid: 'aaaaaaaa-1234-1234-1234-123456789abc'})),
    sg: response(story({headline: 'Oil up', uuid: 'bbbbbbbb-1234-1234-1234-123456789abc',
      href: 'https://sg.finance.yahoo.com/news/oil-up-999999999.html'}))
  });
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.equal(result.candidates.length, 2);
});

function numberedUsHtml(count) {
  return Array.from({length: count}, (_, index) => usStory({
    headline: `US headline number ${index}`,
    uuid: `1000${String(index).padStart(4, '0')}-1234-1234-1234-123456789abc`,
    path: `markets/stocks/articles/us-${index}-1${String(index).padStart(8, '0')}.html`
  })).join('');
}

function numberedSgHtml(count) {
  return Array.from({length: count}, (_, index) => story({
    headline: `SG headline number ${index}`,
    uuid: `2000${String(index).padStart(4, '0')}-1234-1234-1234-123456789abc`,
    href: `https://sg.finance.yahoo.com/news/sg-${index}-2${String(index).padStart(8, '0')}.html`
  })).join('');
}

test('Step 8K.3 every usable item on a 48-section US page reaches the merged list, including the last ones', async () => {
  const {fetchImpl} = routedFetch({us: response(numberedUsHtml(48)), sg: response(numberedSgHtml(25))});
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  const us = result.candidates.filter(item => item.edition === 'US');
  assert.equal(us.length, 48);
  assert.equal(us.at(-1).headline, 'US headline number 47');
  assert.equal(result.candidates.length, 73);
});

test('Step 8K.3 the US extraction cap is 60, the Singapore cap stays 30, and the merged cap of 90 never cuts a US item', async () => {
  const {fetchImpl} = routedFetch({us: response(numberedUsHtml(70)), sg: response(numberedSgHtml(40))});
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.equal(result.usCandidateCount, 60);
  assert.equal(result.singaporeCandidateCount, 30);
  assert.equal(result.candidates.length, 90);
  assert.equal(result.candidates.filter(item => item.edition === 'US').length, 60);
  assert.equal(result.candidates[0].edition, 'US');
  assert.equal(result.candidates[60].edition, 'SG');
});

test('Step 8K.3 a smaller merged cap cuts Singapore entries before US entries', async () => {
  const {fetchImpl} = routedFetch({us: response(numberedUsHtml(10)), sg: response(numberedSgHtml(10))});
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl, maxMergedCandidates: 12}).discoverLatestNews();
  assert.equal(result.candidates.length, 12);
  assert.equal(result.candidates.filter(item => item.edition === 'US').length, 10);
});

test('Step 8K.3 fallback: a failing, oversized, timed-out, empty or shape-changed US page gives the Singapore-only list', async () => {
  const sgBody = story({headline: 'SG story one'}) + story({
    headline: 'SG story two', href: 'https://sg.finance.yahoo.com/news/sg-two-120000300.html',
    uuid: '42345678-1234-1234-1234-123456789abc'
  });
  const usCases = {
    HTTP_FAILURE: response('', {status: 404}),
    TIMEOUT: () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
    RETRIEVAL_FAILURE: () => { throw new Error('network down'); },
    INVALID_CONTENT_TYPE: {ok: true, status: 200, headers: {get: () => 'application/json'}, text: async () => '{}'},
    RESPONSE_TOO_LARGE: response('x', {contentLength: String(10 * 1024 * 1024)}),
    SHAPE_CHANGED: response('<html>redesigned</html>')
  };
  const sgOnly = await createSingaporeDiscoveryService({
    fetchImpl: async () => response(sgBody)
  }).discoverLatestNews();
  for (const [expected, us] of Object.entries(usCases)) {
    const {fetchImpl} = routedFetch({us, sg: response(sgBody)});
    const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
    assert.equal(result.ok, true, expected);
    assert.equal(result.type, 'SUCCESS', expected);
    assert.equal(result.usOutcome, expected);
    assert.equal(result.usCandidateCount, 0);
    assert.deepEqual(result.candidates.map(item => item.headline), ['SG story one', 'SG story two'], expected);
    // Same candidates the Singapore-only service returns, plus the edition tag.
    assert.deepEqual(result.candidates.map(({edition, ...rest}) => rest), sgOnly.candidates);
  }
});

test('Step 8K.3 a throwing US service never breaks discovery', async () => {
  const sgService = createSingaporeDiscoveryService({fetchImpl: async () => response(story())});
  const result = await createYahooMultiEditionNewsDiscoveryService({
    singaporeService: sgService,
    usService: {async discoverUsMarketNews() { throw new Error('boom'); }}
  }).discoverLatestNews();
  assert.equal(result.ok, true);
  assert.equal(result.usOutcome, 'RETRIEVAL_FAILURE');
  assert.equal(result.candidates.length, 1);
});

test('Step 8K.3 US only when Singapore fails; both failing gives an unsuccessful empty result', async () => {
  const usOnly = routedFetch({us: response(usStory()), sg: response('', {status: 503})});
  const usResult = await createYahooMultiEditionNewsDiscoveryService({fetchImpl: usOnly.fetchImpl}).discoverLatestNews();
  assert.equal(usResult.ok, true);
  assert.deepEqual(usResult.candidates.map(item => item.edition), ['US']);
  const none = routedFetch({us: response('', {status: 503}), sg: response('', {status: 503})});
  const noneResult = await createYahooMultiEditionNewsDiscoveryService({fetchImpl: none.fetchImpl}).discoverLatestNews();
  assert.equal(noneResult.ok, false);
  assert.deepEqual(noneResult.candidates, []);
});

// ---- Step 8K.5: page age label ----
test('Step 8K.5 discovery keeps the page relative label verbatim as an age hint, and omits it when absent', async () => {
  const withLabel = usStory({headline: 'US story with a label'});
  const withoutLabel = story({
    href: 'https://finance.yahoo.com/markets/stocks/articles/no-label-120000456.html',
    headline: 'US story without a label', module: 'ai-topic-stream', uuid: '62345678-1234-1234-1234-123456789abc'
  });
  const nested = story({
    href: 'https://finance.yahoo.com/markets/stocks/articles/nested-120000457.html',
    headline: 'US story with a nested label', module: 'ai-topic-stream', uuid: '72345678-1234-1234-1234-123456789abc',
    extra: '<span class="published-date"><b>58m</b> ago</span>'
  });
  const result = await createYahooUsMarketNewsDiscoveryService({
    fetchImpl: async () => response(withLabel + withoutLabel + nested)
  }).discoverUsMarketNews();
  assert.deepEqual(result.candidates.map(item => item.ageLabel ?? null), ['3h ago', null, '58m ago']);
  assert.equal(Object.hasOwn(result.candidates[1], 'ageLabel'), false);
  assert.equal(Object.hasOwn(result.candidates[0], 'publishedAt'), false);
});

test('Step 8K.5 the Singapore parser carries its own label form and stays otherwise unchanged', async () => {
  const html = story({extra: '<span class="published-date">3 min ago</span>'});
  const result = await createYahooLatestNewsDiscoveryService({
    fetchImpl: async () => response(html)
  }).discoverLatestNews();
  assert.deepEqual(result.candidates[0], {
    headline: 'Nvidia rallies on demand',
    url: 'https://finance.yahoo.com/news/nvidia-rallies-on-demand-120000123.html',
    uuid: '12345678-1234-1234-1234-123456789abc', publisher: 'Reuters', ageLabel: '3 min ago'
  });
});

test('Step 8K.5 merged discovery carries the label through the merge', async () => {
  const {fetchImpl} = routedFetch({
    us: response(usStory({headline: 'US labelled story'})),
    sg: response(story({headline: 'SG labelled story', href: 'https://sg.finance.yahoo.com/news/sg-lab-120000901.html',
      uuid: '82345678-1234-1234-1234-123456789abc', extra: '<span class="published-date">7 min ago</span>'}))
  });
  const result = await createYahooMultiEditionNewsDiscoveryService({fetchImpl}).discoverLatestNews();
  assert.deepEqual(result.candidates.map(item => [item.edition, item.ageLabel]), [['US', '3h ago'], ['SG', '7 min ago']]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CNBC_MARKET_NEWS_CACHE_MAX_SESSION_ENTRIES_PER_INTENT,
  CNBC_MARKET_NEWS_CACHE_MAX_IDENTITIES_PER_ENTRY,
  createCnbcMarketNewsDiscoveryCache
} = require('../lib/cnbc-market-news-discovery-cache');

function identity(targetSessionDate, suffix) {
  return {
    title: `CNBC story ${suffix}`,
    url: `https://www.cnbc.com/2026/09/18/story-${suffix}.html`,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate
  };
}

test('partitions immutable identities by date and intent without cross-association', async () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const separateRuntimeCache = createCnbcMarketNewsDiscoveryCache();
  await Promise.all([
    Promise.resolve().then(() => cache.set({
      provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1,
      identities: [identity('2026-09-18', 'breadth')]
    })),
    Promise.resolve().then(() => cache.set({
      provider: 'CNBC', targetSessionDate: '2026-09-17', searchIndex: 2,
      identities: [identity('2026-09-17', 'company')]
    }))
  ]);
  assert.match(cache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1
  })[0].url, /breadth/);
  assert.equal(cache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 2
  }), null);
  assert.equal(cache.get({
    provider: 'YAHOO', targetSessionDate: '2026-09-18', searchIndex: 1
  }), null);
  assert.equal(separateRuntimeCache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1
  }), null);
  assert.equal(Object.isFrozen(cache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1
  })), true);
});

test('enforces identity and entry bounds with deterministic refresh-aware eviction', () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  assert.equal(CNBC_MARKET_NEWS_CACHE_MAX_SESSION_ENTRIES_PER_INTENT, 2);
  assert.equal(CNBC_MARKET_NEWS_CACHE_MAX_IDENTITIES_PER_ENTRY, 5);
  for (const date of ['2026-09-16', '2026-09-17']) {
    assert.equal(cache.set({
      provider: 'CNBC', targetSessionDate: date, searchIndex: 1,
      identities: [identity(date, date)]
    }), true);
  }
  cache.set({
    provider: 'CNBC', targetSessionDate: '2026-09-16', searchIndex: 1,
    identities: [identity('2026-09-16', 'refreshed')]
  });
  cache.set({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1,
    identities: [identity('2026-09-18', 'newest')]
  });
  assert.equal(cache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-17', searchIndex: 1
  }), null);
  assert.match(cache.get({
    provider: 'CNBC', targetSessionDate: '2026-09-16', searchIndex: 1
  })[0].url, /refreshed/);
  assert.equal(cache.set({
    provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 2,
    identities: Array.from({length: 6}, (_, index) => identity('2026-09-18', index))
  }), false);
});

test('rejects malformed, duplicate and content-bearing cache values', () => {
  const cache = createCnbcMarketNewsDiscoveryCache();
  const valid = identity('2026-09-18', 'valid');
  for (const identities of [
    [],
    [{...valid, articleBody: 'not cacheable'}],
    [valid, {...valid}],
    [{...valid, discoveredVia: 'OTHER'}]
  ]) {
    assert.equal(cache.set({
      provider: 'CNBC', targetSessionDate: '2026-09-18', searchIndex: 1, identities
    }), false);
  }
});

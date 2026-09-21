const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETED_SESSION_RECAP_CACHE_MAX_ENTRIES_PER_PROVIDER,
  createCompletedSessionRecapDiscoveryCache
} = require('../lib/completed-session-recap-discovery-cache');

function discovery(provider, targetSessionDate) {
  return {
    title: `${provider} recap`,
    url: provider === 'YAHOO'
      ? `https://finance.yahoo.com/markets/live/stock-market-today-${targetSessionDate}.html`
      : `https://www.cnbc.com/${targetSessionDate.replaceAll('-', '/')}/stock-market-today-live-updates.html`,
    discoveredVia: 'ANTHROPIC_WEB_SEARCH',
    targetSessionDate
  };
}

test('partitions immutable minimum identities by provider and date', () => {
  const cache = createCompletedSessionRecapDiscoveryCache();
  const yahoo = discovery('YAHOO', '2026-09-17');
  const cnbc = discovery('CNBC', '2026-09-17');
  assert.equal(cache.set({
    provider: 'YAHOO', targetSessionDate: yahoo.targetSessionDate, discovery: yahoo
  }), true);
  assert.equal(cache.set({
    provider: 'CNBC', targetSessionDate: cnbc.targetSessionDate, discovery: cnbc
  }), true);
  yahoo.title = 'mutated';
  assert.equal(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-17'}).title,
    'YAHOO recap');
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate: '2026-09-17'}).title,
    'CNBC recap');
  assert.equal(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-18'}), null);
  assert.equal(Object.isFrozen(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-17'})),
    true);
  assert.deepEqual(Object.keys(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-17'})),
    ['title', 'url', 'discoveredVia', 'targetSessionDate']);
});

test('evicts the oldest entry deterministically within each provider partition', () => {
  const cache = createCompletedSessionRecapDiscoveryCache();
  const dates = ['2026-09-16', '2026-09-17', '2026-09-18'];
  assert.equal(COMPLETED_SESSION_RECAP_CACHE_MAX_ENTRIES_PER_PROVIDER, 2);
  for (const targetSessionDate of dates) {
    cache.set({provider: 'YAHOO', targetSessionDate, discovery: discovery('YAHOO', targetSessionDate)});
  }
  assert.equal(cache.get({provider: 'YAHOO', targetSessionDate: dates[0]}), null);
  assert.notEqual(cache.get({provider: 'YAHOO', targetSessionDate: dates[1]}), null);
  assert.notEqual(cache.get({provider: 'YAHOO', targetSessionDate: dates[2]}), null);
  cache.set({provider: 'CNBC', targetSessionDate: dates[0], discovery: discovery('CNBC', dates[0])});
  assert.notEqual(cache.get({provider: 'CNBC', targetSessionDate: dates[0]}), null);
});

test('invalid identities never populate and concurrent provider/date writes cannot cross-associate', async () => {
  const cache = createCompletedSessionRecapDiscoveryCache();
  assert.equal(cache.set({provider: 'YAHOO', targetSessionDate: 'bad', discovery: {}}), false);
  assert.equal(cache.set({
    provider: 'OTHER', targetSessionDate: '2026-09-18', discovery: discovery('YAHOO', '2026-09-18')
  }), false);
  await Promise.all([
    Promise.resolve().then(() => cache.set({
      provider: 'YAHOO', targetSessionDate: '2026-09-18',
      discovery: discovery('YAHOO', '2026-09-18')
    })),
    Promise.resolve().then(() => cache.set({
      provider: 'CNBC', targetSessionDate: '2026-09-17',
      discovery: discovery('CNBC', '2026-09-17')
    }))
  ]);
  assert.match(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-18'}).url,
    /finance\.yahoo\.com/);
  assert.match(cache.get({provider: 'CNBC', targetSessionDate: '2026-09-17'}).url,
    /cnbc\.com/);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate: '2026-09-18'}), null);
  assert.equal(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-17'}), null);
});

test('deterministic recap identity is cacheable only in the CNBC partition', () => {
  const cache = createCompletedSessionRecapDiscoveryCache();
  const identity = {...discovery('CNBC', '2026-09-16'),
    discoveredVia: 'DETERMINISTIC_SESSION_URL'};
  assert.equal(cache.set({provider: 'CNBC', targetSessionDate: '2026-09-16',
    discovery: identity}), true);
  assert.equal(cache.set({provider: 'YAHOO', targetSessionDate: '2026-09-16',
    discovery: identity}), false);
  assert.equal(cache.get({provider: 'CNBC', targetSessionDate: '2026-09-16'}).discoveredVia,
    'DETERMINISTIC_SESSION_URL');
  assert.equal(cache.get({provider: 'YAHOO', targetSessionDate: '2026-09-16'}), null);
});

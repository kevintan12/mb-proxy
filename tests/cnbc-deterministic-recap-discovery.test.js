const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previousUsTradingDate,
  deterministicCnbcRecapCandidate,
  createDeterministicCnbcRecapDiscoveryService
} = require('../lib/cnbc-deterministic-recap-discovery');

test('maps a supported completed US session to the preceding trading-day editorial URL', async () => {
  assert.equal(previousUsTradingDate('2026-09-16'), '2026-09-15');
  assert.deepEqual(deterministicCnbcRecapCandidate('2026-09-16'), {
    title: 'Stock market news for Sep. 16, 2026',
    url: 'https://www.cnbc.com/2026/09/15/stock-market-today-live-updates.html',
    discoveredVia: 'DETERMINISTIC_SESSION_URL',
    targetSessionDate: '2026-09-16'
  });
  assert.equal(previousUsTradingDate('2026-09-04'), '2026-09-03');
  assert.equal(previousUsTradingDate('2026-09-11'), '2026-09-10');
  assert.equal(previousUsTradingDate('2026-09-14'), '2026-09-11');
  assert.equal(previousUsTradingDate('2026-09-08'), '2026-09-04');
  const discovered = await createDeterministicCnbcRecapDiscoveryService()
    .discoverCnbcCompletedSessionRecap({targetSessionDate: '2026-09-16'});
  assert.equal(discovered.type, 'SUCCESS');
  assert.deepEqual(discovered.candidates, [{
    rank: 1, discovery: deterministicCnbcRecapCandidate('2026-09-16')
  }]);
  assert.equal(Object.isFrozen(discovered.candidates[0].discovery), true);
});

test('unsupported, holiday, weekend and malformed target dates do not create a URL', async () => {
  const service = createDeterministicCnbcRecapDiscoveryService();
  for (const targetSessionDate of [
    '2026-09-07', '2026-09-12', '2026-11-27', '2025-09-16', '2026-02-30',
    '2026-09-16T00:00:00Z'
  ]) {
    assert.equal(deterministicCnbcRecapCandidate(targetSessionDate), null);
    assert.deepEqual(await service.discoverCnbcCompletedSessionRecap({targetSessionDate}), {
      ok: true, type: 'NOT_FOUND', candidates: []
    });
  }
});

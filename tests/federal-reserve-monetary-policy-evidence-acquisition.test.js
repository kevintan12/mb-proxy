const test = require('node:test');
const assert = require('node:assert/strict');
const {validateEvidenceCollectionInput} = require('../lib/evidence-collections');
const {
  DEFAULT_TIMEOUT_MS,
  FEDERAL_RESERVE_MONETARY_POLICY_RSS_URL,
  MAX_EVIDENCE_ITEMS,
  MAX_RESPONSE_BYTES,
  FederalReserveEvidenceAcquisitionError,
  createFederalReserveMonetaryPolicyEvidenceAcquisitionService
} = require('../lib/federal-reserve-monetary-policy-evidence-acquisition');

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Federal Reserve Board - Press Release</title>${items.join('')}</channel></rss>`;
}

function item({
  title = 'Federal Reserve issues FOMC statement',
  description = 'The Federal Reserve issued its monetary policy statement.',
  link = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
  pubDate = 'Fri, 04 Sep 2026 18:00:00 GMT'
} = {}) {
  return `<item><title>${title}</title><description>${description}</description><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;
}

function response(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: () => null},
    text: async () => body,
    ...overrides
  };
}

test('makes exactly one deterministic GET with XML headers and the 4000 ms default', async () => {
  const calls = [];
  const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(rss([item()]));
    }
  });
  await service.acquireEvidence();
  assert.equal(DEFAULT_TIMEOUT_MS, 4000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], FEDERAL_RESERVE_MONETARY_POLICY_RSS_URL);
  assert.equal(calls[0][1].method, 'GET');
  assert.deepEqual(calls[0][1].headers, {
    Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
  });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('creates canonical immutable registry-owned Federal Reserve evidence', async () => {
  const xml = rss([item({
    title: 'Federal Reserve &amp; FOMC update',
    description: '<![CDATA[<p>Policy stance &amp; outlook.</p>]]>',
    pubDate: 'Fri, 04 Sep 2026 14:30:00 -0400'
  })]);
  const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(xml)
  });
  const collection = await service.acquireEvidence();
  assert.deepEqual(collection, {
    market: 'US',
    items: [{
      sourceId: 'us.federal-reserve',
      market: 'US',
      evidenceCategory: 'monetary-policy',
      title: 'Federal Reserve & FOMC update',
      summary: 'Policy stance & outlook.',
      canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      publishedAt: '2026-09-04T18:30:00.000Z',
      symbols: [],
      provenance: {
        publisher: 'Board of Governors of the Federal Reserve System',
        authority: 'primary',
        homepage: 'https://www.federalreserve.gov/',
        applicableMarket: 'US',
        sourceJurisdiction: 'US',
        locator: 'source-homepage'
      }
    }]
  });
  assert.equal(validateEvidenceCollectionInput(collection).valid, true);
  assert.equal(Object.isFrozen(collection), true);
  assert.equal(Object.isFrozen(collection.items), true);
  assert.equal(Object.isFrozen(collection.items[0]), true);
  assert.equal(Object.isFrozen(collection.items[0].symbols), true);
  assert.equal(Object.isFrozen(collection.items[0].provenance), true);
});

test('normalizes descriptions to deterministic plain text and defaults absent descriptions to null', async () => {
  const xml = rss([
    item({description: '<![CDATA[<p>Rates&nbsp;held <strong>steady</strong>.</p><script>bad()</script>]]>'}),
    '<item><title>Minutes published</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260903a.htm</link><pubDate>Thu, 03 Sep 2026 18:00:00 GMT</pubDate></item>'
  ]);
  const collection = await createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(xml)
  }).acquireEvidence();
  assert.equal(collection.items[0].summary, 'Rates held steady.');
  assert.equal(collection.items[1].summary, null);
});

test('preserves provider order while accepting at most ten valid items', async () => {
  const entries = Array.from({length: 12}, (_, index) => item({
    title: `Item ${index + 1}`,
    link: `https://www.federalreserve.gov/newsevents/pressreleases/monetary202609${String(index + 1).padStart(2, '0')}a.htm`,
    pubDate: `${String(index + 1).padStart(2, '0')} Sep 2026 18:00:00 GMT`
  }));
  const collection = await createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(rss(entries))
  }).acquireEvidence();
  assert.equal(MAX_EVIDENCE_ITEMS, 10);
  assert.equal(collection.items.length, 10);
  assert.deepEqual(collection.items.map(entry => entry.title), Array.from({length: 10}, (_, index) => `Item ${index + 1}`));
});

test('skips invalid individual items but rejects a zero-valid-item feed', async () => {
  const invalid = [
    item({title: ' '}),
    item({link: 'http://www.federalreserve.gov/insecure'}),
    item({link: 'https://federalreserve.gov.evil.example/fake'}),
    item({pubDate: 'not a date'}),
    item({pubDate: 'Tue, 31 Feb 2026 18:00:00 GMT'})
  ];
  const mixed = rss([invalid[0], item({title: 'Valid item'}), invalid[1]]);
  const collection = await createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(mixed)
  }).acquireEvidence();
  assert.deepEqual(collection.items.map(entry => entry.title), ['Valid item']);

  const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(rss(invalid))
  });
  await assert.rejects(service.acquireEvidence(), error => error.code === 'NO_VALID_EVIDENCE');
});

test('rejects malformed XML and malformed feed structure deterministically', async () => {
  for (const body of ['<rss><channel><item></rss>', '<?xml version="1.0"?><feed></feed>', '<rss><channel></channel></rss>']) {
    const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
      fetchImpl: async () => response(body)
    });
    await assert.rejects(service.acquireEvidence(), error =>
      error instanceof FederalReserveEvidenceAcquisitionError && error.code === 'INVALID_FEED');
  }
});

test('rejects declared and actual oversized responses', async () => {
  const valid = rss([item()]);
  const declared = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(valid, {headers: {get: name => name === 'content-length' ? String(MAX_RESPONSE_BYTES + 1) : null}})
  });
  await assert.rejects(declared.acquireEvidence(), error => error.code === 'RESPONSE_TOO_LARGE');

  const actual = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    fetchImpl: async () => response(`${valid}${' '.repeat(MAX_RESPONSE_BYTES)}`)
  });
  await assert.rejects(actual.acquireEvidence(), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('times out during fetch with one request and no retry', async () => {
  let calls = 0;
  const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      calls++;
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    })
  });
  await assert.rejects(service.acquireEvidence(), error => error.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('keeps timeout active through a stalled body read with one request and no empty success', async () => {
  let calls = 0;
  const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
    timeoutMs: 5,
    fetchImpl: async (url, options) => {
      calls++;
      return response(null, {
        text: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
        })
      });
    }
  });
  await assert.rejects(service.acquireEvidence(), error => error.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('classifies network and HTTP failures stably without exposing causes or retrying', async () => {
  const failures = [
    {code: 'NETWORK_FAILURE', fetchImpl: async () => { throw new Error('sensitive upstream detail'); }},
    {code: 'HTTP_FAILURE', fetchImpl: async () => response('', {ok: false, status: 503})}
  ];
  for (const failure of failures) {
    let calls = 0;
    const service = createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
      fetchImpl: async (...args) => {
        calls++;
        return failure.fetchImpl(...args);
      }
    });
    await assert.rejects(service.acquireEvidence(), error => {
      assert.ok(error instanceof FederalReserveEvidenceAcquisitionError);
      return error.code === failure.code && !Object.hasOwn(error, 'cause');
    });
    assert.equal(calls, 1);
  }
});

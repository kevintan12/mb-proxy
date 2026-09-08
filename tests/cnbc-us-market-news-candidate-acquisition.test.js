const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CNBC_US_MARKET_INSIDER_RSS_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  CnbcUsMarketNewsCandidateAcquisitionError,
  createCnbcUsMarketNewsCandidateAcquisitionService
} = require('../lib/cnbc-us-market-news-candidate-acquisition');
const {validateNewsEvidenceCandidateCollection} = require('../lib/news-evidence-candidates');

const bounds = Object.freeze({
  maxCandidates: 10,
  maxTitleBytes: 200,
  maxSummaryBytes: 500,
  maxExtractBytes: 500,
  maxCollectionBytes: 20000
});
const horizons = Object.freeze([{
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-03T20:00:00Z',
  endsAtInclusive: '2026-09-04T20:00:00Z'
}, {
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-04T20:00:00Z',
  endsAtInclusive: '2026-09-08T14:00:00Z'
}]);

function item({
  title = 'Markets await new data',
  description = '<p>Investors &amp; policymakers reviewed <b>new information</b>.</p>',
  link = 'https://www.cnbc.com/2026/09/08/markets-example.html',
  pubDate = 'Tue, 08 Sep 2026 09:00:00 -0400'
} = {}) {
  return `<item><title><![CDATA[${title}]]></title><description><![CDATA[${description}]]></description><link>${link.replace(/&/g, '&amp;')}</link><pubDate>${pubDate}</pubDate></item>`;
}

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>CNBC Market Insider</title>${items.join('')}</channel></rss>`;
}

function response(body, {ok = true, status = 200, contentLength = null} = {}) {
  return {
    ok,
    status,
    headers: {get: name => name.toLowerCase() === 'content-length' ? contentLength : null},
    async text() { return body; }
  };
}

function serviceFor(body, calls = []) {
  return createCnbcUsMarketNewsCandidateAcquisitionService({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(body);
    }
  });
}

test('makes one GET to the fixed CNBC Market Insider feed with approved headers', async () => {
  const calls = [];
  const service = serviceFor(rss([item()]), calls);
  await service.acquireCandidates({horizons, bounds});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], CNBC_US_MARKET_INSIDER_RSS_URL);
  assert.equal(calls[0][1].method, 'GET');
  assert.deepEqual(calls[0][1].headers, {
    Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
  });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(DEFAULT_TIMEOUT_MS, 4000);
});

test('parses RSS into canonical CNBC news candidates in provider order', async () => {
  const service = serviceFor(rss([
    item({title: 'First &amp; current', link: 'https://www.cnbc.com/first.html'}),
    item({title: 'Second', link: 'https://www.cnbc.com/second.html', pubDate: 'Fri, 04 Sep 2026 15:59:59 -0400'})
  ]));
  const collection = await service.acquireCandidates({horizons, bounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), ['First & current', 'Second']);
  assert.deepEqual(collection.candidates.map(candidate => candidate.reference), ['c1', 'c2']);
  assert.deepEqual(collection.candidates.map(candidate => candidate.horizon.classification), [
    'SUBSEQUENT_DEVELOPMENT', 'COMPLETED_SESSION'
  ]);
  assert.equal(collection.candidates[0].publishedAt, '2026-09-08T13:00:00.000Z');
  assert.equal(collection.candidates[1].publishedAt, '2026-09-04T19:59:59.000Z');
  assert.equal(collection.candidates[0].sourceId, 'us.cnbc');
  assert.equal(collection.candidates[0].evidenceCategory, 'news');
  assert.equal(collection.candidates[0].extract, null);
  assert.deepEqual(collection.candidates[0].symbols, []);
  assert.equal(collection.candidates[0].provenance.publisher, 'CNBC');
  assert.equal(Object.isFrozen(collection), true);
  assert.equal(Object.isFrozen(collection.candidates), true);
  assert.equal(Object.isFrozen(collection.candidates[0]), true);
  assert.equal(Object.isFrozen(collection.candidates[0].provenance), true);
  assert.equal(validateNewsEvidenceCandidateCollection(collection, {bounds}).valid, true);
});

test('copies caller horizons and bounds before asynchronous retrieval', async () => {
  const mutableHorizons = horizons.map(horizon => ({...horizon}));
  const mutableBounds = {...bounds};
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const service = createCnbcUsMarketNewsCandidateAcquisitionService({
    fetchImpl: async () => {
      await waiting;
      return response(rss([item()]));
    }
  });
  const acquisition = service.acquireCandidates({horizons: mutableHorizons, bounds: mutableBounds});
  mutableHorizons[1].classification = 'UNKNOWN';
  mutableBounds.maxCandidates = 0;
  release();
  const collection = await acquisition;
  assert.equal(collection.candidates.length, 1);
  assert.equal(collection.candidates[0].horizon.classification, 'SUBSEQUENT_DEVELOPMENT');
});

test('normalizes RSS descriptions to plain text', async () => {
  const collection = await serviceFor(rss([item({
    description: '<p>Stocks&nbsp;rose.</p><script>hidden()</script><style>.x{}</style><div>Policy &amp; rates</div>'
  })])).acquireCandidates({horizons, bounds});
  assert.equal(collection.candidates[0].summary, 'Stocks rose. Policy & rates');
  assert.equal(collection.candidates[0].summary.includes('<'), false);
});

test('filters by caller horizons before assigning references', async () => {
  const service = serviceFor(rss([
    item({title: 'Too old', link: 'https://www.cnbc.com/old.html', pubDate: 'Thu, 03 Sep 2026 15:00:00 -0400'}),
    item({title: 'Accepted first', link: 'https://www.cnbc.com/accepted-1.html'}),
    item({title: 'Too new', link: 'https://www.cnbc.com/new.html', pubDate: 'Tue, 08 Sep 2026 11:00:00 -0400'}),
    item({title: 'Accepted second', link: 'https://www.cnbc.com/accepted-2.html', pubDate: 'Fri, 04 Sep 2026 15:00:00 -0400'})
  ]));
  const collection = await service.acquireCandidates({horizons, bounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), ['Accepted first', 'Accepted second']);
  assert.deepEqual(collection.candidates.map(candidate => candidate.reference), ['c1', 'c2']);
});

test('accepts only HTTPS CNBC-owned article links without repairing invalid links', async () => {
  const service = serviceFor(rss([
    item({title: 'HTTP', link: 'http://www.cnbc.com/http.html'}),
    item({title: 'Other host', link: 'https://example.com/other.html'}),
    item({title: 'Lookalike', link: 'https://cnbc.com.example.org/lookalike.html'}),
    item({title: 'Valid', link: 'https://www.cnbc.com/valid.html'})
  ]));
  const collection = await service.acquireCandidates({horizons, bounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), ['Valid']);
  assert.equal(collection.candidates[0].canonicalUrl, 'https://www.cnbc.com/valid.html');
});

test('deduplicates canonical URLs in feed order before assigning c1 through cN', async () => {
  const service = serviceFor(rss([
    item({title: 'First occurrence', link: 'https://www.cnbc.com/duplicate.html'}),
    item({title: 'Duplicate occurrence', link: 'https://www.cnbc.com/duplicate.html'}),
    item({title: 'Distinct', link: 'https://www.cnbc.com/distinct.html'})
  ]));
  const collection = await service.acquireCandidates({horizons, bounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), ['First occurrence', 'Distinct']);
  assert.deepEqual(collection.candidates.map(candidate => candidate.reference), ['c1', 'c2']);
});

test('applies caller candidate count bounds deterministically in feed order', async () => {
  const limitedBounds = {...bounds, maxCandidates: 2};
  const collection = await serviceFor(rss([
    item({title: 'First', link: 'https://www.cnbc.com/1.html'}),
    item({title: 'Second', link: 'https://www.cnbc.com/2.html'}),
    item({title: 'Third', link: 'https://www.cnbc.com/3.html'})
  ])).acquireCandidates({horizons, bounds: limitedBounds});
  assert.deepEqual(collection.candidates.map(candidate => candidate.title), ['First', 'Second']);
});

test('rejects invalid or overlapping caller horizons before making a request', async () => {
  let calls = 0;
  const service = createCnbcUsMarketNewsCandidateAcquisitionService({fetchImpl: async () => { calls++; }});
  for (const invalid of [[], [{...horizons[0], classification: 'UNKNOWN'}], [
    horizons[0],
    {...horizons[1], startsAtExclusive: '2026-09-04T19:00:00Z'}
  ]]) {
    await assert.rejects(service.acquireCandidates({horizons: invalid, bounds}), error =>
      error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('rejects invalid caller bounds before making a request', async () => {
  let calls = 0;
  const service = createCnbcUsMarketNewsCandidateAcquisitionService({fetchImpl: async () => { calls++; }});
  await assert.rejects(service.acquireCandidates({horizons, bounds: {...bounds, maxCandidates: 0}}), error =>
    error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === 'INVALID_INPUT');
  assert.equal(calls, 0);
});

test('times out during fetch with one request and no retry', async () => {
  let calls = 0;
  const service = createCnbcUsMarketNewsCandidateAcquisitionService({
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      calls++;
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });
  await assert.rejects(service.acquireCandidates({horizons, bounds}), error =>
    error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('keeps timeout active through a stalled response body read', async () => {
  let calls = 0;
  const service = createCnbcUsMarketNewsCandidateAcquisitionService({
    timeoutMs: 5,
    fetchImpl: async (url, options) => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: {get: () => null},
        text: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }))
      };
    }
  });
  await assert.rejects(service.acquireCandidates({horizons, bounds}), error =>
    error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('rejects declared and actual oversized responses', async () => {
  const declared = createCnbcUsMarketNewsCandidateAcquisitionService({
    fetchImpl: async () => response('', {contentLength: String(MAX_RESPONSE_BYTES + 1)})
  });
  await assert.rejects(declared.acquireCandidates({horizons, bounds}), error => error.code === 'RESPONSE_TOO_LARGE');

  const actual = createCnbcUsMarketNewsCandidateAcquisitionService({
    fetchImpl: async () => response('x'.repeat(MAX_RESPONSE_BYTES + 1))
  });
  await assert.rejects(actual.acquireCandidates({horizons, bounds}), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('fails closed for HTTP, network, malformed XML and malformed feed without retry', async () => {
  const cases = [
    ['HTTP_FAILURE', async () => response('', {ok: false, status: 503})],
    ['NETWORK_FAILURE', async () => { throw new Error('private upstream detail'); }],
    ['INVALID_FEED', async () => response('<rss><channel><item></rss>')],
    ['INVALID_FEED', async () => response('<?xml version="1.0"?><feed></feed>')]
  ];
  for (const [code, fetchImpl] of cases) {
    let calls = 0;
    const service = createCnbcUsMarketNewsCandidateAcquisitionService({
      fetchImpl: async (...args) => {
        calls++;
        return fetchImpl(...args);
      }
    });
    await assert.rejects(service.acquireCandidates({horizons, bounds}), error =>
      error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === code);
    assert.equal(calls, 1);
  }
});

test('fails closed when no valid in-horizon candidate remains', async () => {
  const service = serviceFor(rss([
    item({link: 'https://example.com/not-cnbc.html'}),
    item({link: 'https://www.cnbc.com/old.html', pubDate: 'Thu, 03 Sep 2026 15:00:00 -0400'}),
    item({link: 'https://www.cnbc.com/bad-date.html', pubDate: 'not-a-date'})
  ]));
  await assert.rejects(service.acquireCandidates({horizons, bounds}), error =>
    error instanceof CnbcUsMarketNewsCandidateAcquisitionError && error.code === 'NO_VALID_CANDIDATES');
});

test('fails closed when the bounded candidate collection cannot be constructed', async () => {
  const service = serviceFor(rss([item()]));
  await assert.rejects(service.acquireCandidates({
    horizons,
    bounds: {...bounds, maxCollectionBytes: 100}
  }), error => error instanceof CnbcUsMarketNewsCandidateAcquisitionError
    && error.code === 'INVALID_CANDIDATE_COLLECTION');
});

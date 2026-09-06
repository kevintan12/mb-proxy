const test = require('node:test');
const assert = require('node:assert/strict');
const {validateEvidenceCollectionInput} = require('../lib/evidence-collections');
const {
  DEFAULT_TIMEOUT_MS,
  YahooMarketDataEvidenceAcquisitionError,
  createYahooMarketDataEvidenceAcquisitionService
} = require('../lib/yahoo-market-data-evidence-acquisition');

const EXPECTED_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=10d';

function yahooPayload(overrides = {}) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: 'AAPL',
          longName: 'Apple Inc.',
          regularMarketPrice: 237.88,
          regularMarketTime: 1788537600,
          currency: 'usd',
          ...overrides
        }
      }],
      error: null
    }
  };
}

function response(body = yahooPayload(), overrides = {}) {
  return {ok: true, status: 200, json: async () => body, ...overrides};
}

async function captureSuccess(inputSymbol = ' aapl ') {
  const calls = [];
  const service = createYahooMarketDataEvidenceAcquisitionService({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response();
    }
  });
  return {collection: await service.acquireEvidence({symbol: inputSymbol}), calls};
}

test('performs exactly one deterministic Yahoo chart request with approved headers', async () => {
  const {calls} = await captureSuccess();
  assert.equal(DEFAULT_TIMEOUT_MS, 4000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], EXPECTED_URL);
  assert.deepEqual(calls[0][1].headers, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('returns deterministic canonical US Yahoo evidence with registry provenance', async () => {
  const first = (await captureSuccess()).collection;
  const second = (await captureSuccess('AAPL')).collection;
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    market: 'US',
    items: [{
      sourceId: 'us.yahoo-finance',
      market: 'US',
      evidenceCategory: 'market-data',
      title: 'Apple Inc. market data',
      summary: 'Apple Inc. regular market price was 237.88 USD as of 2026-09-04T16:00:00.000Z.',
      canonicalUrl: 'https://finance.yahoo.com/quote/AAPL/',
      publishedAt: '2026-09-04T16:00:00.000Z',
      symbols: ['AAPL'],
      provenance: {
        publisher: 'Yahoo',
        authority: 'secondary',
        homepage: 'https://finance.yahoo.com/',
        applicableMarket: 'US',
        sourceJurisdiction: 'GLOBAL',
        locator: 'source-homepage'
      }
    }]
  });
  assert.equal(validateEvidenceCollectionInput(first).valid, true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  assert.equal(Object.isFrozen(first.items[0]), true);
  assert.equal(Object.isFrozen(first.items[0].symbols), true);
  assert.equal(Object.isFrozen(first.items[0].provenance), true);
});

test('does not mutate caller input and rejects non-US symbol identities', async () => {
  const input = {symbol: ' aapl '};
  await createYahooMarketDataEvidenceAcquisitionService({fetchImpl: async () => response()}).acquireEvidence(input);
  assert.deepEqual(input, {symbol: ' aapl '});

  for (const symbol of ['', 'D05.SI', '0700.HK', '^STI', '^HSI']) {
    let calls = 0;
    const service = createYahooMarketDataEvidenceAcquisitionService({fetchImpl: async () => { calls++; }});
    await assert.rejects(service.acquireEvidence({symbol}), error => error.code === 'INVALID_INPUT');
    assert.equal(calls, 0);
  }
});

test('fails stably on timeout and aborts the single request without retry', async () => {
  let calls = 0;
  const service = createYahooMarketDataEvidenceAcquisitionService({
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      calls++;
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    })
  });
  await assert.rejects(service.acquireEvidence({symbol: 'AAPL'}), error => {
    assert.ok(error instanceof YahooMarketDataEvidenceAcquisitionError);
    return error.code === 'TIMEOUT' && !Object.hasOwn(error, 'cause');
  });
  assert.equal(calls, 1);
});

test('keeps the timeout active through a stalled response-body read', async () => {
  let calls = 0;
  const service = createYahooMarketDataEvidenceAcquisitionService({
    timeoutMs: 5,
    fetchImpl: async (url, options) => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('body read aborted'), {name: 'AbortError'}));
          });
        })
      };
    }
  });
  await assert.rejects(service.acquireEvidence({symbol: 'AAPL'}), error =>
    error instanceof YahooMarketDataEvidenceAcquisitionError && error.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('classifies network, HTTP and invalid JSON failures without retry or empty success', async () => {
  const cases = [
    {code: 'NETWORK_FAILURE', fetchImpl: async () => { throw new Error('secret upstream detail'); }},
    {code: 'HTTP_FAILURE', fetchImpl: async () => response(null, {ok: false, status: 429})},
    {code: 'INVALID_RESPONSE', fetchImpl: async () => response(null, {json: async () => { throw new SyntaxError('bad json'); }})}
  ];
  for (const failure of cases) {
    let calls = 0;
    const service = createYahooMarketDataEvidenceAcquisitionService({fetchImpl: async (...args) => {
      calls++;
      return failure.fetchImpl(...args);
    }});
    await assert.rejects(service.acquireEvidence({symbol: 'AAPL'}), error =>
      error instanceof YahooMarketDataEvidenceAcquisitionError && error.code === failure.code);
    assert.equal(calls, 1);
  }
});

test('rejects malformed payload, mismatched symbol, invalid price and invalid timestamp', async () => {
  const payloads = [
    {},
    yahooPayload({symbol: 'MSFT'}),
    yahooPayload({regularMarketPrice: 0}),
    yahooPayload({regularMarketPrice: Number.NaN}),
    yahooPayload({regularMarketTime: null}),
    yahooPayload({regularMarketTime: Number.POSITIVE_INFINITY})
  ];
  for (const body of payloads) {
    let calls = 0;
    const service = createYahooMarketDataEvidenceAcquisitionService({fetchImpl: async () => {
      calls++;
      return response(body);
    }});
    await assert.rejects(service.acquireEvidence({symbol: 'AAPL'}), error =>
      error instanceof YahooMarketDataEvidenceAcquisitionError && error.code === 'INVALID_RESPONSE');
    assert.equal(calls, 1);
  }
});

test('uses deterministic provider name fallbacks without accepting caller provenance', async () => {
  const service = createYahooMarketDataEvidenceAcquisitionService({
    fetchImpl: async () => response(yahooPayload({longName: ' ', shortName: 'Apple'}))
  });
  const collection = await service.acquireEvidence({symbol: 'aapl'});
  assert.equal(collection.items[0].title, 'Apple market data');
  assert.equal(collection.items[0].symbols[0], 'AAPL');
  assert.equal(collection.items[0].provenance.publisher, 'Yahoo');
});

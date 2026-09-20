const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YAHOO_MOST_ACTIVE_URL,
  YAHOO_MOST_ACTIVE_MAX_CANDIDATES,
  createYahooMostActiveAcquisitionService
} = require('../lib/yahoo-most-active-acquisition');

function response(body, {status = 200, contentLength = null} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => name.toLowerCase() === 'content-length' ? contentLength : 'application/json'},
    text: async () => body
  };
}

function quote(index, overrides = {}) {
  return {
    quoteType: 'EQUITY', market: 'us_market', symbol: `ABC${index}`,
    shortName: `Company ${index}`, longName: `Company ${index} Incorporated`,
    exchange: 'NMS', marketState: 'REGULAR', regularMarketPrice: 100 + index,
    regularMarketChange: index, regularMarketChangePercent: index / 10,
    regularMarketVolume: 1000000 + index, averageDailyVolume3Month: 900000,
    averageDailyVolume10Day: 950000, preMarketPrice: 99, preMarketChange: -1,
    preMarketChangePercent: -1, preMarketTime: 1789900000, postMarketPrice: 102,
    postMarketChange: 2, postMarketChangePercent: 2, postMarketTime: 1789920000,
    ...overrides
  };
}

function envelope(quotes) {
  return JSON.stringify({finance: {result: [{quotes}], error: null}});
}

test('acquires and normalizes at most ten US equity Most Active candidates', async () => {
  let requested;
  const service = createYahooMostActiveAcquisitionService({fetchImpl: async url => {
    requested = url;
    return response(envelope(Array.from({length: 12}, (_, index) => quote(index))));
  }});
  const result = await service.acquireMostActive();
  assert.equal(requested, YAHOO_MOST_ACTIVE_URL);
  assert.equal(result.ok, true);
  assert.equal(result.type, 'SUCCESS');
  assert.equal(result.candidates.length, YAHOO_MOST_ACTIVE_MAX_CANDIDATES);
  assert.deepEqual(Object.keys(result.candidates[0]), [
    'symbol', 'shortName', 'longName', 'exchange', 'market', 'marketState', 'price',
    'change', 'changePercent', 'volume', 'averageDailyVolume3Month',
    'averageDailyVolume10Day', 'preMarketPrice', 'preMarketChange',
    'preMarketChangePercent', 'preMarketTime', 'postMarketPrice', 'postMarketChange',
    'postMarketChangePercent', 'postMarketTime'
  ]);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
});

test('deduplicates symbols and excludes malformed or non-US non-equity quotes', async () => {
  const quotes = [
    quote(1, {symbol: ' nvda '}), quote(2, {symbol: 'NVDA'}),
    quote(3, {symbol: 'BAD SYMBOL'}), quote(4, {quoteType: 'ETF'}),
    quote(5, {market: 'sg_market'}), quote(6, {regularMarketPrice: null})
  ];
  const result = await createYahooMostActiveAcquisitionService({
    fetchImpl: async () => response(envelope(quotes))
  }).acquireMostActive();
  assert.deepEqual(result.candidates.map(item => item.symbol), ['NVDA']);
});

test('retains only positive finite optional pre- and post-market prices', async () => {
  const result = await createYahooMostActiveAcquisitionService({
    fetchImpl: async () => response(envelope([
      quote(1, {preMarketPrice: 99, postMarketPrice: 101}),
      quote(2, {preMarketPrice: 0, postMarketPrice: 0}),
      quote(3, {preMarketPrice: -1, postMarketPrice: -1}),
      quote(4, {preMarketPrice: NaN, postMarketPrice: Infinity}),
      quote(5, {preMarketPrice: 'not-a-price', postMarketPrice: 'not-a-price'})
    ]))
  }).acquireMostActive();
  assert.equal(result.candidates[0].preMarketPrice, 99);
  assert.equal(result.candidates[0].postMarketPrice, 101);
  for (const candidate of result.candidates.slice(1)) {
    assert.equal(candidate.preMarketPrice, null);
    assert.equal(candidate.postMarketPrice, null);
  }
});

test('fails safely for malformed and oversized Yahoo responses', async () => {
  const malformed = await createYahooMostActiveAcquisitionService({
    fetchImpl: async () => response('{')
  }).acquireMostActive();
  assert.equal(malformed.type, 'INVALID_RESPONSE');
  const oversized = await createYahooMostActiveAcquisitionService({
    maxResponseBytes: 20,
    fetchImpl: async () => response(envelope([quote(1)]), {contentLength: '21'})
  }).acquireMostActive();
  assert.equal(oversized.type, 'RESPONSE_TOO_LARGE');
});

test('returns NOT_FOUND rather than promoting invalid discovery data', async () => {
  const result = await createYahooMostActiveAcquisitionService({
    fetchImpl: async () => response(envelope([quote(1, {quoteType: 'ETF'})]))
  }).acquireMostActive();
  assert.deepEqual(result, {ok: true, type: 'NOT_FOUND', candidates: []});
});

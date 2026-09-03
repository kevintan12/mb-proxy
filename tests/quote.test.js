const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/quote');

const REAL_DATE_NOW = Date.now;
const REAL_FETCH = global.fetch;
const FIXED_NOW_MS = Date.parse('2026-01-08T22:00:00Z');

function epoch(iso) {
  return Date.parse(iso) / 1000;
}

function chartResult(closes, timestamps, metaOverrides) {
  return {
    chart: {
      result: [{
        meta: {
          marketState: 'CLOSED',
          regularMarketPrice: closes.filter(value => Number.isFinite(value) && value > 0).at(-1),
          regularMarketPreviousClose: 90,
          chartPreviousClose: 89,
          exchangeTimezoneName: 'America/New_York',
          currentTradingPeriod: { regular: { end: epoch('2026-01-08T21:00:00Z') } },
          ...metaOverrides
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes, volume: closes.map(() => 1000) }] }
      }],
      error: null
    }
  };
}

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

async function requestQuote(name, baseData, fallbackResult, symbol = `TEST-${name}`) {
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    if (url.includes('range=1d')) {
      if (fallbackResult instanceof Error) throw fallbackResult;
      return fallbackResult || response({}, false, 500);
    }
    return response(baseData);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol } }, res);
  return { res, calls };
}

test.beforeEach(() => { Date.now = () => FIXED_NOW_MS; });
test.afterEach(() => { Date.now = REAL_DATE_NOW; global.fetch = REAL_FETCH; });

test('normal consecutive observations need no fallback and preserve legacy fields', async () => {
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('normal', data);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { price: res.body.price, prev: res.body.prev, change: res.body.change, changePct: res.body.changePct },
    { price: 110, prev: 105, change: 5, changePct: 4.7619 }
  );
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('null completed-session row triggers verified 1d previous close', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: 107 } }] } });
  const { res, calls } = await requestQuote('gap', data, fallback);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /interval=1d&range=1d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart1d');
  assert.deepEqual(
    { price: res.body.price, prev: res.body.prev, change: res.body.change },
    { price: 110, prev: 100, change: 10 }
  );
});

test('equal consecutive completed closes remain distinct and do not create a gap', async () => {
  const data = chartResult([100, 100, 105], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('equal', data);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.previousDailyClose, 100);
  assert.equal(res.body.provider.latestDailyClose, 105);
});

test('weekend adjacency is not a gap', async () => {
  const data = chartResult([100, 105], [
    epoch('2026-01-02T21:00:00Z'), epoch('2026-01-05T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('weekend', data);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
});

test('holiday adjacency without a Yahoo observation is not a gap', async () => {
  const data = chartResult([100, 105], [
    epoch('2025-12-31T21:00:00Z'), epoch('2026-01-02T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('holiday', data);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
});

test('current incomplete null row is not a gap', async () => {
  Date.now = () => Date.parse('2026-01-08T18:00:00Z');
  const data = chartResult([100, 105, null], [
    epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z'), epoch('2026-01-08T21:00:00Z')
  ], { currentTradingPeriod: { regular: { end: epoch('2026-01-08T21:00:00Z') } } });
  const { res, calls } = await requestQuote('incomplete', data);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
});

test('1d fallback failure preserves the base quote', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('fallback-failure', data, new Error('fallback unavailable'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.prev, 100);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('invalid 1d chartPreviousClose is safely unavailable', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: -1 } }] } });
  const { res } = await requestQuote('invalid-fallback', data, fallback);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('HSI without regularMarketPreviousClose verifies 1d even without a detected gap', async () => {
  Date.now = () => FIXED_NOW_MS + 2000;
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: null });
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: 107 } }] } });
  const { res, calls } = await requestQuote('hsi-missing-previous', data, fallback, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /%5EHSI\?interval=1d&range=1d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart1d');
});

test('HSI with valid regularMarketPreviousClose and no gap makes no targeted request', async () => {
  Date.now = () => FIXED_NOW_MS + 4000;
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('hsi-valid-previous', data, undefined, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('non-HSI without regularMarketPreviousClose and no gap remains single-request', async () => {
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: null });
  const { res, calls } = await requestQuote('non-hsi-missing-previous', data);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('failed targeted HSI verification preserves base quote without immediate metadata', async () => {
  Date.now = () => FIXED_NOW_MS + 6000;
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: null });
  const { res, calls } = await requestQuote(
    'hsi-fallback-failure', data, new Error('fallback unavailable'), '^HSI'
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('invalid targeted HSI chartPreviousClose preserves base quote without immediate metadata', async () => {
  Date.now = () => FIXED_NOW_MS + 8000;
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: 0 });
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: 0 } }] } });
  const { res, calls } = await requestQuote('hsi-invalid-fallback', data, fallback, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('STI trailing null completed row uses verified 1d immediate previous close', async () => {
  Date.now = () => FIXED_NOW_MS + 10000;
  const data = chartResult([5700, 5710.3701171875, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPrice: 5759.46,
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: 5744.11 } }] } });
  const { res, calls } = await requestQuote('sti-trailing-null', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /%5ESTI\?interval=1d&range=1d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.latestDailyClose, 5710.3701171875);
  assert.equal(res.body.provider.immediatePreviousClose, 5744.11);
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart1d');
});

test('ordinary SG equity with trailing null and no regular previous close is unaffected', async () => {
  const data = chartResult([10, 10.2, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const { res, calls } = await requestQuote('ordinary-sg-equity', data, undefined, 'D05.SI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('invalid STI 1d verification is rejected while the base quote succeeds', async () => {
  Date.now = () => FIXED_NOW_MS + 12000;
  const data = chartResult([5700, 5710.3701171875, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const fallback = response({ chart: { result: [{ meta: { chartPreviousClose: -1 } }] } });
  const { res, calls } = await requestQuote('sti-invalid-fallback', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('missing STI 1d verification is rejected while the base quote succeeds', async () => {
  Date.now = () => FIXED_NOW_MS + 14000;
  const data = chartResult([5700, 5710.3701171875, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const fallback = response({ chart: { result: [{ meta: {} }] } });
  const { res, calls } = await requestQuote('sti-missing-fallback', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

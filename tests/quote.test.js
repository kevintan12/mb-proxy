const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/quote');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createClaudeAnalysisInput} = require('../lib/claude-analysis-contract');

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
    write(value) {
      if (!this.chunks) this.chunks = [];
      this.chunks.push(value);
      return true;
    },
    end() { this.ended = true; return this; }
  };
}

function claudeAnalysisInput() {
  const item = createEvidenceItem({
    sourceId: 'sg.reuters',
    market: 'SG',
    evidenceCategory: 'news',
    title: 'Market update',
    canonicalUrl: 'https://www.reuters.com/markets/example',
    publishedAt: '2026-09-06T08:00:00Z'
  });
  return createClaudeAnalysisInput({
    evidenceCollection: createEvidenceCollection({market: 'SG', items: [item]})
  });
}

async function requestQuote(
  name,
  baseData,
  fallbackResult,
  symbol = `TEST-${name}`,
  alternateFallbackResult
) {
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    if (url.includes('range=5d')) {
      const selectedResult = url.includes('query2.finance.yahoo.com')
        ? alternateFallbackResult
        : fallbackResult;
      if (selectedResult instanceof Error) throw selectedResult;
      return selectedResult || response({}, false, 500);
    }
    return response(baseData);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol } }, res);
  return { res, calls };
}

test.beforeEach(() => { Date.now = () => FIXED_NOW_MS; });
test.afterEach(() => { Date.now = REAL_DATE_NOW; global.fetch = REAL_FETCH; });

test('structured Claude route returns validated analysis with one server-owned request', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({url, options});
    return {
      ok: true,
      status: 200,
      async json() {
        return {content: [{type: 'text', text: JSON.stringify({
          status: 'NORMAL',
          findings: [{text: 'Supported finding.', evidenceRefs: ['e1']}],
          gaps: []
        })}]};
      }
    };
  };
  try {
    const res = mockRes();
    await handler({method: 'POST', query: {claudeAnalysis: '1'}, body: claudeAnalysisInput()}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const requestBody = JSON.parse(calls[0].options.body);
    assert.equal(requestBody.model, 'claude-haiku-4-5-20251001');
    assert.equal(requestBody.max_tokens, 4000);
    assert.equal(Object.hasOwn(requestBody, 'tools'), false);
    assert.deepEqual(res.body, {result: {
      status: 'NORMAL',
      findings: [{text: 'Supported finding.', evidenceRefs: ['e1']}],
      gaps: []
    }});
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('structured Claude route separates input, contract and upstream failures', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    let calls = 0;
    global.fetch = async () => { calls++; return {ok: false, status: 503}; };
    const invalidInput = mockRes();
    await handler({method: 'POST', query: {claudeAnalysis: '1'}, body: {}}, invalidInput);
    assert.equal(invalidInput.statusCode, 400);
    assert.equal(invalidInput.body.error.type, 'INPUT_FAILURE');
    assert.equal(calls, 0);

    const upstream = mockRes();
    await handler({method: 'POST', query: {claudeAnalysis: '1'}, body: claudeAnalysisInput()}, upstream);
    assert.equal(upstream.statusCode, 502);
    assert.equal(upstream.body.error.type, 'UPSTREAM_FAILURE');
    assert.equal(upstream.body.error.upstreamStatus, 503);
    assert.equal(calls, 1);

    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {content: [{type: 'text', text: JSON.stringify({
          status: 'NORMAL', findings: [{text: 'Unsupported.', evidenceRefs: ['e2']}], gaps: []
        })}]};
      }
    });
    const contract = mockRes();
    await handler({method: 'POST', query: {claudeAnalysis: '1'}, body: claudeAnalysisInput()}, contract);
    assert.equal(contract.statusCode, 502);
    assert.equal(contract.body.error.type, 'CONTRACT_FAILURE');
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('legacy Claude proxy still forwards the caller body and streams unchanged', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'legacy-key';
  const callerBody = {model: 'caller-model', stream: true, messages: [{role: 'user', content: 'legacy'}]};
  const chunks = [new Uint8Array([65]), new Uint8Array([66])];
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({url, options});
    let index = 0;
    return {
      status: 201,
      headers: {get() { return 'text/event-stream'; }},
      body: {getReader() { return {async read() {
        return index < chunks.length ? {done: false, value: chunks[index++]} : {done: true};
      }}; }}
    };
  };
  try {
    const res = mockRes();
    await handler({method: 'POST', query: {claude: '1'}, body: callerBody}, res);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.deepEqual(JSON.parse(calls[0].options.body), callerBody);
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.deepEqual(res.chunks, chunks);
    assert.equal(res.ended, true);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

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

test('null completed-session row triggers date-verified 5d previous close', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const fallback = response(chartResult([107], [epoch('2026-01-06T21:00:00Z')]));
  const { res, calls } = await requestQuote('gap', data, fallback);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /interval=1d&range=5d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseTime, epoch('2026-01-06T21:00:00Z'));
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery1');
  assert.deepEqual(
    { price: res.body.price, prev: res.body.prev, change: res.body.change },
    { price: 110, prev: 100, change: 10 }
  );
});

test('primary query1 failure falls back to a valid query2 row', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const alternate = response(chartResult([107], [epoch('2026-01-06T21:00:00Z')]));
  const { res, calls } = await requestQuote(
    'alternate-after-failure',
    data,
    new Error('primary unavailable'),
    'TEST-alternate-after-failure',
    alternate
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /^https:\/\/query2\.finance\.yahoo\.com\//);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseTime, epoch('2026-01-06T21:00:00Z'));
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery2');
});

test('primary missing expected date falls back to a valid query2 row', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const primary = response(chartResult([106], [epoch('2026-01-05T21:00:00Z')]));
  const alternate = response(chartResult([107], [epoch('2026-01-06T21:00:00Z')]));
  const { res, calls } = await requestQuote(
    'alternate-after-miss', data, primary, 'TEST-alternate-after-miss', alternate
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseTime, epoch('2026-01-06T21:00:00Z'));
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery2');
});

test('wrong-dated alternate row is rejected', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const wrongDatedAlternate = response(chartResult([999], [epoch('2026-01-05T21:00:00Z')]));
  const { res, calls } = await requestQuote(
    'wrong-dated-alternate',
    data,
    new Error('primary unavailable'),
    'TEST-wrong-dated-alternate',
    wrongDatedAlternate
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
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

test('both 5d attempts failing preserves the base quote', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('fallback-failure', data, new Error('fallback unavailable'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.prev, 100);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('invalid aligned 5d close is safely unavailable', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const fallback = response(chartResult([-1], [epoch('2026-01-06T21:00:00Z')]));
  const { res } = await requestQuote('invalid-fallback', data, fallback);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider.dailyClosePairHasGap, true);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('HSI recovers the timestamped expected previous session from 5d', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:00Z');
  const data = chartResult([25566.990234375, 25329.73046875, 25311.2109375], [
    epoch('2026-08-31T01:30:00Z'), epoch('2026-09-01T01:30:00Z'), epoch('2026-09-02T01:30:00Z')
  ], {
    marketState: 'REGULAR',
    regularMarketPrice: 25737.60,
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Hong_Kong',
    currentTradingPeriod: { regular: { end: epoch('2026-09-04T08:00:00Z') } }
  });
  const fallback = response(chartResult(
    [25329.73046875, 25311.2109375, 25213.310546875, 25737.599609375],
    [
      epoch('2026-09-01T01:30:00Z'), epoch('2026-09-02T01:30:00Z'),
      epoch('2026-09-03T01:30:00Z'), epoch('2026-09-04T01:30:00Z')
    ],
    { exchangeTimezoneName: 'Asia/Hong_Kong' }
  ));
  const { res, calls } = await requestQuote('hsi-missing-previous', data, fallback, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /%5EHSI\?interval=1d&range=5d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, 25213.310546875);
  assert.equal(res.body.provider.immediatePreviousCloseTime, 1788399000);
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery1');
});

test('HSI with valid regularMarketPreviousClose and no gap makes no targeted request', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:02Z');
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const { res, calls } = await requestQuote('hsi-valid-previous', data, undefined, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
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
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('failed targeted HSI verification preserves base quote without immediate metadata', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:04Z');
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: null });
  const { res, calls } = await requestQuote(
    'hsi-fallback-failure', data, new Error('fallback unavailable'), '^HSI'
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('invalid targeted HSI 5d close preserves base quote without immediate metadata', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:06Z');
  const data = chartResult([100, 105, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ], { regularMarketPreviousClose: 0 });
  const fallback = response(chartResult([0], [epoch('2026-01-07T21:00:00Z')]));
  const { res, calls } = await requestQuote('hsi-invalid-fallback', data, fallback, '^HSI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.price, 110);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('STI trailing null completed row uses date-verified 5d immediate previous close', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:00Z');
  const data = chartResult([5710.3701171875, 5744.10986328125, null], [
    epoch('2026-09-01T01:00:00Z'), epoch('2026-09-02T01:00:00Z'), epoch('2026-09-03T01:00:00Z')
  ], {
    marketState: 'REGULAR',
    regularMarketPrice: 5811.78,
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-09-04T09:00:00Z') } }
  });
  const fallback = response(chartResult([
    5710.3701171875, 5744.10986328125, 5747.7099609375, 5811.77978515625
  ], [
    epoch('2026-09-01T01:00:00Z'), epoch('2026-09-02T01:00:00Z'),
    epoch('2026-09-03T01:00:00Z'), epoch('2026-09-04T01:00:00Z')
  ], { exchangeTimezoneName: 'Asia/Singapore' }));
  const { res, calls } = await requestQuote('sti-trailing-null', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /%5ESTI\?interval=1d&range=5d$/);
  assert.equal(res.body.provider.dailyClosePairHasGap, false);
  assert.equal(res.body.provider.latestDailyClose, 5744.10986328125);
  assert.equal(res.body.provider.immediatePreviousClose, 5747.7099609375);
  assert.equal(res.body.provider.immediatePreviousCloseTime, epoch('2026-09-03T01:00:00Z'));
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery1');
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
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('ordinary HK equity without a gap remains outside targeted verification', async () => {
  const data = chartResult([430, 433, null], [
    epoch('2026-01-06T01:30:00Z'), epoch('2026-01-07T01:30:00Z'), epoch('2026-01-08T01:30:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Hong_Kong',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T08:00:00Z') } }
  });
  const { res, calls } = await requestQuote('ordinary-hk-equity', data, undefined, '0700.HK');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('5d verification keeps timestamp and close indexes aligned', async () => {
  const data = chartResult([100, null, 110], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z'), epoch('2026-01-07T21:00:00Z')
  ]);
  const fallback = response(chartResult([999, 107], [
    epoch('2026-01-05T21:00:00Z'), epoch('2026-01-06T21:00:00Z')
  ]));
  const { res } = await requestQuote('aligned-fallback', data, fallback);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider.immediatePreviousClose, 107);
  assert.equal(res.body.provider.immediatePreviousCloseTime, epoch('2026-01-06T21:00:00Z'));
  assert.equal(res.body.provider.immediatePreviousCloseSource, 'yahooChart5dQuery1');
});

test('invalid STI 5d verification is rejected while the base quote succeeds', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:02Z');
  const data = chartResult([5700, 5710.3701171875, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const fallback = response(chartResult([-1], [epoch('2026-01-07T09:00:00Z')], {
    exchangeTimezoneName: 'Asia/Singapore'
  }));
  const { res, calls } = await requestQuote('sti-invalid-fallback', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

test('missing expected STI 5d row is rejected while the base quote succeeds', async () => {
  Date.now = () => Date.parse('2026-09-04T04:00:04Z');
  const data = chartResult([5700, 5710.3701171875, null], [
    epoch('2026-01-06T09:00:00Z'), epoch('2026-01-07T09:00:00Z'), epoch('2026-01-08T09:00:00Z')
  ], {
    regularMarketPreviousClose: null,
    exchangeTimezoneName: 'Asia/Singapore',
    currentTradingPeriod: { regular: { end: epoch('2026-01-08T09:00:00Z') } }
  });
  const fallback = response(chartResult([5700], [epoch('2026-01-05T09:00:00Z')], {
    exchangeTimezoneName: 'Asia/Singapore'
  }));
  const { res, calls } = await requestQuote('sti-missing-fallback', data, fallback, '^STI');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(res.body.provider.immediatePreviousClose, null);
  assert.equal(res.body.provider.immediatePreviousCloseTime, null);
  assert.equal(res.body.provider.immediatePreviousCloseSource, null);
});

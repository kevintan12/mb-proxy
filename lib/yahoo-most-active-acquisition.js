const {settingValue} = require('./settings-registry');
const {fetchAnchorChartMove} = require('./yahoo-telemetry-acquisition');

const YAHOO_MOST_ACTIVE_URL = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_actives&count=10&start=0';
// Step 9F.2a: moved into the shared settings registry, same default values.
const DEFAULT_TIMEOUT_MS = settingValue('pageTimeoutMs');
const MAX_RESPONSE_BYTES = settingValue('mostActiveMaxResponseBytes');
const MAX_CANDIDATES = settingValue('mostActiveMaxCandidates');
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const HEADERS = Object.freeze({
  'User-Agent': 'MarketBrief/1.0 active-session-acquisition',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message, candidates: []});
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedString(value, bytes = 256) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, 'utf8') <= bytes ? normalized : null;
}

function epochTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)
      || quote.quoteType !== 'EQUITY' || quote.market !== 'us_market') return null;
  const symbol = typeof quote.symbol === 'string' ? quote.symbol.trim().toUpperCase() : '';
  const price = finite(quote.regularMarketPrice);
  if (!SYMBOL.test(symbol) || price === null || price <= 0) return null;
  return deepFreeze({
    symbol,
    shortName: boundedString(quote.shortName),
    longName: boundedString(quote.longName),
    exchange: boundedString(quote.exchange, 32),
    market: 'us_market',
    marketState: boundedString(quote.marketState, 32),
    price,
    change: finite(quote.regularMarketChange),
    changePercent: finite(quote.regularMarketChangePercent),
    volume: nonNegative(quote.regularMarketVolume),
    averageDailyVolume3Month: nonNegative(quote.averageDailyVolume3Month),
    averageDailyVolume10Day: nonNegative(quote.averageDailyVolume10Day),
    preMarketPrice: positiveFinite(quote.preMarketPrice),
    preMarketChange: finite(quote.preMarketChange),
    preMarketChangePercent: finite(quote.preMarketChangePercent),
    preMarketTime: epochTimestamp(quote.preMarketTime),
    postMarketPrice: positiveFinite(quote.postMarketPrice),
    postMarketChange: finite(quote.postMarketChange),
    postMarketChangePercent: finite(quote.postMarketChangePercent),
    postMarketTime: epochTimestamp(quote.postMarketTime)
  });
}

// Step 9W Build A: the size and move fields the Most Active candidates leave
// out, kept in a separate spotlight row (never on a candidate, so nothing new
// reaches the package).
function screenerRow(quote) {
  const candidate = normalizeQuote(quote);
  if (!candidate) return null;
  const marketCap = positiveFinite(quote.marketCap);
  return deepFreeze({
    symbol: candidate.symbol,
    shortName: candidate.shortName,
    longName: candidate.longName,
    price: candidate.price,
    movePct: candidate.changePercent,
    marketCapUsdBn: marketCap === null ? null : marketCap / 1e9,
    earningsAt: epochTimestamp(quote.earningsTimestamp),
    asOf: epochTimestamp(quote.regularMarketTime)
  });
}

function screenerUrl(scrId, count) {
  return 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US'
    + `&region=US&scrIds=${encodeURIComponent(scrId)}&count=${count}&start=0`;
}

const SPOTLIGHT_SCREENERS = Object.freeze(['day_gainers', 'day_losers']);

async function readBoundedText(response, signal, maximum) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) return {tooLarge: true, text: ''};
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maximum ? {tooLarge: true, text: ''} : {tooLarge: false, text};
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    if (signal.aborted) throw Object.assign(new Error('Aborted'), {name: 'AbortError'});
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      try { await reader.cancel(); } catch (error) {}
      return {tooLarge: true, text: ''};
    }
    chunks.push(Buffer.from(value));
  }
  return {tooLarge: false, text: Buffer.concat(chunks).toString('utf8')};
}

function createYahooMostActiveAcquisitionService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('Invalid Yahoo Most Active acquisition bounds');
  }
  // One screener page: {ok: true, quotes} or a failure. The Most Active
  // fetch below is unchanged; the spotlight screeners use the same reader.
  async function fetchScreenerQuotes(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let body;
    try {
      try {
        response = await fetchImpl(url, {headers: HEADERS, signal: controller.signal});
      } catch (error) {
        return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE', 'Yahoo Most Active could not be retrieved');
      }
      if (!response?.ok) return failure('HTTP_FAILURE', 'Yahoo Most Active request was unsuccessful');
      try {
        body = await readBoundedText(response, controller.signal, maxResponseBytes);
      } catch (error) {
        return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RESPONSE_READ_FAILURE', 'Yahoo Most Active response could not be read');
      }
    } finally {
      clearTimeout(timeout);
    }
    if (body.tooLarge) return failure('RESPONSE_TOO_LARGE', 'Yahoo Most Active response exceeds configured bounds');
    let envelope;
    try { envelope = JSON.parse(body.text); } catch (error) {
      return failure('INVALID_RESPONSE', 'Yahoo Most Active response is not valid JSON');
    }
    const result = envelope?.finance?.result;
    if (envelope?.finance?.error !== null || !Array.isArray(result) || result.length !== 1
        || !Array.isArray(result[0]?.quotes)) {
      return failure('INVALID_RESPONSE', 'Yahoo Most Active response is malformed');
    }
    return {ok: true, quotes: result[0].quotes};
  }

  function mostActiveResult(page) {
    if (!page.ok) return page;
    const seen = new Set();
    const candidates = [];
    for (const quote of page.quotes) {
      const candidate = normalizeQuote(quote);
      if (!candidate || seen.has(candidate.symbol)) continue;
      seen.add(candidate.symbol);
      candidates.push(candidate);
      if (candidates.length === MAX_CANDIDATES) break;
    }
    return deepFreeze({ok: true, type: candidates.length ? 'SUCCESS' : 'NOT_FOUND', candidates});
  }

  const rowsFrom = quotes => quotes.map(screenerRow).filter(Boolean);

  return deepFreeze({
    async acquireMostActive() {
      return mostActiveResult(await fetchScreenerQuotes(YAHOO_MOST_ACTIVE_URL));
    },
    // Step 9W Build A: the same single Most Active fetch (same URL, same
    // candidates), plus its rows with size and move for the spotlight.
    async acquireMostActiveWithRows() {
      const page = await fetchScreenerQuotes(YAHOO_MOST_ACTIVE_URL);
      return {result: mostActiveResult(page), rows: page.ok ? rowsFrom(page.quotes) : []};
    },
    // Step 9W Build A: one spotlight screener (day_gainers or day_losers),
    // screenerCount rows. {ok, type, rows}; never throws.
    async acquireScreenerRows(scrId) {
      if (!SPOTLIGHT_SCREENERS.includes(scrId)) return failure('INVALID_REQUEST', 'Unknown screener');
      try {
        const page = await fetchScreenerQuotes(screenerUrl(scrId, settingValue('screenerCount')));
        if (!page.ok) return page;
        return deepFreeze({ok: true, type: 'SUCCESS', rows: rowsFrom(page.quotes)});
      } catch (error) {
        return failure('RETRIEVAL_FAILURE', 'Yahoo screener could not be retrieved');
      }
    },
    // Step 9W Build A: the anchor price checks, in parallel, through the
    // telemetry chart fetch. A failed check is left out silently.
    async acquireAnchorQuotes(symbols) {
      const settled = await Promise.allSettled((Array.isArray(symbols) ? symbols : []).map(symbol =>
        fetchAnchorChartMove({fetchImpl, symbol, timeoutMs})));
      return settled.filter(entry => entry.status === 'fulfilled' && entry.value)
        .map(entry => entry.value);
    }
  });
}

module.exports = {
  YAHOO_MOST_ACTIVE_URL,
  YAHOO_MOST_ACTIVE_DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  YAHOO_MOST_ACTIVE_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  YAHOO_MOST_ACTIVE_MAX_CANDIDATES: MAX_CANDIDATES,
  createYahooMostActiveAcquisitionService
};

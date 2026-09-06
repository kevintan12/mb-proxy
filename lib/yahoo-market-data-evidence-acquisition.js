const {createEvidenceItem} = require('./evidence-items');
const {createEvidenceCollection} = require('./evidence-collections');

const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_QUOTE_BASE_URL = 'https://finance.yahoo.com/quote/';
const DEFAULT_TIMEOUT_MS = 4000;
const YAHOO_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
});

class YahooMarketDataEvidenceAcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'YahooMarketDataEvidenceAcquisitionError';
    this.code = code;
  }
}

function fail(code, message) {
  return new YahooMarketDataEvidenceAcquisitionError(code, message);
}

function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!symbol || symbol.endsWith('.SI') || symbol.endsWith('.HK') || symbol === '^STI' || symbol === '^HSI') {
    throw fail('INVALID_INPUT', 'A valid US symbol is required');
  }
  return symbol;
}

function validEpochSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const instant = new Date(value * 1000);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function normalizeYahooResult(data, requestedSymbol) {
  const result = data && data.chart && Array.isArray(data.chart.result) && data.chart.result[0];
  const meta = result && result.meta;
  if (!meta || typeof meta !== 'object') {
    throw fail('INVALID_RESPONSE', 'Yahoo chart response is malformed');
  }

  const providerSymbol = typeof meta.symbol === 'string' ? meta.symbol.trim().toUpperCase() : '';
  if (!providerSymbol || providerSymbol !== requestedSymbol) {
    throw fail('INVALID_RESPONSE', 'Yahoo chart response symbol does not match the request');
  }
  if (!Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0) {
    throw fail('INVALID_RESPONSE', 'Yahoo chart response lacks a valid regular market price');
  }
  const publishedAt = validEpochSeconds(meta.regularMarketTime);
  if (!publishedAt) {
    throw fail('INVALID_RESPONSE', 'Yahoo chart response lacks a valid regular market timestamp');
  }

  const longName = typeof meta.longName === 'string' ? meta.longName.trim() : '';
  const shortName = typeof meta.shortName === 'string' ? meta.shortName.trim() : '';
  const instrumentName = longName || shortName || requestedSymbol;
  const currency = typeof meta.currency === 'string' ? meta.currency.trim().toUpperCase() : '';
  const priceText = String(meta.regularMarketPrice);

  return {
    title: `${instrumentName} market data`,
    summary: `${instrumentName} regular market price was ${priceText}${currency ? ` ${currency}` : ''} as of ${publishedAt}.`,
    publishedAt
  };
}

function createYahooMarketDataEvidenceAcquisitionService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');

  return Object.freeze({
    async acquireEvidence({symbol} = {}) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const url = `${YAHOO_CHART_BASE_URL}${encodeURIComponent(normalizedSymbol)}?interval=1d&range=10d`;

      let data;
      try {
        let response;
        try {
          response = await fetchImpl(url, {headers: YAHOO_HEADERS, signal: controller.signal});
        } catch (error) {
          if (controller.signal.aborted || (error && error.name === 'AbortError')) {
            throw fail('TIMEOUT', 'Yahoo chart request timed out');
          }
          throw fail('NETWORK_FAILURE', 'Yahoo chart request failed');
        }

        if (!response || !response.ok) {
          throw fail('HTTP_FAILURE', `Yahoo chart request returned HTTP ${response && Number.isInteger(response.status) ? response.status : 'unknown'}`);
        }

        try {
          data = await response.json();
        } catch (error) {
          if (controller.signal.aborted || (error && error.name === 'AbortError')) {
            throw fail('TIMEOUT', 'Yahoo chart request timed out');
          }
          throw fail('INVALID_RESPONSE', 'Yahoo chart response is not valid JSON');
        }
      } finally {
        clearTimeout(timeout);
      }

      const normalized = normalizeYahooResult(data, normalizedSymbol);
      const item = createEvidenceItem({
        sourceId: 'us.yahoo-finance',
        market: 'US',
        evidenceCategory: 'market-data',
        title: normalized.title,
        summary: normalized.summary,
        canonicalUrl: `${YAHOO_QUOTE_BASE_URL}${encodeURIComponent(normalizedSymbol)}/`,
        publishedAt: normalized.publishedAt,
        symbols: [normalizedSymbol]
      });
      return createEvidenceCollection({market: 'US', items: [item]});
    }
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  YahooMarketDataEvidenceAcquisitionError,
  createYahooMarketDataEvidenceAcquisitionService
};

const {MARKETS} = require('./evidence-sources');
const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createThreeSessionSnapshot
} = require('./three-session-snapshot');
const {getSessionContext: defaultGetSessionContext} = require('./market-session-calendar');

const INPUT_KEYS = Object.freeze(['market', 'symbol']);
const YAHOO_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
});

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && expectedKeys.every(key => keys.includes(key));
}

function marketForSymbol(symbol) {
  if (symbol.endsWith('.SI') || symbol === '^STI') return 'SG';
  if (symbol.endsWith('.HK') || symbol === '^HSI') return 'HK';
  return 'US';
}

function normalizeInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) throw new TypeError('Invalid Yahoo telemetry acquisition input');
  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!MARKETS.includes(market) || !symbol || marketForSymbol(symbol) !== market) {
    throw new TypeError('Invalid market or symbol');
  }
  return {market, symbol};
}

function dateKey(epochSeconds, timezone) {
  if (!Number.isFinite(epochSeconds)) return null;
  try {
    const values = {};
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(epochSeconds * 1000));
    for (const part of parts) values[part.type] = part.value;
    return values.year && values.month && values.day
      ? `${values.year.padStart(4, '0')}-${values.month}-${values.day}`
      : null;
  } catch (error) {
    return null;
  }
}

function shiftDate(exchangeDate, days) {
  const [year, month, day] = exchangeDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validPositive(value) {
  return Number.isFinite(value) && value > 0;
}

function validVolume(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function alignedRows(result, timezone) {
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const opens = Array.isArray(quote && quote.open) ? quote.open : [];
  const highs = Array.isArray(quote && quote.high) ? quote.high : [];
  const lows = Array.isArray(quote && quote.low) ? quote.low : [];
  const closes = Array.isArray(quote && quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote && quote.volume) ? quote.volume : [];
  const byDate = new Map();
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    const exchangeDate = dateKey(timestamp, timezone);
    if (!exchangeDate) continue;
    const row = {
      index,
      timestamp,
      exchangeDate,
      open: opens[index],
      high: highs[index],
      low: lows[index],
      close: closes[index],
      volume: volumes[index]
    };
    row.validClose = validPositive(row.close);
    row.validOhlc = validPositive(row.open) && validPositive(row.high)
      && validPositive(row.low) && row.validClose
      && row.high >= row.low && row.open >= row.low && row.open <= row.high
      && row.close >= row.low && row.close <= row.high;
    byDate.set(exchangeDate, byDate.has(exchangeDate) ? null : row);
  }
  return byDate;
}

function previousTradingDate(market, exchangeDate, getSessionContext) {
  let candidate = exchangeDate;
  for (let count = 0; count < 16; count++) {
    candidate = shiftDate(candidate, -1);
    const context = getSessionContext({market, exchangeDate: candidate});
    if (context.tradingDay) return candidate;
    if (!context.calendarSupported) throw new Error(`Unsupported calendar date: ${candidate}`);
  }
  throw new Error(`Unable to resolve previous trading date before ${exchangeDate}`);
}

function expectedTradingDates(market, currentContext, getSessionContext) {
  let latest = currentContext.tradingDay && currentContext.regularSessionCompleted
    ? currentContext.exchangeDate
    : previousTradingDate(market, currentContext.exchangeDate, getSessionContext);
  const dates = [latest];
  while (dates.length < 10) {
    latest = previousTradingDate(market, latest, getSessionContext);
    dates.push(latest);
  }
  return dates;
}

function createCompletedSessions(market, rows, expectedDates, getSessionContext) {
  const candidates = expectedDates.slice(0, -1).map((exchangeDate, index) => {
    const row = rows.get(exchangeDate);
    const previousRow = rows.get(expectedDates[index + 1]);
    const sessionContext = getSessionContext({market, exchangeDate});
    return sessionContext.calendarSupported && sessionContext.tradingDay
      && sessionContext.regularCloseTime && row && row.validOhlc
      && previousRow && previousRow.validClose
      ? {row, previousRow, sessionContext}
      : null;
  });
  const first = candidates.findIndex(Boolean);
  if (first === -1) return [];
  const selected = [];
  const limit = first === 0 ? 3 : 2;
  for (let index = first; index < candidates.length && selected.length < limit; index++) {
    if (!candidates[index]) break;
    selected.push(candidates[index]);
  }
  return selected.reverse().map(({row, previousRow, sessionContext}) => {
    return createCompletedRegularSession({
      market,
      sessionDate: row.exchangeDate,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      previousClose: previousRow.close,
      volume: validVolume(row.volume),
      asOf: sessionContext.regularCloseTime,
      sourceId: `${market.toLowerCase()}.yahoo-finance`,
      validationState: 'VALIDATED'
    });
  });
}

function overlayFact(market, session, meta) {
  if (market === 'US' && session === 'PRE') {
    return {price: meta.preMarketPrice, time: meta.preMarketTime, volume: meta.preMarketVolume};
  }
  if (session === 'REGULAR' || ((market === 'SG' || market === 'HK') && session === 'LUNCH')) {
    return {price: meta.regularMarketPrice, time: meta.regularMarketTime, volume: meta.regularMarketVolume};
  }
  if (market === 'US' && session === 'POST') {
    return {price: meta.postMarketPrice, time: meta.postMarketTime, volume: meta.postMarketVolume};
  }
  return null;
}

function createOverlay(market, currentContext, meta, completedSessions, expectedLatestDate, nowSeconds) {
  const fact = overlayFact(market, currentContext.session, meta);
  const latest = completedSessions[completedSessions.length - 1];
  const observationStart = currentContext.session === 'LUNCH'
    ? currentContext.regularOpenTime : currentContext.sessionStartTime;
  if (!fact || !latest || latest.sessionDate !== expectedLatestDate
      || !validPositive(fact.price) || !Number.isFinite(fact.time)
      || fact.time > nowSeconds
      || !observationStart || fact.time * 1000 < Date.parse(observationStart)
      || dateKey(fact.time, currentContext.exchangeTimezone) !== currentContext.exchangeDate) return null;
  return createCurrentSessionOverlay({
    market,
    marketState: currentContext.session,
    sessionDate: currentContext.exchangeDate,
    asOf: new Date(fact.time * 1000).toISOString(),
    lastPrice: fact.price,
    referenceClose: latest.close,
    volume: validVolume(fact.volume),
    sourceId: `${market.toLowerCase()}.yahoo-finance`,
    validationState: 'VALIDATED'
  });
}

function createYahooTelemetryAcquisitionService({
  fetchImpl = global.fetch,
  now = () => new Date(),
  getSessionContext = defaultGetSessionContext
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof getSessionContext !== 'function') throw new TypeError('getSessionContext must be a function');

  return Object.freeze({
    async acquireSnapshot(input) {
      const {market, symbol} = normalizeInput(input);
      const instant = new Date(now());
      if (!Number.isFinite(instant.getTime())) throw new TypeError('now returned an invalid instant');
      const currentContext = getSessionContext({market, instant});
      if (!currentContext.calendarSupported) {
        throw new Error(`Unsupported calendar date: ${currentContext.exchangeDate}`);
      }
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10d`;
      const response = await fetchImpl(url, {headers: YAHOO_HEADERS});
      if (!response || !response.ok) throw new Error(`Yahoo chart request failed${response ? `: HTTP ${response.status}` : ''}`);
      const data = await response.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      if (!result || !result.meta || !result.indicators || !result.indicators.quote) {
        throw new Error('Yahoo chart response is malformed');
      }
      const timezone = MARKET_TIME_ZONES[market];
      const rows = alignedRows(result, timezone);
      const expectedDates = expectedTradingDates(market, currentContext, getSessionContext);
      const completedSessions = createCompletedSessions(market, rows, expectedDates, getSessionContext);
      const currentOverlay = createOverlay(
        market,
        currentContext,
        result.meta,
        completedSessions,
        expectedDates[0],
        instant.getTime() / 1000
      );
      const instrumentName = typeof result.meta.longName === 'string' && result.meta.longName.trim()
        ? result.meta.longName : typeof result.meta.shortName === 'string' && result.meta.shortName.trim()
          ? result.meta.shortName : symbol;
      const instrumentType = typeof result.meta.instrumentType === 'string' && result.meta.instrumentType.trim()
        ? result.meta.instrumentType : typeof result.meta.quoteType === 'string' && result.meta.quoteType.trim()
          ? result.meta.quoteType : null;
      if (!instrumentType) throw new Error('Yahoo chart response lacks instrument type');
      const currency = typeof result.meta.currency === 'string' && result.meta.currency.trim()
        ? result.meta.currency : null;
      return createThreeSessionSnapshot({
        market,
        symbol,
        instrumentName,
        instrumentType,
        currency,
        marketState: currentContext.session,
        completedSessions,
        currentOverlay
      });
    }
  });
}

module.exports = {
  createYahooTelemetryAcquisitionService
};

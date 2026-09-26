const {MARKETS} = require('./evidence-sources');
const {MARKET_TIME_ZONES} = require('./completed-session-telemetry');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('./five-session-snapshot');
const {getSessionContext: defaultGetSessionContext} = require('./market-session-calendar');

const INPUT_KEYS = Object.freeze(['market', 'symbol']);
const INTRADAY_INTERVAL_MS = 60 * 1000;
const MAX_INTRADAY_RESPONSE_BYTES = 128 * 1024;
const MAX_INTRADAY_POINTS = 500;
const INTRADAY_TIMEOUT_MS = 8000;
// D-006: real Yahoo daily rows differ from reconciled intraday values by small amounts
// (daily open = opening auction, minute bar = first trade). Tolerance is one-sided per
// field: open uses relative distance; high/low only reject when the daily value would
// narrow the reconciled range beyond this margin.
const DAILY_INTRADAY_TOLERANCE = 0.001;
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

function updateRowValidity(row) {
  row.validClose = validPositive(row.close);
  row.validOhlc = validPositive(row.open) && validPositive(row.high)
    && validPositive(row.low) && row.validClose
    && row.high >= row.low && row.open >= row.low && row.open <= row.high
    && row.close >= row.low && row.close <= row.high;
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
    updateRowValidity(row);
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

function countRowsByDate(timestamps, timezone, expectedDates) {
  const counts = new Map(expectedDates.map(date => [date, 0]));
  if (!Array.isArray(timestamps)) return counts;
  for (const timestamp of timestamps) {
    const date = dateKey(timestamp, timezone);
    if (counts.has(date)) counts.set(date, Math.min(21, counts.get(date) + 1));
  }
  return counts;
}

async function readBoundedText(response, signal) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_INTRADAY_RESPONSE_BYTES) return null;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      if (signal?.aborted) return null;
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INTRADAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  }
  if (typeof response.text !== 'function') return null;
  const text = await response.text();
  return typeof text === 'string'
      && Buffer.byteLength(text, 'utf8') <= MAX_INTRADAY_RESPONSE_BYTES
    ? text : null;
}

function validOhlcBar(open, high, low, close) {
  return validPositive(open) && validPositive(high) && validPositive(low) && validPositive(close)
    && high >= low && open >= low && open <= high && close >= low && close <= high;
}

// A no-trade minute (thinly traded symbol) reports every field as null. It still
// occupies a place in the 390-minute grid, but contributes nothing to high/low/open.
function isNoTradeBar(open, high, low, close) {
  return open === null && high === null && low === null && close === null;
}

// D-006: Yahoo's real 1m response for a completed session is 391 bars: 390 regular
// minutes plus one terminal "closing print" bar stamped exactly at the close, with
// O=H=L=C equal to the official close. The old 390-bar assumption rejected that bar
// (OUTSIDE_EXPECTED_SESSION) and used the 15:59 bar's close instead of the official one.
function normalizeIntradaySession(result, {expectedSessionDate, timezone, sessionContext}) {
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  const opens = quote?.open;
  const highs = quote?.high;
  const lows = quote?.low;
  const closes = quote?.close;
  if (!Array.isArray(timestamps) || timestamps.length === 0
      || timestamps.length > MAX_INTRADAY_POINTS
      || ![opens, highs, lows, closes].every(values => Array.isArray(values)
        && values.length === timestamps.length)) {
    return {session: null, rejectionCategory: 'INVALID_INTRADAY_SHAPE'};
  }

  const openMs = Date.parse(sessionContext.regularOpenTime);
  const closeMs = Date.parse(sessionContext.regularCloseTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)
      || closeMs <= openMs || (closeMs - openMs) % INTRADAY_INTERVAL_MS !== 0) {
    return {session: null, rejectionCategory: 'INVALID_SESSION_WINDOW'};
  }

  const tradedBars = [];
  const gridTimestamps = [];
  let closingPrint = null;
  let openingBarOpen = null;
  let previousTimestamp = null;
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    if (!Number.isFinite(timestamp) || (previousTimestamp !== null && timestamp <= previousTimestamp)) {
      return {session: null, rejectionCategory: 'INVALID_TIMESTAMP_SEQUENCE'};
    }
    previousTimestamp = timestamp;
    const ms = timestamp * 1000;
    const bar = {open: opens[index], high: highs[index], low: lows[index], close: closes[index]};
    if (dateKey(timestamp, timezone) !== expectedSessionDate || ms < openMs || ms > closeMs) {
      return {session: null, rejectionCategory: 'OUTSIDE_EXPECTED_SESSION'};
    }
    if (ms === closeMs) {
      // The one accepted closing print. Any bar strictly after it is caught above
      // (its timestamp must exceed closeMs, since timestamps strictly increase).
      if (!validOhlcBar(bar.open, bar.high, bar.low, bar.close)) {
        return {session: null, rejectionCategory: 'INVALID_INTRADAY_OHLC'};
      }
      closingPrint = bar;
      continue;
    }
    const isOpeningBar = ms === openMs;
    if (isNoTradeBar(bar.open, bar.high, bar.low, bar.close)) {
      if (isOpeningBar) {
        return {session: null, rejectionCategory: 'INVALID_INTRADAY_OHLC'};
      }
      gridTimestamps.push(timestamp);
      continue;
    }
    if (!validOhlcBar(bar.open, bar.high, bar.low, bar.close)) {
      return {session: null, rejectionCategory: 'INVALID_INTRADAY_OHLC'};
    }
    if (isOpeningBar) openingBarOpen = bar.open;
    tradedBars.push(bar);
    gridTimestamps.push(timestamp);
  }

  if (!closingPrint) {
    return {session: null, rejectionCategory: 'MISSING_FINAL_REGULAR_OBSERVATION'};
  }
  const expectedCount = (closeMs - openMs) / INTRADAY_INTERVAL_MS;
  if (gridTimestamps.length !== expectedCount) {
    return {session: null, rejectionCategory: 'INCOMPLETE_SESSION_COVERAGE'};
  }
  for (let index = 0; index < gridTimestamps.length; index++) {
    if (gridTimestamps[index] * 1000 !== openMs + index * INTRADAY_INTERVAL_MS) {
      return {session: null, rejectionCategory: 'INCOMPLETE_SESSION_COVERAGE'};
    }
  }
  if (openingBarOpen === null) {
    return {session: null, rejectionCategory: 'INVALID_INTRADAY_OHLC'};
  }

  return {
    session: {
      open: openingBarOpen,
      high: Math.max(closingPrint.high, ...tradedBars.map(bar => bar.high)),
      low: Math.min(closingPrint.low, ...tradedBars.map(bar => bar.low)),
      close: closingPrint.close
    },
    rejectionCategory: null
  };
}

// D-006: shared by the expected-date and preceding-date recovery paths so they cannot
// drift apart. A present daily open/high/low is kept only if positive and within
// DAILY_INTRADAY_TOLERANCE of the reconciled intraday session; a missing one is filled
// from intraday. Close always comes from the intraday closing print.
function reconcileDailyWithIntraday(dailyRow, intraday) {
  let rejected = dailyRow?.close !== null && dailyRow?.close !== undefined
    && !validPositive(dailyRow.close);
  const candidate = {open: dailyRow?.open, high: dailyRow?.high, low: dailyRow?.low, close: intraday.close};
  if (candidate.open === null || candidate.open === undefined) {
    candidate.open = intraday.open;
  } else if (!validPositive(candidate.open)
      || Math.abs(candidate.open - intraday.open) > DAILY_INTRADAY_TOLERANCE * intraday.open) {
    rejected = true;
  }
  if (candidate.high === null || candidate.high === undefined) {
    candidate.high = intraday.high;
  } else if (!validPositive(candidate.high)
      || candidate.high < intraday.high * (1 - DAILY_INTRADAY_TOLERANCE)) {
    rejected = true;
  }
  if (candidate.low === null || candidate.low === undefined) {
    candidate.low = intraday.low;
  } else if (!validPositive(candidate.low)
      || candidate.low > intraday.low * (1 + DAILY_INTRADAY_TOLERANCE)) {
    rejected = true;
  }
  if (rejected) return {ohlc: null, rejectionCategory: 'DAILY_INTRADAY_OHLC_CONFLICT'};
  if (!validOhlcBar(candidate.open, candidate.high, candidate.low, candidate.close)) {
    return {ohlc: null, rejectionCategory: 'INVALID_RECONSTRUCTED_OHLC'};
  }
  return {ohlc: candidate, rejectionCategory: null};
}

async function acquireIntradaySession({fetchImpl, symbol, expectedSessionDate, timezone, sessionContext}) {
  const openMs = Date.parse(sessionContext.regularOpenTime);
  const closeMs = Date.parse(sessionContext.regularCloseTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
    return {session: null, rejectionCategory: 'INVALID_SESSION_WINDOW'};
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${Math.floor(openMs / 1000)}&period2=${Math.floor(closeMs / 1000)}&interval=1m`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), INTRADAY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: YAHOO_HEADERS,
      ...(controller ? {signal: controller.signal} : {})
    });
    if (!response?.ok) return {session: null, rejectionCategory: 'HTTP_FAILURE'};
    const text = await readBoundedText(response, controller?.signal);
    if (text === null) return {session: null, rejectionCategory: 'RESPONSE_READ_OR_SIZE_FAILURE'};
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return {session: null, rejectionCategory: 'MALFORMED_JSON'};
    }
    const result = data?.chart?.result?.[0];
    if (!result) return {session: null, rejectionCategory: 'MALFORMED_RESPONSE'};
    return normalizeIntradaySession(result, {expectedSessionDate, timezone, sessionContext});
  } catch (error) {
    return {session: null, rejectionCategory: 'NETWORK_FAILURE'};
  } finally {
    clearTimeout(timeout);
  }
}

async function applyLatestCompletedCloseFallback({
  market,
  rows,
  symbol,
  expectedSessionDate,
  timezone,
  acquiredAt,
  getSessionContext,
  fetchImpl,
  onDiagnostics
}) {
  if (market !== 'US') return;
  const row = rows.get(expectedSessionDate);
  const matchingRows = rows.expectedDateCounts?.get(expectedSessionDate) || (row ? 1 : 0);
  const precedingDate = rows.expectedPrecedingDate || null;
  const precedingMatchingRows = precedingDate
    ? (rows.expectedDateCounts?.get(precedingDate) || 0) : 0;
  const precedingRow = precedingDate ? rows.get(precedingDate) : null;
  const expectedDailyCloseValid = row?.validClose === true;
  const expectedDailyOhlcValid = row?.validOhlc === true;
  let guardReason = null;
  let attempted = false;
  let attemptResult = null;
  let rejectionCategory = null;
  let precedingGuardReason = null;
  let precedingAttempted = false;
  let precedingAttemptResult = null;
  let precedingRejectionCategory = null;
  let recoveredPrecedingClose = null;

  if (!row) guardReason = matchingRows > 1 ? 'DUPLICATE_EXPECTED_ROW' : 'EXPECTED_ROW_MISSING';
  else if (row.close !== null && row.close !== undefined) guardReason = 'EXPECTED_CLOSE_PRESENT';
  let sessionContext = null;
  if (!guardReason) {
    sessionContext = getSessionContext({market, exchangeDate: expectedSessionDate});
    if (!sessionContext.calendarSupported) guardReason = 'CALENDAR_UNSUPPORTED';
    else if (!sessionContext.tradingDay) guardReason = 'EXPECTED_DATE_NOT_TRADING_DAY';
    else if (!sessionContext.regularOpenTime || !sessionContext.regularCloseTime) {
      guardReason = 'SESSION_TIME_UNAVAILABLE';
    } else if (Date.parse(sessionContext.regularCloseTime) > acquiredAt.getTime()) {
      guardReason = 'EXPECTED_SESSION_NOT_CLOSED';
    }
  }

  // A valid newest daily bar still needs the immediately preceding session's
  // close to construct previousClose. Recover that dependency independently;
  // keep it separate from the daily row so intraday data cannot promote that
  // row into completed-session history.
  if (row?.validOhlc === true && precedingRow?.validClose !== true) {
    if (precedingMatchingRows > 1) precedingGuardReason = 'DUPLICATE_PRECEDING_ROW';
    let precedingContext = null;
    if (!precedingGuardReason) {
      precedingContext = getSessionContext({market, exchangeDate: precedingDate});
      if (!precedingContext.calendarSupported) precedingGuardReason = 'CALENDAR_UNSUPPORTED';
      else if (!precedingContext.tradingDay) precedingGuardReason = 'PRECEDING_DATE_NOT_TRADING_DAY';
      else if (!precedingContext.regularOpenTime || !precedingContext.regularCloseTime) {
        precedingGuardReason = 'SESSION_TIME_UNAVAILABLE';
      } else if (Date.parse(precedingContext.regularCloseTime) > acquiredAt.getTime()) {
        precedingGuardReason = 'PRECEDING_SESSION_NOT_CLOSED';
      }
    }
    if (!precedingGuardReason) {
      precedingAttempted = true;
      const intradayResult = await acquireIntradaySession({
        fetchImpl, symbol, expectedSessionDate: precedingDate, timezone,
        sessionContext: precedingContext
      });
      precedingRejectionCategory = intradayResult.rejectionCategory;
      const intraday = intradayResult.session;
      if (!intraday || !validPositive(intraday.close)) {
        precedingAttemptResult = 'FAILURE';
      } else {
        const {ohlc, rejectionCategory: mergeRejectionCategory} =
          reconcileDailyWithIntraday(precedingRow, intraday);
        if (!ohlc) {
          precedingRejectionCategory = mergeRejectionCategory;
          precedingAttemptResult = 'FAILURE';
        } else {
          recoveredPrecedingClose = ohlc.close;
          precedingAttemptResult = 'SUCCESS';
          precedingRejectionCategory = null;
        }
      }
    }
  } else if (row?.validOhlc !== true) {
    precedingGuardReason = 'EXPECTED_ROW_NOT_VALID_OHLC';
  } else {
    precedingGuardReason = 'PRECEDING_CLOSE_PRESENT';
  }
  if (!guardReason) {
    attempted = true;
    const intradayResult = await acquireIntradaySession({
      fetchImpl, symbol, expectedSessionDate, timezone, sessionContext
    });
    rejectionCategory = intradayResult.rejectionCategory;
    if (!intradayResult.session || !validPositive(intradayResult.session.close)) {
      attemptResult = 'FAILURE';
    } else {
      const {ohlc, rejectionCategory: mergeRejectionCategory} =
        reconcileDailyWithIntraday(row, intradayResult.session);
      if (!ohlc) {
        rejectionCategory = mergeRejectionCategory;
        attemptResult = 'FAILURE';
      } else {
        row.open = ohlc.open;
        row.high = ohlc.high;
        row.low = ohlc.low;
        row.close = ohlc.close;
        updateRowValidity(row);
        attemptResult = 'SUCCESS';
      }
    }
  }

  if (typeof onDiagnostics === 'function') {
    try {
      onDiagnostics(Object.freeze({
        stage: 'yahooCompletedSessionRecovery',
        symbol,
        expectedCompletedDate: expectedSessionDate,
        expectedDailyRowExists: matchingRows > 0,
        expectedDailyRowDuplicateCount: Math.min(20, Math.max(0, matchingRows - 1)),
        expectedDailyCloseValid,
        expectedDailyOhlcValid,
        precedingExpectedDate: precedingDate,
        precedingDailyRowExists: precedingMatchingRows > 0,
        precedingDailyCloseValid: precedingRow?.validClose === true,
        precedingDailyOhlcValid: precedingRow?.validOhlc === true,
        intradayRecoveryAttempted: attempted,
        ...(guardReason ? {intradayRecoveryGuardReason: guardReason} : {}),
        ...(attempted ? {intradayRecoveryResult: attemptResult,
          ...(rejectionCategory ? {intradayRecoveryRejectionCategory: rejectionCategory} : {})} : {}),
        precedingIntradayRecoveryAttempted: precedingAttempted,
        ...(precedingGuardReason
          ? {precedingIntradayRecoveryGuardReason: precedingGuardReason} : {}),
        ...(precedingAttempted ? {
          precedingIntradayRecoveryResult: precedingAttemptResult,
          ...(precedingRejectionCategory
            ? {precedingIntradayRecoveryRejectionCategory: precedingRejectionCategory} : {})
        } : {})
      }));
    } catch (error) {
      // Diagnostics must not affect acquisition.
    }
  }
  return recoveredPrecedingClose === null
    ? null : Object.freeze({sessionDate: precedingDate, close: recoveredPrecedingClose});
}

function createCompletedSessions(market, rows, expectedDates, getSessionContext,
  recoveredPreviousClose = null) {
  const candidates = expectedDates.slice(0, -1).map((exchangeDate, index) => {
    const row = rows.get(exchangeDate);
    const previousRow = rows.get(expectedDates[index + 1]);
    const recovered = recoveredPreviousClose?.sessionDate === expectedDates[index + 1]
      ? recoveredPreviousClose.close : null;
    const previousClose = previousRow?.validClose === true ? previousRow.close : recovered;
    const sessionContext = getSessionContext({market, exchangeDate});
    return sessionContext.calendarSupported && sessionContext.tradingDay
      && sessionContext.regularCloseTime && row && row.validOhlc
      && validPositive(previousClose)
      ? {row, previousClose, sessionContext}
      : null;
  });
  const first = candidates.findIndex(Boolean);
  if (first === -1) return [];
  const selected = [];
  const limit = first === 0 ? 5 : 4;
  for (let index = first; index < candidates.length && selected.length < limit; index++) {
    if (!candidates[index]) break;
    selected.push(candidates[index]);
  }
  return selected.reverse().map(({row, previousClose, sessionContext}) => {
    return createCompletedRegularSession({
      market,
      sessionDate: row.exchangeDate,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      previousClose,
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
  getSessionContext = defaultGetSessionContext,
  onDiagnostics
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
      rows.expectedDateCounts = countRowsByDate(result.timestamp, timezone, expectedDates.slice(0, 2));
      rows.expectedPrecedingDate = expectedDates[1];
      const recoveredPrecedingClose = await applyLatestCompletedCloseFallback({
        market,
        rows,
        symbol,
        expectedSessionDate: expectedDates[0],
        timezone,
        acquiredAt: instant,
        getSessionContext,
        fetchImpl,
        onDiagnostics
      });
      const completedSessions = createCompletedSessions(
        market, rows, expectedDates, getSessionContext, recoveredPrecedingClose
      );
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
      return createFiveSessionSnapshot({
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

const QUOTE_CACHE_TTL_MS = 1500;
const QUOTE_CACHE_MAX_ENTRIES = 100;
const quoteCache = new Map();

function pruneQuoteCache(now) {
  for (const [key, entry] of quoteCache) {
    if (now - entry.cachedAt >= QUOTE_CACHE_TTL_MS) quoteCache.delete(key);
  }
  while (quoteCache.size >= QUOTE_CACHE_MAX_ENTRIES) {
    quoteCache.delete(quoteCache.keys().next().value);
  }
}

function exchangeDateKey(epochSeconds, timeZone) {
  if (!Number.isFinite(epochSeconds) || !timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(epochSeconds * 1000));
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    return `${values.year}-${values.month}-${values.day}`;
  } catch(e) {
    return null;
  }
}

function previousWeekdayDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return null;
  const date = new Date(`${dateKey}T00:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

function isCompletedDailyObservation(timestamp, meta, nowSeconds) {
  if (!Number.isFinite(timestamp)) return false;
  const timeZone = meta.exchangeTimezoneName;
  const observationDate = exchangeDateKey(timestamp, timeZone);
  const currentDate = exchangeDateKey(nowSeconds, timeZone);
  if (!observationDate || !currentDate) return false;
  if (observationDate < currentDate) return true;
  if (observationDate > currentDate) return false;

  const regularEnd = meta.currentTradingPeriod?.regular?.end;
  return Number.isFinite(regularEnd)
    && exchangeDateKey(regularEnd, timeZone) === currentDate
    && nowSeconds >= regularEnd;
}

function getVerifiedDailyObservation(data, expectedDate, meta, nowSeconds) {
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const timestamp = timestamps[i];
    const close = closes[i];
    if (exchangeDateKey(timestamp, meta.exchangeTimezoneName) === expectedDate
        && isCompletedDailyObservation(timestamp, meta, nowSeconds)
        && Number.isFinite(close) && close > 0) {
      return { close, time: timestamp };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol, search, financials, finnhub } = req.query;
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  // ── Claude proxy endpoint (POST ?claude=1) ────────────────────────────────
  if (req.method === 'POST' && req.query.claude) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(403).json({ error: 'Claude API key not configured' });
    try {
      // Vercel parses req.body automatically — use it directly
      const body = req.body || {};
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      // Stream response back to client
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // ── Finnhub proxy endpoint (?finnhub=1&symbol=MSFT) ──────────────────────
  if (finnhub && symbol) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.status(403).json({ error: 'Finnhub API key not configured' });
    let sym = symbol;
    try { sym = decodeURIComponent(sym); } catch(e) {}
    try {
      const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${apiKey}`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Search endpoint ───────────────────────────────────────────────────────
  if (search) {
    try {
      const q = decodeURIComponent(search);
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error('Yahoo search HTTP ' + r.status);
      const data = await r.json();
      const quotes = (data.quotes || [])
        .filter(q => q.symbol && q.quoteType !== 'OPTION')
        .slice(0, 8)
        .map(q => ({ symbol: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchange || '', type: q.quoteType || '' }));
      return res.status(200).json({ results: quotes });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Financials endpoint (?financials=1&symbol=MSFT) ───────────────────────
  if (financials && symbol) {
    let sym = symbol;
    try { sym = decodeURIComponent(sym); } catch(e) {}
    try {
      const modules = 'incomeStatementHistory,cashflowStatementHistory,balanceSheetHistory,defaultKeyStatistics,financialData';
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const result = data?.quoteSummary?.result?.[0];
      if (!result) throw new Error('No data');
      const ks  = result.defaultKeyStatistics || {};
      const fd  = result.financialData || {};
      const ish = result.incomeStatementHistory?.incomeStatementHistory || [];
      const cfh = result.cashflowStatementHistory?.cashflowStatements || [];
      const trailingEps = ks.trailingEps?.raw || null;
      const epsHistory = ish.map(s => s.basicEPS?.raw || s.dilutedEPS?.raw || null).filter(v => v !== null && v > 0);
      const fcf = cfh[0]?.freeCashflow?.raw || null;
      const sharesOut = ks.sharesOutstanding?.raw || ks.impliedSharesOutstanding?.raw || null;
      const fcfps = (fcf && sharesOut && sharesOut > 0) ? fcf / sharesOut : null;
      const bvps = ks.bookValue?.raw || null;
      const pb   = ks.priceToBook?.raw || null;
      const analystGrowth = fd.earningsGrowth?.raw || fd.revenueGrowth?.raw || null;
      return res.status(200).json({ trailingEps, epsHistory, fcfps, bvps, pb, analystGrowth });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Quote endpoint ────────────────────────────────────────────────────────
  if (!symbol) return res.status(400).json({ error: 'symbol or search required' });
  let sym = symbol;
  try { sym = decodeURIComponent(sym); } catch(e) {}
  const cacheKey = String(sym).toUpperCase();
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.cachedAt < QUOTE_CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.body, symbol: sym });
  }
  if (cached) quoteCache.delete(cacheKey);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data.chart?.result?.[0]) throw new Error('No data');

    const result = data.chart.result[0];
    const meta   = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const vols   = result.indicators?.quote?.[0]?.volume || [];
    const timestamps = result.timestamp || [];

    const dailyObservations = [];
    const completedDailyRows = [];
    const nowSeconds = Date.now() / 1000;
    for (let i = 0; i < closes.length; i++) {
      if (isCompletedDailyObservation(timestamps[i], meta, nowSeconds)) {
        const validClose = Number.isFinite(closes[i]) && closes[i] > 0;
        completedDailyRows.push({ index: i, validClose });
        if (validClose) {
          dailyObservations.push({
            close: closes[i],
            time: timestamps[i],
            index: i
          });
        }
      }
    }
    const latestDailyObservation = dailyObservations.length >= 1
      ? dailyObservations[dailyObservations.length - 1]
      : null;
    const previousDailyObservation = dailyObservations.length >= 2
      ? dailyObservations[dailyObservations.length - 2]
      : null;
    let missingCompletedDailyRow = null;
    if (latestDailyObservation && previousDailyObservation) {
      for (const row of completedDailyRows) {
        if (!row.validClose
            && row.index > previousDailyObservation.index
            && row.index < latestDailyObservation.index) {
          missingCompletedDailyRow = row;
        }
      }
    }
    const dailyClosePairHasGap = !!missingCompletedDailyRow;
    const hasValidRegularMarketPreviousClose = Number.isFinite(meta.regularMarketPreviousClose)
      && meta.regularMarketPreviousClose > 0;
    const shouldVerifyImmediatePreviousClose = dailyClosePairHasGap
      || ((cacheKey === '^HSI' || cacheKey === '^STI') && !hasValidRegularMarketPreviousClose);

    let immediatePreviousClose = null;
    let immediatePreviousCloseTime = null;
    let immediatePreviousCloseSource = null;
    if (shouldVerifyImmediatePreviousClose) {
      try {
        const currentExchangeDate = exchangeDateKey(nowSeconds, meta.exchangeTimezoneName);
        const regularEndDate = exchangeDateKey(
          meta.currentTradingPeriod?.regular?.end,
          meta.exchangeTimezoneName
        );
        const latestDailyDate = exchangeDateKey(
          latestDailyObservation?.time,
          meta.exchangeTimezoneName
        );
        const verificationAnchorDate = regularEndDate === currentExchangeDate
          ? currentExchangeDate
          : latestDailyDate;
        const expectedPreviousDate = missingCompletedDailyRow
          ? exchangeDateKey(timestamps[missingCompletedDailyRow.index], meta.exchangeTimezoneName)
          : previousWeekdayDateKey(verificationAnchorDate);
        if (expectedPreviousDate) {
          const verificationAttempts = [
            { host: 'query1.finance.yahoo.com', source: 'yahooChart5dQuery1' },
            { host: 'query2.finance.yahoo.com', source: 'yahooChart5dQuery2' }
          ];
          for (const attempt of verificationAttempts) {
            try {
              const fallbackUrl = `https://${attempt.host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
              const fallbackResponse = await fetch(fallbackUrl, { headers: HEADERS });
              if (!fallbackResponse.ok) continue;
              const fallbackData = await fallbackResponse.json();
              const verifiedObservation = getVerifiedDailyObservation(
                fallbackData,
                expectedPreviousDate,
                meta,
                nowSeconds
              );
              if (verifiedObservation) {
                immediatePreviousClose = verifiedObservation.close;
                immediatePreviousCloseTime = verifiedObservation.time;
                immediatePreviousCloseSource = attempt.source;
                break;
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    const allCloses = closes.filter(c => c != null && c > 0);
    const validCloses = [];
    for (let i = 0; i < allCloses.length; i++) {
      if (validCloses.length === 0 || allCloses[i] !== validCloses[validCloses.length - 1]) {
        validCloses.push(allCloses[i]);
      }
    }

    let latestChartTimestamp = null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && closes[i] > 0) {
        latestChartTimestamp = timestamps[i] ?? null;
        break;
      }
    }

    const isLive = meta.marketState === 'REGULAR';
    let price, prev, priceSource;

    if (isLive) {
      price = meta.regularMarketPrice;
      priceSource = 'regularMarketPrice';
      prev  = validCloses.length >= 1
        ? validCloses[validCloses.length - 1]
        : meta.regularMarketPreviousClose || meta.chartPreviousClose;
    } else {
      if (validCloses.length >= 2) {
        price = validCloses[validCloses.length - 1];
        priceSource = 'latestDailyClose';
        prev  = validCloses[validCloses.length - 2];
      } else {
        price = meta.regularMarketPrice;
        priceSource = 'regularMarketPrice';
        prev  = meta.regularMarketPreviousClose || meta.chartPreviousClose;
      }
    }

    if (!price) throw new Error('No price');
    if (!prev)  throw new Error('No previous close');

    let volume = isLive ? (meta.regularMarketVolume || 0) : 0;
    if (!volume) {
      for (let i = vols.length - 1; i >= 0; i--) {
        if (vols[i] != null && vols[i] > 0) { volume = vols[i]; break; }
      }
    }

    const change    = parseFloat((price - prev).toFixed(4));
    const changePct = parseFloat(((price - prev) / prev * 100).toFixed(4));

    const responseBody = {
      symbol: sym,
      name:     meta.longName || meta.shortName || sym,
      price, prev, change, changePct,
      high:     meta.regularMarketDayHigh || price,
      low:      meta.regularMarketDayLow  || price,
      volume:   volume || 0,
      currency: meta.currency || '',
      priceSource,
      provider: {
        marketState: meta.marketState ?? null,
        regularMarketPrice: meta.regularMarketPrice ?? null,
        regularMarketPreviousClose: meta.regularMarketPreviousClose ?? null,
        regularMarketTime: meta.regularMarketTime ?? null,
        regularMarketDayHigh: meta.regularMarketDayHigh ?? null,
        regularMarketDayLow: meta.regularMarketDayLow ?? null,
        regularMarketVolume: meta.regularMarketVolume ?? null,
        exchange: meta.exchange ?? null,
        exchangeName: meta.exchangeName ?? null,
        fullExchangeName: meta.fullExchangeName ?? null,
        exchangeTimezoneName: meta.exchangeTimezoneName ?? null,
        quoteType: meta.quoteType ?? null,
        instrumentType: meta.instrumentType ?? null,
        preMarketPrice: meta.preMarketPrice ?? null,
        preMarketChange: meta.preMarketChange ?? null,
        preMarketChangePercent: meta.preMarketChangePercent ?? null,
        preMarketTime: meta.preMarketTime ?? null,
        postMarketPrice: meta.postMarketPrice ?? null,
        postMarketChange: meta.postMarketChange ?? null,
        postMarketChangePercent: meta.postMarketChangePercent ?? null,
        postMarketTime: meta.postMarketTime ?? null,
        latestDailyClose: latestDailyObservation?.close ?? null,
        latestDailyCloseTime: latestDailyObservation?.time ?? null,
        previousDailyClose: previousDailyObservation?.close ?? null,
        previousDailyCloseTime: previousDailyObservation?.time ?? null,
        dailyClosePairHasGap,
        immediatePreviousClose,
        immediatePreviousCloseTime,
        immediatePreviousCloseSource,
        latestChartTimestamp
      }
    };
    pruneQuoteCache(Date.now());
    quoteCache.set(cacheKey, { body: responseBody, cachedAt: Date.now() });
    res.status(200).json(responseBody);
  } catch(e) { res.status(500).json({ error: e.message }); }
};

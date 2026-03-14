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
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        req.on('error', reject);
      });
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      // Stream the response back
      const reader = upstream.body.getReader();
      const flush = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(value);
        }
      };
      await flush();
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

    const allCloses = closes.filter(c => c != null && c > 0);
    const validCloses = [];
    for (let i = 0; i < allCloses.length; i++) {
      if (validCloses.length === 0 || allCloses[i] !== validCloses[validCloses.length - 1]) {
        validCloses.push(allCloses[i]);
      }
    }

    const isLive = meta.marketState === 'REGULAR';
    let price, prev;

    if (isLive) {
      price = meta.regularMarketPrice;
      prev  = validCloses.length >= 1
        ? validCloses[validCloses.length - 1]
        : meta.regularMarketPreviousClose || meta.chartPreviousClose;
    } else {
      if (validCloses.length >= 2) {
        price = validCloses[validCloses.length - 1];
        prev  = validCloses[validCloses.length - 2];
      } else {
        price = meta.regularMarketPrice;
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

    res.status(200).json({
      symbol: sym,
      name:     meta.longName || meta.shortName || sym,
      price, prev, change, changePct,
      high:     meta.regularMarketDayHigh || price,
      low:      meta.regularMarketDayLow  || price,
      volume:   volume || 0,
      currency: meta.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol, search } = req.query;
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  // ── Symbol search endpoint ────────────────────────────────────────────────
  if (search) {
    try {
      const q = decodeURIComponent(search);
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error('Yahoo search HTTP ' + r.status);
      const data = await r.json();
      const quotes = (data.quotes || []).filter(q => q.symbol && q.quoteType !== 'OPTION').slice(0, 8).map(q => ({
        symbol: q.symbol,
        name: q.longname || q.shortname || q.symbol,
        exchange: q.exchange || '',
        type: q.quoteType || ''
      }));
      return res.status(200).json({ results: quotes });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Quote endpoint ────────────────────────────────────────────────────────
  if (!symbol) return res.status(400).json({ error: 'symbol or search required' });
  let sym = symbol;
  try { sym = decodeURIComponent(sym); } catch(e) {}

  try {
    // Use v7/quote — returns regularMarketChange and regularMarketChangePercent directly
    // so we never have to compute change ourselves (avoids prev-close mismatch bugs)
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,longName,shortName,currency`;
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error('Yahoo Finance returned HTTP ' + response.status);
    const data = await response.json();
    const q = data?.quoteResponse?.result?.[0];
    if (!q) throw new Error('No quote data returned');

    const price = q.regularMarketPrice;
    const change = q.regularMarketChange;
    const changePct = q.regularMarketChangePercent;
    const prev = q.regularMarketPreviousClose;
    if (!price) throw new Error('Missing price data');

    // Volume: regularMarketVolume from v7 is reliable
    // For indices (^DJI etc) volume may be 0 — fall back to chart endpoint for volume only
    let volume = q.regularMarketVolume || 0;
    if (volume === 0 && !sym.startsWith('^')) {
      // Attempt chart fallback for volume
      try {
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
        const cr = await fetch(chartUrl, { headers: HEADERS });
        const cd = await cr.json();
        const vols = cd?.chart?.result?.[0]?.indicators?.quote?.[0]?.volume || [];
        for (let i = vols.length - 1; i >= 0; i--) {
          if (vols[i] != null && vols[i] > 0) { volume = vols[i]; break; }
        }
      } catch(_) {}
    }

    res.status(200).json({
      symbol: sym,
      name: q.longName || q.shortName || sym,
      price,
      prev: prev || price,
      change: parseFloat((change || 0).toFixed(4)),
      changePct: parseFloat((changePct || 0).toFixed(4)),
      high: q.regularMarketDayHigh || price,
      low: q.regularMarketDayLow || price,
      volume,
      currency: q.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

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

  // ── Quote endpoint ────────────────────────────────────────────────────────
  if (!symbol) return res.status(400).json({ error: 'symbol or search required' });
  let sym = symbol;
  try { sym = decodeURIComponent(sym); } catch(e) {}

  try {
    // Fetch 5d of daily bars — gives us last session's close as prev, and current price in meta
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data.chart?.result?.[0]) throw new Error('No data');

    const result = data.chart.result[0];
    const meta   = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const vols   = result.indicators?.quote?.[0]?.volume || [];

    const price = meta.regularMarketPrice;
    if (!price) throw new Error('No price');

    // Previous close: use the second-to-last (or last) close bar from the daily series
    // This is the actual last completed session close — more reliable than meta.regularMarketPreviousClose
    // which can be stale or reflect pre/post-market adjusted values
    let prev = null;
    // Collect all non-null closes
    const validCloses = closes.filter(c => c != null && c > 0);
    if (validCloses.length >= 2) {
      // Second to last = prior session's close (last = today's close if session ended, else current partial)
      prev = validCloses[validCloses.length - 2];
    } else if (validCloses.length === 1) {
      prev = validCloses[0];
    } else {
      // Final fallback
      prev = meta.regularMarketPreviousClose || meta.chartPreviousClose;
    }
    if (!prev) throw new Error('No previous close');

    // Volume: regularMarketVolume for live session, last bar otherwise
    let volume = meta.regularMarketVolume || 0;
    if (!volume) {
      for (let i = vols.length - 1; i >= 0; i--) {
        if (vols[i] != null && vols[i] > 0) { volume = vols[i]; break; }
      }
    }

    const change    = parseFloat((price - prev).toFixed(4));
    const changePct = parseFloat(((price - prev) / prev * 100).toFixed(4));

    res.status(200).json({
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      price, prev,
      change, changePct,
      high:     meta.regularMarketDayHigh || price,
      low:      meta.regularMarketDayLow  || price,
      volume:   volume || 0,
      currency: meta.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

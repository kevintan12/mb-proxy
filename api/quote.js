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
    // v8 chart API — no cookie/crumb required, works reliably
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error('Yahoo Finance returned HTTP ' + response.status);
    const data = await response.json();
    if (!data.chart?.result?.[0]) throw new Error('No chart data returned');
    const result = data.chart.result[0];
    const meta = result.meta;

    const price = meta.regularMarketPrice;
    const prev  = meta.regularMarketPreviousClose || meta.chartPreviousClose;
    if (!price || !prev) throw new Error('Missing price data');

    // Use Yahoo's pre-computed change values from meta — never calculate manually
    // These match exactly what Yahoo Finance displays on their site
    const change    = meta.regularMarketChange    ?? parseFloat((price - prev).toFixed(4));
    const changePct = meta.regularMarketChangePercent ?? parseFloat(((price - prev) / prev * 100).toFixed(4));

    // Volume: regularMarketVolume is live; fall back to last bar in quotes array
    let volume = meta.regularMarketVolume || 0;
    if (volume === 0) {
      const vols = result.indicators?.quote?.[0]?.volume || [];
      for (let i = vols.length - 1; i >= 0; i--) {
        if (vols[i] != null && vols[i] > 0) { volume = vols[i]; break; }
      }
    }

    res.status(200).json({
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      price,
      prev,
      change:    parseFloat(change.toFixed(4)),
      changePct: parseFloat(changePct.toFixed(4)),
      high:   meta.regularMarketDayHigh || price,
      low:    meta.regularMarketDayLow  || price,
      volume: volume || 0,
      currency: meta.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

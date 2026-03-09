module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol, search } = req.query;

  // ── Symbol search endpoint ────────────────────────────────────────────────
  if (search) {
    try {
      const q = decodeURIComponent(search);
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
    if (!response.ok) throw new Error('Yahoo Finance returned HTTP ' + response.status);
    const data = await response.json();
    if (!data.chart?.result?.[0]) throw new Error('No chart data returned');
    const meta = data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    if (!price || !prev) throw new Error('Missing price data');
    res.status(200).json({
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      price, prev,
      change: parseFloat((price - prev).toFixed(4)),
      changePct: parseFloat(((price - prev) / prev * 100).toFixed(4)),
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
      currency: meta.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

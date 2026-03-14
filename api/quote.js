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
    // Fetch 5d of daily bars — gives us last session's close and prior close
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data.chart?.result?.[0]) throw new Error('No data');

    const result = data.chart.result[0];
    const meta   = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const vols   = result.indicators?.quote?.[0]?.volume || [];

    // Collect all non-null positive closes from the 5d series
    const validCloses = closes.filter(c => c != null && c > 0);

    // Determine if a live trading session is in progress
    const isLive = meta.marketState === 'REGULAR';

    let price, prev;

    if (isLive) {
      // Live session — real-time price vs last completed session close
      price = meta.regularMarketPrice;
      prev  = validCloses.length >= 2
        ? validCloses[validCloses.length - 2]
        : meta.regularMarketPreviousClose || meta.chartPreviousClose;
    } else {
      // Market closed (weekend, holiday, pre/post-market) —
      // show last completed session close vs the session before it
      // so change always reflects the last trading day's actual move
      price = validCloses.length >= 1
        ? validCloses[validCloses.length - 1]
        : meta.regularMarketPrice;
      prev  = validCloses.length >= 2
        ? validCloses[validCloses.length - 2]
        : meta.regularMarketPreviousClose || meta.chartPreviousClose;
    }

    if (!price) throw new Error('No price');
    if (!prev)  throw new Error('No previous close');

    // Volume: use live volume during session, last completed bar otherwise
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
      price, prev,
      change, changePct,
      high:     meta.regularMarketDayHigh || price,
      low:      meta.regularMarketDayLow  || price,
      volume:   volume || 0,
      currency: meta.currency || ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

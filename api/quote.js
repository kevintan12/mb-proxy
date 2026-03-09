export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Decode in case browser double-encoded
  try { symbol = decodeURIComponent(symbol); } catch(e) {}

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    if (!r.ok) throw new Error('Yahoo returned HTTP ' + r.status);
    const data = await r.json();

    if (!data.chart?.result?.[0]) throw new Error('No data in response');
    const meta = data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose || meta.previousClose;
    if (!price || !prev) throw new Error('Price data missing');

    res.json({
      symbol,
      price,
      prev,
      change:    price - prev,
      changePct: ((price - prev) / prev) * 100,
      high:      meta.regularMarketDayHigh || price,
      low:       meta.regularMarketDayLow  || price,
      currency:  meta.currency  || '',
      name:      meta.longName  || meta.shortName || symbol
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

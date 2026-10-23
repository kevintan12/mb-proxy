// Step 9W Build A (Kevin, 23 Oct 2026): the company spotlight. A short daily
// list of the companies that matter most today, built once here and used
// through the shared reader (lib/source-reader.js) while the Admin switch
// companySpotlightEnabled is on. Pure: no fetches, no clock.
//
// A company enters through a big move against the S&P 500 (signal 1) or the
// number of distinct listed headlines naming it (signal 3), and must meet the
// size floor. Event words (results, earnings, ...) are a ranking booster only
// (lib/article-score.js) and never put a company in the spotlight. Among the
// anchor companies (an Admin reference list), the biggest relative mover(s)
// are guaranteed a place. Companies on My Stocks or the Watchlist are left out
// (Kevin's decision 1): they already have their own points, slots, price line
// and Section 4, so nothing is counted twice.
'use strict';

const {settingValue} = require('./settings-registry');
const {headlineMatchesIdentity, wholeWordPattern} = require('./headline-matching');
const {createEvidenceItem} = require('./evidence-items');

const YAHOO_QUOTE_BASE_URL = 'https://finance.yahoo.com/quote/';

const COMPANY_EVENT_TERMS = Object.freeze([
  'results', 'earnings', 'guidance', 'merger', 'acquisition', 'probe', 'lawsuit', 'deal'
]);
const COMPANY_EVENT_PATTERNS = Object.freeze(COMPANY_EVENT_TERMS.map(term => wholeWordPattern(term)));

const REASON = Object.freeze({
  ANCHOR_GUARANTEED: 'ANCHOR_GUARANTEED',
  BIG_MOVE: 'BIG_MOVE',
  OUTLETS: 'OUTLETS'
});

function hasCompanyEventWord(headline) {
  return typeof headline === 'string' && COMPANY_EVENT_PATTERNS.some(pattern => pattern.test(headline));
}

function spotlightSettings({env = process.env} = {}) {
  return Object.freeze({
    maxCompanies: settingValue('spotlightMaxCompanies', {env}),
    relativeMovePct: settingValue('spotlightRelativeMovePct', {env}),
    minMarketCapUsdBn: settingValue('spotlightMinMarketCapUsdBn', {env}),
    minOutlets: settingValue('spotlightMinOutlets', {env}),
    anchorSymbols: settingValue('spotlightAnchorSymbols', {env}),
    anchorGuaranteed: settingValue('spotlightAnchorGuaranteed', {env})
  });
}

const finiteOrNull = value => (Number.isFinite(value) ? value : null);

// One merged row per symbol. Screener rows: {symbol, shortName, longName,
// price, movePct, marketCapUsdBn, asOf}. Anchor quotes: {symbol, name, price,
// movePct, asOf}. An anchor's own price check supplies its move; a screener
// row supplies the size (and the move for everyone else).
function mergedCompanies(screenerRows, anchorQuotes, anchorSymbols) {
  const bySymbol = new Map();
  for (const row of Array.isArray(screenerRows) ? screenerRows : []) {
    if (!row || typeof row.symbol !== 'string' || bySymbol.has(row.symbol)) continue;
    bySymbol.set(row.symbol, {
      symbol: row.symbol,
      shortName: row.shortName || null,
      longName: row.longName || null,
      price: finiteOrNull(row.price),
      movePct: finiteOrNull(row.movePct),
      marketCapUsdBn: finiteOrNull(row.marketCapUsdBn),
      asOf: row.asOf || null,
      anchor: false
    });
  }
  const anchorSet = new Set(anchorSymbols);
  for (const quote of Array.isArray(anchorQuotes) ? anchorQuotes : []) {
    if (!quote || !anchorSet.has(quote.symbol) || !Number.isFinite(quote.movePct)) continue;
    const existing = bySymbol.get(quote.symbol);
    bySymbol.set(quote.symbol, {
      symbol: quote.symbol,
      shortName: existing?.shortName || quote.name || null,
      longName: existing?.longName || quote.name || null,
      price: finiteOrNull(quote.price),
      movePct: quote.movePct,
      marketCapUsdBn: existing ? existing.marketCapUsdBn : null,
      asOf: quote.asOf || existing?.asOf || null,
      anchor: true
    });
  }
  for (const company of bySymbol.values()) {
    if (anchorSet.has(company.symbol)) company.anchor = true;
  }
  return [...bySymbol.values()];
}

// Distinct listed headlines (trimmed, case-insensitive) naming the company.
function outletCount(company, headlines) {
  const seen = new Set();
  for (const headline of headlines) {
    if (typeof headline !== 'string') continue;
    const key = headline.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    if (headlineMatchesIdentity(headline, company)) seen.add(key);
  }
  return seen.size;
}

const byStrength = (a, b) => {
  const moveA = a.relativeMovePct === null ? -1 : Math.abs(a.relativeMovePct);
  const moveB = b.relativeMovePct === null ? -1 : Math.abs(b.relativeMovePct);
  if (moveA !== moveB) return moveB - moveA;
  if (a.outlets !== b.outlets) return b.outlets - a.outlets;
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
};

// Returns {companies, considered}. `companies` (best first, at most
// maxCompanies): [{symbol, shortName, longName, price, movePct,
// relativeMovePct, marketCapUsdBn, outlets, asOf, anchor, reasons}].
// `sp500MovePct` null skips signal 1 and the anchor guarantee.
function buildSpotlight({
  screenerRows = [],
  anchorQuotes = [],
  sp500MovePct = null,
  poolHeadlines = [],
  listSymbols = [],
  settings = spotlightSettings()
}) {
  const listSet = new Set(listSymbols);
  const spKnown = Number.isFinite(sp500MovePct);
  const rows = mergedCompanies(screenerRows, anchorQuotes, settings.anchorSymbols)
    .filter(company => !listSet.has(company.symbol))
    .map(company => {
      const relativeMovePct = spKnown && company.movePct !== null ? company.movePct - sp500MovePct : null;
      const outlets = outletCount(company, poolHeadlines);
      // Anchors count as meeting the size floor (Kevin's decision 3) unless a
      // screener row gives their size.
      const sizeOk = company.marketCapUsdBn !== null
        ? company.marketCapUsdBn >= settings.minMarketCapUsdBn
        : company.anchor;
      const bigMove = relativeMovePct !== null && Math.abs(relativeMovePct) >= settings.relativeMovePct;
      const manyOutlets = outlets >= settings.minOutlets;
      return {...company, relativeMovePct, outlets, sizeOk, bigMove, manyOutlets};
    });

  const chosen = [];
  const take = (company, reasons) => chosen.push(Object.freeze({
    symbol: company.symbol,
    shortName: company.shortName,
    longName: company.longName,
    price: company.price,
    movePct: company.movePct,
    relativeMovePct: company.relativeMovePct,
    marketCapUsdBn: company.marketCapUsdBn,
    outlets: company.outlets,
    asOf: company.asOf,
    anchor: company.anchor,
    reasons: Object.freeze(reasons)
  }));
  const signalReasons = company => [
    ...(company.bigMove ? [REASON.BIG_MOVE] : []),
    ...(company.manyOutlets ? [REASON.OUTLETS] : [])
  ];

  const guaranteed = rows
    .filter(company => company.anchor && company.relativeMovePct !== null)
    .sort(byStrength)
    .slice(0, Math.min(settings.anchorGuaranteed, settings.maxCompanies));
  const guaranteedSymbols = new Set(guaranteed.map(company => company.symbol));
  for (const company of guaranteed) take(company, [REASON.ANCHOR_GUARANTEED, ...signalReasons(company)]);

  const qualifying = rows
    .filter(company => !guaranteedSymbols.has(company.symbol)
      && company.sizeOk && (company.bigMove || company.manyOutlets))
    .sort(byStrength);
  for (const company of qualifying) {
    if (chosen.length >= settings.maxCompanies) break;
    take(company, signalReasons(company));
  }
  return Object.freeze({
    companies: Object.freeze(chosen),
    considered: rows.length
  });
}

const identityOf = company => Object.freeze({
  symbol: company.symbol, shortName: company.shortName, longName: company.longName
});

function percentText(value) {
  return `${Math.abs(value).toFixed(2)}%`;
}

function moveWords(value, subject) {
  if (value > 0) return `${subject} rose ${percentText(value)}`;
  if (value < 0) return `${subject} fell ${percentText(value)}`;
  return `${subject} was unchanged`;
}

// One compact market-data evidence item for a spotlight company, with only
// the existing evidence keys. Throws when the company has no usable price,
// move or time (the caller leaves that line out).
function priceLineItem(company, {sp500MovePct = null} = {}) {
  if (!Number.isFinite(company?.price) || company.price <= 0 || !Number.isFinite(company.movePct)
      || typeof company.asOf !== 'string' || !Number.isFinite(Date.parse(company.asOf))) {
    throw new TypeError('Spotlight company lacks a usable price, move or time');
  }
  const name = company.longName || company.shortName || company.symbol;
  const label = `${name} (${company.symbol})`;
  const comparison = Number.isFinite(sp500MovePct)
    ? `, while ${moveWords(sp500MovePct, 'the S&P 500')}`
      + ` (${Math.abs(company.movePct - sp500MovePct).toFixed(2)} percentage points `
      + `${company.movePct - sp500MovePct >= 0 ? 'better' : 'worse'} than the S&P 500)`
    : '';
  return createEvidenceItem({
    sourceId: 'us.yahoo-finance',
    market: 'US',
    evidenceCategory: 'market-data',
    title: `${label} move against the S&P 500`,
    summary: `${moveWords(company.movePct, `${label} shares`)} to ${company.price} USD in the regular `
      + `session, last price time ${company.asOf}${comparison}.`,
    canonicalUrl: `${YAHOO_QUOTE_BASE_URL}${encodeURIComponent(company.symbol)}/`,
    publishedAt: company.asOf,
    symbols: [company.symbol]
  });
}

// The S&P 500's move on the regular-session basis the screeners and anchors
// use: the live overlay while the regular session is open, otherwise the
// latest completed session. Null when it is not known.
function sp500MovePctFrom(benchmarkSnapshots) {
  const snapshot = (Array.isArray(benchmarkSnapshots) ? benchmarkSnapshots : [])
    .find(entry => entry?.symbol === '^GSPC');
  if (!snapshot) return null;
  const overlay = snapshot.currentOverlay;
  if (overlay && overlay.marketState === 'REGULAR' && Number.isFinite(overlay.percentChange)) {
    return overlay.percentChange;
  }
  const sessions = Array.isArray(snapshot.completedSessions) ? snapshot.completedSessions : [];
  const latest = sessions[sessions.length - 1];
  return Number.isFinite(latest?.percentChange) ? latest.percentChange : null;
}

module.exports = {
  COMPANY_EVENT_TERMS,
  REASON,
  hasCompanyEventWord,
  spotlightSettings,
  buildSpotlight,
  identityOf,
  priceLineItem,
  sp500MovePctFrom
};

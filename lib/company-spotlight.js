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

// Step 9W Build A.1 (Kevin, 24 Oct 2026): short company names, for the
// spotlight only. A spotlight company is named by a headline when the shared
// matcher (headlineMatchesIdentity, unchanged) says so, or when one of its
// short forms appears: Yahoo's name without legal suffixes ("Amazon.com, Inc."
// -> "Amazon"), then without one trailing descriptor word ("Palo Alto
// Networks" -> "Palo Alto"), plus the anchors' fixed aliases ("Google"). These
// lists are fixed code constants, not Admin settings. Guards: whole words
// only; the matched word must start with a capital letter; a derived form is
// dropped when it is shorter than 4 letters, a common word, or shared by two
// companies seen in the run; and a seen company's longer name containing the
// form ("Bloom Energy" inside "Bloom Energy Partners") does not count for it.
// My Stocks and Watchlist companies are never matched this way.
const LEGAL_SUFFIX_PATTERN =
  /(?:,?\s+(?:incorporated|inc\.?|corporation|corp\.?|holdings?|company|co\.?|limited|ltd\.?|plc|group)|\.com)\s*$/i;
const DESCRIPTOR_WORDS = Object.freeze(new Set([
  'networks', 'energy', 'platforms', 'technologies', 'technology', 'systems', 'software', 'semiconductor',
  'semiconductors', 'therapeutics', 'pharmaceuticals', 'communications', 'entertainment', 'brands',
  'industries', 'markets', 'global', 'computer', 'devices', 'motor', 'motors'
]));
const COMMON_WORDS = Object.freeze(new Set([
  'general', 'united', 'american', 'america', 'first', 'national', 'international', 'global', 'new', 'target',
  'block', 'match', 'progressive', 'southern', 'northern', 'western', 'eastern', 'central', 'pacific',
  'atlantic', 'standard', 'universal', 'applied', 'advanced', 'digital', 'capital', 'financial', 'health',
  'energy', 'power', 'data', 'life', 'gold', 'silver', 'royal', 'prime', 'core', 'select', 'best', 'smart',
  'live', 'real', 'market', 'markets', 'stock', 'stocks', 'street', 'trade', 'check', 'square', 'shift',
  'unity', 'fortune', 'strategy', 'state', 'public', 'trust', 'bank', 'home', 'world', 'news', 'micro',
  'super', 'big', 'open', 'next', 'future', 'value', 'growth', 'income'
]));
const ANCHOR_ALIASES = Object.freeze({
  AAPL: Object.freeze(['Apple']),
  MSFT: Object.freeze(['Microsoft']),
  GOOGL: Object.freeze(['Alphabet', 'Google']),
  GOOG: Object.freeze(['Alphabet', 'Google']),
  AMZN: Object.freeze(['Amazon']),
  NVDA: Object.freeze(['Nvidia']),
  META: Object.freeze(['Meta']),
  TSLA: Object.freeze(['Tesla'])
});
const MIN_FORM_LETTERS = 4;

const formKey = form => form.toLowerCase().replace(/\s+/g, ' ');

// The name without legal suffixes (and a leading "The"), or null.
function baseName(name) {
  if (typeof name !== 'string') return null;
  let value = name.trim().replace(/^the\s+/i, '');
  for (let previous = null; value !== previous;) {
    previous = value;
    value = value.replace(LEGAL_SUFFIX_PATTERN, '').replace(/[\s,.]+$/, '');
  }
  return value || null;
}

function usableForm(form) {
  if (!form || form.replace(/[^A-Za-z]/g, '').length < MIN_FORM_LETTERS) return false;
  return !(!/\s/.test(form) && COMMON_WORDS.has(form.toLowerCase()));
}

// A company's derived short forms (no aliases), each once.
function derivedForms(company) {
  const forms = new Map();
  for (const name of [company?.shortName, company?.longName]) {
    const base = baseName(name);
    if (!base) continue;
    const words = base.split(/\s+/);
    const candidates = [base];
    if (words.length > 1 && DESCRIPTOR_WORDS.has(words[words.length - 1].toLowerCase())) {
      candidates.push(words.slice(0, -1).join(' '));
    }
    for (const form of candidates) {
      if (usableForm(form) && !forms.has(formKey(form))) forms.set(formKey(form), form);
    }
  }
  return [...forms.values()];
}

const aliasesOf = company => ANCHOR_ALIASES[company?.symbol] || [];

// Every form of each company in `companies` (the spotlight rows and both
// lists), with the shared-form and longer-name guards applied. Returns a Map
// symbol -> {forms, blockers}. List companies are only there to guard others.
function spotlightNameForms(companies) {
  const all = (Array.isArray(companies) ? companies : []).filter(company => typeof company?.symbol === 'string');
  const derivedBySymbol = new Map(all.map(company => [company.symbol, derivedForms(company)]));
  const aliasOwners = new Map();
  for (const company of all) {
    for (const alias of aliasesOf(company)) aliasOwners.set(formKey(alias), company.symbol);
  }
  const owners = new Map();
  for (const [symbol, forms] of derivedBySymbol) {
    for (const form of forms) {
      const key = formKey(form);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(symbol);
    }
  }
  const result = new Map();
  for (const company of all) {
    const forms = new Map(aliasesOf(company).map(alias => [formKey(alias), alias]));
    for (const form of derivedBySymbol.get(company.symbol)) {
      const key = formKey(form);
      const alias = aliasOwners.get(key);
      if (owners.get(key).size > 1 || (alias && alias !== company.symbol)) continue;
      if (!forms.has(key)) forms.set(key, form);
    }
    const blockers = [];
    for (const [symbol, otherForms] of derivedBySymbol) {
      if (symbol === company.symbol) continue;
      for (const other of otherForms) {
        if ([...forms.keys()].some(key => key !== formKey(other) && wholeWordPattern(key).test(other))) {
          blockers.push(other);
        }
      }
    }
    result.set(company.symbol, Object.freeze({
      forms: Object.freeze([...forms.values()]), blockers: Object.freeze(blockers)
    }));
  }
  return result;
}

// True when the form appears as a whole word starting with a capital letter.
function formAppears(headline, form) {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=[^A-Za-z0-9]|$)`, 'gi');
  for (let match = pattern.exec(headline); match; match = pattern.exec(headline)) {
    if (/[A-Z]/.test(match[2][0])) return true;
  }
  return false;
}

// Does the headline name this spotlight company? `identity` carries `forms`
// and `blockers` from spotlightNameForms; without them they are worked out
// from the identity alone (no cross-company guard).
function spotlightNamesCompany(headline, identity) {
  if (typeof headline !== 'string' || !identity) return false;
  if (headlineMatchesIdentity(headline, identity)) return true;
  const forms = Array.isArray(identity.forms) ? identity.forms : aliasesOf(identity).concat(derivedForms(identity));
  const blockers = Array.isArray(identity.blockers) ? identity.blockers : [];
  let text = headline;
  for (const blocker of blockers) {
    text = text.replace(new RegExp(wholeWordPattern(blocker).source, 'gi'), (whole, before, after) =>
      `${before}${' '.repeat(whole.length - before.length - after.length)}${after}`);
  }
  return forms.some(form => formAppears(text, form));
}

// The spotlight symbols a headline names (list order, each once).
function spotlightSymbolsNamed(headline, identities) {
  const symbols = [];
  for (const identity of identities) {
    if (!symbols.includes(identity.symbol) && spotlightNamesCompany(headline, identity)) {
      symbols.push(identity.symbol);
    }
  }
  return symbols;
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
// Step 9W Build A.1: by the spotlight match (short names included).
function outletCount(company, headlines) {
  const seen = new Set();
  for (const headline of headlines) {
    if (typeof headline !== 'string') continue;
    const key = headline.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    if (spotlightNamesCompany(headline, company)) seen.add(key);
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
// Step 9W Build A.1: `listIdentities` (both lists' names) only guard the
// spotlight's short names; each chosen company carries its `forms` and
// `blockers` for the spotlight match.
function buildSpotlight({
  screenerRows = [],
  anchorQuotes = [],
  sp500MovePct = null,
  poolHeadlines = [],
  listSymbols = [],
  listIdentities = [],
  settings = spotlightSettings()
}) {
  const listSet = new Set(listSymbols);
  const spKnown = Number.isFinite(sp500MovePct);
  const merged = mergedCompanies(screenerRows, anchorQuotes, settings.anchorSymbols);
  const nameForms = spotlightNameForms(merged.concat(
    (Array.isArray(listIdentities) ? listIdentities : []).filter(item => !merged.some(company =>
      company.symbol === item?.symbol))));
  const rows = merged
    .filter(company => !listSet.has(company.symbol))
    .map(company => {
      const relativeMovePct = spKnown && company.movePct !== null ? company.movePct - sp500MovePct : null;
      const {forms, blockers} = nameForms.get(company.symbol);
      const outlets = outletCount({...company, forms, blockers}, poolHeadlines);
      // Anchors count as meeting the size floor (Kevin's decision 3) unless a
      // screener row gives their size.
      const sizeOk = company.marketCapUsdBn !== null
        ? company.marketCapUsdBn >= settings.minMarketCapUsdBn
        : company.anchor;
      const bigMove = relativeMovePct !== null && Math.abs(relativeMovePct) >= settings.relativeMovePct;
      const manyOutlets = outlets >= settings.minOutlets;
      return {...company, relativeMovePct, outlets, sizeOk, bigMove, manyOutlets, forms, blockers};
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
    reasons: Object.freeze(reasons),
    forms: company.forms,
    blockers: company.blockers
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

// Step 9W Build A.1: with the company's short-name `forms` and `blockers`
// when it has them (the shared matcher reads only the three names).
const identityOf = company => Object.freeze({
  symbol: company.symbol, shortName: company.shortName, longName: company.longName,
  ...(Array.isArray(company.forms) ? {forms: company.forms, blockers: company.blockers || []} : {})
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
  DESCRIPTOR_WORDS,
  COMMON_WORDS,
  ANCHOR_ALIASES,
  hasCompanyEventWord,
  spotlightNameForms,
  spotlightNamesCompany,
  spotlightSymbolsNamed,
  spotlightSettings,
  buildSpotlight,
  identityOf,
  priceLineItem,
  sp500MovePctFrom
};

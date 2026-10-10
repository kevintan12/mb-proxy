// Step 9F.2c.1: the headline ranking word lists for the active-session Yahoo
// candidate ranker, moved into one shared module so Step 9G can later source
// them from Neon without touching the matching logic in
// us-analysis-package-orchestration.js. Each term is {term, caseSensitive};
// caseSensitive defaults to false unless set. Multi-word terms match as whole
// phrases (internal spaces become \s+ at the matching site).

// Tier 2: US market and macro terms. Whole words only; generic words such as
// "stocks", "shares" or "markets" are deliberately absent.
const US_MACRO_TERMS = Object.freeze([
  {term: 'S&P 500'}, {term: 'Nasdaq'}, {term: 'Wall Street'}, {term: 'Federal Reserve'},
  {term: 'Treasury'}, {term: 'yields'}, {term: 'inflation'}, {term: 'CPI'},
  {term: 'jobs report'}, {term: 'payrolls'}, {term: 'tariffs'}, {term: 'earnings'},
  {term: 'futures'}, {term: 'oil'}, {term: 'crude'}, {term: 'Brent'}, {term: 'dollar'},
  {term: 'rate hike'}, {term: 'rate cut'}, {term: 'Iran'}, {term: 'Middle East'},
  {term: 'Strait of Hormuz'}, {term: 'geopolitical'},
  {term: 'Fed', caseSensitive: true}, {term: 'Dow', caseSensitive: true},
  // Step 9F.2c.1 (3 Oct 2026 decision): approved additions.
  {term: 'AI', caseSensitive: true}, {term: 'Artificial Intelligence'}, {term: 'OpenAI'},
  {term: 'Anthropic'}, {term: 'Nvidia'}, {term: 'AMD'}, {term: 'VIX'}, {term: 'gold'},
  {term: 'silver'}, {term: 'rare earths'}, {term: 'bonds'}, {term: 'EU', caseSensitive: true}
]);

// Tier 4a: non-US regional and personal-finance/lifestyle articles. Applied only
// when the headline carries no tier 1, tier 2 or tier 4b signal. Dropped before
// any fetch (Step 8K.1). Whole words, case-insensitive; "how to" at the start of
// the headline is a separate rule, kept inline at the matching site.
const DROP_TERMS = Object.freeze([
  {term: 'Singapore'}, {term: 'STI'}, {term: 'ASX'}, {term: 'Australia'},
  {term: 'Australian'}, {term: 'Malaysia'}, {term: 'Indonesia'}, {term: 'retire'},
  {term: 'retirement'}, {term: 'mortgage'}, {term: 'credit card'}, {term: 'savings account'},
  // Step 9F.2c.1 (3 Oct 2026 decision): approved additions.
  {term: 'Singaporean'}, {term: 'Malaysian'}, {term: 'Indonesian'}, {term: 'Thailand'},
  {term: 'Thai'}, {term: 'Vietnam'}, {term: 'Vietnamese'}, {term: 'Philippines'},
  {term: 'Filipino'}, {term: 'Brunei'}, {term: 'Bruneian'}, {term: 'Cambodia'},
  {term: 'Cambodian'}, {term: 'Laos'}, {term: 'Laotian'}, {term: 'Myanmar'},
  {term: 'Burmese'}, {term: 'ASEAN'}
]);

// Tier 4b: Asian and European market headlines can move US markets. Kept, ranked
// last, and they win over a tier 4a match in the same headline.
const LAST_RANKED_TERMS = Object.freeze([
  {term: 'India'}, {term: 'China'}, {term: 'Hong Kong'}, {term: 'Hang Seng'},
  {term: 'Nikkei'}, {term: 'FTSE'}
]);

// Tier 3a: a headline with no tier 1, tier 2, tier 4a or tier 4b signal that names
// a benchmark index not already in the tier 2 macro list, or a generic
// broad-market/macro term.
const TIER_3A_TERMS = Object.freeze([
  {term: 'S&P'}, {term: 'Russell'}, {term: 'stocks'}, {term: 'shares fall'},
  {term: 'shares rise'}, {term: 'trading day'}, {term: 'market'}
]);

// Step 8K.5: wire-style partners. A market-wide wrap from one of these that
// already matches a tier 2 term outranks a single-company most-active piece.
// Matched on the listing's partner name, lower-cased with punctuation removed.
const WIRE_PARTNERS = Object.freeze([
  'reuters', 'associated press', 'ap', 'afp', 'bloomberg', 'marketwatch',
  'the wall street journal', 'wall street journal'
]);

module.exports = {US_MACRO_TERMS, DROP_TERMS, LAST_RANKED_TERMS, TIER_3A_TERMS, WIRE_PARTNERS};

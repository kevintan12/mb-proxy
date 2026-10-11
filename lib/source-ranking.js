// Step 9F.6a.2: today's headline tier ranking, the stale-by-label check and
// symbol tagging, moved unchanged out of lib/us-analysis-package-orchestration.js
// so every news source ranks and tags candidates the same way. Step 9F.2e swaps
// the tier ranking here for lib/article-score.js.
'use strict';

const {settingValue} = require('./settings-registry');
// Step 9F.2c.2: the headline matching primitives (whole-word patterns, macro/AMD
// exclusion, identity matching, publisher-key normalizing, age-label parsing)
// live in lib/headline-matching.js, shared with lib/article-score.js.
const {
  headlineMatchesIdentity, US_MACRO_PATTERNS, macroTermMatches, DROP_TERM_PATTERNS,
  HOW_TO_DROP_PATTERNS, LAST_RANKED_PATTERNS, TIER_3A_PATTERNS, partnerKey, WIRE_PARTNERS_SET,
  activeYahooLabelAgeLowerBoundMs
} = require('./headline-matching');

// Step 9F.2a: read from the shared settings registry (lib/settings-registry.js)
// when the module loads, as before.
const STALE_LABEL_TOLERANCE_MS = settingValue('yahooStaleLabelToleranceHours') * 60 * 60 * 1000;

// Tier 4a: non-US regional and personal-finance/lifestyle articles. Applied only
// when the headline carries no tier 1, tier 2 or tier 4b signal. Dropped before
// any fetch (Step 8K.1). Whole words, case-insensitive; "how to" only counts at
// the start of the headline. Step 9F.2d.1: both parts now come from the word
// lists (DROP_TERMS and HOW_TO_DROP_PREFIXES in lib/headline-lists.js); the
// "how to" pattern is the same one that used to be written inline here.
const DROPPED_PATTERNS = Object.freeze([
  ...DROP_TERM_PATTERNS,
  ...HOW_TO_DROP_PATTERNS
]);

// Tier 4b: Asian and European market headlines can move US markets. Kept, ranked
// last, and they win over a tier 4a match in the same headline (LAST_RANKED_PATTERNS).
//
// Tier 3a (Step 8K.1 correction #2): a headline with no tier 1, tier 2, tier 4a or
// tier 4b signal that names a benchmark index not already in the tier 2 macro list,
// or a generic broad-market/macro term (TIER_3A_PATTERNS). Checked after tier 4a/4b
// so a specific non-US-regional or lifestyle drop, or an Asian/European market
// mention, still wins over a bare "stocks"/"market" word in the same headline.
// Ranked above tier 4b and below tier 2 in the final order.
//
// Step 8K.5: wire-style partners (WIRE_PARTNERS_SET) — a market-wide wrap from one
// of these that already matches a tier 2 term outranks a single-company
// most-active piece. Matched on the listing's partner name, lower-cased with
// punctuation removed. Step 9F.2c.1: the blog-style partner list and its ranking
// effect are removed — publishers other than wire partners no longer affect ranking.

// Step 8K.5 tier order: 1a (My Stocks/Watchlist name), 2w (wire or market-wide
// headline matching a tier 2 term), 1b (most-active name only), 2 (other US
// market/macro), 3a, 4b, 3b. `tier` keeps its 8K.1 number; `subTier` names the
// bucket. This reorders the 8K.1 tiers.
const BUCKET_ORDER = Object.freeze(['1a', '2w', '1b', '2', '3a', '4b', '3b']);

function candidateTier(candidate, portfolioIdentities, mostActiveIdentities) {
  const headline = typeof candidate?.headline === 'string' ? candidate.headline : '';
  if (portfolioIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    return {tier: 1, dropped: false, subTier: '1a'};
  }
  const macro = US_MACRO_PATTERNS.some(entry => macroTermMatches(entry, headline));
  if (macro && WIRE_PARTNERS_SET.has(partnerKey(candidate?.publisher))) {
    return {tier: 2, dropped: false, subTier: '2w'};
  }
  if (mostActiveIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    return {tier: 1, dropped: false, subTier: '1b'};
  }
  if (macro) {
    return {tier: 2, dropped: false, subTier: null};
  }
  if (LAST_RANKED_PATTERNS.some(pattern => pattern.test(headline))) {
    return {tier: 4, dropped: false, subTier: '4b'};
  }
  if (DROPPED_PATTERNS.some(pattern => pattern.test(headline))) {
    return {tier: 4, dropped: true, subTier: '4a'};
  }
  if (TIER_3A_PATTERNS.some(pattern => pattern.test(headline))) {
    return {tier: 3, dropped: false, subTier: '3a'};
  }
  return {tier: 5, dropped: false, subTier: '3b'};
}

// Orders candidates by relevance bucket (page order inside a bucket). Final order
// (Step 8K.5): 1a (a My Stocks/Watchlist security), 2w (wire or market-wide
// headline with a US market/macro term), 1b (a most-active stock only), 2 (other
// US market/macro), 3a (benchmark index or broad-market term), 4b (Asian/European
// markets), 3b (no relevance signal). Tier 4a candidates are flagged dropped and
// listed after every fetchable candidate: the audit keeps them, the caller never
// fetches them. Step 9F.2c.1: publishers other than wire partners (which can earn
// the 2w bucket) no longer affect ordering within a bucket.
// The portfolio names a headline is matched against, from stock snapshots.
// Step 9F.2e.1: shared with the shadow score so both see the same names.
function portfolioIdentitiesFrom(portfolioSnapshots) {
  return portfolioSnapshots.map(snapshot => ({
    symbol: snapshot.symbol,
    shortName: snapshot.instrumentName,
    longName: snapshot.instrumentName
  }));
}

function rankCandidates(mostActive, candidates, portfolioSnapshots = []) {
  const portfolioIdentities = portfolioIdentitiesFrom(portfolioSnapshots);
  const buckets = new Map(BUCKET_ORDER.map(key => [key, []]));
  const dropped = [];
  for (const candidate of candidates) {
    const {tier, dropped: isDropped, subTier} =
      candidateTier(candidate, portfolioIdentities, mostActive);
    const entry = Object.freeze({candidate, tier, dropped: isDropped, subTier});
    if (isDropped) {
      dropped.push(entry);
      continue;
    }
    const key = subTier || (tier === 2 ? '2' : String(tier));
    buckets.get(key).push(entry);
  }
  return Object.freeze(BUCKET_ORDER
    .flatMap(key => buckets.get(key))
    .concat(dropped));
}

// True only when the label's lower-bound age exceeds the window-start age plus the
// tolerance. No label, an unparseable label or no window means false. Since Step
// 9F.1c this only moves a candidate to the back of the order; it never skips one.
function staleByLabel(candidate, window, generationTime) {
  if (!window || !Number.isFinite(generationTime)) return false;
  const lowerBound = activeYahooLabelAgeLowerBoundMs(candidate?.ageLabel);
  const windowStart = Date.parse(window.startsAtInclusive);
  if (lowerBound === null || !Number.isFinite(windowStart)) return false;
  return lowerBound > (generationTime - windowStart) + STALE_LABEL_TOLERANCE_MS;
}

function headlineSymbols(headline, mostActive, portfolioSnapshots) {
  const identities = mostActive.map(item => ({
    symbol: item.symbol,
    shortName: item.shortName,
    longName: item.longName
  })).concat(portfolioSnapshots.map(snapshot => ({
    symbol: snapshot.symbol,
    shortName: snapshot.instrumentName,
    longName: snapshot.instrumentName
  })));
  const seen = new Set();
  const symbols = [];
  for (const item of identities) {
    if (seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    if (headlineMatchesIdentity(headline, item)) {
      symbols.push(item.symbol);
    }
  }
  return symbols;
}

module.exports = {
  candidateTier,
  portfolioIdentitiesFrom,
  rankCandidates,
  staleByLabel,
  headlineSymbols
};

// Step 9F.2c.2: the headline matching primitives shared by the active-session
// Yahoo candidate ranker (lib/us-analysis-package-orchestration.js) and the new,
// not-yet-wired shared article score (lib/article-score.js). Moved out of
// us-analysis-package-orchestration.js unchanged -- same regexes, same behavior,
// now one copy instead of a future second one. Depends only on
// lib/headline-lists.js (the word-list data), no require cycle.
'use strict';

const {
  US_MACRO_TERMS, DROP_TERMS, HOW_TO_DROP_PREFIXES, LAST_RANKED_TERMS, TIER_3A_TERMS,
  WIRE_PARTNERS, AMD_EXCLUSION_PHRASES
} = require('./headline-lists');

// Moved from lib/us-analysis-package-orchestration.js (was unexported there).
const AMBIGUOUS_TICKER_SYMBOLS = new Set([
  'ALL', 'ARE', 'BEST', 'BIG', 'CAN', 'CAR', 'CAT', 'FOR', 'HAS', 'JOB', 'KEY',
  'LIFE', 'LOVE', 'LOW', 'MAN', 'NOW', 'OPEN', 'PLAY', 'REAL', 'RUN', 'SAVE',
  'SUN', 'WELL'
]);

function companyNameVariants(item) {
  return [item.shortName, item.longName].flatMap(value => {
    if (typeof value !== 'string' || value.trim().length < 4) return [];
    const normalized = value.trim().toLowerCase();
    const withoutSuffix = normalized.replace(
      /(?:,?\s+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc))\.?$/i,
      ''
    ).trim();
    return withoutSuffix && withoutSuffix !== normalized
      ? [normalized, withoutSuffix] : [normalized];
  });
}

function headlineMatchesIdentity(headline, item) {
  if (typeof headline !== 'string') return false;
  const lowerHeadline = headline.toLowerCase();
  if (companyNameVariants(item).some(name => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escapedName}([^a-z0-9]|$)`, 'i').test(lowerHeadline);
  })) return true;
  const escaped = item.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (item.symbol.length <= 2 || AMBIGUOUS_TICKER_SYMBOLS.has(item.symbol)) {
    return new RegExp(`(?:\\$${escaped}\\b|\\(${escaped}\\)|\\b(?:NASDAQ|NYSE)\\s*:\\s*${escaped}\\b)`)
      .test(headline.toUpperCase());
  }
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(headline);
}

function wholeWordPattern(term, {caseSensitive = false} = {}) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, caseSensitive ? '' : 'i');
}

// Tier 2: US market and macro terms. Whole words only; generic words such as
// "stocks", "shares" or "markets" are deliberately absent.
const US_MACRO_PATTERNS = Object.freeze(
  US_MACRO_TERMS.map(({term, caseSensitive}) => ({term, pattern: wholeWordPattern(term, {caseSensitive})}))
);

// "AMD" in a headline about wet/dry age-related macular degeneration isn't the
// chipmaker. Only the AMD macro term is suppressed when one of these phrases is
// present; other macro terms in the same headline still count.
const AMD_EXCLUSION_PATTERNS = Object.freeze(
  AMD_EXCLUSION_PHRASES.map(({term, caseSensitive}) => wholeWordPattern(term, {caseSensitive}))
);

function macroTermMatches({term, pattern}, headline) {
  if (!pattern.test(headline)) return false;
  if (term === 'AMD' && AMD_EXCLUSION_PATTERNS.some(excluded => excluded.test(headline))) {
    return false;
  }
  return true;
}

// Step 9F.2d.1: a term that only counts at the start of the headline (leading
// spaces allowed) and must not run straight into a letter or digit. For
// "how to" this builds exactly the old inline /^\s*how\s+to(?![A-Za-z0-9])/i.
function headlineStartPattern(term, {caseSensitive = false} = {}) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
  return new RegExp(`^\\s*${escaped}(?![A-Za-z0-9])`, caseSensitive ? '' : 'i');
}

// Tier 4a word-list terms (non-US regional and personal-finance/lifestyle).
const DROP_TERM_PATTERNS = Object.freeze(
  DROP_TERMS.map(({term, caseSensitive}) => wholeWordPattern(term, {caseSensitive}))
);

// Tier 4a start-of-headline patterns ("how to"), shared by the tier ranking and
// the article score.
const HOW_TO_DROP_PATTERNS = Object.freeze(
  HOW_TO_DROP_PREFIXES.map(({term, caseSensitive}) => headlineStartPattern(term, {caseSensitive}))
);

// Tier 4b: Asian and European market headlines can move US markets.
const LAST_RANKED_PATTERNS = Object.freeze(
  LAST_RANKED_TERMS.map(({term, caseSensitive}) => wholeWordPattern(term, {caseSensitive}))
);

// Tier 3a: benchmark index or generic broad-market/macro term.
const TIER_3A_PATTERNS = Object.freeze(
  TIER_3A_TERMS.map(({term, caseSensitive}) => wholeWordPattern(term, {caseSensitive}))
);

// Wire-style partners, matched on the listing's partner name, lower-cased with
// punctuation removed.
function partnerKey(publisher) {
  return typeof publisher === 'string'
    ? publisher.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}
const WIRE_PARTNERS_SET = Object.freeze(new Set(WIRE_PARTNERS));

// The page's relative label ("58m ago", "3 min ago", "1d ago") floors to whole
// units, so the true age is at least the label's value. Returns that lower bound
// in milliseconds, or null for anything missing, garbled or unit-less.
function activeYahooLabelAgeLowerBoundMs(label) {
  const match = /^\s*(\d{1,4})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s+ago\s*$/i.exec(
    typeof label === 'string' ? label : ''
  );
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const unitMs = unit.startsWith('m') ? 60000 : unit.startsWith('h') ? 3600000 : 86400000;
  return Number(match[1]) * unitMs;
}

module.exports = {
  AMBIGUOUS_TICKER_SYMBOLS,
  companyNameVariants,
  headlineMatchesIdentity,
  wholeWordPattern,
  headlineStartPattern,
  US_MACRO_PATTERNS,
  macroTermMatches,
  DROP_TERM_PATTERNS,
  HOW_TO_DROP_PATTERNS,
  LAST_RANKED_PATTERNS,
  TIER_3A_PATTERNS,
  partnerKey,
  WIRE_PARTNERS_SET,
  activeYahooLabelAgeLowerBoundMs
};

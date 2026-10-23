// Step 9F.2c.2: the shared article score. Every article, from any source, is
// scored once in this one place with additive points plus a small recency
// bonus, all read live from the settings registry. Wired into the reader's
// try order since Step 9F.2e.4a, while the Admin switch scoreTryOrderEnabled
// is on (lib/source-reader.js -> lib/article-selection.js scoreTryOrder).
'use strict';

const {settingValue, checkRecencyNeverOverridesMacro} = require('./settings-registry');
const {
  headlineMatchesIdentity, wholeWordPattern, US_MACRO_PATTERNS, AI_THEME_TERMS_SET, macroTermMatches,
  DROP_TERM_PATTERNS, HOW_TO_DROP_PATTERNS, LAST_RANKED_PATTERNS, TIER_3A_PATTERNS, partnerKey,
  WIRE_PARTNERS_SET, activeYahooLabelAgeLowerBoundMs
} = require('./headline-matching');
const {hasCompanyEventWord} = require('./company-spotlight');

// Step 9F.2d.1 (Kevin, 11 Oct 2026): the lists that protect a headline from
// the drop list -- the same protection the tier ranking gives today (portfolio,
// most-active, US macro, Asia/Europe), plus the promote-only include words.
// Wire publishers and the generic benchmark/market list score points but do
// not protect.
const DROP_PROTECTING_LISTS = Object.freeze(['portfolio', 'mostActive', 'usMacro', 'asiaEurope', 'includeWords']);

const HOUR_MS = 60 * 60 * 1000;

function normalizeInstant(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Age from the trigger instant, never from the last close. Prefers a known
// publish time; falls back to the age label's lower bound when the publish
// time isn't known yet (candidates are ranked before download); otherwise
// recency is 0 and the basis is 'unknown'.
function articleAgeHours(candidate, triggerAt) {
  const trigger = normalizeInstant(triggerAt);
  if (!Number.isFinite(trigger)) return {ageHours: null, recencyBasis: 'unknown'};
  const publishedAt = normalizeInstant(candidate?.publishedAt);
  if (Number.isFinite(publishedAt)) {
    return {ageHours: Math.max(0, (trigger - publishedAt) / HOUR_MS), recencyBasis: 'publishedAt'};
  }
  const lowerBoundMs = activeYahooLabelAgeLowerBoundMs(candidate?.ageLabel);
  if (lowerBoundMs !== null) {
    return {ageHours: lowerBoundMs / HOUR_MS, recencyBasis: 'ageLabel'};
  }
  return {ageHours: null, recencyBasis: 'unknown'};
}

// The recency bonus for `ageHours`, using the registry's thresholds and the
// three bonus values after the safety clamp (see checkRecencyNeverOverridesMacro
// in lib/settings-registry.js): under the near threshold, between near and far,
// at or past far. Exactly at a threshold falls into the later bucket.
function recencyPointsFor(ageHours, env) {
  if (ageHours === null) return 0;
  const nearHours = settingValue('recencyThresholdHoursNear', {env});
  const farHours = settingValue('recencyThresholdHoursFar', {env});
  const {values} = checkRecencyNeverOverridesMacro({env});
  if (ageHours < nearHours) return values.recencyBonusUnder6h;
  if (ageHours < farHours) return values.recencyBonus6to24h;
  return values.recencyBonusOver24h;
}

// `includeWords` entries may be plain strings or {term, caseSensitive} objects,
// matching the shape of lib/headline-lists.js terms, since the real Admin list
// doesn't exist yet. An empty or missing list never matches.
function includeWordsMatch(headline, includeWords) {
  if (!Array.isArray(includeWords) || includeWords.length === 0) return false;
  return includeWords.some(entry => {
    const term = typeof entry === 'string' ? entry : entry?.term;
    if (typeof term !== 'string' || term.trim() === '') return false;
    const caseSensitive = typeof entry === 'object' && entry !== null && !!entry.caseSensitive;
    return wholeWordPattern(term, {caseSensitive}).test(headline);
  });
}

// Scores one candidate. `candidate`: {headline, publisher, publishedAt, ageLabel}.
// `portfolioIdentities` is the list that started the run (My Stocks or
// Watchlist); `mostActiveIdentities` is the Most Active list; `includeWords` is
// the caller-supplied include-word list (empty by default). Every point value,
// recency bonus and recency threshold is read live from the settings registry.
function scoreArticle(candidate, {
  triggerAt,
  portfolioIdentities = [],
  mostActiveIdentities = [],
  includeWords = [],
  // Step 9W Build A: present only while companySpotlightEnabled is on. Left
  // out (null), the result is exactly as before -- no new keys.
  spotlightIdentities = null,
  eventIdentities = null,
  env = process.env
} = {}) {
  const headline = typeof candidate?.headline === 'string' ? candidate.headline : '';

  const matched = {
    usMacro: 0, mostActive: 0, portfolio: 0, wirePublishers: 0,
    includeWords: 0, asiaEurope: 0, benchmarkOrGeneric: 0, ai: 0
  };

  if (portfolioIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    matched.portfolio = settingValue('rankingPointsPortfolio', {env});
  }
  if (mostActiveIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    matched.mostActive = settingValue('rankingPointsMostActive', {env});
  }
  // Step 9F.2e.4b: a headline with no matched macro term scores 0, as before.
  // One with at least one matched term outside AI_THEME_TERMS still scores the
  // full macro value, as before. One whose matched terms are ALL AI-theme
  // words scores the (lower) AI-theme value instead -- unless that value has
  // been set equal to the macro value, in which case it is scored and labeled
  // exactly as the macro case (so a 20/20 setup reproduces today's logs byte
  // for byte). Either/or, never both; the match itself (not the points) is
  // what protects the headline from the drop rule -- see `macroMatched` below.
  const matchedMacroTerms = US_MACRO_PATTERNS.filter(entry => macroTermMatches(entry, headline));
  const macroMatched = matchedMacroTerms.length > 0;
  if (macroMatched) {
    const hasNonAiTheme = matchedMacroTerms.some(({term}) => !AI_THEME_TERMS_SET.has(term));
    const macroValue = settingValue('rankingPointsUsMacro', {env});
    if (hasNonAiTheme) {
      matched.usMacro = macroValue;
    } else {
      const aiValue = settingValue('rankingPointsAiTheme', {env});
      if (aiValue === macroValue) {
        matched.usMacro = macroValue;
      } else {
        matched.ai = aiValue;
      }
    }
  }
  if (WIRE_PARTNERS_SET.has(partnerKey(candidate?.publisher))) {
    matched.wirePublishers = settingValue('rankingPointsWirePublishers', {env});
  }
  if (includeWordsMatch(headline, includeWords)) {
    matched.includeWords = settingValue('rankingPointsIncludeWords', {env});
  }
  if (LAST_RANKED_PATTERNS.some(pattern => pattern.test(headline))) {
    matched.asiaEurope = settingValue('rankingPointsAsiaEurope', {env});
  }
  if (TIER_3A_PATTERNS.some(pattern => pattern.test(headline))) {
    matched.benchmarkOrGeneric = settingValue('rankingPointsBenchmarkOrGeneric', {env});
  }

  // Step 9W Build A: spotlight points for a headline naming a spotlight
  // company; event-word points only when the headline also names a spotlight
  // or My Stocks/Watchlist company (a booster, never a signal on its own).
  if (Array.isArray(spotlightIdentities)) {
    matched.spotlight = spotlightIdentities.some(item => headlineMatchesIdentity(headline, item))
      ? settingValue('rankingPointsSpotlight', {env}) : 0;
    const eventNames = Array.isArray(eventIdentities) ? eventIdentities : spotlightIdentities;
    matched.companyEvent = hasCompanyEventWord(headline)
      && eventNames.some(item => headlineMatchesIdentity(headline, item))
      ? settingValue('rankingPointsCompanyEvent', {env}) : 0;
  }

  const {ageHours, recencyBasis} = articleAgeHours(candidate, triggerAt);
  const recencyPoints = recencyPointsFor(ageHours, env);

  // Recency never rescues a drop. `excludedByDropList` covers both drop
  // patterns; `dropReason` says which one. Step 9F.2e.4b: US-macro protection
  // is by match (`macroMatched`), not by points, so an AI-theme-only headline
  // is still protected even when rankingPointsAiTheme is set to 0.
  const isProtected = macroMatched
    || DROP_PROTECTING_LISTS.some(name => name !== 'usMacro' && matched[name] > 0);
  const dropReason = isProtected ? null
    : DROP_TERM_PATTERNS.some(pattern => pattern.test(headline)) ? 'DROP_LIST'
      : HOW_TO_DROP_PATTERNS.some(pattern => pattern.test(headline)) ? 'HOW_TO' : null;

  const score = Object.values(matched).reduce((sum, points) => sum + points, 0) + recencyPoints;

  return Object.freeze({
    score,
    matched: Object.freeze(matched),
    recencyPoints,
    recencyBasis,
    ageHours,
    excludedByDropList: dropReason !== null,
    dropReason
  });
}

// Orders scored entries highest score first; ties go to the newer article
// (smaller ageHours), then to the original listing order. `a`/`b` are
// {score, ageHours, listIndex} -- the shape `scoreArticle`'s result already has,
// plus a caller-assigned `listIndex`. Not called from anywhere yet.
function compareScoredArticles(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (Number.isFinite(a.ageHours) && Number.isFinite(b.ageHours) && a.ageHours !== b.ageHours) {
    return a.ageHours - b.ageHours;
  }
  return a.listIndex - b.listIndex;
}

module.exports = {
  DROP_PROTECTING_LISTS,
  scoreArticle,
  compareScoredArticles
};

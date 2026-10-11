// Step 9F.2c.2: the shared article score. Every article, from any source, is
// scored once in this one place with additive points plus a small recency
// bonus, all read live from the settings registry. NOT wired into ranking,
// slots or selection -- nothing in the pipeline calls this yet.
'use strict';

const {settingValue, checkRecencyNeverOverridesMacro} = require('./settings-registry');
const {
  headlineMatchesIdentity, wholeWordPattern, US_MACRO_PATTERNS, macroTermMatches,
  DROP_TERM_PATTERNS, LAST_RANKED_PATTERNS, TIER_3A_PATTERNS, partnerKey, WIRE_PARTNERS_SET,
  activeYahooLabelAgeLowerBoundMs
} = require('./headline-matching');

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
  env = process.env
} = {}) {
  const headline = typeof candidate?.headline === 'string' ? candidate.headline : '';

  const matched = {
    usMacro: 0, mostActive: 0, portfolio: 0, wirePublishers: 0,
    includeWords: 0, asiaEurope: 0, benchmarkOrGeneric: 0
  };

  if (portfolioIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    matched.portfolio = settingValue('rankingPointsPortfolio', {env});
  }
  if (mostActiveIdentities.some(item => headlineMatchesIdentity(headline, item))) {
    matched.mostActive = settingValue('rankingPointsMostActive', {env});
  }
  if (US_MACRO_PATTERNS.some(entry => macroTermMatches(entry, headline))) {
    matched.usMacro = settingValue('rankingPointsUsMacro', {env});
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

  const {ageHours, recencyBasis} = articleAgeHours(candidate, triggerAt);
  const recencyPoints = recencyPointsFor(ageHours, env);

  const anyListScored = Object.values(matched).some(points => points > 0);
  const excludedByDropList = !anyListScored && DROP_TERM_PATTERNS.some(pattern => pattern.test(headline));

  const score = Object.values(matched).reduce((sum, points) => sum + points, 0) + recencyPoints;

  return Object.freeze({
    score,
    matched: Object.freeze(matched),
    recencyPoints,
    recencyBasis,
    ageHours,
    excludedByDropList
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
  scoreArticle,
  compareScoredArticles
};

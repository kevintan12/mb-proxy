// Step 9F.2a: one settings table for every limit, slot count, point value, time
// window, retry count and budget, each with a default, a safe range (where one
// applies) and an Admin/Fixed tag, so Step 9G can move this table into Neon and
// Step 9H can add an Admin page without rebuilding anything.
//
// This module depends on nothing else in the repo, so lib/section-rules.js and
// lib/reading-window.js can both read from it with no require cycle.
'use strict';

// Pulls a numeric setting back to the nearest safe limit. A missing value, a
// non-number, a non-finite number, or a string that cannot be read as a number
// gets the default. Moved here from lib/reading-window.js (Step 9F.1a) so there
// is exactly one implementation; lib/reading-window.js now imports it from here.
function clampSetting(value, {default: fallback, min, max}) {
  let number = value;
  if (typeof value === 'string') number = value.trim() === '' ? NaN : Number(value);
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// An on/off setting read from a string: 'true'/'1'/'on' is on, 'false'/'0'/'off'
// is off (case-insensitive); anything else, including missing, is the default.
function clampBooleanSetting(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().toLowerCase();
  if (['true', '1', 'on'].includes(text)) return true;
  if (['false', '0', 'off'].includes(text)) return false;
  return fallback;
}

function numericSetting({
  default: value, min, max, admin, envVar, description, location, wired = true
}) {
  return Object.freeze({default: value, min, max, admin, envVar, description, location, wired});
}

function booleanSetting({default: value, admin, envVar, description, location, wired = true}) {
  return Object.freeze({default: value, admin, envVar, description, location, wired, boolean: true});
}

function fixedSetting({default: value, description, location, wired = true}) {
  return Object.freeze({default: value, admin: 'Fixed', description, location, wired});
}

function referenceSetting({default: value, description, location, wired = false}) {
  return Object.freeze({default: value, admin: 'Admin', description, location, wired, reference: true});
}

const KB = 1024;
const HOUR_MS = 60 * 60 * 1000;

// The table. Keys are camelCase, matching the names other modules already use
// for the values that are moving in; env var names are upper-case, matching the
// two that are already live in Vercel (READING_EXTENSION_HOURS, ARTICLE_KB).
const SETTINGS_REGISTRY = Object.freeze({
  // --- Reading window and article size (existing, unchanged behaviour) ---
  readingExtensionHours: numericSetting({
    default: 24, min: 0, max: 72, admin: 'Admin', envVar: 'READING_EXTENSION_HOURS',
    description: 'How many hours before the last close the Yahoo reading window starts.',
    location: 'lib/section-rules.js READING_SETTINGS -> lib/reading-window.js'
  }),
  articleKb: numericSetting({
    default: 16, min: 2, max: 32, admin: 'Admin', envVar: 'ARTICLE_KB',
    description: 'How much of a Yahoo article (news or recap) is kept, in KB.',
    location: 'lib/section-rules.js READING_SETTINGS -> lib/reading-window.js'
  }),

  // --- Budgets and retries (Step 9F.1d made these Fixed; Kevin's 10 Oct 2026
  // rule in Step 9F.2a makes every budget, window and retry count an Admin
  // setting instead, superseding that part of 9F.1d/9F.1e) ---
  yahooReadingBudgetSeconds: numericSetting({
    default: 30, min: 10, max: 60, admin: 'Admin', envVar: 'READING_BUDGET_SECONDS',
    description: 'How long the active-session Yahoo news reading stage keeps downloading '
      + 'before it stops starting new downloads or retries.',
    location: 'lib/section-rules.js READING_SETTINGS.readingBudgetSeconds (was Fixed)'
  }),
  recapReadingBudgetSeconds: numericSetting({
    default: 30, min: 10, max: 60, admin: 'Admin', envVar: 'RECAP_READING_BUDGET_SECONDS',
    description: 'The same kind of budget as the Yahoo news reading, for the completed-session '
      + 'Yahoo recap search and download.',
    location: 'lib/us-analysis-package-orchestration.js recap retry options '
      + '(previously reused the Yahoo news budget directly)'
  }),
  downloadAttempts: numericSetting({
    default: 3, min: 1, max: 5, admin: 'Admin', envVar: 'DOWNLOAD_ATTEMPTS',
    description: 'How many times a single Yahoo article download (news or recap) is tried '
      + 'before giving up.',
    location: 'lib/reading-window.js DOWNLOAD_ATTEMPTS (was Fixed)'
  }),
  downloadRetryPausesMs: fixedSetting({
    default: Object.freeze([250, 750]),
    description: 'The pause before each retry of a failed Yahoo download.',
    location: 'lib/reading-window.js DOWNLOAD_RETRY_PAUSES_MS'
  }),
  classifierArticleBytes: fixedSetting({
    default: 8 * KB,
    description: 'How much of an article the classifier and subject repair read, regardless '
      + 'of how much was kept.',
    location: 'lib/reading-window.js CLASSIFIER_ARTICLE_BYTES'
  }),

  // --- Caps and tolerances ---
  recapMaxCandidates: numericSetting({
    default: 3, min: 1, max: 5, admin: 'Admin', envVar: 'RECAP_MAX_CANDIDATES',
    description: 'How many candidate pages the Yahoo recap search checks before giving up.',
    location: 'lib/yahoo-recap-acceptance.js YAHOO_RECAP_MAX_CANDIDATES'
  }),
  yahooMaxArticleAttempts: numericSetting({
    default: 12, min: 6, max: 20, admin: 'Admin', envVar: 'YAHOO_MAX_ARTICLE_ATTEMPTS',
    description: 'How many Yahoo news articles the active session will try to download in one run.',
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS'
  }),
  yahooMaxAdmittedArticles: numericSetting({
    default: 6, min: 0, max: 10, admin: 'Admin', envVar: 'YAHOO_MAX_ADMITTED_ARTICLES',
    description: "How many Yahoo news articles the active session will admit into the report "
      + "in one run (today's value in use).",
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES'
  }),
  yahooStaleLabelToleranceHours: numericSetting({
    default: 4, min: 0, max: 12, admin: 'Admin', envVar: 'YAHOO_STALE_LABEL_TOLERANCE_HOURS',
    description: "How much older than the reading window start a Yahoo page's own age label "
      + 'can claim before that candidate is tried last instead of first.',
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_STALE_LABEL_TOLERANCE_MS '
      + '(stored there in milliseconds)'
  }),

  // --- Page timeouts and listing caps ---
  pageTimeoutMs: numericSetting({
    default: 4000, min: 2000, max: 8000, admin: 'Admin', envVar: 'PAGE_TIMEOUT_MS',
    description: 'The fetch timeout for a single Yahoo or Federal Reserve page, outside the '
      + 'recap page and the US listing page.',
    location: 'DEFAULT_TIMEOUT_MS, duplicated across lib/federal-reserve-monetary-policy-'
      + 'evidence-acquisition.js, lib/yahoo-current-news-article-content-acquisition.js, '
      + 'lib/yahoo-latest-news-discovery.js (non-US), lib/yahoo-market-data-evidence-'
      + 'acquisition.js, lib/yahoo-most-active-acquisition.js'
  }),
  usListingTimeoutMs: numericSetting({
    default: 6000, min: 2000, max: 10000, admin: 'Admin', envVar: 'US_LISTING_TIMEOUT_MS',
    description: 'The fetch timeout for the larger US Yahoo news-listing page.',
    location: 'lib/yahoo-latest-news-discovery.js US_DEFAULT_TIMEOUT_MS'
  }),
  nonUsListingMaxResponseBytes: numericSetting({
    default: 1024 * KB, min: 256 * KB, max: 4096 * KB, admin: 'Admin',
    envVar: 'NON_US_LISTING_MAX_RESPONSE_BYTES',
    description: 'How much of the non-US Yahoo news-listing page is read.',
    location: 'lib/yahoo-latest-news-discovery.js MAX_RESPONSE_BYTES'
  }),
  nonUsListingMaxCandidates: numericSetting({
    default: 30, min: 5, max: 100, admin: 'Admin', envVar: 'NON_US_LISTING_MAX_CANDIDATES',
    description: 'How many headline candidates are taken from the non-US Yahoo news-listing page.',
    location: 'lib/yahoo-latest-news-discovery.js MAX_CANDIDATES'
  }),
  usListingMaxResponseBytes: numericSetting({
    default: 2048 * KB, min: 256 * KB, max: 8192 * KB, admin: 'Admin',
    envVar: 'US_LISTING_MAX_RESPONSE_BYTES',
    description: 'How much of the US Yahoo news-listing page is read.',
    location: 'lib/yahoo-latest-news-discovery.js US_MAX_RESPONSE_BYTES'
  }),
  usListingMaxCandidates: numericSetting({
    default: 60, min: 10, max: 200, admin: 'Admin', envVar: 'US_LISTING_MAX_CANDIDATES',
    description: 'How many headline candidates are taken from the US Yahoo news-listing page.',
    location: 'lib/yahoo-latest-news-discovery.js US_MAX_CANDIDATES'
  }),
  mergedListingMaxCandidates: numericSetting({
    default: 90, min: 10, max: 300, admin: 'Admin', envVar: 'MERGED_LISTING_MAX_CANDIDATES',
    description: 'How many candidates survive once the US and non-US listing pages are merged.',
    location: 'lib/yahoo-latest-news-discovery.js MERGED_MAX_CANDIDATES'
  }),
  mostActiveMaxResponseBytes: numericSetting({
    default: 256 * KB, min: 64 * KB, max: 1024 * KB, admin: 'Admin',
    envVar: 'MOST_ACTIVE_MAX_RESPONSE_BYTES',
    description: 'How much of the Yahoo Most Active page is read.',
    location: 'lib/yahoo-most-active-acquisition.js MAX_RESPONSE_BYTES'
  }),
  mostActiveMaxCandidates: numericSetting({
    default: 10, min: 1, max: 30, admin: 'Admin', envVar: 'MOST_ACTIVE_MAX_CANDIDATES',
    description: 'How many symbols are taken from the Yahoo Most Active page.',
    location: 'lib/yahoo-most-active-acquisition.js MAX_CANDIDATES'
  }),

  // --- Request-size limits (Step 9F.2b: Kevin's 4 Oct 2026 500 KB / 300 KB
  // decision; supersedes Step 9F.2a's 128 KB / 64 KB live values) ---
  writerRequestLimitBytes: numericSetting({
    default: 500 * KB, min: 192 * KB, max: 600 * KB, admin: 'Admin',
    envVar: 'WRITER_REQUEST_LIMIT_BYTES',
    description: "The writer (final analysis) Claude request's size cap.",
    location: 'lib/claude-analysis-invocation.js CLAUDE_ANALYSIS_PROVISIONAL_MAX_REQUEST_BYTES'
  }),
  classifierRequestLimitBytes: numericSetting({
    default: 300 * KB, min: 64 * KB, max: 400 * KB, admin: 'Admin',
    envVar: 'CLASSIFIER_REQUEST_LIMIT_BYTES',
    description: "The evidence-role classifier Claude request's size cap.",
    location: 'lib/claude-evidence-role-classification.js '
      + 'CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES'
  }),

  // --- Yahoo recap's own page bounds: protected by Step 9F.1g's decision log
  // ("the 4 s page timeout and 1.5 MB page cap"). Moved into the table at
  // today's value but kept Fixed, so there is no override point. ---
  yahooRecapPageTimeoutMs: fixedSetting({
    default: 4000,
    description: "The Yahoo recap page's own fetch timeout. Protected by Step 9F.1g; not overridable.",
    location: 'lib/analysis-package-runtime.js yahooRecapPackageBounds timeoutMs'
  }),
  yahooRecapMaxResponseBytes: fixedSetting({
    default: 1572864,
    description: "The Yahoo recap page's own response-size cap. Protected by Step 9F.1g; not overridable.",
    location: 'lib/analysis-package-runtime.js yahooRecapPackageBounds maxResponseBytes'
  }),

  // --- Planned, wider budgets for the Step 9F.2 ranking/budget redesign (not
  // wired into any pipeline code; used only by the cross-check below). The
  // writer/classifier request limits are no longer duplicated here -- Step
  // 9F.2b merged them into the one live entry above. ---
  articleTextBudgetBytesPlanned: numericSetting({
    default: 150 * KB, min: 32 * KB, max: 200 * KB, admin: 'Admin',
    envVar: 'ARTICLE_TEXT_BUDGET_BYTES_PLANNED', wired: false,
    description: 'Planned total article-text budget for a run, once sources are ranked and '
      + 'shared across Yahoo/CNBC/portfolio slots.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  nonArticleOverheadBytesPlanned: numericSetting({
    default: 100 * KB, min: 32 * KB, max: 200 * KB, admin: 'Admin',
    envVar: 'NON_ARTICLE_OVERHEAD_BYTES_PLANNED', wired: false,
    description: 'Measured non-article overhead assumed when checking whether the planned '
      + 'article budget fits the planned writer limit.',
    location: 'new, used only by checkArticleBudgetFits below'
  }),

  // --- New: slots, spillover, per-source switches (not wired) ---
  yahooSlots: numericSetting({
    default: 7, min: 0, max: 10, admin: 'Admin', envVar: 'YAHOO_SLOTS', wired: false,
    description: 'Planned number of article slots given to Yahoo sources in a run.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  cnbcSlots: numericSetting({
    default: 3, min: 0, max: 6, admin: 'Admin', envVar: 'CNBC_SLOTS', wired: false,
    description: 'Planned number of article slots given to CNBC sources in a run.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  portfolioSlots: numericSetting({
    default: 2, min: 0, max: 4, admin: 'Admin', envVar: 'PORTFOLIO_SLOTS', wired: false,
    description: 'Planned number of article slots given to My Stocks/Watchlist sources in a run.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  cnbcMaxArticleAttempts: numericSetting({
    default: 6, min: 3, max: 12, admin: 'Admin', envVar: 'CNBC_MAX_ARTICLE_ATTEMPTS', wired: false,
    description: 'Planned attempt cap for CNBC article downloads (CNBC acquisition code is not '
      + 'touched in this step; this moves in Step 9F.6).',
    location: 'new, for the future CNBC attempt cap'
  }),
  spareAdmits: numericSetting({
    default: 3, min: 0, max: 5, admin: 'Admin', envVar: 'SPARE_ADMITS', wired: false,
    description: 'Planned number of spare admitted-article slots that can spill over between sources.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  slotSpilloverEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SLOT_SPILLOVER_ENABLED', wired: false,
    description: 'Planned on/off switch for letting an unfilled slot spill over to another source.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  yahooSourceEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'YAHOO_SOURCE_ENABLED', wired: false,
    description: 'Planned on/off switch for the Yahoo news source.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  cnbcSourceEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CNBC_SOURCE_ENABLED', wired: false,
    description: 'Planned on/off switch for the CNBC news source.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  portfolioSourceEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'PORTFOLIO_SOURCE_ENABLED', wired: false,
    description: 'Planned on/off switch for My Stocks/Watchlist as a news source.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),

  // --- New: ranking points and recency bonuses (not wired) ---
  rankingPointsUsMacro: numericSetting({
    default: 20, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_US_MACRO', wired: false,
    description: 'Planned ranking points for a US macro/market headline.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsMostActive: numericSetting({
    default: 12, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_MOST_ACTIVE', wired: false,
    description: 'Planned ranking points for a Most Active symbol match.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsPortfolio: numericSetting({
    default: 8, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_PORTFOLIO', wired: false,
    description: 'Planned ranking points for a My Stocks/Watchlist symbol match.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsWirePublishers: numericSetting({
    default: 5, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_WIRE_PUBLISHERS', wired: false,
    description: 'Planned ranking points for a wire-service publisher byline.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsIncludeWords: numericSetting({
    default: 5, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_INCLUDE_WORDS', wired: false,
    description: 'Planned ranking points for an include-word list match.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsAsiaEurope: numericSetting({
    default: 3, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_ASIA_EUROPE', wired: false,
    description: 'Planned ranking points for an Asia/Europe market headline.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  rankingPointsBenchmarkOrGeneric: numericSetting({
    default: 1, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_BENCHMARK_OR_GENERIC', wired: false,
    description: 'Planned ranking points for a generic benchmark/broad-market headline.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  recencyBonusUnder6h: numericSetting({
    default: 4, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_UNDER_6H', wired: false,
    description: 'Planned ranking bonus for an article published under the near-recency threshold.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  recencyBonus6to24h: numericSetting({
    default: 2, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_6_TO_24H', wired: false,
    description: 'Planned ranking bonus for an article published between the two recency thresholds.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  recencyBonusOver24h: numericSetting({
    default: 0, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_OVER_24H', wired: false,
    description: 'Planned ranking bonus for an article published beyond the far recency threshold.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  recencyThresholdHoursNear: numericSetting({
    default: 6, min: 1, max: 12, admin: 'Admin', envVar: 'RECENCY_THRESHOLD_HOURS_NEAR', wired: false,
    description: 'Planned near-recency threshold, in hours.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),
  recencyThresholdHoursFar: numericSetting({
    default: 24, min: 6, max: 72, admin: 'Admin', envVar: 'RECENCY_THRESHOLD_HOURS_FAR', wired: false,
    description: 'Planned far-recency threshold, in hours.',
    location: 'new, for the Step 9F.2 ranking/budget redesign'
  }),

  // --- Headline word lists: registered as Admin-editable-default pointers to
  // the real lists in lib/headline-lists.js (moves to Neon in Step 9G), not
  // duplicated here so there is no second source of truth. File untouched. ---
  headlineListUsMacroTerms: referenceSetting({
    default: 'see lib/headline-lists.js: US_MACRO_TERMS',
    description: 'Tier 2 US macro/market headline terms.',
    location: 'lib/headline-lists.js US_MACRO_TERMS'
  }),
  headlineListDropTerms: referenceSetting({
    default: 'see lib/headline-lists.js: DROP_TERMS',
    description: 'Tier 4a non-US-regional/personal-finance terms, dropped unless rescued.',
    location: 'lib/headline-lists.js DROP_TERMS'
  }),
  headlineListLastRankedTerms: referenceSetting({
    default: 'see lib/headline-lists.js: LAST_RANKED_TERMS',
    description: 'Tier 4b Asia/Europe market terms, kept and ranked last.',
    location: 'lib/headline-lists.js LAST_RANKED_TERMS'
  }),
  headlineListTier3aTerms: referenceSetting({
    default: 'see lib/headline-lists.js: TIER_3A_TERMS',
    description: 'Tier 3a generic benchmark/broad-market terms.',
    location: 'lib/headline-lists.js TIER_3A_TERMS'
  }),
  headlineListWirePartners: referenceSetting({
    default: 'see lib/headline-lists.js: WIRE_PARTNERS',
    description: 'Wire-service publisher names.',
    location: 'lib/headline-lists.js WIRE_PARTNERS'
  }),
  headlineListAmdExclusionPhrases: referenceSetting({
    default: 'see lib/headline-lists.js: AMD_EXCLUSION_PHRASES',
    description: 'Phrases that mean a headline\'s "AMD" is the eye disease, not the chipmaker.',
    location: 'lib/headline-lists.js AMD_EXCLUSION_PHRASES'
  }),

  // --- CNBC values: listed for visibility only. CNBC acquisition code and its
  // shared timing functions are not touched in this step; they move in Step 9F.6. ---
  cnbcMaxCandidates: referenceSetting({
    default: 20,
    description: 'CNBC candidate cap (left in place; moves in Step 9F.6).',
    location: 'lib/cnbc-news-research-runtime.js CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS'
      + '.candidateBounds.maxCandidates'
  }),
  cnbcPageTimeoutMs: referenceSetting({
    default: 4000,
    description: 'CNBC page fetch timeout (left in place; moves in Step 9F.6).',
    location: 'lib/cnbc-news-research-runtime.js / lib/cnbc-recap-research-runtime.js timeoutMs'
  }),
  cnbcMaxResponseBytes: referenceSetting({
    default: 1280 * KB,
    description: 'CNBC page response-size cap (left in place; moves in Step 9F.6).',
    location: 'lib/cnbc-news-research-runtime.js CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS'
      + '.articleRetrievalBounds.maxResponseBytes'
  }),
  cnbcMaxArticleTextBytes: referenceSetting({
    default: 8 * KB,
    description: 'CNBC article text cap (left in place; moves in Step 9F.6).',
    location: 'lib/cnbc-news-research-runtime.js CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS'
      + '.articleRetrievalBounds.maxArticleTextBytes'
  }),
  cnbcMaxEvidenceTextBytes: referenceSetting({
    default: 8 * KB,
    description: 'CNBC evidence text cap (left in place; moves in Step 9F.6).',
    location: 'lib/cnbc-news-research-runtime.js CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS'
      + '.evidenceConstructionBounds.maxEvidenceTextBytes'
  }),
  cnbcMaterialityRequestLimitBytes: referenceSetting({
    default: 64 * KB,
    description: 'CNBC news-materiality selection request cap (left in place; moves in Step 9F.6).',
    location: 'lib/claude-news-materiality-selection.js '
      + 'CLAUDE_NEWS_MATERIALITY_PROVISIONAL_MAX_REQUEST_BYTES'
  })
});

// The one reader: a setting's value, with an environment-variable override (for
// Admin settings only) applied and clamped, falling back to the default when
// the value is missing, not a number, or the setting is Fixed/unwired-to-env.
function settingValue(name, {env = process.env} = {}) {
  const entry = SETTINGS_REGISTRY[name];
  if (!entry) throw new TypeError(`Unknown setting: ${name}`);
  if (entry.admin !== 'Admin' || !entry.envVar) return entry.default;
  const raw = env[entry.envVar];
  if (raw === undefined) return entry.default;
  if (entry.boolean) return clampBooleanSetting(raw, entry.default);
  if (typeof entry.default !== 'number' || entry.min === undefined || entry.max === undefined) {
    return entry.default;
  }
  return clampSetting(raw, entry);
}

// Step 9F.2a cross-check (not wired into any pipeline code; unit-tested only):
// would the planned article-text budget, plus measured non-article overhead,
// fit inside the planned writer request limit? If not, the budget is lowered to
// fit and a warning is returned (not logged here -- that happens once this is
// actually wired in a later step).
function checkArticleBudgetFits({articleTextBudgetBytes, nonArticleOverheadBytes, writerRequestLimitBytes}) {
  const total = articleTextBudgetBytes + nonArticleOverheadBytes;
  if (total <= writerRequestLimitBytes) {
    return Object.freeze({fits: true, budgetBytes: articleTextBudgetBytes, warning: null});
  }
  const budgetBytes = Math.max(0, writerRequestLimitBytes - nonArticleOverheadBytes);
  return Object.freeze({
    fits: false,
    budgetBytes,
    warning: `articleTextBudgetBytes (${articleTextBudgetBytes}) plus nonArticleOverheadBytes `
      + `(${nonArticleOverheadBytes}) would exceed writerRequestLimitBytes `
      + `(${writerRequestLimitBytes}); lowered to ${budgetBytes}`
  });
}

module.exports = {
  SETTINGS_REGISTRY,
  clampSetting,
  clampBooleanSetting,
  settingValue,
  checkArticleBudgetFits,
  HOUR_MS
};

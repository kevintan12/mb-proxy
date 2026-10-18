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
    description: 'How many Yahoo news articles one run will try to download while the article slots '
      + 'are off (articleSlotsEnabled; Step 9F.2e.5).',
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS'
  }),
  yahooMaxAdmittedArticles: numericSetting({
    default: 6, min: 0, max: 10, admin: 'Admin', envVar: 'YAHOO_MAX_ADMITTED_ARTICLES',
    description: 'How many Yahoo news articles one run will admit into the report while the article '
      + 'slots are off (articleSlotsEnabled; Step 9F.2e.5). On, the general slots set this instead.',
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES'
  }),
  // Step 9F.2d.1 (Kevin, 11 Oct 2026): the attempt cap once slots are live.
  // Step 9F.2e.5: wired; used instead of yahooMaxArticleAttempts while
  // articleSlotsEnabled is on (the 12 above is used while it is off).
  yahooMaxArticleAttemptsPlanned: numericSetting({
    default: 18, min: 6, max: 24, admin: 'Admin', envVar: 'YAHOO_MAX_ARTICLE_ATTEMPTS_PLANNED',
    description: 'How many Yahoo news articles one run may try to download while the article slots '
      + 'are on (articleSlotsEnabled); yahooMaxArticleAttempts is used while they are off.',
    location: 'lib/source-reader.js sourceLimits (Step 9F.2e.5)'
  }),
  // Step 9F.2e.5 (Kevin, 16 Oct 2026): the general article slots. Wired; read
  // once per run. Off gives the previous caps (12 attempts, 6 admitted) exactly.
  articleSlotsEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'ARTICLE_SLOTS_ENABLED',
    description: 'On: the Yahoo news reader admits as many articles as its general slots allow '
      + '(yahooSlots, plus the unused slots of sources not yet in the selection step, through '
      + 'slotSpilloverEnabled and spareAdmits) and may try yahooMaxArticleAttemptsPlanned articles. '
      + 'Off: yahooMaxAdmittedArticles and yahooMaxArticleAttempts, as before.',
    location: 'lib/source-reader.js sourceLimits -> lib/article-selection.js generalSlotCapacity'
  }),
  yahooStaleLabelToleranceHours: numericSetting({
    default: 4, min: 0, max: 12, admin: 'Admin', envVar: 'YAHOO_STALE_LABEL_TOLERANCE_HOURS',
    description: "How much older than the reading window start a Yahoo page's own age label "
      + 'can claim before that candidate is tried last instead of first.',
    location: 'lib/us-analysis-package-orchestration.js ACTIVE_YAHOO_STALE_LABEL_TOLERANCE_MS '
      + '(stored there in milliseconds)'
  }),

  // --- Step 9F.6a.1: the shared source reader's own numbers. Moved in at
  // today's values from lib/us-analysis-package-orchestration.js and
  // lib/yahoo-news-reading.js; Fixed, so there is no override point. ---
  yahooInitialCandidateAttempts: fixedSetting({
    default: 5,
    description: 'How many Yahoo news downloads count as the first pass; trying more than this '
      + 'only sets the backfill flag in the logs.',
    location: 'lib/source-reader.js SOURCE_LIMIT_SETTINGS (was ACTIVE_YAHOO_INITIAL_CANDIDATE_ATTEMPTS)'
  }),
  auditMaxCandidatesPerEvent: fixedSetting({
    default: 10,
    description: 'How many candidates one candidate-audit log event may list.',
    location: 'lib/source-audit.js (was ACTIVE_YAHOO_AUDIT_MAX_CANDIDATES_PER_EVENT)'
  }),
  auditMaxEventBytes: fixedSetting({
    default: 3400,
    description: 'The largest size, in bytes, of one candidate-audit log event.',
    location: 'lib/source-audit.js (was ACTIVE_YAHOO_AUDIT_MAX_EVENT_BYTES)'
  }),
  auditFieldLimits: fixedSetting({
    default: Object.freeze({
      headlineCharacters: 80, headlineBytes: 120,
      publisherCharacters: 24, publisherBytes: 48,
      slugCharacters: 48, slugBytes: 48,
      ageLabelCharacters: 12, ageLabelBytes: 16,
      failureTypeCharacters: 48, failureTypeBytes: 48,
      listingOutcomeCharacters: 32, listingOutcomeBytes: 32,
      // Step 9F.2e.1: the shadow score's points summary in the candidate audit.
      scorePartsCharacters: 64, scorePartsBytes: 64
    }),
    description: 'How much of each text field the candidate audit and the reading summary keep.',
    location: 'lib/source-audit.js / lib/source-reader.js / lib/sources/yahoo-news.js '
      + '(were literals in lib/yahoo-news-reading.js)'
  }),
  maxClassificationEvidenceItems: referenceSetting({
    default: 50,
    description: 'How many evidence items the classifier accepts; the reader stops admitting '
      + 'articles that would go past it.',
    location: 'lib/claude-evidence-role-classification.js MAX_CLASSIFICATION_EVIDENCE_ITEMS'
  }),

  // --- Step 9F.6a.1: Further Readings numbers for Step 9F.2h (not wired). ---
  furtherReadingMaxLinks: numericSetting({
    default: 15, min: 5, max: 30, admin: 'Admin', envVar: 'FURTHER_READING_MAX_LINKS', wired: false,
    description: 'Planned largest number of links Further Readings may show.',
    location: 'new, for Step 9F.2h'
  }),
  furtherReadingExtrasBudgetSeconds: numericSetting({
    default: 10, min: 5, max: 30, admin: 'Admin', envVar: 'FURTHER_READING_EXTRAS_BUDGET_SECONDS',
    wired: false,
    description: 'Planned time budget for checking extra Further Readings candidates after the '
      + 'main reading.',
    location: 'new, for Step 9F.2h'
  }),
  furtherReadingExtrasMinScore: numericSetting({
    default: 12, min: 0, max: 58, admin: 'Admin', envVar: 'FURTHER_READING_EXTRAS_MIN_SCORE',
    wired: false,
    description: 'Planned lowest article score an extra Further Readings candidate needs.',
    location: 'new, for Step 9F.2h'
  }),

  // --- Page timeouts and listing caps ---
  pageTimeoutMs: numericSetting({
    default: 4000, min: 2000, max: 8000, admin: 'Admin', envVar: 'PAGE_TIMEOUT_MS',
    description: 'The fetch timeout for a single Yahoo or Federal Reserve page, outside the '
      + 'recap page and the US listing page. Step 9F.6c: also the CNBC page read for the shared '
      + 'source reader (read on each call); the older CNBC recap and paid-search reads keep their own 4 s.',
    location: 'DEFAULT_TIMEOUT_MS, duplicated across lib/federal-reserve-monetary-policy-'
      + 'evidence-acquisition.js, lib/yahoo-current-news-article-content-acquisition.js, '
      + 'lib/cnbc-article-content-acquisition.js readPage (per call), '
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
  // Step 9F.2e.6 + 9F.2g (Kevin, 17 Oct 2026): switched on. While
  // articleTextBudgetEnabled is on, the total article text of the run's
  // admitted Yahoo general/portfolio news, plus CNBC news and both recaps
  // (counted, never dropped), must fit this budget; over it, the
  // lowest-scored Yahoo general articles go first, then Yahoo portfolio
  // articles. Off, the Step 9F.1f temporary trim runs exactly as before.
  // Step 9F.6d Build B: in completed states CNBC news now comes from the
  // shared reader (at most cnbcSlots articles) and is still never dropped.
  articleTextBudgetBytesPlanned: numericSetting({
    default: 150 * KB, min: 32 * KB, max: 200 * KB, admin: 'Admin',
    envVar: 'ARTICLE_TEXT_BUDGET_BYTES_PLANNED', wired: true,
    description: 'Total article-text budget for a run, shared across Yahoo general/portfolio news, '
      + 'CNBC news and both recaps. Over it, the lowest-scored Yahoo general articles go first, then '
      + 'Yahoo portfolio articles; CNBC and recaps are never dropped and nothing is shortened.',
    location: 'lib/article-selection.js applyWriterBudget, called from '
      + 'lib/us-analysis-package-orchestration.js (Step 9F.2e.6)'
  }),
  nonArticleOverheadBytesPlanned: numericSetting({
    default: 100 * KB, min: 32 * KB, max: 200 * KB, admin: 'Admin',
    envVar: 'NON_ARTICLE_OVERHEAD_BYTES_PLANNED', wired: false,
    description: 'Measured non-article overhead assumed when checking whether the article '
      + 'budget fits the writer limit (checkArticleBudgetFits cross-check only; not itself read by '
      + 'the pipeline).',
    location: 'new, used only by checkArticleBudgetFits below'
  }),
  // Step 9F.2e.6 + 9F.2g (Kevin, 17 Oct 2026). On: the writer text budget
  // above runs in the orchestration before the writer sees any article, and
  // the Step 9F.1f temporary trim is skipped entirely (no article is both
  // dropped and shortened). Off: byte-identical to 72ac47c (temporary trim
  // only, budget never called).
  articleTextBudgetEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'ARTICLE_TEXT_BUDGET_ENABLED',
    description: 'On: the 150 KB writer text budget runs on the admitted Yahoo news (general and '
      + 'portfolio), counting CNBC news and both recaps as never-dropped weight, before the writer '
      + "request is built; the Step 9F.1f temporary trim is skipped. Off: today's temporary trim only.",
    location: 'lib/us-analysis-package-orchestration.js; lib/claude-analysis-invocation.js attemptClaudeAnalysis'
  }),

  // --- Slots, spillover, per-source switches. Step 9F.2e.5: the general
  // slots and spillover are wired while articleSlotsEnabled is on. ---
  yahooSlots: numericSetting({
    default: 7, min: 0, max: 10, admin: 'Admin', envVar: 'YAHOO_SLOTS',
    description: 'Number of general article slots given to Yahoo sources in a run (while '
      + 'articleSlotsEnabled is on).',
    location: 'lib/article-selection.js generalSlotCapacity -> fillGeneralSlots (Step 9F.2e.5)'
  }),
  cnbcSlots: numericSetting({
    default: 3, min: 0, max: 6, admin: 'Admin', envVar: 'CNBC_SLOTS',
    description: 'Number of general article slots given to CNBC sources in a run; also the CNBC '
      + 'admitted cap while articleSlotsEnabled is off (Step 9F.6d). Step 9F.6d Build B: in Closed, Weekend '
      + 'and Holiday runs (cnbcSharedReaderCompletedEnabled on) CNBC is read first and fills up to these '
      + 'slots; the slots it leaves unused pass to Yahoo while slotSpilloverEnabled is on. In active states '
      + 'CNBC is not read, so all of them pass to Yahoo.',
    location: 'lib/article-selection.js generalSlotCapacity -> fillGeneralSlots (Step 9F.2e.5); '
      + 'lib/source-reader.js SOURCE_LIMIT_SETTINGS us.cnbc (Step 9F.6d)'
  }),
  // Step 9F.2d.3: wired; read once per run while portfolioSlotsEnabled is on.
  portfolioSlots: numericSetting({
    default: 2, min: 0, max: 4, admin: 'Admin', envVar: 'PORTFOLIO_SLOTS',
    description: 'Number of article slots for articles naming a company on My Stocks or the '
      + 'Watchlist (both lists), on top of the general slots (while portfolioSlotsEnabled is on).',
    location: 'lib/source-reader.js sourceLimits -> lib/portfolio-slots.js createPortfolioSlotTracker '
      + '(Step 9F.2d.3); also lib/article-selection.js pickPortfolioSlots'
  }),
  // Step 9F.2d.1: how many articles per company the portfolio-slot picker
  // (lib/portfolio-slots.js) takes before any company gets a second one.
  // Step 9F.2d.3: wired, used while portfolioSlotsEnabled is on.
  portfolioFirstPassPerCompany: fixedSetting({
    default: 1,
    description: 'How many articles each company on My Stocks or the Watchlist may take in the first '
      + 'pass of the portfolio slots, before any slot goes to a second article for a company. A '
      + 'general-slot article naming the company counts as one.',
    location: 'lib/source-reader.js sourceLimits -> lib/portfolio-slots.js createPortfolioSlotTracker '
      + '(Step 9F.2d.3); also lib/article-selection.js pickPortfolioSlots'
  }),
  // Step 9F.2d.3 (Kevin, 11 and 17 Oct 2026): the portfolio slots. Read once
  // per run. Off gives exactly the Step 9F.2e.5 behaviour.
  portfolioSlotsEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'PORTFOLIO_SLOTS_ENABLED',
    description: 'On: once the general slots are full, the Yahoo news reader keeps trying articles that '
      + 'name a company on My Stocks or the Watchlist not yet covered, for portfolioSlots more articles '
      + '(first pass one per company, then any portfolio article), and completed-day Yahoo news naming '
      + 'a company is offered to Section 4 for that company. Off: as before (no portfolio slots; the '
      + 'candidate pool flag uses only the list that started the run).',
    location: 'lib/source-reader.js sourceLimits/readSource; lib/us-analysis-package-orchestration.js'
  }),
  // Step 9F.6d Build A: CNBC's row in the shared reader points at these. Nothing
  // reads CNBC through the shared reader until Step 9F.6d Build B.
  cnbcMaxArticleAttempts: numericSetting({
    default: 6, min: 3, max: 12, admin: 'Admin', envVar: 'CNBC_MAX_ARTICLE_ATTEMPTS',
    description: 'How many CNBC news articles one run may try to download through the shared reader '
      + '(article slots on or off). Retries do not count.',
    location: 'lib/source-reader.js SOURCE_LIMIT_SETTINGS us.cnbc (Step 9F.6d)'
  }),
  cnbcReadingBudgetSeconds: numericSetting({
    default: 20, min: 10, max: 60, admin: 'Admin', envVar: 'CNBC_READING_BUDGET_SECONDS',
    description: 'How long the CNBC news reading keeps downloading before it stops starting new '
      + 'downloads or retries.',
    location: 'lib/source-reader.js SOURCE_LIMIT_SETTINGS us.cnbc (Step 9F.6d)'
  }),
  cnbcInitialCandidateAttempts: fixedSetting({
    default: 3,
    description: 'How many CNBC news downloads count as the first pass; trying more only sets the '
      + 'backfill flag in the logs.',
    location: 'lib/source-reader.js SOURCE_LIMIT_SETTINGS us.cnbc (Step 9F.6d)'
  }),
  spareAdmits: numericSetting({
    default: 3, min: 0, max: 5, admin: 'Admin', envVar: 'SPARE_ADMITS',
    description: 'Largest number of spare general slots one source may receive from other '
      + 'sources that could not fill their own (while articleSlotsEnabled is on).',
    location: 'lib/article-selection.js generalSlotCapacity -> fillGeneralSlots (Step 9F.2e.5)'
  }),
  slotSpilloverEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SLOT_SPILLOVER_ENABLED',
    description: 'On/off switch for letting an unfilled general slot pass to another source (while '
      + 'articleSlotsEnabled is on).',
    location: 'lib/article-selection.js generalSlotCapacity -> fillGeneralSlots (Step 9F.2e.5)'
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
  // Step 9F.2f (Kevin, 10 Oct 2026 decision: CNBC gets no special conditions).
  // Wired; read once per run. Off gives exactly the 907aacf behaviour (the
  // post-classifier materiality/role gate that only general CNBC evidence had).
  cnbcNoSpecialConditionsEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CNBC_NO_SPECIAL_CONDITIONS_ENABLED',
    description: 'On: general CNBC evidence is admitted on the same terms as Yahoo news and the base '
      + 'evidence items -- the classifier still roles and scores it, but no CNBC-only materiality/role '
      + 'gate drops it afterward. Off: as before (general CNBC evidence is kept only when the classifier '
      + "gave it HIGH or MEDIUM materiality and a MATERIAL_EVENT or PRINCIPAL_CATALYST role).",
    location: 'lib/us-analysis-package-orchestration.js (retainedCnbcConstructedEvidence)'
  }),
  // Step 9F.2e.4a (Kevin, 13 Oct 2026): the reader's try order. Wired; read
  // once per run. Off gives the tier order exactly as before.
  scoreTryOrderEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SCORE_TRY_ORDER_ENABLED',
    description: 'On: the Yahoo news reader tries articles best score first (ties: the newer article, '
      + "then listing order). Off: today's tier order. Which articles are dropped, and old-label "
      + 'articles going last, are the same either way.',
    location: 'lib/source-reader.js readSource -> lib/article-selection.js scoreTryOrder (on) / tierTryOrder (off)'
  }),
  // Step 8P.2(b) + 8P.3 (Kevin, 15 Oct 2026): Pre-market, Trading and After-Hours
  // reports lead with what has happened since the last close. Wired; read once per
  // writer request. Off gives the previous writer request exactly, byte for byte.
  sinceCloseLeadEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SINCE_CLOSE_LEAD_ENABLED',
    description: 'On: in PRE, REGULAR and POST the writer is told the last close time, sees each '
      + 'admitted after-close article marked with its publish time, and is told to open Sections 1 '
      + 'and 2 (and lead Section 3) with what has happened since the close, then the close as '
      + '"where we left off". Off: the previous writer request. Closed, weekend and holiday '
      + 'reports are the same either way.',
    location: 'lib/claude-model-input-projection.js projectClaudeAnalysisInput + '
      + 'lib/claude-analysis-invocation.js sinceCloseLeadInstruction'
  }),
  // Step 21D.1 (Kevin, 17 Oct 2026): Section 4 gives a reason for a stock's move
  // only when an article linked to that stock is cited in Section 4. Read once
  // per writer request and once per cleanup. Off gives the 3d5f595 behaviour
  // exactly, byte for byte.
  sectionFourCauseCheckEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SECTION_FOUR_CAUSE_CHECK_ENABLED',
    description: 'On: in every market state the writer is told to give a Section 4 reason only from '
      + 'a cited article linked to that stock, and every Section 4 sentence about a stock with no '
      + 'such article is cut back to its move facts (direction, amount, percent, price, day, prior '
      + 'close, index comparison). Off: as before.',
    location: 'lib/section-rules.js sectionFourCauseCut; lib/claude-analysis-invocation.js '
      + 'normalizeDynamicReferenceViolations + sectionFourCauseInstruction'
  }),
  // Step 21D.2 (Kevin, 17 Oct 2026): Section 4 covers My Stocks and the Watchlist
  // together, whichever list started the brief. Read at call time. Off gives the
  // ad61dd6 behaviour exactly, byte for byte.
  sectionFourBothListsEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'SECTION_FOUR_BOTH_LISTS_ENABLED',
    description: 'On: Section 4 covers every stock in My Stocks, then every stock in the Watchlist, in '
      + 'their saved order, as one section, whichever list started the brief; its allowed references, '
      + 'checks, Section 4 reason check and empty-list wording use both lists. Off: Section 4 covers '
      + 'only the list that started the brief, as before.',
    location: 'lib/section-rules.js sectionFourPortfolio + sectionFourEmptyContent; '
      + 'lib/claude-model-input-projection.js; lib/claude-analysis-invocation.js; '
      + 'lib/claude-analysis-contract.js; lib/us-analysis-package-orchestration.js'
  }),
  // Step 9L (Kevin, 18 Oct 2026): after a successful writer reply, an empty Section
  // 1, 2, 3, 5, 6 or 7 is written again (one writer call per round, covering every
  // still-empty section); sections that already survived are never changed. Off
  // gives the c3c7ee5 behaviour exactly, byte for byte.
  writerSectionRetryEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'WRITER_SECTION_RETRY_ENABLED',
    description: 'On: an empty Section 1, 2, 3, 5, 6 or 7 (never 4 or 8, never one the code blanks '
      + 'by design) is retried with a changed instruction and the same checks; the result is kept only '
      + 'when every section that already survived is unchanged and a retried section now has text. '
      + 'Off: no section retry, as before.',
    location: 'lib/writer-section-retry.js runWriterSectionRetry; lib/claude-analysis-invocation.js '
      + 'invokeClaudeAnalysis'
  }),
  writerSectionRetryCount: numericSetting({
    default: 2, min: 0, max: 3, admin: 'Admin', envVar: 'WRITER_SECTION_RETRY_COUNT',
    description: 'How many section-retry rounds may run per report (each round is one writer call '
      + 'covering every still-empty section). 0 = no section retry.',
    location: 'lib/writer-section-retry.js runWriterSectionRetry'
  }),
  writerSectionRetryMaxElapsedMs: numericSetting({
    default: 150000, min: 60000, max: 200000, admin: 'Admin', envVar: 'WRITER_SECTION_RETRY_MAX_ELAPSED_MS',
    description: 'No new section-retry round starts once this much time has passed since the writer '
      + 'stage began (milliseconds).',
    location: 'lib/writer-section-retry.js runWriterSectionRetry'
  }),
  writerSectionRetryMaxSentences: numericSetting({
    default: 4, min: 2, max: 8, admin: 'Admin', envVar: 'WRITER_SECTION_RETRY_MAX_SENTENCES',
    description: 'Round 2 and later: the most sentences a retried section may have; a longer one is '
      + 'not used.',
    location: 'lib/writer-section-retry.js sectionRetryInstruction + mergeSectionRetryTransport'
  }),
  writerCallsPerRunMax: numericSetting({
    default: 3, min: 1, max: 4, admin: 'Admin', envVar: 'WRITER_CALLS_PER_RUN_MAX',
    description: 'The most writer calls per report: the first call, the whole-report retry and every '
      + 'section-retry round all count. 1 = no retry of any kind.',
    location: 'lib/claude-analysis-invocation.js invokeClaudeAnalysis; lib/contract-retry.js'
  }),
  // Step 9L, decision 3 (Kevin, 18 Oct 2026): the whole-report writer retry names
  // the broken rule (category only) instead of repeating the identical request, and
  // a whole-report failure logs which section and field broke which rule. Off gives
  // the identical retry of c3c7ee5, byte for byte.
  writerRetryGuidanceEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'WRITER_RETRY_GUIDANCE_ENABLED',
    description: 'On: when the whole writer reply fails the checks, the one retry tells the writer '
      + 'which rule it broke and in which section (rule category only, no report text), and the logs '
      + 'show the section, field and rule category of the failure. Off: the identical retry, as before.',
    location: 'lib/writer-section-retry.js contractFailureCategories + retryGuidanceInstruction; '
      + 'lib/claude-analysis-invocation.js invokeClaudeAnalysis'
  }),
  // Step 9F.4c (Kevin, 18 Oct 2026): the labelling-step (classifier) retry names the
  // broken rule category and the references involved; off gives the identical retry
  // of f8d56c9. The retry count was the fixed Step 8L value of 1.
  classifierRetryGuidanceEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CLASSIFIER_RETRY_GUIDANCE_ENABLED',
    description: 'On: when the labelling step fails its own checks, its retry tells it which rule it '
      + 'broke and for which references (rule category and references only, no article or reply text), '
      + 'and the logs show the same. Off: the identical retry, as before.',
    location: 'lib/claude-evidence-role-classification.js invokeClaudeEvidenceRoleClassification'
  }),
  classifierRetryCount: numericSetting({
    default: 1, min: 0, max: 2, admin: 'Admin', envVar: 'CLASSIFIER_RETRY_COUNT',
    description: 'How many times the labelling step is retried after it fails its own checks '
      + '(never for input, size, network, key or rate-limit errors, a reply cut off at the token '
      + 'limit, or after 150 s). 0 = no retry.',
    location: 'lib/claude-evidence-role-classification.js invokeClaudeEvidenceRoleClassification; '
      + 'lib/contract-retry.js'
  }),
  // Step 8W (Kevin, 18 Oct 2026): readable publish and report-time labels for the
  // writer in every market state, one shared date instruction, and the sentence trim
  // for a wrong weekday or (Section 7) a past date. Off: identical to f8d56c9.
  dateAccuracyEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'DATE_ACCURACY_ENABLED',
    description: 'On: every article the writer receives carries a readable ET publish label and the '
      + 'request carries one readable report-time label; one instruction tells the writer how to count '
      + 'day words and that anything dated before the report time is not upcoming; a sentence naming a '
      + 'weekday the cited evidence does not support, or (Section 7) an explicit date before the report '
      + 'date, is removed. Off: none of this, as before.',
    location: 'lib/claude-model-input-projection.js; lib/claude-analysis-invocation.js '
      + 'dateAccuracyInstruction + DATE_ACCURACY handler; lib/section-rules.js dateAccuracyCut'
  }),

  // --- Ranking points and recency bonuses. Registered as "planned/not wired"
  // in Step 9F.2a (`wired` stays false here -- see the Step 9F.2e.4b decision
  // log entry: flipping it would need re-deriving the >=30-unwired-settings
  // count test, so it is left as documentation-only drift, not a behaviour
  // change); their descriptions now say what is actually true since Step
  // 9F.2e.4a: lib/article-score.js reads every one of these live, and
  // lib/source-reader.js's try order uses them whenever the Admin switch
  // scoreTryOrderEnabled is on. ---
  rankingPointsUsMacro: numericSetting({
    default: 20, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_US_MACRO', wired: false,
    description: 'Ranking points for a US macro/market headline. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsMostActive: numericSetting({
    default: 12, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_MOST_ACTIVE', wired: false,
    description: 'Ranking points for a Most Active symbol match. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsPortfolio: numericSetting({
    default: 8, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_PORTFOLIO', wired: false,
    description: 'Ranking points for a My Stocks/Watchlist symbol match. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsWirePublishers: numericSetting({
    default: 5, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_WIRE_PUBLISHERS', wired: false,
    description: 'Ranking points for a wire-service publisher byline. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsIncludeWords: numericSetting({
    default: 5, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_INCLUDE_WORDS', wired: false,
    description: 'Ranking points for an include-word list match. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsAsiaEurope: numericSetting({
    default: 3, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_ASIA_EUROPE', wired: false,
    description: 'Ranking points for an Asia/Europe market headline. Read live by lib/article-score.js; '
      + "steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  rankingPointsBenchmarkOrGeneric: numericSetting({
    default: 1, min: 0, max: 40, admin: 'Admin', envVar: 'RANKING_POINTS_BENCHMARK_OR_GENERIC', wired: false,
    description: 'Ranking points for a generic benchmark/broad-market headline. Read live by '
      + "lib/article-score.js; steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  // Step 9F.2e.4b (Kevin's decision, 12 Oct 2026 Pre-market run evidence): a
  // headline whose only matched macro term(s) are AI-theme words (see
  // AI_THEME_TERMS in lib/headline-lists.js) scores this value instead of the
  // full rankingPointsUsMacro value. Either/or, never both.
  rankingPointsAiTheme: numericSetting({
    default: 8, min: 0, max: 20, admin: 'Admin', envVar: 'RANKING_POINTS_AI_THEME', wired: false,
    description: 'Ranking points for a headline whose only matched US-macro term(s) are AI-theme '
      + 'words (AI, Artificial Intelligence, OpenAI, Anthropic, Nvidia, AMD), instead of the full '
      + "rankingPointsUsMacro value. Read live by lib/article-score.js; steers the reader's try "
      + 'order whenever scoreTryOrderEnabled is on.',
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  recencyBonusUnder6h: numericSetting({
    default: 4, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_UNDER_6H', wired: false,
    description: 'Ranking bonus for an article published under the near-recency threshold. Read live '
      + "by lib/article-score.js; steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  recencyBonus6to24h: numericSetting({
    default: 2, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_6_TO_24H', wired: false,
    description: 'Ranking bonus for an article published between the two recency thresholds. Read '
      + "live by lib/article-score.js; steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  recencyBonusOver24h: numericSetting({
    default: 0, min: 0, max: 8, admin: 'Admin', envVar: 'RECENCY_BONUS_OVER_24H', wired: false,
    description: 'Ranking bonus for an article published beyond the far recency threshold. Read live '
      + "by lib/article-score.js; steers the reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  recencyThresholdHoursNear: numericSetting({
    default: 6, min: 1, max: 12, admin: 'Admin', envVar: 'RECENCY_THRESHOLD_HOURS_NEAR', wired: false,
    description: 'Near-recency threshold, in hours. Read live by lib/article-score.js; steers the '
      + "reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),
  recencyThresholdHoursFar: numericSetting({
    default: 24, min: 6, max: 72, admin: 'Admin', envVar: 'RECENCY_THRESHOLD_HOURS_FAR', wired: false,
    description: 'Far-recency threshold, in hours. Read live by lib/article-score.js; steers the '
      + "reader's try order whenever scoreTryOrderEnabled is on.",
    location: 'lib/article-score.js scoreArticle -> lib/source-reader.js / lib/article-selection.js scoreTryOrder'
  }),

  // --- Headline word lists: registered as Admin-editable-default pointers to
  // the real lists in lib/headline-lists.js (moves to Neon in Step 9G), not
  // duplicated here so there is no second source of truth. File untouched. ---
  headlineListUsMacroTerms: referenceSetting({
    default: 'see lib/headline-lists.js: US_MACRO_TERMS',
    description: 'Tier 2 US macro/market headline terms.',
    location: 'lib/headline-lists.js US_MACRO_TERMS'
  }),
  // Step 9F.2e.4b: a subset of US_MACRO_TERMS -- see AI_THEME_TERMS above.
  headlineListAiThemeTerms: referenceSetting({
    default: 'see lib/headline-lists.js: AI_THEME_TERMS',
    description: 'AI-theme and chip-company words (a subset of the US macro list) that score '
      + 'rankingPointsAiTheme instead of the full rankingPointsUsMacro when they are the only '
      + 'matched macro term(s).',
    location: 'lib/headline-lists.js AI_THEME_TERMS'
  }),
  headlineListDropTerms: referenceSetting({
    default: 'see lib/headline-lists.js: DROP_TERMS',
    description: 'Tier 4a non-US-regional/personal-finance terms, dropped unless rescued.',
    location: 'lib/headline-lists.js DROP_TERMS'
  }),
  headlineListHowToPatterns: referenceSetting({
    default: 'see lib/headline-lists.js: HOW_TO_DROP_PREFIXES',
    description: 'Tier 4a drop patterns that only count at the start of a headline ("how to"), '
      + 'with the same protection as the drop terms.',
    location: 'lib/headline-lists.js HOW_TO_DROP_PREFIXES (was inline in lib/source-ranking.js)'
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

  // --- Step 9F.6b (Kevin, 18 Oct 2026): the CNBC RSS finder (lib/sources/cnbc-rss.js)
  // and its read-only Preview probe (lib/cnbc-rss-probe.js). Nothing in the
  // pipeline calls the finder yet (Steps 9F.6c/9F.6d connect it). ---
  cnbcRssFinderEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CNBC_RSS_FINDER_ENABLED',
    description: 'On: the CNBC RSS finder reads the CNBC lists when asked. Off: it makes no request and '
      + 'returns no candidates. Step 9F.6d Build B: Closed, Weekend and Holiday reports read CNBC news '
      + 'through it (cnbcSharedReaderCompletedEnabled on); off there means no CNBC news (the CNBC gap '
      + 'line, all 10 slots to Yahoo, no paid search). Off also changes what the probe shows.',
    location: 'lib/sources/cnbc-rss.js createCnbcRssSource'
  }),
  cnbcRssLists: fixedSetting({
    // Top News, Economy, Finance, Investing, Earnings, Tech, Business (Kevin,
    // 18 Oct 2026). Market Insider (20409666) is left out: ~90% movers pages.
    default: Object.freeze(['100003114', '20910258', '10000664', '15839069', '15839135', '19854910', '10001147']),
    description: 'The CNBC RSS list ids the finder reads, in order.',
    location: 'lib/sources/cnbc-rss.js readCnbcRssLists'
  }),
  cnbcRssTimeoutMs: numericSetting({
    default: 4000, min: 1000, max: 10000, admin: 'Admin', envVar: 'CNBC_RSS_TIMEOUT_MS',
    description: 'How long the finder waits for one CNBC RSS list, in milliseconds.',
    location: 'lib/sources/cnbc-rss.js readList'
  }),
  cnbcRssMaxResponseKb: fixedSetting({
    default: 512,
    description: 'Largest CNBC RSS list response read, in KB (lists are about 20 KB).',
    location: 'lib/sources/cnbc-rss.js readBoundedBody'
  }),
  cnbcRssMaxCandidates: numericSetting({
    default: 40, min: 10, max: 100, admin: 'Admin', envVar: 'CNBC_RSS_MAX_CANDIDATES',
    description: 'Most CNBC RSS candidates kept, after the filters, the duplicate check and newest-first order.',
    location: 'lib/sources/cnbc-rss.js selectCnbcRssCandidates'
  }),
  cnbcRssMoversPatterns: fixedSetting({
    // Address patterns run on the page path; title patterns on the trimmed
    // title; both case-insensitive. A page matching either is a movers page.
    default: Object.freeze({
      address: Object.freeze([
        'stocks-making-the-biggest-moves-(?:midday|premarket|after-hours)-',
        'stocks-moving-(?:premarket|midday|after-hours)',
        '(?:premarket|midday|after-hours)-stock-movers'
      ]),
      title: Object.freeze([
        '^stocks making the biggest moves\\b',
        '^stocks moving (?:big )?(?:premarket|midday|after hours)\\b'
      ])
    }),
    description: 'The "biggest movers" rule: a CNBC page whose address or title matches is never a candidate.',
    location: 'lib/sources/cnbc-rss.js moversMatch'
  }),
  cnbcRssProbeEnabled: booleanSetting({
    default: false, admin: 'Admin', envVar: 'CNBC_RSS_PROBE_ENABLED',
    description: 'Diagnostic only. On: GET ?cnbcRssProbe=1 shows what the CNBC lists return (never in '
      + 'Production: there it always answers "not found", a Fixed rule). Off: the probe answers "not found".',
    location: 'lib/cnbc-rss-probe.js handleCnbcRssProbe (api/quote.js ?cnbcRssProbe=1)'
  }),
  cnbcRssProbePages: numericSetting({
    default: 0, min: 0, max: 3, admin: 'Fixed',
    description: 'Default and cap for the probe\'s page option (&pages=N): how many kept candidates\' pages '
      + 'it downloads to show each page\'s own publish time next to the list time.',
    location: 'lib/cnbc-rss-probe.js probePageCount'
  }),

  // --- Step 9F.6c (Kevin, 18 Oct 2026): the CNBC page reader for the shared
  // source reader. Nothing calls it until Step 9F.6d. ---
  cnbcPageReaderAlignedEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CNBC_PAGE_READER_ALIGNED_ENABLED',
    description: 'On: the CNBC page reader for the shared source reader reads a page on Yahoo\'s terms '
      + '(shared retries, first articleKb of text kept, the page\'s own publish time alone decides, wire '
      + 'stories read). Off: it downloads nothing and answers "disabled". Step 9F.6d Build B: Closed, '
      + 'Weekend and Holiday reports read CNBC pages through it (cnbcSharedReaderCompletedEnabled on); off '
      + 'there means no CNBC news (the CNBC gap line, all 10 slots to Yahoo, no paid search). The older '
      + 'CNBC recap and paid-search page reads are not affected.',
    location: 'lib/cnbc-article-content-acquisition.js readPage'
  }),

  // --- Step 9F.6d Build B (Kevin, 18 Oct 2026): CNBC news in completed states
  // through the shared source reader. Read once per run, completed states only.
  // Off gives exactly the 2532952 behaviour (the paid CNBC search). ---
  cnbcSharedReaderCompletedEnabled: booleanSetting({
    default: true, admin: 'Admin', envVar: 'CNBC_SHARED_READER_COMPLETED_ENABLED',
    description: 'On: Closed, Weekend and Holiday reports read CNBC news from the free CNBC lists '
      + 'through the shared source reader, before Yahoo. CNBC keeps up to cnbcSlots articles (never '
      + 'pushed out by Yahoo); Yahoo gets its own slots plus the ones CNBC leaves unused. The paid CNBC '
      + 'search runs only when every CNBC list failed, and keeps its first cnbcSlots results. CNBC news '
      + 'is kept when the classifier fails. Off: as before (the paid CNBC search). Pre, Regular and '
      + 'After-Hours are the same either way.',
    location: 'lib/us-analysis-package-orchestration.js acquireAnalysisMaterial; '
      + 'lib/analysis-package-runtime.js (cnbcNewsSource)'
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

// Step 9F.2c.2 safety check (not wired into any pipeline code; unit-tested only):
// none of the three recency bonuses may reach or exceed the US macro points, so a
// fresh article without a macro/market word can never outrank one that has one.
// Checks all three independently; a breaching value is clamped to
// rankingPointsUsMacro - 1 and a warning is recorded for it.
const RECENCY_BONUS_NAMES = Object.freeze(['recencyBonusUnder6h', 'recencyBonus6to24h', 'recencyBonusOver24h']);

function checkRecencyNeverOverridesMacro({env = process.env} = {}) {
  const macroPoints = settingValue('rankingPointsUsMacro', {env});
  const warnings = [];
  const values = {};
  for (const name of RECENCY_BONUS_NAMES) {
    let value = settingValue(name, {env});
    if (value >= macroPoints) {
      const clamped = Math.max(0, macroPoints - 1);
      warnings.push(`${name} (${value}) would reach or exceed rankingPointsUsMacro (${macroPoints}); `
        + `clamped to ${clamped}`);
      value = clamped;
    }
    values[name] = value;
  }
  return Object.freeze({
    safe: warnings.length === 0,
    values: Object.freeze(values),
    warning: warnings.length ? warnings.join('; ') : null
  });
}

module.exports = {
  SETTINGS_REGISTRY,
  clampSetting,
  clampBooleanSetting,
  settingValue,
  checkArticleBudgetFits,
  checkRecencyNeverOverridesMacro,
  HOUR_MS
};

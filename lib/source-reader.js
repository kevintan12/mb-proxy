// Step 9F.6a.3: the shared source reader. Yahoo's evidence-gathering method is
// the baseline every news source follows: reading window, try order, reading
// budget, download retries, result-to-decision mapping, article size cap,
// duplicate check, symbol tagging, evidence creation, classifier fit check and
// the candidate audit. A source supplies only how it finds candidates and how it
// reads one page:
//
//   {sourceId,
//    findCandidates({market, window, triggerAt}) -> {ok, candidates, discoveryStats},
//    readPage(url, {headline}) -> {ok: true, type: 'SUCCESS', articleContent}
//                               | {ok: false, type, httpStatus?, extractionFailureType?}}
//
// The loop is the Step 9F.1b-9F.1g Yahoo loop (formerly lib/yahoo-news-reading.js,
// removed in Step 9F.6a.6), moved here unchanged apart from taking the source as
// an input.
'use strict';

const {createEvidenceCollection} = require('./evidence-collections');
const {createEvidenceItem} = require('./evidence-items');
const {
  readingWindow,
  readingSettings,
  createReadingBudget,
  downloadWithRetries,
  firstBytes
} = require('./reading-window');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  MAX_CLASSIFICATION_EVIDENCE_ITEMS,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES
} = require('./claude-evidence-role-classification');
const {settingValue} = require('./settings-registry');
const {AUDIT_FIELD_LIMITS, sourceStageNames, truncatedText, auditSlug, auditEvents} =
  require('./source-audit');
const {rankCandidates, portfolioIdentitiesFrom, headlineSymbols} =
  require('./source-ranking');
const {scoreArticle} = require('./article-score');
const {headlineMatchesIdentity} = require('./headline-matching');
// Step 9F.2e.3.4b: the try order, the stop rule and the per-article classifier
// fit check come from the shared selection step (today's behaviour).
const {tierTryOrder, createReaderStopRule, checkListOrderFit} = require('./article-selection');

// Step 9F.2e.1: the shadow score's short points summary for the audit, e.g.
// "macro 20, wire 5, recency 2". Lists only the parts that scored.
const SCORE_PART_LABELS = Object.freeze({
  usMacro: 'macro', mostActive: 'most-active', portfolio: 'portfolio', wirePublishers: 'wire',
  includeWords: 'include', asiaEurope: 'asia-europe', benchmarkOrGeneric: 'generic'
});

function scorePartsText(scored) {
  const parts = Object.entries(SCORE_PART_LABELS)
    .filter(([name]) => scored.matched[name] > 0)
    .map(([name, label]) => `${label} ${scored.matched[name]}`);
  if (scored.recencyPoints > 0) parts.push(`recency ${scored.recencyPoints}`);
  return parts.length ? parts.join(', ') : 'none';
}

// Which settings-registry rows hold each source's limits.
const SOURCE_LIMIT_SETTINGS = Object.freeze({
  'us.yahoo-finance': Object.freeze({
    readingBudgetSeconds: 'yahooReadingBudgetSeconds',
    maxArticleAttempts: 'yahooMaxArticleAttempts',
    maxAdmittedArticles: 'yahooMaxAdmittedArticles',
    initialCandidateAttempts: 'yahooInitialCandidateAttempts'
  })
});

function sourceLimitSettings(sourceId) {
  const names = SOURCE_LIMIT_SETTINGS[sourceId];
  if (!names) throw new TypeError(`No limits for source: ${sourceId}`);
  return names;
}

// A source's attempt and admit caps and its first-pass size, read from the
// settings registry. The reading budget is read on every run instead.
function sourceLimits(sourceId, {env = process.env} = {}) {
  const names = sourceLimitSettings(sourceId);
  return Object.freeze({
    maxArticleAttempts: settingValue(names.maxArticleAttempts, {env}),
    maxAdmittedArticles: settingValue(names.maxAdmittedArticles, {env}),
    initialCandidateAttempts: settingValue(names.initialCandidateAttempts, {env})
  });
}

// Shared run context, fetched once before any source: Most Active feeds the
// ranking, the score and the symbol tagging for every source.
async function readRunContext({yahooMostActiveAcquisition, timed}) {
  let mostActive = [];
  try {
    const result = await timed('yahooMostActiveAcquisitionMs', () =>
      yahooMostActiveAcquisition.acquireMostActive());
    if (result?.ok === true && Array.isArray(result.candidates)) mostActive = result.candidates;
  } catch (error) {
    mostActive = [];
  }
  return Object.freeze({mostActive});
}

const FETCH_FAILURE_TYPES = Object.freeze(['TIMEOUT', 'RETRIEVAL_FAILURE', 'HTTP_FAILURE',
  'RESPONSE_READ_FAILURE', 'RESPONSE_TOO_LARGE']);

// Reads one source. Admitted items are pushed onto `acquiredItems`.
// `mode` is 'ACTIVE' or 'COMPLETED'. `horizonFor(publishedAt)` maps a publish
// time to its horizon, or null when there is no window to judge it by:
// active states pass CURRENT_SESSION while the session window exists;
// completed states pass COMPLETED_SESSION, or SUBSEQUENT_DEVELOPMENT after the
// completed close (Step 9F.1e). `requiredItems` is the evidence already
// gathered, for the classifier size and duplicate checks.
async function readSource({
  source,
  runContext: {mostActive},
  market = 'US',
  mode,
  timed,
  emit,
  acquisitionStartedAt,
  marketContext,
  benchmarkSnapshots,
  stockSnapshots,
  // Step 9F.2e.1: the list that started the run, for the pool's
  // portfolioSlotEligible flag only (one named input; Step 21D may widen it).
  portfolioSlotSnapshots = [],
  classificationPreflightAvailable,
  requiredItems,
  horizonFor,
  windowUnavailableReason = null,
  sessionWindow = null,
  acquiredItems,
  clock: {monotonicNow = () => performance.now(), sleep} = {},
  limits: {
    maxArticleAttempts,
    maxAdmittedArticles,
    initialCandidateAttempts
  }
}) {
  if (mode !== 'ACTIVE' && mode !== 'COMPLETED') throw new TypeError('mode must be ACTIVE or COMPLETED');
  if (typeof horizonFor !== 'function') throw new TypeError('horizonFor must be a function');
  const completed = mode === 'COMPLETED';
  const sourceId = source.sourceId;
  const stageNames = sourceStageNames(sourceId);
  const limitSettings = sourceLimitSettings(sourceId);
  const counts = {
    missingOrMalformedPublicationTimeCount: 0,
    beforeSessionWindowCount: 0,
    afterSessionWindowCount: 0,
    duplicateEvidenceCount: 0,
    activeWindowUnavailableCount: 0,
    benchmarkOverlayInvalidCount: 0,
    otherEvidenceConstructionRejectedCount: 0,
    selectedCandidateCount: 0,
    candidateConsideredCount: 0,
    articleFetchRequestFailureCount: 0,
    articleExtractionFailureCount: 0,
    articleMetadataFailureCount: 0,
    articleIdentityHeadlineMismatchCount: 0,
    articleBodyUnavailableCount: 0,
    articleCanonicalRedirectMismatchCount: 0,
    otherArticleExtractionRejectionCount: 0,
    activeWindowRejectionCount: 0,
    classifierPreflightRejectedCount: 0
  };
  let candidates = [];
  let discoveryStats = {};
  let staleByLabelCount = 0;
  let articleFetchAttemptCount = 0;
  let articleFetchSuccessCount = 0;
  // Step 9F.1d: downloads including retries, and whether the reading budget
  // stopped any download or retry from starting.
  let downloadAttemptCount = 0;
  let readingBudgetStopped = false;
  // Step 9F.1c: an article is admitted by its publish time alone, inside the reading
  // window (trigger back to the last close, plus the extension).
  let window = null;
  try {
    window = readingWindow({market, triggerAt: acquisitionStartedAt});
  } catch (error) {
    window = null;
  }
  try {
    const result = await timed(stageNames.listingTiming, () =>
      source.findCandidates({market, window, triggerAt: acquisitionStartedAt}));
    if (result?.ok === true && Array.isArray(result.candidates)) candidates = result.candidates;
    if (result?.discoveryStats && typeof result.discoveryStats === 'object') {
      discoveryStats = result.discoveryStats;
    }
  } catch (error) {
    candidates = [];
  }
  const selected = rankCandidates(mostActive, candidates, stockSnapshots);
  counts.selectedCandidateCount = selected.length;
  // Step 9F.2e.1: shadow score. Every candidate is scored with the shared score
  // from the same names the tier ranking used (both lists, Most Active) and the
  // trigger time, before download (recency from the age label). Written next to
  // the tier in the audit and the pool only; the order, decisions and caps
  // above and below still come from the tiers.
  const portfolioIdentities = portfolioIdentitiesFrom(stockSnapshots);
  const portfolioSlotIdentities = portfolioIdentitiesFrom(portfolioSlotSnapshots);
  const scores = selected.map(({candidate}) => scoreArticle(
    {headline: candidate?.headline, publisher: candidate?.publisher, ageLabel: candidate?.ageLabel},
    {triggerAt: acquisitionStartedAt, portfolioIdentities, mostActiveIdentities: mostActive}
  ));
  const auditEntries = selected.map(({candidate, tier, subTier}, index) => ({
    rank: index + 1,
    tier,
    subTier,
    score: scores[index].score,
    scoreParts: truncatedText(scorePartsText(scores[index]),
      AUDIT_FIELD_LIMITS.scorePartsCharacters, AUDIT_FIELD_LIMITS.scorePartsBytes),
    ...(scores[index].excludedByDropList ? {scoreDrop: true} : {}),
    headline: truncatedText(candidate.headline,
      AUDIT_FIELD_LIMITS.headlineCharacters, AUDIT_FIELD_LIMITS.headlineBytes),
    publisher: truncatedText(candidate.publisher,
      AUDIT_FIELD_LIMITS.publisherCharacters, AUDIT_FIELD_LIMITS.publisherBytes),
    slug: auditSlug(candidate.url),
    edition: candidate.edition === 'US' || candidate.edition === 'SG' ? candidate.edition : null,
    ageLabel: truncatedText(candidate.ageLabel,
      AUDIT_FIELD_LIMITS.ageLabelCharacters, AUDIT_FIELD_LIMITS.ageLabelBytes) || null,
    decision: selected[index].dropped ? 'SKIPPED_BELOW_RELEVANCE_FLOOR' : null
  }));
  // Step 9F.1e: an article already in the evidence (in completed states, the
  // Yahoo recap can also be on the news list) is a duplicate, not a second item.
  const seenUrls = new Set(requiredItems.map(item => item.canonicalUrl));
  const acquiredHorizons = [];
  // Step 9F.2e.3.4b: the classifier request this reader would send with the
  // trial article added, in UTF-8 bytes. The shared fit check
  // (checkListOrderFit, SKIP) runs the 50-item test, calls this, compares the
  // size with the limit and treats a throw from here as a misfit.
  function classifierRequestBytes(trial, trialHorizon) {
    const items = requiredItems.concat(acquiredItems, trial);
    const horizons = acquiredHorizons.concat(trialHorizon);
    const collection = createEvidenceCollection({market, items});
    const request = buildClaudeEvidenceRoleClassificationRequest(Object.freeze({
      marketContext: Object.freeze({
        market,
        exchangeTimezone: marketContext.exchangeTimezone,
        marketState: marketContext.marketState,
        primaryCompletedSessionDate: marketContext.primaryCompletedSessionDate
      }),
      benchmarkTelemetry: Object.freeze(benchmarkSnapshots.map((snapshot, index) => Object.freeze({
        reference: `t${index + 1}`,
        snapshot
      }))),
      evidence: Object.freeze(collection.items.map((item, index) => Object.freeze({
        reference: `e${index + 1}`,
        horizon: index >= requiredItems.length
          ? horizons[index - requiredItems.length] : 'COMPLETED_SESSION',
        requiresBroadMarketSubjects: index >= requiredItems.length,
        item
      })))
    }));
    return Buffer.byteLength(JSON.stringify(request), 'utf8');
  }
  const windowStart = window ? Date.parse(window.startsAt) : NaN;
  const windowEnd = window ? Date.parse(window.endsAt) : NaN;
  // Step 9F.1c: the page label no longer skips anything. Candidates whose label
  // says they are older than the reading window start (plus tolerance) are tried
  // after the rest, in their usual order, and judged by their real publish time.
  const generationTime = Date.parse(acquisitionStartedAt);
  const labelWindow = window ? {startsAtInclusive: window.startsAt} : null;
  // Step 9F.2e.3.4b: the shared try order (the same tier ranking and label
  // move, on the same inputs) returns listing positions; each is translated
  // back to this reader's ranked row through its candidate object (a source
  // gives one object per listing row). Dropped (tier 4a) rows are not in the
  // order and keep their decision above. Old-label rows are marked here,
  // before any download, so every audit entry keeps today's field order.
  const tryOrder = tierTryOrder({
    candidates, mostActive, portfolioSnapshots: stockSnapshots, labelWindow, generationTime
  });
  const rankedIndexOf = new Map(selected.map(({candidate}, selectedIndex) => [candidate, selectedIndex]));
  const selectedIndexAt = position => rankedIndexOf.get(candidates[position]);
  for (const position of tryOrder.oldLabelPositions) {
    auditEntries[selectedIndexAt(position)].labelOld = true;
    staleByLabelCount++;
  }
  // Step 9F.1d: one reading budget per source for the article downloads.
  // Retries do not count against the article cap; the cap counts articles tried.
  // Step 9F.2e.3.4b: the same budget object drives the shared stop rule and
  // the download retries (one stopwatch). The stop rule checks the attempts
  // cap, then the admitted cap, then the budget, as before.
  const budget = createReadingBudget({
    budgetMs: settingValue(limitSettings.readingBudgetSeconds) * 1000,
    now: monotonicNow
  });
  const shouldStop = createReaderStopRule({
    maxAttempts: maxArticleAttempts, maxAdmitted: maxAdmittedArticles, budget
  });
  for (const selectedIndex of tryOrder.order.map(selectedIndexAt)) {
    const {candidate} = selected[selectedIndex];
    const audit = auditEntries[selectedIndex];
    const stop = shouldStop({attemptsMade: articleFetchAttemptCount, admittedCount: acquiredItems.length});
    if (stop.stop) {
      if (stop.reason === 'READING_BUDGET_SPENT') readingBudgetStopped = true;
      break;
    }
    counts.candidateConsideredCount++;
    articleFetchAttemptCount++;
    const download = await timed(stageNames.downloadTiming, () =>
      downloadWithRetries(() => source.readPage(candidate.url, {headline: candidate.headline}), {
        budget,
        attempts: readingSettings({market}).downloadAttempts,
        ...(sleep ? {sleep} : {})
      }));
    downloadAttemptCount += download.attempts;
    audit.attempts = download.attempts;
    if (download.budgetStopped) {
      readingBudgetStopped = true;
      audit.retriesStoppedByBudget = true;
    }
    if (download.error) {
      counts.articleFetchRequestFailureCount++;
      audit.decision = 'FETCH_FAILED';
      audit.failureType = 'EXCEPTION';
      continue;
    }
    const result = download.result;
    if (result?.ok !== true || result.type !== 'SUCCESS' || !result.articleContent) {
      if (FETCH_FAILURE_TYPES.includes(result?.type)) {
        counts.articleFetchRequestFailureCount++;
        audit.decision = 'FETCH_FAILED';
        audit.failureType = result.type;
      } else {
        audit.decision = 'EXTRACTION_FAILED';
        audit.failureType = truncatedText(
          result?.extractionFailureType || result?.type || 'UNKNOWN',
          AUDIT_FIELD_LIMITS.failureTypeCharacters, AUDIT_FIELD_LIMITS.failureTypeBytes
        );
        counts.articleExtractionFailureCount++;
        if (result?.extractionFailureType === 'NO_COMPATIBLE_ARTICLE_METADATA') {
          counts.articleMetadataFailureCount++;
        } else if (result?.extractionFailureType === 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH') {
          counts.articleIdentityHeadlineMismatchCount++;
        } else if (result?.extractionFailureType === 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT') {
          counts.articleBodyUnavailableCount++;
        } else if (result?.extractionFailureType === 'CANONICAL_OR_REDIRECT_MISMATCH') {
          counts.articleCanonicalRedirectMismatchCount++;
        } else {
          counts.otherArticleExtractionRejectionCount++;
        }
      }
      continue;
    }
    articleFetchSuccessCount++;
    const article = result.articleContent;
    const publishedAt = typeof article.publishedAt === 'string'
      ? Date.parse(article.publishedAt) : NaN;
    if (!Number.isFinite(publishedAt)) {
      counts.missingOrMalformedPublicationTimeCount++;
      audit.decision = 'REJECTED_NO_PUBLICATION_TIME';
      continue;
    }
    audit.publishedAt = new Date(publishedAt).toISOString();
    const horizon = horizonFor(publishedAt);
    if (!window || !horizon) {
      if (windowUnavailableReason === 'BENCHMARK_OVERLAY_INVALID') {
        counts.benchmarkOverlayInvalidCount++;
      } else {
        counts.activeWindowUnavailableCount++;
      }
      audit.decision = 'REJECTED_WINDOW_UNAVAILABLE';
      continue;
    }
    if (publishedAt < windowStart) {
      counts.beforeSessionWindowCount++;
      counts.activeWindowRejectionCount++;
      audit.decision = 'REJECTED_BEFORE_READING_WINDOW';
      continue;
    }
    if (publishedAt > windowEnd) {
      counts.afterSessionWindowCount++;
      counts.activeWindowRejectionCount++;
      audit.decision = 'REJECTED_AFTER_READING_WINDOW';
      continue;
    }
    if (seenUrls.has(article.canonicalUrl)) {
      counts.duplicateEvidenceCount++;
      audit.decision = 'REJECTED_DUPLICATE';
      continue;
    }
    try {
      const item = createEvidenceItem({
        sourceId,
        market,
        evidenceCategory: 'news',
        title: article.headline,
        // The shared article size cap; a no-op for a reader that already keeps
        // no more than `articleKb` (Yahoo's does, Step 9F.1f).
        summary: firstBytes(article.articleText,
          Math.floor(readingSettings({market}).articleKb * 1024)),
        canonicalUrl: article.canonicalUrl,
        publishedAt: article.publishedAt,
        symbols: headlineSymbols(
          article.headline,
          mostActive,
          stockSnapshots
        ),
        ...(typeof article.publisher === 'string' && article.publisher.trim()
          ? {publisher: article.publisher} : {})
      });
      const fit = checkListOrderFit({
        items: [item],
        mode: 'SKIP',
        maxItems: MAX_CLASSIFICATION_EVIDENCE_ITEMS,
        baseCount: requiredItems.length + acquiredItems.length,
        maxBytes: CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES,
        measure: classificationPreflightAvailable
          ? trial => classifierRequestBytes(trial, horizon) : null
      });
      if (fit.kept.length === 0) {
        counts.classifierPreflightRejectedCount++;
        counts.otherEvidenceConstructionRejectedCount++;
        audit.decision = 'REJECTED_CLASSIFIER_PREFLIGHT';
        continue;
      }
      seenUrls.add(item.canonicalUrl);
      acquiredItems.push(item);
      acquiredHorizons.push(horizon);
      audit.decision = 'ADMITTED';
      if (completed && horizon === 'SUBSEQUENT_DEVELOPMENT') audit.afterClose = true;
    } catch (error) {
      // An invalid optional article is omitted without affecting package assembly.
      counts.otherEvidenceConstructionRejectedCount++;
      audit.decision = 'REJECTED_OTHER';
    }
  }
  for (const audit of auditEntries) {
    if (audit.decision !== null) continue;
    audit.decision = acquiredItems.length >= maxAdmittedArticles ? 'SKIPPED_MAX_ADMITTED'
      : readingBudgetStopped && articleFetchAttemptCount < maxArticleAttempts
        ? 'SKIPPED_READING_BUDGET' : 'SKIPPED_MAX_ATTEMPTS';
  }
  const stats = {
    stage: stageNames.summary,
    outcome: acquiredItems.length > 0 ? 'SUCCESS' : 'NOT_FOUND',
    mostActiveCount: mostActive.length,
    latestNewsCandidateCount: candidates.length,
    ...discoveryStats,
    staleByLabelCount,
    selectedCandidateCount: counts.selectedCandidateCount,
    candidateConsideredCount: counts.candidateConsideredCount,
    articleFetchAttemptCount,
    articleFetchSuccessCount,
    downloadAttemptCount,
    readingBudgetStopped,
    articleFetchRequestFailureCount: counts.articleFetchRequestFailureCount,
    articleExtractionFailureCount: counts.articleExtractionFailureCount,
    articleMetadataFailureCount: counts.articleMetadataFailureCount,
    articleIdentityHeadlineMismatchCount: counts.articleIdentityHeadlineMismatchCount,
    articleBodyUnavailableCount: counts.articleBodyUnavailableCount,
    articleCanonicalRedirectMismatchCount: counts.articleCanonicalRedirectMismatchCount,
    otherArticleExtractionRejectionCount: counts.otherArticleExtractionRejectionCount,
    missingOrMalformedPublicationTimeCount: counts.missingOrMalformedPublicationTimeCount,
    beforeSessionWindowCount: counts.beforeSessionWindowCount,
    afterSessionWindowCount: counts.afterSessionWindowCount,
    duplicateEvidenceCount: counts.duplicateEvidenceCount,
    activeWindowUnavailableCount: counts.activeWindowUnavailableCount,
    benchmarkOverlayInvalidCount: counts.benchmarkOverlayInvalidCount,
    otherEvidenceConstructionRejectedCount: counts.otherEvidenceConstructionRejectedCount,
    activeWindowRejectionCount: counts.activeWindowRejectionCount,
    classifierPreflightRejectedCount: counts.classifierPreflightRejectedCount,
    backfillUsed: counts.candidateConsideredCount > initialCandidateAttempts,
    acquiredCurrentSessionCount: acquiredItems.length,
    ...(completed ? {
      subsequentDevelopmentCount: acquiredHorizons
        .filter(horizon => horizon === 'SUBSEQUENT_DEVELOPMENT').length
    } : {})
  };
  emit(stats);
  for (const event of auditEvents(auditEntries, sessionWindow, window,
    {stage: stageNames.audit, sourceId})) {
    emit(event);
  }
  return {
    items: acquiredItems,
    horizons: acquiredHorizons,
    pool: candidatePool(sourceId, selected, auditEntries, scores, portfolioSlotIdentities),
    stats
  };
}

// Step 9F.6a.4: the candidate pool -- every candidate the source found, in
// ranked order (dropped ones last, as in the audit), with its decision. Full
// url and headline, unlike the audit. Kept in memory only: never logged,
// stored or put in the package. Nothing reads it yet; Step 9F.2h's second
// validation pass for extra Further Readings works from it.
// Step 9F.2e.1: each entry also carries its shadow score (total, every list's
// points, recency, drop reason) and whether it names a company in the list
// that started the run (portfolioSlotEligible).
function candidatePool(sourceId, selected, auditEntries, scores, portfolioSlotIdentities) {
  return Object.freeze(selected.map(({candidate, tier, subTier}, index) => {
    const audit = auditEntries[index];
    const scored = scores[index];
    const text = value => typeof value === 'string' ? value : null;
    return Object.freeze({
      sourceId,
      rank: audit.rank,
      url: text(candidate.url),
      headline: text(candidate.headline),
      publisher: text(candidate.publisher),
      listedAt: text(candidate.listedAt),
      ageLabel: text(candidate.ageLabel),
      edition: text(candidate.edition),
      tier,
      subTier,
      labelOld: audit.labelOld === true,
      opened: audit.attempts !== undefined,
      attempts: audit.attempts ?? null,
      publishedAt: audit.publishedAt ?? null,
      decision: audit.decision,
      score: scored.score,
      scoreBreakdown: scored.matched,
      recencyPoints: scored.recencyPoints,
      recencyBasis: scored.recencyBasis,
      ageHours: scored.ageHours,
      dropReason: scored.dropReason,
      portfolioSlotEligible: portfolioSlotIdentities.some(item =>
        headlineMatchesIdentity(candidate.headline, item))
    });
  }));
}

module.exports = {
  SOURCE_LIMIT_SETTINGS,
  sourceLimits,
  readRunContext,
  readSource
};

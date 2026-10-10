const {createEvidenceCollection} = require('./evidence-collections');
const {createEvidenceItem} = require('./evidence-items');
const {
  readingWindow,
  readingSettings,
  createReadingBudget,
  downloadWithRetries
} = require('./reading-window');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  MAX_CLASSIFICATION_EVIDENCE_ITEMS,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES
} = require('./claude-evidence-role-classification');

// Step 9F.1b: the active-session Yahoo news reading loop, lifted unchanged out of
// us-analysis-package-orchestration.js. Admitted items are pushed onto acquiredItems.
// Step 9F.1c: admission is by publish time inside the reading window only.
// Step 9F.1e: the same function also runs in CLOSED, WEEKEND and HOLIDAY. Those
// states have no session window; they pass `horizonFor`, which maps a publish
// time to the existing completed-session horizon (COMPLETED_SESSION, or
// SUBSEQUENT_DEVELOPMENT after the completed close), and `requiredItems`, the
// evidence already gathered, for the classifier size and duplicate checks.
async function readYahooNews({
  yahooMostActiveAcquisition,
  yahooLatestNewsDiscovery,
  yahooCurrentNewsArticleContentAcquisition,
  timed,
  emit,
  acquisitionStartedAt,
  marketContext,
  benchmarkSnapshots,
  stockSnapshots,
  classificationPreflightAvailable,
  yahooCollections,
  federalReserveCollection,
  activeSessionWindowResult,
  activeSessionWindow,
  acquiredItems,
  horizonFor = null,
  requiredItems = null,
  clock: {monotonicNow = () => performance.now(), sleep} = {},
  limits: {
    maxArticleAttempts,
    maxAdmittedArticles,
    initialCandidateAttempts
  },
  helpers: {
    selectedActiveYahooCandidates,
    activeYahooStaleByLabel,
    activeYahooSymbols,
    activeYahooAuditSlug,
    activeYahooAuditEvents,
    truncatedText
  }
}) {
  const activeYahooCounts = {
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
  let mostActive = [];
  let latestNews = [];
  let newsDiscoveryMeta = {};
  let staleByLabelCount = 0;
  let articleFetchAttemptCount = 0;
  let articleFetchSuccessCount = 0;
  // Step 9F.1d: downloads including retries, and whether the reading budget
  // stopped any download or retry from starting.
  let downloadAttemptCount = 0;
  let readingBudgetStopped = false;
  try {
    const result = await timed('yahooMostActiveAcquisitionMs', () =>
      yahooMostActiveAcquisition.acquireMostActive());
    if (result?.ok === true && Array.isArray(result.candidates)) mostActive = result.candidates;
  } catch (error) {
    mostActive = [];
  }
  try {
    const result = await timed('yahooLatestNewsDiscoveryMs', () =>
      yahooLatestNewsDiscovery.discoverLatestNews());
    if (result?.ok === true && Array.isArray(result.candidates)) latestNews = result.candidates;
    newsDiscoveryMeta = result || {};
  } catch (error) {
    latestNews = [];
  }
  const selected = selectedActiveYahooCandidates(mostActive, latestNews, stockSnapshots);
  activeYahooCounts.selectedCandidateCount = selected.length;
  const auditEntries = selected.map(({candidate, tier, subTier}, index) => ({
    rank: index + 1,
    tier,
    subTier,
    headline: truncatedText(candidate.headline, 80, 120),
    publisher: truncatedText(candidate.publisher, 24, 48),
    slug: activeYahooAuditSlug(candidate.url),
    edition: candidate.edition === 'US' || candidate.edition === 'SG' ? candidate.edition : null,
    ageLabel: truncatedText(candidate.ageLabel, 12, 16) || null,
    decision: selected[index].dropped ? 'SKIPPED_BELOW_RELEVANCE_FLOOR' : null
  }));
  const activeRequiredItems = requiredItems
    || yahooCollections.flatMap(collection => collection.items).concat(
      federalReserveCollection ? federalReserveCollection.items : []
    );
  // Step 9F.1e: an article already in the evidence (in completed states, the
  // Yahoo recap can also be on the news list) is a duplicate, not a second item.
  const seenUrls = new Set(activeRequiredItems.map(item => item.canonicalUrl));
  const acquiredHorizons = [];
  function activeCandidateFitsClassifier(candidateItem, candidateHorizon) {
    const items = activeRequiredItems.concat(acquiredItems, candidateItem);
    const horizons = acquiredHorizons.concat(candidateHorizon);
    if (items.length > MAX_CLASSIFICATION_EVIDENCE_ITEMS) return false;
    if (!classificationPreflightAvailable) return true;
    try {
      const collection = createEvidenceCollection({market: 'US', items});
      const request = buildClaudeEvidenceRoleClassificationRequest(Object.freeze({
        marketContext: Object.freeze({
          market: 'US',
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
          horizon: index >= activeRequiredItems.length
            ? horizons[index - activeRequiredItems.length] : 'COMPLETED_SESSION',
          requiresBroadMarketSubjects: index >= activeRequiredItems.length,
          item
        })))
      }));
      return Buffer.byteLength(JSON.stringify(request), 'utf8')
        <= CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES;
    } catch (error) {
      return false;
    }
  }
  // Step 9F.1c: an article is admitted by its publish time alone, inside the reading
  // window (trigger back to the last close, plus the extension). The session window
  // still has to exist, but no longer decides which articles are in or out.
  let window = null;
  try {
    window = readingWindow({market: 'US', triggerAt: acquisitionStartedAt});
  } catch (error) {
    window = null;
  }
  const windowStart = window ? Date.parse(window.startsAt) : NaN;
  const windowEnd = window ? Date.parse(window.endsAt) : NaN;
  // Step 9F.1c: the page label no longer skips anything. Candidates whose label
  // says they are older than the reading window start (plus tolerance) are tried
  // after the rest, in their usual order, and judged by their real publish time.
  const generationTime = Date.parse(acquisitionStartedAt);
  const labelWindow = window ? {startsAtInclusive: window.startsAt} : null;
  const tryFirst = [];
  const tryLast = [];
  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
    if (selected[selectedIndex].dropped) continue;
    if (activeYahooStaleByLabel(selected[selectedIndex].candidate, labelWindow, generationTime)) {
      auditEntries[selectedIndex].labelOld = true;
      staleByLabelCount++;
      tryLast.push(selectedIndex);
    } else {
      tryFirst.push(selectedIndex);
    }
  }
  // Step 9F.1d: one shared reading budget for the article downloads. Retries do
  // not count against the article cap; the cap counts articles tried.
  const budget = createReadingBudget({
    budgetMs: readingSettings({market: 'US'}).readingBudgetSeconds * 1000,
    now: monotonicNow
  });
  for (const selectedIndex of tryFirst.concat(tryLast)) {
    const {candidate} = selected[selectedIndex];
    const audit = auditEntries[selectedIndex];
    if (articleFetchAttemptCount >= maxArticleAttempts
        || acquiredItems.length >= maxAdmittedArticles) break;
    if (budget.spent()) {
      readingBudgetStopped = true;
      break;
    }
    activeYahooCounts.candidateConsideredCount++;
    articleFetchAttemptCount++;
    const download = await timed('yahooCurrentNewsArticleAcquisitionMs', () =>
      downloadWithRetries(() => yahooCurrentNewsArticleContentAcquisition.acquireArticleContent({
        url: candidate.url,
        headline: candidate.headline
      }), {
        budget,
        attempts: readingSettings({market: 'US'}).downloadAttempts,
        ...(sleep ? {sleep} : {})
      }));
    downloadAttemptCount += download.attempts;
    audit.attempts = download.attempts;
    if (download.budgetStopped) {
      readingBudgetStopped = true;
      audit.retriesStoppedByBudget = true;
    }
    if (download.error) {
      activeYahooCounts.articleFetchRequestFailureCount++;
      audit.decision = 'FETCH_FAILED';
      audit.failureType = 'EXCEPTION';
      continue;
    }
    const result = download.result;
    if (result?.ok !== true || result.type !== 'SUCCESS' || !result.articleContent) {
      if (['TIMEOUT', 'RETRIEVAL_FAILURE', 'HTTP_FAILURE', 'RESPONSE_READ_FAILURE',
        'RESPONSE_TOO_LARGE'].includes(result?.type)) {
        activeYahooCounts.articleFetchRequestFailureCount++;
        audit.decision = 'FETCH_FAILED';
        audit.failureType = result.type;
      } else {
        audit.decision = 'EXTRACTION_FAILED';
        audit.failureType = truncatedText(
          result?.extractionFailureType || result?.type || 'UNKNOWN', 48, 48
        );
        activeYahooCounts.articleExtractionFailureCount++;
        if (result?.extractionFailureType === 'NO_COMPATIBLE_ARTICLE_METADATA') {
          activeYahooCounts.articleMetadataFailureCount++;
        } else if (result?.extractionFailureType === 'ARTICLE_IDENTITY_OR_HEADLINE_MISMATCH') {
          activeYahooCounts.articleIdentityHeadlineMismatchCount++;
        } else if (result?.extractionFailureType === 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT') {
          activeYahooCounts.articleBodyUnavailableCount++;
        } else if (result?.extractionFailureType === 'CANONICAL_OR_REDIRECT_MISMATCH') {
          activeYahooCounts.articleCanonicalRedirectMismatchCount++;
        } else {
          activeYahooCounts.otherArticleExtractionRejectionCount++;
        }
      }
      continue;
    }
    articleFetchSuccessCount++;
    const article = result.articleContent;
    const publishedAt = typeof article.publishedAt === 'string'
      ? Date.parse(article.publishedAt) : NaN;
    if (!Number.isFinite(publishedAt)) {
      activeYahooCounts.missingOrMalformedPublicationTimeCount++;
      audit.decision = 'REJECTED_NO_PUBLICATION_TIME';
      continue;
    }
    audit.publishedAt = new Date(publishedAt).toISOString();
    const horizon = horizonFor ? horizonFor(publishedAt) : 'CURRENT_SESSION';
    if (!window || (horizonFor ? !horizon : !activeSessionWindow)) {
      if (activeSessionWindowResult?.failureType === 'BENCHMARK_OVERLAY_INVALID') {
        activeYahooCounts.benchmarkOverlayInvalidCount++;
      } else {
        activeYahooCounts.activeWindowUnavailableCount++;
      }
      audit.decision = 'REJECTED_WINDOW_UNAVAILABLE';
      continue;
    }
    if (publishedAt < windowStart) {
      activeYahooCounts.beforeSessionWindowCount++;
      activeYahooCounts.activeWindowRejectionCount++;
      audit.decision = 'REJECTED_BEFORE_READING_WINDOW';
      continue;
    }
    if (publishedAt > windowEnd) {
      activeYahooCounts.afterSessionWindowCount++;
      activeYahooCounts.activeWindowRejectionCount++;
      audit.decision = 'REJECTED_AFTER_READING_WINDOW';
      continue;
    }
    if (seenUrls.has(article.canonicalUrl)) {
      activeYahooCounts.duplicateEvidenceCount++;
      audit.decision = 'REJECTED_DUPLICATE';
      continue;
    }
    try {
      const item = createEvidenceItem({
        sourceId: 'us.yahoo-finance',
        market: 'US',
        evidenceCategory: 'news',
        title: article.headline,
        summary: article.articleText,
        canonicalUrl: article.canonicalUrl,
        publishedAt: article.publishedAt,
        symbols: activeYahooSymbols(
          article.headline,
          mostActive,
          stockSnapshots
        ),
        ...(typeof article.publisher === 'string' && article.publisher.trim()
          ? {publisher: article.publisher} : {})
      });
      if (!activeCandidateFitsClassifier(item, horizon)) {
        activeYahooCounts.classifierPreflightRejectedCount++;
        activeYahooCounts.otherEvidenceConstructionRejectedCount++;
        audit.decision = 'REJECTED_CLASSIFIER_PREFLIGHT';
        continue;
      }
      seenUrls.add(item.canonicalUrl);
      acquiredItems.push(item);
      acquiredHorizons.push(horizon);
      audit.decision = 'ADMITTED';
      if (horizonFor && horizon === 'SUBSEQUENT_DEVELOPMENT') audit.afterClose = true;
    } catch (error) {
      // An invalid optional article is omitted without affecting package assembly.
      activeYahooCounts.otherEvidenceConstructionRejectedCount++;
      audit.decision = 'REJECTED_OTHER';
    }
  }
  for (const audit of auditEntries) {
    if (audit.decision !== null) continue;
    audit.decision = acquiredItems.length >= maxAdmittedArticles ? 'SKIPPED_MAX_ADMITTED'
      : readingBudgetStopped && articleFetchAttemptCount < maxArticleAttempts
        ? 'SKIPPED_READING_BUDGET' : 'SKIPPED_MAX_ATTEMPTS';
  }
  emit({
    stage: 'activeYahooAcquisition',
    outcome: acquiredItems.length > 0 ? 'SUCCESS' : 'NOT_FOUND',
    mostActiveCount: mostActive.length,
    latestNewsCandidateCount: latestNews.length,
    usNewsOutcome: truncatedText(newsDiscoveryMeta.usOutcome || 'NOT_CONFIGURED', 32, 32),
    usNewsSectionCount: Number.isSafeInteger(newsDiscoveryMeta.usSectionCount) ? newsDiscoveryMeta.usSectionCount : 0,
    usNewsCandidateCount: Number.isSafeInteger(newsDiscoveryMeta.usCandidateCount) ? newsDiscoveryMeta.usCandidateCount : 0,
    singaporeNewsCandidateCount: Number.isSafeInteger(newsDiscoveryMeta.singaporeCandidateCount) ? newsDiscoveryMeta.singaporeCandidateCount : 0,
    crossEditionDuplicateCount: Number.isSafeInteger(newsDiscoveryMeta.crossEditionDuplicateCount) ? newsDiscoveryMeta.crossEditionDuplicateCount : 0,
    staleByLabelCount,
    selectedCandidateCount: activeYahooCounts.selectedCandidateCount,
    candidateConsideredCount: activeYahooCounts.candidateConsideredCount,
    articleFetchAttemptCount,
    articleFetchSuccessCount,
    downloadAttemptCount,
    readingBudgetStopped,
    articleFetchRequestFailureCount: activeYahooCounts.articleFetchRequestFailureCount,
    articleExtractionFailureCount: activeYahooCounts.articleExtractionFailureCount,
    articleMetadataFailureCount: activeYahooCounts.articleMetadataFailureCount,
    articleIdentityHeadlineMismatchCount: activeYahooCounts.articleIdentityHeadlineMismatchCount,
    articleBodyUnavailableCount: activeYahooCounts.articleBodyUnavailableCount,
    articleCanonicalRedirectMismatchCount: activeYahooCounts.articleCanonicalRedirectMismatchCount,
    otherArticleExtractionRejectionCount: activeYahooCounts.otherArticleExtractionRejectionCount,
    missingOrMalformedPublicationTimeCount: activeYahooCounts.missingOrMalformedPublicationTimeCount,
    beforeSessionWindowCount: activeYahooCounts.beforeSessionWindowCount,
    afterSessionWindowCount: activeYahooCounts.afterSessionWindowCount,
    duplicateEvidenceCount: activeYahooCounts.duplicateEvidenceCount,
    activeWindowUnavailableCount: activeYahooCounts.activeWindowUnavailableCount,
    benchmarkOverlayInvalidCount: activeYahooCounts.benchmarkOverlayInvalidCount,
    otherEvidenceConstructionRejectedCount: activeYahooCounts.otherEvidenceConstructionRejectedCount,
    activeWindowRejectionCount: activeYahooCounts.activeWindowRejectionCount,
    classifierPreflightRejectedCount: activeYahooCounts.classifierPreflightRejectedCount,
    backfillUsed: activeYahooCounts.candidateConsideredCount > initialCandidateAttempts,
    acquiredCurrentSessionCount: acquiredItems.length,
    ...(horizonFor ? {
      subsequentDevelopmentCount: acquiredHorizons
        .filter(horizon => horizon === 'SUBSEQUENT_DEVELOPMENT').length
    } : {})
  });
  for (const event of activeYahooAuditEvents(auditEntries, activeSessionWindow, window)) {
    emit(event);
  }
}

module.exports = {readYahooNews};

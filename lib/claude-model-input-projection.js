const {
  currentSessionEvidenceContext,
  exchangeTimeLabel,
  sinceLastCloseContext,
  completedSinceLastCloseContext
} = require('./us-active-session-evidence');
const {classifierArticleText} = require('./reading-window');
const {settingValue} = require('./settings-registry');
const {
  sectionFourBothListsOn,
  sectionFourPortfolio,
  sectionFourTableOn,
  sectionFourNewsStocks,
  isSectionFourPriceRecord
} = require('./section-rules');

// Step 21D.2: the Section 4 purpose the writer reads while sectionFourBothListsEnabled is on.
const SECTION_FOUR_BOTH_LISTS_PURPOSE = 'Cover material movements and relevant known upcoming events '
  + 'within 14 days for every security in My Stocks and the Watchlist, as one section: My Stocks first, '
  + 'then the Watchlist, each in its saved order.';
// Step 9AA Build 1: the Section 4 purpose the writer reads while sectionFourTableEnabled is also on.
const SECTION_FOUR_TABLE_PURPOSE = 'MarketBrief adds a price table for every security in My Stocks and '
  + 'the Watchlist. Explain only the stocks in sectionFourReferenceAllowlist.newsStocks whose own linked '
  + 'news article gives a reason for the move, one or two sentences each, without restating the figures.';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function projectEvidenceItem(item) {
  return {
    sourceId: item.sourceId,
    market: item.market,
    evidenceCategory: item.evidenceCategory,
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt,
    symbols: item.symbols.slice(),
    provenance: {
      publisher: item.provenance.publisher,
      authority: item.provenance.authority
    }
  };
}

function projectTelemetryProvenance(provenance) {
  return {
    publisher: provenance.publisher,
    authority: provenance.authority
  };
}

function projectTelemetryRecord(record) {
  return {
    ...JSON.parse(JSON.stringify(record)),
    provenance: projectTelemetryProvenance(record.provenance)
  };
}

function projectTelemetrySnapshot(snapshot) {
  return {
    ...JSON.parse(JSON.stringify(snapshot)),
    completedSessions: snapshot.completedSessions.map(projectTelemetryRecord),
    currentOverlay: snapshot.currentOverlay === null
      ? null
      : projectTelemetryRecord(snapshot.currentOverlay)
  };
}

function projectTelemetryEntries(entries) {
  return entries.map(entry => ({
    reference: entry.reference,
    snapshot: projectTelemetrySnapshot(entry.snapshot)
  }));
}

function projectTelemetry(telemetry) {
  return {
    benchmarkSnapshots: projectTelemetryEntries(telemetry.benchmarkSnapshots),
    stockSnapshots: projectTelemetryEntries(telemetry.stockSnapshots)
  };
}

// Step 9F.1f: this is the one place the classifier's view of an article is cut to
// its first 8 KB (`classifierArticleText`). Every classifier size check builds the
// request through here, so they all measure the cut text.
function projectClaudeEvidenceRoleClassificationInput(canonicalInput) {
  return deepFreeze({
    marketContext: JSON.parse(JSON.stringify(canonicalInput.marketContext)),
    benchmarkTelemetry: projectTelemetryEntries(canonicalInput.benchmarkTelemetry),
    evidence: canonicalInput.evidence.map(entry => {
      const item = projectEvidenceItem(entry.item);
      item.summary = classifierArticleText(item.summary);
      return {
        reference: entry.reference,
        horizon: entry.horizon,
        requiresBroadMarketSubjects: entry.requiresBroadMarketSubjects,
        item
      };
    })
  });
}

// Step 8P.2(b) + 8P.3: with sinceCloseLeadEnabled on, an active request also carries
// a top-level sinceLastClose list (last close time, the after-close article refs) and
// each of those articles is marked sinceLastClose with a readable ET publish time.
// Off (or any completed day) adds nothing, so the projection is exactly as before.
function projectClaudeAnalysisInput(canonicalInput, {env = process.env} = {}) {
  const projected = JSON.parse(JSON.stringify(canonicalInput));
  const currentSessionContext = currentSessionEvidenceContext(canonicalInput);
  const currentSessionRefsByMarket = new Map(
    currentSessionContext.map(entry => [entry.market, new Set(entry.evidenceRefs)])
  );
  const sinceLastClose = currentSessionContext.length > 0
    && settingValue('sinceCloseLeadEnabled', {env}) === true
    ? sinceLastCloseContext(canonicalInput) : [];
  // Step 9V: with completedSinceCloseEnabled on, a CLOSED, WEEKEND or HOLIDAY request carries
  // the same sinceLastClose list (mode COMPLETED, with each item's home section) and the same
  // per-article marking, plus the item's home. Off, or any active day: nothing added here.
  const completedSinceClose = currentSessionContext.length === 0
    && settingValue('completedSinceCloseEnabled', {env}) === true
    ? completedSinceLastCloseContext(canonicalInput) : [];
  const sinceCloseRefsByMarket = new Map(
    sinceLastClose.concat(completedSinceClose)
      .map(entry => [entry.market, new Set(entry.evidenceRefs)])
  );
  const sinceCloseHomeByReference = new Map(completedSinceClose.flatMap(entry =>
    entry.homes.map(home => [home.evidenceRef, home.sectionIndex + 1])));
  const generatedAtMs = Date.parse(canonicalInput.analysisRequest.generatedAt);
  // Step 8W: with dateAccuracyEnabled on, every article (any market state) carries a
  // readable ET publish label and the request one readable report-time label, both
  // from the same label helper. Off: exactly as before.
  const dateAccuracy = settingValue('dateAccuracyEnabled', {env}) === true;
  // Step 9AA.2: price records (lib/section-rules.js isSectionFourPriceRecord) are bookkeeping
  // for the code-built Section 4 table, never evidence for the writer: they are left out of the
  // evidence list, every security's refs and the Section 4 allowlist. Whatever the switch says;
  // a package without records projects exactly as before.
  const priceRecordRefs = new Set(canonicalInput.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.evidence.filter(entry => isSectionFourPriceRecord(entry.item))
      .map(entry => entry.reference)));
  const writerRefs = references => references.filter(reference => !priceRecordRefs.has(reference));
  if (dateAccuracy) {
    const reportTimeEt = exchangeTimeLabel(canonicalInput.analysisRequest.generatedAt);
    if (reportTimeEt) projected.reportTimeEt = reportTimeEt;
  }
  projected.marketPackages = canonicalInput.marketPackages.map(marketPackage => {
    const currentRefs = currentSessionRefsByMarket.get(marketPackage.market) || null;
    const sinceCloseRefs = sinceCloseRefsByMarket.get(marketPackage.market) || null;
    return {
      ...JSON.parse(JSON.stringify(marketPackage)),
      telemetry: projectTelemetry(marketPackage.telemetry),
      evidenceContext: {
        ...JSON.parse(JSON.stringify(marketPackage.evidenceContext)),
        evidence: marketPackage.evidenceContext.evidence
          .filter(entry => !priceRecordRefs.has(entry.reference)).map(entry => {
          const projectedItem = projectEvidenceItem(entry.item);
          if (currentRefs && currentRefs.has(entry.reference) && Number.isFinite(generatedAtMs)) {
            const publishedAtMs = Date.parse(entry.item.publishedAt);
            if (Number.isFinite(publishedAtMs)) {
              projectedItem.ageHoursAtGeneration =
                Math.round(((generatedAtMs - publishedAtMs) / 3600000) * 10) / 10;
            }
          }
          if (sinceCloseRefs && sinceCloseRefs.has(entry.reference)) {
            projectedItem.sinceLastClose = true;
            projectedItem.publishedEt = exchangeTimeLabel(entry.item.publishedAt);
            if (sinceCloseHomeByReference.has(entry.reference)) {
              projectedItem.sinceCloseHomeSection = sinceCloseHomeByReference.get(entry.reference);
            }
          }
          // Step 8W: every article in every market state carries the same readable label.
          if (dateAccuracy && !projectedItem.publishedEt) {
            const publishedEt = exchangeTimeLabel(entry.item.publishedAt);
            if (publishedEt) projectedItem.publishedEt = publishedEt;
          }
          return {reference: entry.reference, item: projectedItem};
        })
      }
    };
  });
  const initiatingList = canonicalInput.analysisRequest.initiatingList;
  const bothLists = sectionFourBothListsOn({env});
  const initiatingPortfolio = sectionFourPortfolio(canonicalInput, {env});
  if (currentSessionContext.length > 0) {
    projected.currentSessionContext = JSON.parse(JSON.stringify(currentSessionContext));
  }
  if (sinceLastClose.length > 0) {
    projected.sinceLastClose = sinceLastClose.map(entry => ({
      market: entry.market,
      marketState: entry.marketState,
      lastCloseEt: entry.lastCloseEt,
      liveTelemetry: entry.liveTelemetry,
      evidenceRefs: entry.evidenceRefs.slice()
    }));
  }
  if (completedSinceClose.length > 0) {
    projected.sinceLastClose = completedSinceClose.map(entry => ({
      market: entry.market,
      marketState: entry.marketState,
      mode: entry.mode,
      lastCloseEt: entry.lastCloseEt,
      reportTimeEt: entry.reportTimeEt,
      evidenceRefs: entry.evidenceRefs.slice(),
      homeSections: entry.homes.map(home => ({evidenceRef: home.evidenceRef, section: home.sectionIndex + 1}))
    }));
  }
  if (priceRecordRefs.size > 0) {
    for (const list of ['myStocks', 'watchlist']) {
      for (const security of projected.portfolioContext[list]) security.evidenceRefs = writerRefs(security.evidenceRefs);
    }
  }
  const allowedRefs = {
    evidenceRefs: writerRefs([...new Set(initiatingPortfolio.flatMap(security =>
      security.evidenceRefs.concat(security.upcomingEvents.flatMap(event => event.evidenceRefs))))]),
    telemetryRefs: [...new Set(initiatingPortfolio.flatMap(security => security.telemetryRefs))]
  };
  // Step 21D.2: while sectionFourBothListsEnabled is on, the allowlist covers both lists and
  // gives the Section 4 stock order (My Stocks, then the Watchlist, in saved order), and the
  // Section 4 purpose the writer reads says so. The canonical input is unchanged. Off: as before.
  // Step 9AA Build 1: while sectionFourTableEnabled is also on, the allowlist adds the stocks with
  // a linked news article (the only ones the writer may explain) and the writer reads the table
  // purpose. The canonical input is unchanged. Off: as before.
  const table = sectionFourTableOn({env});
  projected.sectionFourReferenceAllowlist = bothLists
    ? {lists: ['myStocks', 'watchlist'],
      stockOrder: initiatingPortfolio.map(security => security.symbol), ...allowedRefs,
      ...(table ? {newsStocks: sectionFourNewsStocks(canonicalInput).map(security => security.symbol)} : {})}
    : {initiatingList, ...allowedRefs};
  if (bothLists) {
    projected.outputRequirements.sections[3].purpose = table
      ? SECTION_FOUR_TABLE_PURPOSE : SECTION_FOUR_BOTH_LISTS_PURPOSE;
  }
  return deepFreeze(projected);
}

module.exports = {
  projectClaudeEvidenceRoleClassificationInput,
  projectClaudeAnalysisInput
};

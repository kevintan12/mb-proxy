const {
  currentSessionEvidenceContext,
  exchangeTimeLabel,
  sinceLastCloseContext
} = require('./us-active-session-evidence');
const {classifierArticleText} = require('./reading-window');
const {settingValue} = require('./settings-registry');
const {sectionFourBothListsOn, sectionFourPortfolio} = require('./section-rules');

// Step 21D.2: the Section 4 purpose the writer reads while sectionFourBothListsEnabled is on.
const SECTION_FOUR_BOTH_LISTS_PURPOSE = 'Cover material movements and relevant known upcoming events '
  + 'within 14 days for every security in My Stocks and the Watchlist, as one section: My Stocks first, '
  + 'then the Watchlist, each in its saved order.';

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
  const sinceCloseRefsByMarket = new Map(
    sinceLastClose.map(entry => [entry.market, new Set(entry.evidenceRefs)])
  );
  const generatedAtMs = Date.parse(canonicalInput.analysisRequest.generatedAt);
  projected.marketPackages = canonicalInput.marketPackages.map(marketPackage => {
    const currentRefs = currentSessionRefsByMarket.get(marketPackage.market) || null;
    const sinceCloseRefs = sinceCloseRefsByMarket.get(marketPackage.market) || null;
    return {
      ...JSON.parse(JSON.stringify(marketPackage)),
      telemetry: projectTelemetry(marketPackage.telemetry),
      evidenceContext: {
        ...JSON.parse(JSON.stringify(marketPackage.evidenceContext)),
        evidence: marketPackage.evidenceContext.evidence.map(entry => {
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
  const allowedRefs = {
    evidenceRefs: [...new Set(initiatingPortfolio.flatMap(security =>
      security.evidenceRefs.concat(security.upcomingEvents.flatMap(event => event.evidenceRefs))))],
    telemetryRefs: [...new Set(initiatingPortfolio.flatMap(security => security.telemetryRefs))]
  };
  // Step 21D.2: while sectionFourBothListsEnabled is on, the allowlist covers both lists and
  // gives the Section 4 stock order (My Stocks, then the Watchlist, in saved order), and the
  // Section 4 purpose the writer reads says so. The canonical input is unchanged. Off: as before.
  projected.sectionFourReferenceAllowlist = bothLists
    ? {lists: ['myStocks', 'watchlist'],
      stockOrder: initiatingPortfolio.map(security => security.symbol), ...allowedRefs}
    : {initiatingList, ...allowedRefs};
  if (bothLists) projected.outputRequirements.sections[3].purpose = SECTION_FOUR_BOTH_LISTS_PURPOSE;
  return deepFreeze(projected);
}

module.exports = {
  projectClaudeEvidenceRoleClassificationInput,
  projectClaudeAnalysisInput
};

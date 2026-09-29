const {currentSessionEvidenceContext} = require('./us-active-session-evidence');

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

function projectClaudeEvidenceRoleClassificationInput(canonicalInput) {
  return deepFreeze({
    marketContext: JSON.parse(JSON.stringify(canonicalInput.marketContext)),
    benchmarkTelemetry: projectTelemetryEntries(canonicalInput.benchmarkTelemetry),
    evidence: canonicalInput.evidence.map(entry => ({
      reference: entry.reference,
      horizon: entry.horizon,
      requiresBroadMarketSubjects: entry.requiresBroadMarketSubjects,
      item: projectEvidenceItem(entry.item)
    }))
  });
}

function projectClaudeAnalysisInput(canonicalInput) {
  const projected = JSON.parse(JSON.stringify(canonicalInput));
  const currentSessionContext = currentSessionEvidenceContext(canonicalInput);
  const currentSessionRefsByMarket = new Map(
    currentSessionContext.map(entry => [entry.market, new Set(entry.evidenceRefs)])
  );
  const generatedAtMs = Date.parse(canonicalInput.analysisRequest.generatedAt);
  projected.marketPackages = canonicalInput.marketPackages.map(marketPackage => {
    const currentRefs = currentSessionRefsByMarket.get(marketPackage.market) || null;
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
          return {reference: entry.reference, item: projectedItem};
        })
      }
    };
  });
  const initiatingList = canonicalInput.analysisRequest.initiatingList;
  const initiatingPortfolio = canonicalInput.portfolioContext[initiatingList];
  if (currentSessionContext.length > 0) {
    projected.currentSessionContext = JSON.parse(JSON.stringify(currentSessionContext));
  }
  projected.sectionFourReferenceAllowlist = {
    initiatingList,
    evidenceRefs: [...new Set(initiatingPortfolio.flatMap(security =>
      security.evidenceRefs.concat(security.upcomingEvents.flatMap(event => event.evidenceRefs))))],
    telemetryRefs: [...new Set(initiatingPortfolio.flatMap(security => security.telemetryRefs))]
  };
  return deepFreeze(projected);
}

module.exports = {
  projectClaudeEvidenceRoleClassificationInput,
  projectClaudeAnalysisInput
};

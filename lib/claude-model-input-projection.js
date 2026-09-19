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

function projectClaudeEvidenceRoleClassificationInput(canonicalInput) {
  return deepFreeze({
    marketContext: JSON.parse(JSON.stringify(canonicalInput.marketContext)),
    benchmarkTelemetry: JSON.parse(JSON.stringify(canonicalInput.benchmarkTelemetry)),
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
  projected.marketPackages = canonicalInput.marketPackages.map(marketPackage => ({
    ...JSON.parse(JSON.stringify(marketPackage)),
    evidenceContext: {
      ...JSON.parse(JSON.stringify(marketPackage.evidenceContext)),
      evidence: marketPackage.evidenceContext.evidence.map(entry => ({
        reference: entry.reference,
        item: projectEvidenceItem(entry.item)
      }))
    }
  }));
  return deepFreeze(projected);
}

module.exports = {
  projectClaudeEvidenceRoleClassificationInput,
  projectClaudeAnalysisInput
};

const {getPostgresRuntime} = require('./postgres-runtime');
const {
  createRuntimeThreeSessionSnapshotRepository
} = require('./runtime-three-session-snapshot-repository');
const {createYahooTelemetryAcquisitionService} = require('./yahoo-telemetry-acquisition');
const {
  createYahooMarketDataEvidenceAcquisitionService
} = require('./yahoo-market-data-evidence-acquisition');
const {
  createFederalReserveMonetaryPolicyEvidenceAcquisitionService
} = require('./federal-reserve-monetary-policy-evidence-acquisition');
const {
  createUsAnalysisPackageOrchestrationService
} = require('./us-analysis-package-orchestration');
const {createCnbcNewsResearchRuntime} = require('./cnbc-news-research-runtime');
const {createYahooRecapResearchRuntime} = require('./yahoo-recap-research-runtime');
const {
  createYahooRecapArticleContentAcquisitionService
} = require('./yahoo-recap-article-content-acquisition');
const {
  createYahooRecapEvidenceConstructionService
} = require('./yahoo-recap-evidence-construction');
const {
  invokeClaudeEvidenceRoleClassification
} = require('./claude-evidence-role-classification');

const YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS = Object.freeze({
  articleContentBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1258291,
    maxHeadlineBytes: 512,
    maxPublisherNameBytes: 256,
    maxArticleTextBytes: 8192,
    maxResultBytes: 12288
  }),
  evidenceConstructionBounds: Object.freeze({
    maxHeadlineBytes: 512,
    maxPublisherNameBytes: 256,
    maxEvidenceTextBytes: 8192,
    maxResultBytes: 12288
  })
});

function createAnalysisPackageRuntime({
  fetchImpl = global.fetch,
  now = () => new Date(),
  postgresRuntime,
  monotonicNow,
  onDiagnostics
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const runtime = postgresRuntime || getPostgresRuntime();
  const snapshotPersistence = createRuntimeThreeSessionSnapshotRepository({runtime});
  const yahooEvidenceAcquisition = createYahooMarketDataEvidenceAcquisitionService({fetchImpl});
  const federalReserveEvidenceAcquisition =
    createFederalReserveMonetaryPolicyEvidenceAcquisitionService({fetchImpl});
  const cnbcNewsResearch = createCnbcNewsResearchRuntime({
    fetchImpl,
    apiKey: process.env.ANTHROPIC_API_KEY,
    onDiagnostics
  });
  const yahooRecapResearch = createYahooRecapResearchRuntime({
    fetchImpl,
    apiKey: process.env.ANTHROPIC_API_KEY,
    onDiagnostics,
    ...(monotonicNow ? {monotonicNow} : {})
  });
  const yahooRecapArticleContentAcquisition =
    createYahooRecapArticleContentAcquisitionService({fetchImpl});
  const yahooRecapEvidenceConstruction = createYahooRecapEvidenceConstructionService({
    evidenceConstructionBounds:
      YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS.evidenceConstructionBounds
  });
  const evidenceRoleClassification = Object.freeze({
    classifyEvidenceRoles(input) {
      return invokeClaudeEvidenceRoleClassification({
        input,
        apiKey: process.env.ANTHROPIC_API_KEY,
        fetchImpl,
        onDiagnostics,
        ...(monotonicNow ? {monotonicNow} : {})
      });
    }
  });

  return createUsAnalysisPackageOrchestrationService({
    createTelemetryAcquisition: ({generatedAt}) => createYahooTelemetryAcquisitionService({
      fetchImpl,
      now: () => new Date(generatedAt)
    }),
    snapshotPersistence,
    yahooEvidenceAcquisition,
    federalReserveEvidenceAcquisition,
    yahooRecapResearch,
    yahooRecapArticleContentAcquisition,
    yahooRecapEvidenceConstruction,
    yahooRecapArticleContentBounds: YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS.articleContentBounds,
    cnbcNewsResearch,
    evidenceRoleClassification,
    now,
    ...(monotonicNow ? {monotonicNow} : {}),
    onDiagnostics
  });
}

let sharedAnalysisPackageRuntime = null;

function getAnalysisPackageRuntime() {
  if (!sharedAnalysisPackageRuntime) {
    sharedAnalysisPackageRuntime = createAnalysisPackageRuntime({
      onDiagnostics(diagnostics) {
        console.info('[analysis-package.stages]', JSON.stringify(diagnostics));
      }
    });
  }
  return sharedAnalysisPackageRuntime;
}

module.exports = {
  YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS,
  createAnalysisPackageRuntime,
  getAnalysisPackageRuntime
};

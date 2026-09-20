const {AsyncLocalStorage} = require('node:async_hooks');
const {getPostgresRuntime} = require('./postgres-runtime');
const {
  createRuntimeFiveSessionSnapshotRepository
} = require('./runtime-five-session-snapshot-repository');
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
const {createCnbcMarketNewsDiscoveryCache} = require('./cnbc-market-news-discovery-cache');
const {createCnbcRecapResearchRuntime} = require('./cnbc-recap-research-runtime');
const {createYahooRecapResearchRuntime} = require('./yahoo-recap-research-runtime');
const {
  createCompletedSessionRecapDiscoveryCache
} = require('./completed-session-recap-discovery-cache');
const {
  createYahooRecapArticleContentAcquisitionService
} = require('./yahoo-recap-article-content-acquisition');
const {
  createYahooRecapEvidenceConstructionService
} = require('./yahoo-recap-evidence-construction');
const {
  invokeClaudeEvidenceRoleClassification,
  invokeClaudeEvidenceSubjectRepair
} = require('./claude-evidence-role-classification');

const YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS = Object.freeze({
  articleContentBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1572864,
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
  const snapshotPersistence = createRuntimeFiveSessionSnapshotRepository({runtime});
  const yahooEvidenceAcquisition = createYahooMarketDataEvidenceAcquisitionService({fetchImpl});
  const federalReserveEvidenceAcquisition =
    createFederalReserveMonetaryPolicyEvidenceAcquisitionService({fetchImpl});
  const completedSessionRecapDiscoveryCache = createCompletedSessionRecapDiscoveryCache();
  const cnbcMarketNewsDiscoveryCache = createCnbcMarketNewsDiscoveryCache();
  const cnbcNewsResearch = createCnbcNewsResearchRuntime({
    fetchImpl,
    apiKey: process.env.ANTHROPIC_API_KEY,
    onDiagnostics,
    cnbcMarketNewsDiscoveryCache
  });
  const cnbcRecapResearch = createCnbcRecapResearchRuntime({
    fetchImpl,
    onDiagnostics,
    completedSessionRecapDiscoveryCache
  });
  const yahooRecapResearch = createYahooRecapResearchRuntime({
    fetchImpl,
    apiKey: process.env.ANTHROPIC_API_KEY,
    onDiagnostics,
    completedSessionRecapDiscoveryCache,
    ...(monotonicNow ? {monotonicNow} : {})
  });
  const yahooRecapArticleContentAcquisition =
    createYahooRecapArticleContentAcquisitionService({
      fetchImpl,
      onDiagnostics,
      ...(monotonicNow ? {monotonicNow} : {})
    });
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
    },
    repairEvidenceSubjects(input) {
      return invokeClaudeEvidenceSubjectRepair({
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
    cnbcRecapResearch,
    cnbcNewsResearch,
    evidenceRoleClassification,
    now,
    ...(monotonicNow ? {monotonicNow} : {}),
    onDiagnostics
  });
}

const generationIdContext = new AsyncLocalStorage();
const CANONICAL_GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalGenerationId(value) {
  return typeof value === 'string' && value.length === 36
    && CANONICAL_GENERATION_ID.test(value) ? value.toLowerCase() : null;
}

function runWithGenerationId(generationId, operation) {
  return generationIdContext.run(canonicalGenerationId(generationId), operation);
}

function correlatedDiagnostics(diagnostics, generationId = generationIdContext.getStore()) {
  const canonical = canonicalGenerationId(generationId);
  return canonical === null ? diagnostics : {...diagnostics, generationId: canonical};
}

function logAnalysisPackageDiagnostics(diagnostics) {
  console.info('[analysis-package.stages]', JSON.stringify(correlatedDiagnostics(diagnostics)));
}

let sharedAnalysisPackageRuntime = null;

function getAnalysisPackageRuntime() {
  if (!sharedAnalysisPackageRuntime) {
    sharedAnalysisPackageRuntime = createAnalysisPackageRuntime({
      onDiagnostics: logAnalysisPackageDiagnostics
    });
  }
  return sharedAnalysisPackageRuntime;
}

module.exports = {
  YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS,
  createAnalysisPackageRuntime,
  getAnalysisPackageRuntime,
  canonicalGenerationId,
  runWithGenerationId,
  correlatedDiagnostics,
  logAnalysisPackageDiagnostics
};

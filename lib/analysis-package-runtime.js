const {AsyncLocalStorage} = require('node:async_hooks');
const {getPostgresRuntime} = require('./postgres-runtime');
const {
  createRuntimeFiveSessionSnapshotRepository
} = require('./runtime-five-session-snapshot-repository');
const {createYahooTelemetryAcquisitionService} = require('./yahoo-telemetry-acquisition');
const {
  createYahooMarketDataEvidenceAcquisitionService
} = require('./yahoo-market-data-evidence-acquisition');
const {createYahooMostActiveAcquisitionService} = require('./yahoo-most-active-acquisition');
const {createYahooMultiEditionNewsDiscoveryService} = require('./yahoo-latest-news-discovery');
const {
  createYahooCurrentNewsArticleContentAcquisitionService
} = require('./yahoo-current-news-article-content-acquisition');
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

const {yahooArticleBounds} = require('./reading-window');
const {settingValue} = require('./settings-registry');

// Step 9F.1f: the recap article text, evidence text and result caps come from the
// shared article size setting (ARTICLE_KB, default 16 KB, clamped 2-32 KB).
// Step 9F.2a: the page timeout and response cap below are moved into the shared
// settings registry but kept Fixed (no environment override), since Step
// 9F.1g's decision log protects "the 4 s page timeout and 1.5 MB page cap" for
// the recap specifically.
function yahooRecapPackageBounds(env = process.env) {
  const {maxArticleTextBytes, maxResultBytes} = yahooArticleBounds({env});
  return Object.freeze({
    articleContentBounds: Object.freeze({
      timeoutMs: settingValue('yahooRecapPageTimeoutMs'),
      maxResponseBytes: settingValue('yahooRecapMaxResponseBytes'),
      maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256,
      maxArticleTextBytes,
      maxResultBytes
    }),
    evidenceConstructionBounds: Object.freeze({
      maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256,
      maxEvidenceTextBytes: maxArticleTextBytes,
      maxResultBytes
    })
  });
}

const YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS = yahooRecapPackageBounds();

function createAnalysisPackageRuntime({
  fetchImpl = global.fetch,
  now = () => new Date(),
  postgresRuntime,
  monotonicNow,
  onDiagnostics,
  env = process.env
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const runtime = postgresRuntime || getPostgresRuntime();
  const recapBounds = yahooRecapPackageBounds(env);
  const snapshotPersistence = createRuntimeFiveSessionSnapshotRepository({runtime});
  const yahooEvidenceAcquisition = createYahooMarketDataEvidenceAcquisitionService({fetchImpl});
  const yahooMostActiveAcquisition = createYahooMostActiveAcquisitionService({fetchImpl});
  const yahooLatestNewsDiscovery = createYahooMultiEditionNewsDiscoveryService({fetchImpl});
  const yahooCurrentNewsArticleContentAcquisition =
    createYahooCurrentNewsArticleContentAcquisitionService({fetchImpl, ...yahooArticleBounds({env})});
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
    evidenceConstructionBounds: recapBounds.evidenceConstructionBounds
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
      now: () => new Date(generatedAt),
      onDiagnostics
    }),
    snapshotPersistence,
    yahooEvidenceAcquisition,
    yahooMostActiveAcquisition,
    yahooLatestNewsDiscovery,
    yahooCurrentNewsArticleContentAcquisition,
    federalReserveEvidenceAcquisition,
    yahooRecapResearch,
    yahooRecapArticleContentAcquisition,
    yahooRecapEvidenceConstruction,
    yahooRecapArticleContentBounds: recapBounds.articleContentBounds,
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
  yahooRecapPackageBounds,
  createAnalysisPackageRuntime,
  getAnalysisPackageRuntime,
  canonicalGenerationId,
  runWithGenerationId,
  correlatedDiagnostics,
  logAnalysisPackageDiagnostics
};

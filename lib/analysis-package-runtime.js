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

function createAnalysisPackageRuntime({
  fetchImpl = global.fetch,
  now = () => new Date(),
  postgresRuntime
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const runtime = postgresRuntime || getPostgresRuntime();
  const snapshotPersistence = createRuntimeThreeSessionSnapshotRepository({runtime});
  const yahooEvidenceAcquisition = createYahooMarketDataEvidenceAcquisitionService({fetchImpl});
  const federalReserveEvidenceAcquisition =
    createFederalReserveMonetaryPolicyEvidenceAcquisitionService({fetchImpl});

  return createUsAnalysisPackageOrchestrationService({
    createTelemetryAcquisition: ({generatedAt}) => createYahooTelemetryAcquisitionService({
      fetchImpl,
      now: () => new Date(generatedAt)
    }),
    snapshotPersistence,
    yahooEvidenceAcquisition,
    federalReserveEvidenceAcquisition,
    now
  });
}

let sharedAnalysisPackageRuntime = null;

function getAnalysisPackageRuntime() {
  if (!sharedAnalysisPackageRuntime) sharedAnalysisPackageRuntime = createAnalysisPackageRuntime();
  return sharedAnalysisPackageRuntime;
}

module.exports = {
  createAnalysisPackageRuntime,
  getAnalysisPackageRuntime
};

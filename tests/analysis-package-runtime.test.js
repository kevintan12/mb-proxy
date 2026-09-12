const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS,
  createAnalysisPackageRuntime
} = require('../lib/analysis-package-runtime');

test('runtime composer exposes a frozen US orchestration service without eager database access', async () => {
  let databaseCalls = 0;
  const runtime = {
    async query() { databaseCalls++; throw new Error('not expected'); },
    async transaction() { databaseCalls++; throw new Error('not expected'); }
  };
  const service = createAnalysisPackageRuntime({
    postgresRuntime: runtime,
    fetchImpl: async () => { throw new Error('not expected'); },
    now: () => new Date('2026-09-06T10:00:00Z')
  });
  assert.equal(Object.isFrozen(service), true);
  assert.equal(typeof service.assemble, 'function');
  await assert.rejects(service.assemble({}), /Invalid US analysis orchestration request/);
  assert.equal(databaseCalls, 0);
});

test('runtime composition includes bounded CNBC and Yahoo recap research but not final synthesis', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analysis-package-runtime.js'), 'utf8');
  for (const component of [
    'getPostgresRuntime',
    'createRuntimeThreeSessionSnapshotRepository',
    'createYahooTelemetryAcquisitionService',
    'createYahooMarketDataEvidenceAcquisitionService',
    'createFederalReserveMonetaryPolicyEvidenceAcquisitionService',
    'createCnbcNewsResearchRuntime',
    'createYahooRecapResearchRuntime',
    'createYahooRecapArticleContentAcquisitionService',
    'createYahooRecapEvidenceConstructionService',
    'invokeClaudeEvidenceRoleClassification',
    'createUsAnalysisPackageOrchestrationService'
  ]) assert.match(source, new RegExp(component));
  assert.doesNotMatch(source, /invokeClaudeAnalysis|claude-analysis-invocation/);
});

test('runtime owns the exact deeply immutable Yahoo recap package bounds', () => {
  assert.deepEqual(YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS, {
    articleContentBounds: {
      timeoutMs: 4000,
      maxResponseBytes: 1258291,
      maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256,
      maxArticleTextBytes: 8192,
      maxResultBytes: 12288
    },
    evidenceConstructionBounds: {
      maxHeadlineBytes: 512,
      maxPublisherNameBytes: 256,
      maxEvidenceTextBytes: 8192,
      maxResultBytes: 12288
    }
  });
  assert.equal(Object.isFrozen(YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS), true);
  assert.equal(Object.isFrozen(YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS.articleContentBounds), true);
  assert.equal(Object.isFrozen(YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS.evidenceConstructionBounds), true);
});

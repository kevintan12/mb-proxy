const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS,
  createAnalysisPackageRuntime,
  canonicalGenerationId,
  runWithGenerationId,
  correlatedDiagnostics
} = require('../lib/analysis-package-runtime');

test('accepts only canonical opaque UUIDs and keeps asynchronous generation contexts isolated', async () => {
  const first = '123E4567-E89B-42D3-A456-426614174000';
  const second = '123e4567-e89b-72d3-b456-426614174001';
  assert.equal(canonicalGenerationId(first), first.toLowerCase());
  for (const value of [undefined, null, [first, second], {id: first}, ` ${first}`,
    `${first} `, `${first}x`, '123e4567-e89b-02d3-a456-426614174000']) {
    assert.equal(canonicalGenerationId(value), null);
  }
  let releaseFirst;
  const firstWait = new Promise(resolve => { releaseFirst = resolve; });
  const pending = runWithGenerationId(first, async () => {
    await firstWait;
    return correlatedDiagnostics({stage: 'first'});
  });
  const other = await runWithGenerationId(second, async () => correlatedDiagnostics({stage: 'second'}));
  releaseFirst();
  assert.deepEqual(other, {stage: 'second', generationId: second});
  assert.deepEqual(await pending, {stage: 'first', generationId: first.toLowerCase()});
  assert.deepEqual(correlatedDiagnostics({stage: 'outside'}), {stage: 'outside'});
});

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
    'createRuntimeFiveSessionSnapshotRepository',
    'createYahooTelemetryAcquisitionService',
    'createYahooMarketDataEvidenceAcquisitionService',
    'createFederalReserveMonetaryPolicyEvidenceAcquisitionService',
    'createCnbcNewsResearchRuntime',
    'createCnbcRecapResearchRuntime',
    'createYahooRecapResearchRuntime',
    'createYahooRecapArticleContentAcquisitionService',
    'createYahooRecapEvidenceConstructionService',
    'invokeClaudeEvidenceRoleClassification',
    'invokeClaudeEvidenceSubjectRepair',
    'createUsAnalysisPackageOrchestrationService'
  ]) assert.match(source, new RegExp(component));
  assert.match(source,
    /createYahooRecapArticleContentAcquisitionService\(\{\s*fetchImpl,\s*onDiagnostics,/);
  assert.doesNotMatch(source, /invokeClaudeAnalysis|claude-analysis-invocation/);
});

test('runtime owns the exact deeply immutable Yahoo recap package bounds', () => {
  assert.deepEqual(YAHOO_RECAP_PACKAGE_PRODUCTION_BOUNDS, {
    articleContentBounds: {
      timeoutMs: 4000,
      maxResponseBytes: 1572864,
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

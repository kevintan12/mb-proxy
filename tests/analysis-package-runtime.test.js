const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createAnalysisPackageRuntime} = require('../lib/analysis-package-runtime');

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

test('runtime composition uses only the approved production components and does not invoke Claude', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analysis-package-runtime.js'), 'utf8');
  for (const component of [
    'getPostgresRuntime',
    'createRuntimeThreeSessionSnapshotRepository',
    'createYahooTelemetryAcquisitionService',
    'createYahooMarketDataEvidenceAcquisitionService',
    'createFederalReserveMonetaryPolicyEvidenceAcquisitionService',
    'createUsAnalysisPackageOrchestrationService'
  ]) assert.match(source, new RegExp(component));
  assert.doesNotMatch(source, /invokeClaude|claudeAnalysis|ANTHROPIC/);
});

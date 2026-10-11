// Step 9F.6a.3: a thin wrapper. The Yahoo news reading loop (Steps 9F.1b to
// 9F.1g) now lives in the shared source reader (lib/source-reader.js), with
// Yahoo as its first source (lib/sources/yahoo-news.js). This keeps the old
// call shape until Step 9F.6a.6, when the orchestration calls the shared reader
// directly and this file is removed.
'use strict';

const {readRunContext, readSource} = require('./source-reader');
const {createYahooNewsSource} = require('./sources/yahoo-news');

// Admitted items are pushed onto acquiredItems. Completed states (CLOSED,
// WEEKEND, HOLIDAY) pass `horizonFor` and `requiredItems` (Step 9F.1e); active
// states pass neither, and their horizon is CURRENT_SESSION while the session
// window exists.
async function readYahooNews({
  yahooMostActiveAcquisition,
  yahooLatestNewsDiscovery,
  yahooCurrentNewsArticleContentAcquisition,
  timed,
  emit,
  acquisitionStartedAt,
  marketContext,
  benchmarkSnapshots,
  stockSnapshots,
  classificationPreflightAvailable,
  yahooCollections,
  federalReserveCollection,
  activeSessionWindowResult,
  activeSessionWindow,
  acquiredItems,
  horizonFor = null,
  requiredItems = null,
  clock = {},
  limits
}) {
  const runContext = await readRunContext({yahooMostActiveAcquisition, timed});
  return readSource({
    source: createYahooNewsSource({
      yahooLatestNewsDiscovery,
      yahooCurrentNewsArticleContentAcquisition
    }),
    runContext,
    market: 'US',
    mode: horizonFor ? 'COMPLETED' : 'ACTIVE',
    timed,
    emit,
    acquisitionStartedAt,
    marketContext,
    benchmarkSnapshots,
    stockSnapshots,
    classificationPreflightAvailable,
    requiredItems: requiredItems
      || yahooCollections.flatMap(collection => collection.items).concat(
        federalReserveCollection ? federalReserveCollection.items : []
      ),
    horizonFor: horizonFor || (() => activeSessionWindow ? 'CURRENT_SESSION' : null),
    windowUnavailableReason: activeSessionWindowResult?.failureType ?? null,
    sessionWindow: activeSessionWindow,
    acquiredItems,
    clock,
    limits
  });
}

module.exports = {readYahooNews};

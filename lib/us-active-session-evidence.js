const {getSessionContext} = require('./market-session-calendar');

const US_ACTIVE_SESSION_STATES = Object.freeze(['PRE', 'REGULAR', 'POST']);
const ACTIVE_STATE_SET = new Set(US_ACTIVE_SESSION_STATES);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function deriveUsActiveSessionEvidenceWindow({marketState, generatedAt, benchmarkSnapshots = []} = {}) {
  if (!ACTIVE_STATE_SET.has(marketState) || !Array.isArray(benchmarkSnapshots)) return null;
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) return null;

  let current;
  try {
    current = getSessionContext({market: 'US', instant: generated});
  } catch (error) {
    return null;
  }
  if (!current.calendarSupported || !current.tradingDay || !current.regularOpenTime
      || current.session !== marketState) return null;

  const overlays = benchmarkSnapshots.map(entry => entry?.snapshot || entry)
    .map(snapshot => snapshot?.currentOverlay);
  if (overlays.length === 0 || overlays.some(overlay => !overlay)) return null;
  if (overlays.some(overlay => overlay.marketState !== marketState
      || overlay.sessionDate !== current.exchangeDate)) return null;

  let preMarket;
  try {
    preMarket = getSessionContext({
      market: 'US',
      instant: new Date(Date.parse(current.regularOpenTime) - 1)
    });
  } catch (error) {
    return null;
  }
  if (preMarket.session !== 'PRE' || !preMarket.sessionStartTime
      || preMarket.exchangeDate !== current.exchangeDate
      || Date.parse(preMarket.sessionStartTime) > generated.getTime()) return null;

  return deepFreeze({
    sessionDate: current.exchangeDate,
    startsAtInclusive: preMarket.sessionStartTime,
    endsAtInclusive: generated.toISOString()
  });
}

function isTimestampWithinUsActiveSessionWindow(value, window) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Boolean(window)
    && Number.isFinite(timestamp)
    && timestamp >= Date.parse(window.startsAtInclusive)
    && timestamp <= Date.parse(window.endsAtInclusive);
}

function currentSessionEvidenceContext(input) {
  if (!input || !input.analysisRequest || !Array.isArray(input.marketPackages)) return [];
  const result = [];
  for (const marketPackage of input.marketPackages) {
    if (marketPackage?.market !== 'US' || !marketPackage.marketContext
        || !marketPackage.telemetry || !marketPackage.evidenceContext) continue;
    const window = deriveUsActiveSessionEvidenceWindow({
      marketState: marketPackage.marketContext.marketState,
      generatedAt: input.analysisRequest.generatedAt,
      benchmarkSnapshots: marketPackage.telemetry.benchmarkSnapshots
    });
    if (!window) continue;
    const evidenceRefs = marketPackage.evidenceContext.evidence
      .filter(entry => entry?.item?.sourceId === 'us.yahoo-finance'
        && entry.item.evidenceCategory === 'news'
        && isTimestampWithinUsActiveSessionWindow(entry.item.publishedAt, window))
      .map(entry => entry.reference);
    result.push({market: 'US', sessionDate: window.sessionDate, evidenceRefs});
  }
  return deepFreeze(result);
}

module.exports = {
  US_ACTIVE_SESSION_STATES,
  deriveUsActiveSessionEvidenceWindow,
  isTimestampWithinUsActiveSessionWindow,
  currentSessionEvidenceContext
};

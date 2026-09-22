const {getSessionContext} = require('./market-session-calendar');

const US_ACTIVE_SESSION_STATES = Object.freeze(['PRE', 'REGULAR', 'POST']);
const ACTIVE_STATE_SET = new Set(US_ACTIVE_SESSION_STATES);
const ACTIVE_SESSION_ANCHOR_PREFIX = 'US_ACTIVE_SESSION_V1:';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function createUsActiveSessionAnchor({marketState, cutoffAt} = {}) {
  if (!ACTIVE_STATE_SET.has(marketState)) return null;
  const canonicalCutoff = canonicalTimestamp(cutoffAt);
  if (!canonicalCutoff) return null;
  let current;
  try {
    current = getSessionContext({market: 'US', instant: new Date(canonicalCutoff)});
  } catch (error) {
    return null;
  }
  if (!current.calendarSupported || !current.tradingDay || !current.regularOpenTime
      || current.session !== marketState) return null;
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
      || Date.parse(preMarket.sessionStartTime) > Date.parse(canonicalCutoff)) return null;
  return deepFreeze({
    marketState,
    sessionDate: current.exchangeDate,
    startsAtInclusive: preMarket.sessionStartTime,
    endsAtInclusive: canonicalCutoff
  });
}

function serializeUsActiveSessionAnchor(anchor) {
  if (!anchor || !ACTIVE_STATE_SET.has(anchor.marketState)
      || !/^\d{4}-\d{2}-\d{2}$/.test(anchor.sessionDate)
      || !canonicalTimestamp(anchor.startsAtInclusive)
      || !canonicalTimestamp(anchor.endsAtInclusive)) return null;
  return `${ACTIVE_SESSION_ANCHOR_PREFIX}${JSON.stringify({
    marketState: anchor.marketState,
    sessionDate: anchor.sessionDate,
    startsAtInclusive: canonicalTimestamp(anchor.startsAtInclusive),
    endsAtInclusive: canonicalTimestamp(anchor.endsAtInclusive)
  })}`;
}

function parseUsActiveSessionAnchor(value) {
  if (typeof value !== 'string' || !value.startsWith(ACTIVE_SESSION_ANCHOR_PREFIX)) return null;
  let parsed;
  try { parsed = JSON.parse(value.slice(ACTIVE_SESSION_ANCHOR_PREFIX.length)); } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || JSON.stringify(Object.keys(parsed)) !== JSON.stringify([
        'marketState', 'sessionDate', 'startsAtInclusive', 'endsAtInclusive'
      ])) return null;
  const canonical = createUsActiveSessionAnchor({
    marketState: parsed.marketState,
    cutoffAt: parsed.endsAtInclusive
  });
  if (!canonical || canonical.sessionDate !== parsed.sessionDate
      || canonical.startsAtInclusive !== parsed.startsAtInclusive
      || canonical.endsAtInclusive !== parsed.endsAtInclusive) return null;
  const serialized = serializeUsActiveSessionAnchor(canonical);
  return serialized === value ? canonical : null;
}

function activeSessionEvidenceWindowResult({
  marketState,
  generatedAt,
  benchmarkSnapshots = [],
  anchor = null
} = {}) {
  if (!ACTIVE_STATE_SET.has(marketState) || !Array.isArray(benchmarkSnapshots)) {
    return deepFreeze({window: null, failureType: 'ACTIVE_WINDOW_UNAVAILABLE'});
  }
  const canonicalAnchor = anchor || createUsActiveSessionAnchor({marketState, cutoffAt: generatedAt});
  if (!canonicalAnchor || canonicalAnchor.marketState !== marketState) {
    return deepFreeze({window: null, failureType: 'ACTIVE_WINDOW_UNAVAILABLE'});
  }

  const overlays = benchmarkSnapshots.map(entry => entry?.snapshot || entry)
    .map(snapshot => snapshot?.currentOverlay);
  const presentOverlays = overlays.filter(Boolean);
  if (presentOverlays.some(overlay => overlay.marketState !== marketState
      || overlay.sessionDate !== canonicalAnchor.sessionDate)) {
    return deepFreeze({window: null, failureType: 'BENCHMARK_OVERLAY_INVALID'});
  }
  return deepFreeze({window: canonicalAnchor, failureType: null});
}

function deriveUsActiveSessionEvidenceWindow(input) {
  return activeSessionEvidenceWindowResult(input).window;
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
    const anchor = parseUsActiveSessionAnchor(marketPackage.marketContext.calendarContext);
    const window = deriveUsActiveSessionEvidenceWindow({
      marketState: marketPackage.marketContext.marketState,
      generatedAt: input.analysisRequest.generatedAt,
      benchmarkSnapshots: marketPackage.telemetry.benchmarkSnapshots,
      anchor
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
  createUsActiveSessionAnchor,
  serializeUsActiveSessionAnchor,
  parseUsActiveSessionAnchor,
  activeSessionEvidenceWindowResult,
  deriveUsActiveSessionEvidenceWindow,
  isTimestampWithinUsActiveSessionWindow,
  currentSessionEvidenceContext
};

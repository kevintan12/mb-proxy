const {getSessionContext} = require('./market-session-calendar');

const US_ACTIVE_SESSION_STATES = Object.freeze(['PRE', 'REGULAR', 'POST']);
const ACTIVE_STATE_SET = new Set(US_ACTIVE_SESSION_STATES);
const ACTIVE_SESSION_ANCHOR_PREFIX_V2 = 'US_ACTIVE_SESSION_V2:';
const ACTIVE_SESSION_ANCHOR_PREFIX_V1 = 'US_ACTIVE_SESSION_V1:';
const PREVIOUS_TRADING_DAY_LOOKBACK_LIMIT = 10;

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

function previousCalendarDate(exchangeDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exchangeDate);
  if (!match) return null;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const previous = new Date(instant - 24 * 60 * 60 * 1000);
  return previous.toISOString().slice(0, 10);
}

function findPreviousTradingDayClose(market, exchangeDate) {
  let candidate = exchangeDate;
  for (let iteration = 0; iteration < PREVIOUS_TRADING_DAY_LOOKBACK_LIMIT; iteration++) {
    candidate = previousCalendarDate(candidate);
    if (!candidate) return null;
    let context;
    try {
      context = getSessionContext({market, exchangeDate: candidate});
    } catch (error) {
      return null;
    }
    if (context.calendarSupported && context.tradingDay && context.regularCloseTime) {
      return context;
    }
  }
  return null;
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
  if (!current.calendarSupported || !current.tradingDay || !current.regularCloseTime
      || current.session !== marketState) return null;

  let startsAtInclusive;
  if (marketState === 'POST') {
    startsAtInclusive = current.regularCloseTime;
  } else {
    const previous = findPreviousTradingDayClose('US', current.exchangeDate);
    if (!previous) return null;
    startsAtInclusive = previous.regularCloseTime;
  }
  if (Date.parse(startsAtInclusive) > Date.parse(canonicalCutoff)) return null;

  return deepFreeze({
    marketState,
    sessionDate: current.exchangeDate,
    startsAtInclusive,
    endsAtInclusive: canonicalCutoff
  });
}

// Legacy V1 window math (04:00 ET session-start anchored), kept only so a previously
// serialized US_ACTIVE_SESSION_V1 anchor still parses and replays with its original window.
// New anchors are never created with this logic; do not use it outside parseUsActiveSessionAnchor.
function legacyCreateUsActiveSessionAnchorV1({marketState, cutoffAt} = {}) {
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

function serializeAnchorWithPrefix(prefix, anchor) {
  if (!anchor || !ACTIVE_STATE_SET.has(anchor.marketState)
      || !/^\d{4}-\d{2}-\d{2}$/.test(anchor.sessionDate)
      || !canonicalTimestamp(anchor.startsAtInclusive)
      || !canonicalTimestamp(anchor.endsAtInclusive)) return null;
  return `${prefix}${JSON.stringify({
    marketState: anchor.marketState,
    sessionDate: anchor.sessionDate,
    startsAtInclusive: canonicalTimestamp(anchor.startsAtInclusive),
    endsAtInclusive: canonicalTimestamp(anchor.endsAtInclusive)
  })}`;
}

function serializeUsActiveSessionAnchor(anchor) {
  return serializeAnchorWithPrefix(ACTIVE_SESSION_ANCHOR_PREFIX_V2, anchor);
}

function legacySerializeUsActiveSessionAnchorV1(anchor) {
  return serializeAnchorWithPrefix(ACTIVE_SESSION_ANCHOR_PREFIX_V1, anchor);
}

function parseAnchorBody(prefix, value, createFn, serializeFn) {
  let parsed;
  try { parsed = JSON.parse(value.slice(prefix.length)); } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || JSON.stringify(Object.keys(parsed)) !== JSON.stringify([
        'marketState', 'sessionDate', 'startsAtInclusive', 'endsAtInclusive'
      ])) return null;
  const canonical = createFn({
    marketState: parsed.marketState,
    cutoffAt: parsed.endsAtInclusive
  });
  if (!canonical || canonical.sessionDate !== parsed.sessionDate
      || canonical.startsAtInclusive !== parsed.startsAtInclusive
      || canonical.endsAtInclusive !== parsed.endsAtInclusive) return null;
  const serialized = serializeFn(canonical);
  return serialized === value ? canonical : null;
}

function parseUsActiveSessionAnchor(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith(ACTIVE_SESSION_ANCHOR_PREFIX_V2)) {
    return parseAnchorBody(
      ACTIVE_SESSION_ANCHOR_PREFIX_V2, value,
      createUsActiveSessionAnchor, serializeUsActiveSessionAnchor
    );
  }
  if (value.startsWith(ACTIVE_SESSION_ANCHOR_PREFIX_V1)) {
    return parseAnchorBody(
      ACTIVE_SESSION_ANCHOR_PREFIX_V1, value,
      legacyCreateUsActiveSessionAnchorV1, legacySerializeUsActiveSessionAnchorV1
    );
  }
  return null;
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

// Step 8P.2(b) + 8P.3: a fixed, readable exchange-time label ("Thu 15 Oct, 6:33 am ET")
// so the writer never has to convert a timestamp itself.
const EXCHANGE_TIME_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true
});

function exchangeTimeLabel(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) return null;
  const parts = Object.fromEntries(EXCHANGE_TIME_PARTS.formatToParts(new Date(milliseconds))
    .map(part => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} `
    + `${String(parts.dayPeriod).toLowerCase()} ET`;
}

// Step 8W: the same exchange-time instant as a calendar date ("2026-10-15") and its
// weekday ("Thursday"), for the date check. Same time zone as the label above.
const EXCHANGE_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
});

function exchangeDateParts(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) return null;
  const parts = Object.fromEntries(EXCHANGE_DATE_PARTS.formatToParts(new Date(milliseconds))
    .map(part => [part.type, part.value]));
  return Object.freeze({date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday});
}

// Step 8P.2(b) + 8P.3: what has happened since the last regular close, for every
// active state alike (PRE and REGULAR: the previous trading day's close; POST: today's
// close). The articles are exactly the current-session Yahoo references above that
// were published at or after that close; nothing new is admitted here. The close is
// always worked out with today's (V2) close rule, so a replayed V1 package still names
// the real close rather than its narrower 04:00 ET window start.
function sinceLastCloseContext(input) {
  const current = currentSessionEvidenceContext(input);
  if (!current.length) return [];
  const result = [];
  for (const entry of current) {
    const marketPackage = input.marketPackages.find(item => item?.market === entry.market);
    const marketState = marketPackage.marketContext.marketState;
    const anchor = createUsActiveSessionAnchor({marketState, cutoffAt: input.analysisRequest.generatedAt})
      || parseUsActiveSessionAnchor(marketPackage.marketContext.calendarContext);
    if (!anchor) continue;
    const lastCloseAt = anchor.startsAtInclusive;
    const refs = new Set(entry.evidenceRefs);
    const evidenceRefs = marketPackage.evidenceContext.evidence
      .filter(item => refs.has(item.reference)
        && Date.parse(item.item.publishedAt) >= Date.parse(lastCloseAt))
      .map(item => item.reference);
    const liveTelemetry = marketPackage.telemetry.benchmarkSnapshots
      .some(snapshot => (snapshot?.snapshot || snapshot)?.currentOverlay);
    result.push({
      market: entry.market,
      marketState,
      lastCloseAt,
      lastCloseEt: exchangeTimeLabel(lastCloseAt),
      liveTelemetry,
      evidenceRefs
    });
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
  currentSessionEvidenceContext,
  exchangeTimeLabel,
  exchangeDateParts,
  sinceLastCloseContext
};

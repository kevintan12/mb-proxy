const {getSessionContext} = require('./market-session-calendar');

const DISCOVERED_VIA = 'DETERMINISTIC_SESSION_URL';
const MONTHS = Object.freeze([
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.',
  'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDate(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + days);
  return date.toISOString().slice(0, 10);
}

function previousUsTradingDate(targetSessionDate) {
  if (typeof targetSessionDate !== 'string' || !DATE.test(targetSessionDate)) return null;
  let target;
  try { target = getSessionContext({market: 'US', exchangeDate: targetSessionDate}); }
  catch (error) { return null; }
  if (!target.calendarSupported || !target.tradingDay) return null;
  let candidate = targetSessionDate;
  for (let attempts = 0; attempts < 16; attempts++) {
    candidate = shiftDate(candidate, -1);
    let context;
    try { context = getSessionContext({market: 'US', exchangeDate: candidate}); }
    catch (error) { return null; }
    if (!context.calendarSupported) return null;
    if (context.tradingDay) return candidate;
  }
  return null;
}

function deterministicCnbcRecapCandidate(targetSessionDate) {
  const editorialDate = previousUsTradingDate(targetSessionDate);
  if (!editorialDate) return null;
  const [year, month, day] = targetSessionDate.split('-').map(Number);
  return Object.freeze({
    title: `Stock market news for ${MONTHS[month - 1]} ${day}, ${year}`,
    url: `https://www.cnbc.com/${editorialDate.replaceAll('-', '/')}/stock-market-today-live-updates.html`,
    discoveredVia: DISCOVERED_VIA,
    targetSessionDate
  });
}

function createDeterministicCnbcRecapDiscoveryService() {
  return Object.freeze({
    async discoverCnbcCompletedSessionRecap({targetSessionDate} = {}) {
      const discovery = deterministicCnbcRecapCandidate(targetSessionDate);
      return Object.freeze(discovery
        ? {ok: true, type: 'SUCCESS', candidates: Object.freeze([
          Object.freeze({rank: 1, discovery})
        ])}
        : {ok: true, type: 'NOT_FOUND', candidates: Object.freeze([])});
    }
  });
}

module.exports = {
  CNBC_DETERMINISTIC_RECAP_DISCOVERED_VIA: DISCOVERED_VIA,
  previousUsTradingDate,
  deterministicCnbcRecapCandidate,
  createDeterministicCnbcRecapDiscoveryService
};

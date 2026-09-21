const PROVIDER = 'CNBC';
const SEARCH_INDEXES = Object.freeze([1, 2]);
const MAX_SESSION_ENTRIES_PER_INTENT = 2;
const MAX_IDENTITIES_PER_ENTRY = 5;
const IDENTITY_KEYS = Object.freeze(['title', 'url', 'discoveredVia', 'targetSessionDate']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? value : null;
}

function exactIdentity(value, targetSessionDate) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).length !== IDENTITY_KEYS.length
      || !IDENTITY_KEYS.every((key, index) => Reflect.ownKeys(value)[index] === key)
      || value.targetSessionDate !== targetSessionDate
      || typeof value.title !== 'string' || !value.title.trim()
      || typeof value.url !== 'string' || !value.url.trim()
      || value.discoveredVia !== 'ANTHROPIC_WEB_SEARCH') return null;
  return deepFreeze({
    title: value.title,
    url: value.url,
    discoveredVia: value.discoveredVia,
    targetSessionDate
  });
}

function createCnbcMarketNewsDiscoveryCache() {
  const entries = new Map(SEARCH_INDEXES.map(searchIndex => [searchIndex, new Map()]));
  return Object.freeze({
    get({provider, targetSessionDate, searchIndex} = {}) {
      const date = canonicalDate(targetSessionDate);
      if (provider !== PROVIDER || !date || !SEARCH_INDEXES.includes(searchIndex)) return null;
      return entries.get(searchIndex).get(date) || null;
    },
    set({provider, targetSessionDate, searchIndex, identities} = {}) {
      const date = canonicalDate(targetSessionDate);
      if (provider !== PROVIDER || !date || !SEARCH_INDEXES.includes(searchIndex)
          || !Array.isArray(identities) || identities.length < 1
          || identities.length > MAX_IDENTITIES_PER_ENTRY) return false;
      const canonical = identities.map(identity => exactIdentity(identity, date));
      if (canonical.some(identity => identity === null)
          || new Set(canonical.map(identity => identity.url)).size !== canonical.length) return false;
      const intentEntries = entries.get(searchIndex);
      intentEntries.delete(date);
      intentEntries.set(date, deepFreeze(canonical.slice()));
      while (intentEntries.size > MAX_SESSION_ENTRIES_PER_INTENT) {
        intentEntries.delete(intentEntries.keys().next().value);
      }
      return true;
    },
    delete({provider, targetSessionDate, searchIndex} = {}) {
      const date = canonicalDate(targetSessionDate);
      return provider === PROVIDER && date && SEARCH_INDEXES.includes(searchIndex)
        ? entries.get(searchIndex).delete(date) : false;
    }
  });
}

module.exports = {
  CNBC_MARKET_NEWS_CACHE_MAX_SESSION_ENTRIES_PER_INTENT: MAX_SESSION_ENTRIES_PER_INTENT,
  CNBC_MARKET_NEWS_CACHE_MAX_IDENTITIES_PER_ENTRY: MAX_IDENTITIES_PER_ENTRY,
  createCnbcMarketNewsDiscoveryCache
};

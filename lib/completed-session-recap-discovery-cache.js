const PROVIDERS = Object.freeze(['YAHOO', 'CNBC']);
const MAX_ENTRIES_PER_PROVIDER = 2;
const DISCOVERY_KEYS = Object.freeze(['title', 'url', 'discoveredVia', 'targetSessionDate']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
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

function canonicalProvider(value) {
  return PROVIDERS.includes(value) ? value : null;
}

function canonicalDiscovery(discovery, targetSessionDate) {
  if (!hasExactKeys(discovery, DISCOVERY_KEYS)
      || discovery.targetSessionDate !== targetSessionDate
      || typeof discovery.title !== 'string' || !discovery.title.trim()
      || typeof discovery.url !== 'string' || !discovery.url.trim()
      || discovery.discoveredVia !== 'ANTHROPIC_WEB_SEARCH') return null;
  return deepFreeze({
    title: discovery.title,
    url: discovery.url,
    discoveredVia: discovery.discoveredVia,
    targetSessionDate
  });
}

function createCompletedSessionRecapDiscoveryCache() {
  const entries = new Map(PROVIDERS.map(provider => [provider, new Map()]));
  return Object.freeze({
    get({provider, targetSessionDate} = {}) {
      const canonical = canonicalProvider(provider);
      const date = canonicalDate(targetSessionDate);
      if (!canonical || !date) return null;
      return entries.get(canonical).get(date) || null;
    },
    set({provider, targetSessionDate, discovery} = {}) {
      const canonical = canonicalProvider(provider);
      const date = canonicalDate(targetSessionDate);
      const identity = date ? canonicalDiscovery(discovery, date) : null;
      if (!canonical || !date || !identity) return false;
      const providerEntries = entries.get(canonical);
      providerEntries.delete(date);
      providerEntries.set(date, identity);
      while (providerEntries.size > MAX_ENTRIES_PER_PROVIDER) {
        providerEntries.delete(providerEntries.keys().next().value);
      }
      return true;
    },
    delete({provider, targetSessionDate} = {}) {
      const canonical = canonicalProvider(provider);
      const date = canonicalDate(targetSessionDate);
      return canonical && date ? entries.get(canonical).delete(date) : false;
    }
  });
}

module.exports = {
  COMPLETED_SESSION_RECAP_CACHE_PROVIDERS: PROVIDERS,
  COMPLETED_SESSION_RECAP_CACHE_MAX_ENTRIES_PER_PROVIDER: MAX_ENTRIES_PER_PROVIDER,
  createCompletedSessionRecapDiscoveryCache
};

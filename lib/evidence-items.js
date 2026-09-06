const {
  MARKETS,
  EVIDENCE_CATEGORIES,
  getSourceById
} = require('./evidence-sources');

const EVIDENCE_ITEM_KEYS = Object.freeze([
  'sourceId',
  'market',
  'evidenceCategory',
  'title',
  'summary',
  'canonicalUrl',
  'publishedAt',
  'symbols',
  'provenance'
]);
const EVIDENCE_PROVENANCE_KEYS = Object.freeze([
  'publisher',
  'authority',
  'homepage',
  'applicableMarket',
  'sourceJurisdiction',
  'locator'
]);

const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object') return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function equalStringArrays(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalPublishedAt(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_8601_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);

  if (calendarDate.getUTCFullYear() !== year
      || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;

  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? new Date(epochMilliseconds).toISOString() : null;
}

function canonicalHttpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.href : null;
  } catch (error) {
    return null;
  }
}

function normalizeInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['evidence item input must be an object'], values: null };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'provenance')) {
    errors.push('provenance is derived and must not be supplied');
  }

  const source = getSourceById(input.sourceId);
  if (!source) errors.push('unknown sourceId');

  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  if (!MARKETS.includes(market)) errors.push('invalid market');
  else if (source && source.market !== market) errors.push('source does not support market');

  const evidenceCategory = typeof input.evidenceCategory === 'string'
    ? input.evidenceCategory.trim().toLowerCase()
    : '';
  if (!EVIDENCE_CATEGORIES.includes(evidenceCategory)) errors.push('invalid evidenceCategory');
  else if (source && !source.evidenceCategories.includes(evidenceCategory)) {
    errors.push('source does not support evidenceCategory');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.push('title is required');

  let summary = null;
  if (input.summary !== undefined && input.summary !== null) {
    if (typeof input.summary !== 'string' || !input.summary.trim()) errors.push('invalid summary');
    else summary = input.summary.trim();
  }

  const canonicalUrl = canonicalHttpsUrl(input.canonicalUrl);
  if (!canonicalUrl) errors.push('canonicalUrl must be a valid HTTPS URL');

  const publishedAt = canonicalPublishedAt(input.publishedAt);
  if (!publishedAt) errors.push('publishedAt must be a valid ISO-8601 timestamp with timezone');

  let symbols = [];
  if (input.symbols !== undefined) {
    if (!Array.isArray(input.symbols)
        || input.symbols.some(symbol => typeof symbol !== 'string' || !symbol.trim())) {
      errors.push('symbols must be an array of non-empty strings');
    } else {
      symbols = input.symbols.map(symbol => symbol.trim());
    }
  }

  return {
    errors,
    values: source ? {
      sourceId: source.id,
      market,
      evidenceCategory,
      title,
      summary,
      canonicalUrl,
      publishedAt,
      symbols,
      source
    } : null
  };
}

function validateEvidenceItemInput(input) {
  const { errors } = normalizeInput(input);
  return deepFreeze({ valid: errors.length === 0, errors: errors.slice() });
}

function createEvidenceItem(input) {
  const { errors, values } = normalizeInput(input);
  if (errors.length) throw new TypeError(`Invalid evidence item: ${errors.join('; ')}`);

  return deepFreeze({
    sourceId: values.sourceId,
    market: values.market,
    evidenceCategory: values.evidenceCategory,
    title: values.title,
    summary: values.summary,
    canonicalUrl: values.canonicalUrl,
    publishedAt: values.publishedAt,
    symbols: values.symbols.slice(),
    provenance: {
      publisher: values.source.provenance.publisher,
      authority: values.source.provenance.authority,
      homepage: values.source.provenance.homepage,
      applicableMarket: values.source.provenance.applicableMarket,
      sourceJurisdiction: values.source.provenance.sourceJurisdiction,
      locator: values.source.provenance.locator
    }
  });
}

function validateEvidenceItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return deepFreeze({ valid: false, errors: ['evidence item must be an object'] });
  }
  if (!hasExactKeys(item, EVIDENCE_ITEM_KEYS)) {
    errors.push('invalid canonical property shape or order');
  }

  let expected = null;
  try {
    expected = createEvidenceItem({
      sourceId: item.sourceId,
      market: item.market,
      evidenceCategory: item.evidenceCategory,
      title: item.title,
      summary: item.summary,
      canonicalUrl: item.canonicalUrl,
      publishedAt: item.publishedAt,
      symbols: item.symbols
    });
  } catch (error) {
    errors.push('invalid canonical field values');
  }

  if (!item.provenance || typeof item.provenance !== 'object' || Array.isArray(item.provenance)) {
    errors.push('invalid canonical provenance');
  } else if (!hasExactKeys(item.provenance, EVIDENCE_PROVENANCE_KEYS)) {
    errors.push('invalid provenance property shape or order');
  }

  if (expected) {
    for (const key of EVIDENCE_ITEM_KEYS) {
      const equal = key === 'symbols'
        ? equalStringArrays(item.symbols, expected.symbols)
        : key === 'provenance'
          ? hasExactKeys(item.provenance, EVIDENCE_PROVENANCE_KEYS)
            && EVIDENCE_PROVENANCE_KEYS.every(provenanceKey =>
              item.provenance[provenanceKey] === expected.provenance[provenanceKey])
          : item[key] === expected[key];
      if (!equal) {
        errors.push(key === 'provenance' ? 'altered or spoofed provenance' : `non-canonical ${key}`);
      }
    }
  }

  return deepFreeze({ valid: errors.length === 0, errors });
}

module.exports = {
  EVIDENCE_ITEM_KEYS,
  createEvidenceItem,
  validateEvidenceItemInput,
  validateEvidenceItem
};

const { MARKETS } = require('./evidence-sources');
const { createEvidenceItem, validateEvidenceItem } = require('./evidence-items');

const EVIDENCE_COLLECTION_KEYS = Object.freeze(['market', 'items']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function normalizeCollectionInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['evidence collection input must be an object'], market: null, items: null };
  }

  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  if (!MARKETS.includes(market)) errors.push('invalid collection market');

  if (!Array.isArray(input.items)) {
    errors.push('collection items must be an array');
    return { errors, market, items: null };
  }

  input.items.forEach((item, index) => {
    const result = validateEvidenceItem(item);
    result.errors.forEach(error => errors.push(`items[${index}]: ${error}`));
    if (result.valid && item.market !== market) errors.push(`items[${index}]: collection market mismatch`);
  });
  return { errors, market, items: input.items };
}

function validateEvidenceCollectionInput(input) {
  const { errors } = normalizeCollectionInput(input);
  return deepFreeze({ valid: errors.length === 0, errors: errors.slice() });
}

function createEvidenceCollection(input) {
  const { errors, market, items } = normalizeCollectionInput(input);
  if (errors.length) throw new TypeError(`Invalid evidence collection: ${errors.join('; ')}`);

  const copiedItems = items.map(item => {
    const evidenceInput = {
      sourceId: item.sourceId,
      market: item.market,
      evidenceCategory: item.evidenceCategory,
      title: item.title,
      summary: item.summary,
      canonicalUrl: item.canonicalUrl,
      publishedAt: item.publishedAt,
      symbols: item.symbols
    };
    if (item.sourceId === 'us.yahoo-finance' && item.evidenceCategory === 'news') {
      evidenceInput.publisher = item.provenance.publisher;
    }
    return createEvidenceItem(evidenceInput);
  });

  return deepFreeze({ market, items: copiedItems });
}

module.exports = {
  EVIDENCE_COLLECTION_KEYS,
  createEvidenceCollection,
  validateEvidenceCollectionInput
};

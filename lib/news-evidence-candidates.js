const {MARKETS} = require('./evidence-sources');
const {createEvidenceItem, validateEvidenceItem} = require('./evidence-items');

const NEWS_EVIDENCE_CANDIDATE_KEYS = Object.freeze([
  'reference',
  'horizon',
  'sourceId',
  'market',
  'evidenceCategory',
  'title',
  'summary',
  'extract',
  'canonicalUrl',
  'publishedAt',
  'symbols',
  'provenance'
]);
const NEWS_EVIDENCE_HORIZON_KEYS = Object.freeze([
  'classification',
  'startsAtExclusive',
  'endsAtInclusive'
]);
const NEWS_EVIDENCE_COLLECTION_KEYS = Object.freeze(['market', 'candidates']);
const NEWS_EVIDENCE_BOUND_KEYS = Object.freeze([
  'maxCandidates',
  'maxTitleBytes',
  'maxSummaryBytes',
  'maxExtractBytes',
  'maxCollectionBytes'
]);
const NEWS_EVIDENCE_HORIZONS = Object.freeze([
  'COMPLETED_SESSION',
  'SUBSEQUENT_DEVELOPMENT'
]);
const CANDIDATE_REFERENCE = /^c[1-9][0-9]*$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
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

function canonicalBounds(bounds) {
  if (!hasExactKeys(bounds, NEWS_EVIDENCE_BOUND_KEYS)) {
    throw new TypeError('Invalid news evidence candidate bounds');
  }
  const result = {};
  for (const key of NEWS_EVIDENCE_BOUND_KEYS) {
    const value = bounds[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Invalid news evidence candidate bounds');
    }
    result[key] = value;
  }
  return deepFreeze(result);
}

function canonicalHorizon(value, publishedAt) {
  if (!hasExactKeys(value, NEWS_EVIDENCE_HORIZON_KEYS)
      || !NEWS_EVIDENCE_HORIZONS.includes(value.classification)) {
    throw new TypeError('Invalid news evidence horizon');
  }
  const startsAtExclusive = canonicalTimestamp(value.startsAtExclusive);
  const endsAtInclusive = canonicalTimestamp(value.endsAtInclusive);
  const publishedTime = Date.parse(publishedAt);
  if (!startsAtExclusive || !endsAtInclusive
      || Date.parse(startsAtExclusive) >= Date.parse(endsAtInclusive)
      || publishedTime <= Date.parse(startsAtExclusive)
      || publishedTime > Date.parse(endsAtInclusive)) {
    throw new TypeError('Candidate publication is outside its evidence horizon');
  }
  return {classification: value.classification, startsAtExclusive, endsAtInclusive};
}

function canonicalOptionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid candidate ${name}`);
  return value.trim();
}

function enforceTextBounds(values, bounds) {
  if (Buffer.byteLength(values.title, 'utf8') > bounds.maxTitleBytes
      || (values.summary !== null && Buffer.byteLength(values.summary, 'utf8') > bounds.maxSummaryBytes)
      || (values.extract !== null && Buffer.byteLength(values.extract, 'utf8') > bounds.maxExtractBytes)) {
    throw new TypeError('News evidence candidate text exceeds configured bounds');
  }
}

function evidenceInput(candidate) {
  return {
    sourceId: candidate.sourceId,
    market: candidate.market,
    evidenceCategory: candidate.evidenceCategory,
    title: candidate.title,
    summary: candidate.summary,
    canonicalUrl: candidate.canonicalUrl,
    publishedAt: candidate.publishedAt,
    symbols: candidate.symbols
  };
}

function createNewsEvidenceCandidate(input, {bounds} = {}) {
  const canonicalLimits = canonicalBounds(bounds);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid news evidence candidate');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'provenance')) {
    throw new TypeError('Candidate provenance is derived and must not be supplied');
  }
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (!CANDIDATE_REFERENCE.test(reference)) throw new TypeError('Invalid candidate reference');
  const item = createEvidenceItem(evidenceInput(input));
  const extract = canonicalOptionalText(input.extract, 'extract');
  enforceTextBounds({title: item.title, summary: item.summary, extract}, canonicalLimits);
  const horizon = canonicalHorizon(input.horizon, item.publishedAt);

  return deepFreeze({
    reference,
    horizon,
    sourceId: item.sourceId,
    market: item.market,
    evidenceCategory: item.evidenceCategory,
    title: item.title,
    summary: item.summary,
    extract,
    canonicalUrl: item.canonicalUrl,
    publishedAt: item.publishedAt,
    symbols: item.symbols.slice(),
    provenance: {...item.provenance}
  });
}

function validateNewsEvidenceCandidate(candidate, {bounds} = {}) {
  const errors = [];
  let expected = null;
  try {
    if (!hasExactKeys(candidate, NEWS_EVIDENCE_CANDIDATE_KEYS)) {
      errors.push('invalid canonical candidate property shape or order');
    }
    expected = createNewsEvidenceCandidate({
      reference: candidate.reference,
      horizon: candidate.horizon,
      ...evidenceInput(candidate),
      extract: candidate.extract
    }, {bounds});
  } catch (error) {
    errors.push('invalid canonical candidate values');
  }
  if (expected) {
    const candidateItem = evidenceInput(candidate);
    candidateItem.provenance = candidate.provenance;
    if (!validateEvidenceItem(candidateItem).valid
        || JSON.stringify(candidate) !== JSON.stringify(expected)) {
      errors.push('altered, spoofed, or non-canonical candidate');
    }
  }
  return deepFreeze({valid: errors.length === 0, errors});
}

function createNewsEvidenceCandidateCollection(input, {bounds} = {}) {
  const canonicalLimits = canonicalBounds(bounds);
  if (!hasExactKeys(input, NEWS_EVIDENCE_COLLECTION_KEYS)) {
    throw new TypeError('Invalid news evidence candidate collection shape');
  }
  const market = typeof input.market === 'string' ? input.market.trim().toUpperCase() : '';
  if (!MARKETS.includes(market) || !Array.isArray(input.candidates)) {
    throw new TypeError('Invalid news evidence candidate collection');
  }
  if (input.candidates.length > canonicalLimits.maxCandidates) {
    throw new TypeError('News evidence candidate collection exceeds configured candidate bound');
  }

  const seen = new Set();
  const candidates = input.candidates.map((candidate, index) => {
    const validation = validateNewsEvidenceCandidate(candidate, {bounds: canonicalLimits});
    if (!validation.valid || candidate.market !== market) {
      throw new TypeError(`Invalid news evidence candidate collection item ${index}`);
    }
    if (seen.has(candidate.reference)) throw new TypeError('Duplicate candidate reference');
    if (candidate.reference !== `c${index + 1}`) {
      throw new TypeError('Candidate references must match deterministic collection order');
    }
    seen.add(candidate.reference);
    return createNewsEvidenceCandidate({
      reference: candidate.reference,
      horizon: candidate.horizon,
      ...evidenceInput(candidate),
      extract: candidate.extract
    }, {bounds: canonicalLimits});
  });
  const collection = {market, candidates};
  if (Buffer.byteLength(JSON.stringify(collection), 'utf8') > canonicalLimits.maxCollectionBytes) {
    throw new TypeError('News evidence candidate collection exceeds configured byte bound');
  }
  return deepFreeze(collection);
}

function validateNewsEvidenceCandidateCollection(input, {bounds} = {}) {
  try {
    createNewsEvidenceCandidateCollection(input, {bounds});
    return deepFreeze({valid: true, errors: []});
  } catch (error) {
    return deepFreeze({valid: false, errors: [error.message]});
  }
}

module.exports = {
  NEWS_EVIDENCE_CANDIDATE_KEYS,
  NEWS_EVIDENCE_HORIZON_KEYS,
  NEWS_EVIDENCE_COLLECTION_KEYS,
  NEWS_EVIDENCE_BOUND_KEYS,
  NEWS_EVIDENCE_HORIZONS,
  createNewsEvidenceCandidate,
  validateNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection,
  validateNewsEvidenceCandidateCollection
};

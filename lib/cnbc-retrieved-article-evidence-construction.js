const {createEvidenceCollection} = require('./evidence-collections');
const {createEvidenceItem} = require('./evidence-items');
const {createNewsEvidenceCandidateCollection} = require('./news-evidence-candidates');
const {createClaudeNewsMaterialityOutput} = require('./claude-news-materiality-selection');
const {CNBC_ARTICLE_CONTENT_RESULT_KEYS} = require('./cnbc-article-content-acquisition');

const EVIDENCE_CONSTRUCTION_BOUND_KEYS = Object.freeze([
  'maxEvidenceTextBytes',
  'maxTitleBytes',
  'maxCollectionBytes'
]);
const CONSTRUCTED_EVIDENCE_RECORD_KEYS = Object.freeze([
  'candidateReference',
  'horizon',
  'selection',
  'evidenceItem'
]);
const CNBC_RETRIEVED_ARTICLE_EVIDENCE_RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'INPUT_FAILURE',
  'ARTICLE_VALIDATION_FAILURE',
  'EVIDENCE_TOO_LARGE',
  'EVIDENCE_CONTRACT_FAILURE'
]);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function canonicalCandidateBounds(bounds) {
  createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds});
  return deepFreeze({
    maxCandidates: bounds.maxCandidates,
    maxTitleBytes: bounds.maxTitleBytes,
    maxSummaryBytes: bounds.maxSummaryBytes,
    maxExtractBytes: bounds.maxExtractBytes,
    maxCollectionBytes: bounds.maxCollectionBytes
  });
}

function canonicalConstructionBounds(bounds) {
  if (!hasExactKeys(bounds, EVIDENCE_CONSTRUCTION_BOUND_KEYS)) {
    throw new TypeError('Invalid CNBC evidence construction bounds');
  }
  const result = {};
  for (const key of EVIDENCE_CONSTRUCTION_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) {
      throw new TypeError('Invalid CNBC evidence construction bounds');
    }
    result[key] = bounds[key];
  }
  return deepFreeze(result);
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message});
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function withinHorizon(timestamp, horizon) {
  const milliseconds = Date.parse(timestamp);
  return milliseconds > Date.parse(horizon.startsAtExclusive)
    && milliseconds <= Date.parse(horizon.endsAtInclusive);
}

function validateRetrievedArticle(article, candidate) {
  if (!hasExactKeys(article, CNBC_ARTICLE_CONTENT_RESULT_KEYS)
      || article.reference !== candidate.reference
      || article.sourceId !== candidate.sourceId
      || article.canonicalUrl !== candidate.canonicalUrl
      || article.title !== candidate.title
      || JSON.stringify(article.provenance) !== JSON.stringify(candidate.provenance)
      || !isCanonicalUtcTimestamp(article.publishedAt)
      || (article.updatedAt !== null && !isCanonicalUtcTimestamp(article.updatedAt))
      || typeof article.articleText !== 'string'
      || !article.articleText
      || article.articleText !== article.articleText.trim()) {
    throw new TypeError('Invalid CNBC retrieved article');
  }
  if (!withinHorizon(article.publishedAt, candidate.horizon)
      || (article.updatedAt !== null && !withinHorizon(article.updatedAt, candidate.horizon))
      || (article.updatedAt !== null
        && Date.parse(article.updatedAt) < Date.parse(article.publishedAt))) {
    throw new TypeError('CNBC retrieved article timestamps do not match its candidate');
  }
}

function createCnbcRetrievedArticleEvidenceConstructionService({
  candidateBounds,
  evidenceConstructionBounds
} = {}) {
  const canonicalCandidateLimits = canonicalCandidateBounds(candidateBounds);
  const constructionLimits = canonicalConstructionBounds(evidenceConstructionBounds);

  return Object.freeze({
    constructEvidence({candidateCollection, selections, retrievedArticles} = {}) {
      let canonicalCollection;
      let canonicalSelections;
      try {
        canonicalCollection = createNewsEvidenceCandidateCollection(
          candidateCollection,
          {bounds: canonicalCandidateLimits}
        );
        if (canonicalCollection.market !== 'US'
            || canonicalCollection.candidates.some(candidate =>
              candidate.sourceId !== 'us.cnbc'
              || candidate.market !== 'US'
              || candidate.evidenceCategory !== 'news')) {
          throw new TypeError('A canonical US CNBC candidate collection is required');
        }
        canonicalSelections = createClaudeNewsMaterialityOutput(
          {selections},
          canonicalCollection,
          {candidateBounds: canonicalCandidateLimits}
        ).selections;
      } catch (error) {
        return failure(
          'INPUT_FAILURE',
          'Invalid CNBC candidate collection or materiality selections'
        );
      }

      const selected = canonicalSelections.filter(selection => selection.decision === 'USE');
      if (!Array.isArray(retrievedArticles) || retrievedArticles.length !== selected.length) {
        return failure(
          'ARTICLE_VALIDATION_FAILURE',
          'CNBC retrieved articles do not match selected candidates'
        );
      }

      const candidatesByReference = new Map(
        canonicalCollection.candidates.map(candidate => [candidate.reference, candidate])
      );
      const evidenceInputs = [];
      for (let index = 0; index < selected.length; index++) {
        const selection = selected[index];
        const candidate = candidatesByReference.get(selection.reference);
        const article = retrievedArticles[index];
        try {
          if (!candidate) throw new TypeError('Unknown selected candidate');
          validateRetrievedArticle(article, candidate);
        } catch (error) {
          return failure(
            'ARTICLE_VALIDATION_FAILURE',
            'CNBC retrieved articles do not match selected candidates'
          );
        }
        if (Buffer.byteLength(candidate.title, 'utf8') > constructionLimits.maxTitleBytes
            || Buffer.byteLength(article.articleText, 'utf8') > constructionLimits.maxEvidenceTextBytes) {
          return failure(
            'EVIDENCE_TOO_LARGE',
            'CNBC constructed evidence exceeds configured bounds'
          );
        }
        try {
          evidenceInputs.push(createEvidenceItem({
            sourceId: candidate.sourceId,
            market: candidate.market,
            evidenceCategory: candidate.evidenceCategory,
            title: candidate.title,
            summary: article.articleText,
            canonicalUrl: candidate.canonicalUrl,
            publishedAt: candidate.publishedAt,
            symbols: candidate.symbols
          }));
        } catch (error) {
          return failure(
            'EVIDENCE_CONTRACT_FAILURE',
            'CNBC evidence construction failed canonical validation'
          );
        }
      }

      let evidenceCollection;
      try {
        evidenceCollection = createEvidenceCollection({market: 'US', items: evidenceInputs});
      } catch (error) {
        return failure(
          'EVIDENCE_CONTRACT_FAILURE',
          'CNBC evidence construction failed canonical validation'
        );
      }

      const constructedEvidence = evidenceCollection.items.map((evidenceItem, index) => ({
        candidateReference: selected[index].reference,
        horizon: {...candidatesByReference.get(selected[index].reference).horizon},
        selection: {...selected[index]},
        evidenceItem
      }));
      if (constructedEvidence.some(record => !hasExactKeys(record, CONSTRUCTED_EVIDENCE_RECORD_KEYS))
          || Buffer.byteLength(JSON.stringify(constructedEvidence), 'utf8')
            > constructionLimits.maxCollectionBytes) {
        return failure(
          'EVIDENCE_TOO_LARGE',
          'CNBC constructed evidence exceeds configured bounds'
        );
      }

      return deepFreeze({
        ok: true,
        type: 'SUCCESS',
        constructedEvidence
      });
    }
  });
}

module.exports = {
  CNBC_EVIDENCE_CONSTRUCTION_BOUND_KEYS: EVIDENCE_CONSTRUCTION_BOUND_KEYS,
  CNBC_CONSTRUCTED_EVIDENCE_RECORD_KEYS: CONSTRUCTED_EVIDENCE_RECORD_KEYS,
  CNBC_RETRIEVED_ARTICLE_EVIDENCE_RESULT_TYPES,
  createCnbcRetrievedArticleEvidenceConstructionService
};

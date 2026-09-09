const {createNewsEvidenceCandidateCollection} = require('./news-evidence-candidates');
const {createClaudeNewsMaterialityOutput} = require('./claude-news-materiality-selection');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS
} = require('./cnbc-article-content-acquisition');

const CNBC_SELECTED_ARTICLE_RETRIEVAL_RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'INPUT_FAILURE',
  'ARTICLE_RETRIEVAL_FAILURE',
  'ARTICLE_CONTRACT_FAILURE'
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

function canonicalArticleBounds(bounds) {
  if (!hasExactKeys(bounds, CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS)) {
    throw new TypeError('Invalid CNBC article retrieval bounds');
  }
  const result = {};
  for (const key of CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) {
      throw new TypeError('Invalid CNBC article retrieval bounds');
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

function isWithinCandidateHorizon(timestamp, candidate) {
  const instant = Date.parse(timestamp);
  return instant > Date.parse(candidate.horizon.startsAtExclusive)
    && instant <= Date.parse(candidate.horizon.endsAtInclusive);
}

function canonicalRetrievedArticle(article, candidate, bounds) {
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
  if (!isWithinCandidateHorizon(article.publishedAt, candidate)
      || (article.updatedAt !== null && !isWithinCandidateHorizon(article.updatedAt, candidate))
      || (article.updatedAt !== null
        && Date.parse(article.updatedAt) < Date.parse(article.publishedAt))) {
    throw new TypeError('CNBC retrieved article timestamps do not match its candidate');
  }
  if (Buffer.byteLength(article.title, 'utf8') > bounds.maxTitleBytes
      || Buffer.byteLength(article.articleText, 'utf8') > bounds.maxArticleTextBytes
      || Buffer.byteLength(JSON.stringify(article), 'utf8') > bounds.maxResultBytes) {
    throw new TypeError('CNBC retrieved article exceeds configured bounds');
  }
  return deepFreeze({
    reference: candidate.reference,
    sourceId: candidate.sourceId,
    canonicalUrl: candidate.canonicalUrl,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
    title: candidate.title,
    articleText: article.articleText,
    provenance: {...candidate.provenance}
  });
}

function createCnbcSelectedArticleRetrievalOrchestrationService({
  articleContentAcquisition,
  candidateBounds,
  articleRetrievalBounds
} = {}) {
  if (!articleContentAcquisition
      || typeof articleContentAcquisition.acquireArticleContent !== 'function') {
    throw new TypeError('articleContentAcquisition.acquireArticleContent must be a function');
  }
  const canonicalCandidateLimits = canonicalCandidateBounds(candidateBounds);
  const canonicalArticleLimits = canonicalArticleBounds(articleRetrievalBounds);

  return Object.freeze({
    async retrieveSelectedArticles({candidateCollection, selections} = {}) {
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
          throw new TypeError('A canonical US CNBC news candidate collection is required');
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

      const candidatesByReference = new Map(
        canonicalCollection.candidates.map(candidate => [candidate.reference, candidate])
      );
      const retrievedArticles = [];
      for (const selection of canonicalSelections) {
        if (selection.decision === 'SKIP') continue;
        const candidate = candidatesByReference.get(selection.reference);
        if (!candidate) {
          return failure('INPUT_FAILURE', 'Invalid CNBC materiality selection reference');
        }
        let acquired;
        try {
          acquired = await articleContentAcquisition.acquireArticleContent({
            candidate,
            bounds: canonicalArticleLimits
          });
        } catch (error) {
          return failure(
            'ARTICLE_RETRIEVAL_FAILURE',
            'CNBC selected article retrieval failed'
          );
        }
        try {
          retrievedArticles.push(canonicalRetrievedArticle(
            acquired,
            candidate,
            canonicalArticleLimits
          ));
        } catch (error) {
          return failure(
            'ARTICLE_CONTRACT_FAILURE',
            'CNBC retrieved article failed validation'
          );
        }
      }

      return deepFreeze({
        ok: true,
        type: 'SUCCESS',
        candidateCollection: canonicalCollection,
        selections: canonicalSelections,
        retrievedArticles
      });
    }
  });
}

module.exports = {
  CNBC_SELECTED_ARTICLE_RETRIEVAL_RESULT_TYPES,
  createCnbcSelectedArticleRetrievalOrchestrationService
};

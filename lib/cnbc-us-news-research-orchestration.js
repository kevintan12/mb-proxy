const {performance} = require('node:perf_hooks');
const {createEvidenceItem} = require('./evidence-items');
const {createNewsEvidenceCandidateCollection} = require('./news-evidence-candidates');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS
} = require('./cnbc-article-content-acquisition');
const {
  CNBC_PROVISIONAL_EVIDENCE_RECORD_KEYS,
  CNBC_EVIDENCE_CONSTRUCTION_BOUND_KEYS
} = require('./cnbc-retrieved-article-evidence-construction');

const CNBC_US_NEWS_RESEARCH_RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'NOT_FOUND',
  'DISCOVERY_PROVIDER_FAILURE',
  'CANDIDATE_ACQUISITION_FAILURE',
  'MATERIALITY_PROVIDER_FAILURE',
  'MATERIALITY_CONTRACT_FAILURE',
  'MATERIALITY_REQUEST_TOO_LARGE',
  'ARTICLE_RETRIEVAL_FAILURE',
  'EVIDENCE_CONSTRUCTION_FAILURE'
]);
const RESEARCH_RESULT_KEYS = Object.freeze([
  'ok',
  'type',
  'candidateCollection',
  'selections',
  'retrievedArticles',
  'constructedEvidence'
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

function canonicalPositiveBounds(bounds, keys, message) {
  if (!hasExactKeys(bounds, keys)) throw new TypeError(message);
  const result = {};
  for (const key of keys) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0) throw new TypeError(message);
    result[key] = bounds[key];
  }
  return deepFreeze(result);
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message});
}

function elapsed(start) {
  const value = performance.now() - start;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function emitDiagnostics(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try {
    onDiagnostics(deepFreeze(value));
  } catch (error) {
    // Observability must not affect research behavior.
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function withinHorizon(timestamp, horizon) {
  const value = Date.parse(timestamp);
  return value > Date.parse(horizon.startsAtExclusive)
    && value <= Date.parse(horizon.endsAtInclusive);
}

function canonicalArticles(candidateCollection, articles, bounds) {
  if (!Array.isArray(articles)
      || articles.length !== candidateCollection.candidates.length) {
    throw new TypeError('Article coverage mismatch');
  }
  return articles.map((article, index) => {
    const candidate = candidateCollection.candidates[index];
    if (!candidate || !hasExactKeys(article, CNBC_ARTICLE_CONTENT_RESULT_KEYS)
        || article.reference !== candidate.reference
        || article.sourceId !== candidate.sourceId
        || article.canonicalUrl !== candidate.canonicalUrl
        || article.title !== candidate.title
        || JSON.stringify(article.provenance) !== JSON.stringify(candidate.provenance)
        || !canonicalTimestamp(article.publishedAt)
        || (article.updatedAt !== null && !canonicalTimestamp(article.updatedAt))
        || typeof article.articleText !== 'string'
        || !article.articleText
        || article.articleText !== article.articleText.trim()
        || !withinHorizon(article.publishedAt, candidate.horizon)
        || (article.updatedAt !== null && !withinHorizon(article.updatedAt, candidate.horizon))
        || (article.updatedAt !== null
          && Date.parse(article.updatedAt) < Date.parse(article.publishedAt))
        || Buffer.byteLength(article.title, 'utf8') > bounds.maxTitleBytes
        || Buffer.byteLength(article.articleText, 'utf8') > bounds.maxArticleTextBytes
        || Buffer.byteLength(JSON.stringify(article), 'utf8') > bounds.maxResultBytes) {
      throw new TypeError('Invalid selected CNBC article');
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
  });
}

function canonicalConstructedEvidence(result, candidateCollection, articles, bounds) {
  if (!hasExactKeys(result, ['ok', 'type', 'constructedEvidence'])
      || result.ok !== true || result.type !== 'SUCCESS'
      || !Array.isArray(result.constructedEvidence)) {
    throw new TypeError('Invalid evidence construction result');
  }
  if (result.constructedEvidence.length !== candidateCollection.candidates.length) {
    throw new TypeError('Constructed evidence coverage mismatch');
  }
  const canonical = result.constructedEvidence.map((record, index) => {
    const candidate = candidateCollection.candidates[index];
    if (!candidate || !hasExactKeys(record, CNBC_PROVISIONAL_EVIDENCE_RECORD_KEYS)
        || record.candidateReference !== candidate.reference
        || JSON.stringify(record.horizon) !== JSON.stringify(candidate.horizon)) {
      throw new TypeError('Invalid constructed evidence linkage');
    }
    const evidenceItem = createEvidenceItem({
      sourceId: candidate.sourceId,
      market: candidate.market,
      evidenceCategory: candidate.evidenceCategory,
      title: candidate.title,
      summary: candidate.extract,
      canonicalUrl: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt,
      symbols: candidate.symbols
    });
    const expected = {
      candidateReference: candidate.reference,
      horizon: candidate.horizon,
      evidenceItem
    };
    if (JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new TypeError('Constructed evidence does not match canonical inputs');
    }
    return {
      candidateReference: candidate.reference,
      horizon: {...candidate.horizon},
      evidenceItem
    };
  });
  if (canonical.some(record =>
    Buffer.byteLength(record.evidenceItem.title, 'utf8') > bounds.maxTitleBytes
    || Buffer.byteLength(record.evidenceItem.summary, 'utf8') > bounds.maxEvidenceTextBytes)
      || Buffer.byteLength(JSON.stringify(canonical), 'utf8') > bounds.maxCollectionBytes) {
    throw new TypeError('Constructed evidence exceeds configured bounds');
  }
  return deepFreeze(canonical);
}

function createCnbcUsNewsResearchOrchestrationService({
  candidateAcquisition,
  evidenceConstruction,
  candidateBounds,
  articleRetrievalBounds,
  evidenceConstructionBounds,
  onDiagnostics
} = {}) {
  if (!candidateAcquisition || typeof candidateAcquisition.acquireCandidates !== 'function') {
    throw new TypeError('candidateAcquisition.acquireCandidates must be a function');
  }
  if (!evidenceConstruction
      || typeof evidenceConstruction.constructProvisionalEvidence !== 'function') {
    throw new TypeError('evidenceConstruction.constructProvisionalEvidence must be a function');
  }
  const candidateLimits = canonicalCandidateBounds(candidateBounds);
  const articleLimits = canonicalPositiveBounds(
    articleRetrievalBounds,
    CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS,
    'Invalid CNBC article retrieval bounds'
  );
  const evidenceLimits = canonicalPositiveBounds(
    evidenceConstructionBounds,
    CNBC_EVIDENCE_CONSTRUCTION_BOUND_KEYS,
    'Invalid CNBC evidence construction bounds'
  );

  return Object.freeze({
    async researchNews({targetSessionDate, horizons} = {}) {
      const started = performance.now();
      const timing = {
        candidateAcquisitionMs: 0,
        materialitySelectionMs: 0,
        selectedArticleRetrievalMs: 0,
        evidenceConstructionMs: 0,
        researchTotalMs: 0
      };
      const counts = {
        candidateCount: 0,
        useCount: 0,
        skipCount: 0,
        retrievedArticleCount: 0,
        constructedEvidenceCount: 0,
        materialityInvocationCount: 0
      };
      function finish(result) {
        timing.researchTotalMs = elapsed(started);
        emitDiagnostics(onDiagnostics, {
          stage: 'cnbcNewsResearch',
          outcome: result?.ok === true ? result.type : 'FAILURE',
          failureType: result?.ok === false && typeof result.type === 'string' ? result.type : null,
          timing: {...timing},
          counts: {...counts}
        });
        return result;
      }

      let candidateCollection;
      let retainedArticles;
      const acquisitionStarted = performance.now();
      try {
        const acquired = await candidateAcquisition.acquireCandidates({
          targetSessionDate, horizons, bounds: candidateLimits,
          articleRetrievalBounds: articleLimits
        });
        candidateCollection = createNewsEvidenceCandidateCollection(
          acquired?.candidateCollection,
          {bounds: candidateLimits}
        );
        if ((!Array.isArray(acquired?.retrievedArticles)
              || acquired.retrievedArticles.length !== candidateCollection.candidates.length)
            || candidateCollection.market !== 'US'
            || candidateCollection.candidates.some(candidate =>
              candidate.sourceId !== 'us.cnbc'
              || candidate.market !== 'US'
              || candidate.evidenceCategory !== 'news')) {
          throw new TypeError('Invalid CNBC candidate acquisition output');
        }
        if (candidateCollection.candidates.length === 0) {
          timing.candidateAcquisitionMs = elapsed(acquisitionStarted);
          return finish(deepFreeze({
            ok: true, type: 'NOT_FOUND', candidateCollection,
            selections: [], retrievedArticles: [], constructedEvidence: []
          }));
        }
        retainedArticles = acquired.retrievedArticles;
      } catch (error) {
        timing.candidateAcquisitionMs = elapsed(acquisitionStarted);
        return finish(failure(
          error?.code === 'DISCOVERY_PROVIDER_FAILURE'
            ? 'DISCOVERY_PROVIDER_FAILURE' : 'CANDIDATE_ACQUISITION_FAILURE',
          error?.code === 'DISCOVERY_PROVIDER_FAILURE'
            ? 'CNBC market-news discovery failed' : 'CNBC news candidate acquisition failed'
        ));
      }
      timing.candidateAcquisitionMs = elapsed(acquisitionStarted);
      counts.candidateCount = candidateCollection.candidates.length;

      let retrievedArticles;
      const retrievalStarted = performance.now();
      try {
        retrievedArticles = canonicalArticles(
          candidateCollection,
          retainedArticles,
          articleLimits
        );
      } catch (error) {
        timing.selectedArticleRetrievalMs = elapsed(retrievalStarted);
        return finish(failure(
          'ARTICLE_RETRIEVAL_FAILURE',
          'CNBC selected article retrieval failed'
        ));
      }
      timing.selectedArticleRetrievalMs = elapsed(retrievalStarted);
      counts.retrievedArticleCount = retrievedArticles.length;

      let constructedEvidence;
      const constructionStarted = performance.now();
      try {
        const constructionResult = await evidenceConstruction.constructProvisionalEvidence({
          candidateCollection,
          retrievedArticles,
          evidenceConstructionBounds: evidenceLimits
        });
        if (!constructionResult || constructionResult.ok !== true) {
          throw new TypeError('Evidence construction failed');
        }
        constructedEvidence = canonicalConstructedEvidence(
          constructionResult,
          candidateCollection,
          retrievedArticles,
          evidenceLimits
        );
      } catch (error) {
        timing.evidenceConstructionMs = elapsed(constructionStarted);
        return finish(failure(
          'EVIDENCE_CONSTRUCTION_FAILURE',
          'CNBC canonical evidence construction failed'
        ));
      }
      timing.evidenceConstructionMs = elapsed(constructionStarted);
      counts.constructedEvidenceCount = constructedEvidence.length;

      return finish(deepFreeze({
        ok: true,
        type: 'SUCCESS',
        candidateCollection,
        selections: [],
        retrievedArticles,
        constructedEvidence
      }));
    }
  });
}

module.exports = {
  CNBC_US_NEWS_RESEARCH_RESULT_TYPES,
  CNBC_US_NEWS_RESEARCH_RESULT_KEYS: RESEARCH_RESULT_KEYS,
  createCnbcUsNewsResearchOrchestrationService
};

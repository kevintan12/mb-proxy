const {performance} = require('node:perf_hooks');
const {createEvidenceItem} = require('./evidence-items');
const {createNewsEvidenceCandidateCollection} = require('./news-evidence-candidates');
const {createClaudeNewsMaterialityOutput} = require('./claude-news-materiality-selection');
const {
  CNBC_ARTICLE_CONTENT_RESULT_KEYS,
  CNBC_ARTICLE_RETRIEVAL_BOUND_KEYS
} = require('./cnbc-article-content-acquisition');
const {
  CNBC_CONSTRUCTED_EVIDENCE_RECORD_KEYS,
  CNBC_EVIDENCE_CONSTRUCTION_BOUND_KEYS
} = require('./cnbc-retrieved-article-evidence-construction');

const CNBC_US_NEWS_RESEARCH_RESULT_TYPES = Object.freeze([
  'SUCCESS',
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

function canonicalArticles(result, candidateCollection, selections, bounds) {
  if (!hasExactKeys(result, [
    'ok', 'type', 'candidateCollection', 'selections', 'retrievedArticles'
  ]) || result.ok !== true || result.type !== 'SUCCESS'
      || JSON.stringify(result.candidateCollection) !== JSON.stringify(candidateCollection)
      || JSON.stringify(result.selections) !== JSON.stringify(selections)
      || !Array.isArray(result.retrievedArticles)) {
    throw new TypeError('Invalid selected article retrieval result');
  }
  const selected = selections.filter(selection => selection.decision === 'USE');
  if (result.retrievedArticles.length !== selected.length) {
    throw new TypeError('Selected article coverage mismatch');
  }
  const candidates = new Map(candidateCollection.candidates.map(candidate => [candidate.reference, candidate]));
  return result.retrievedArticles.map((article, index) => {
    const selection = selected[index];
    const candidate = candidates.get(selection.reference);
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

function canonicalConstructedEvidence(result, candidateCollection, selections, articles, bounds) {
  if (!hasExactKeys(result, ['ok', 'type', 'constructedEvidence'])
      || result.ok !== true || result.type !== 'SUCCESS'
      || !Array.isArray(result.constructedEvidence)) {
    throw new TypeError('Invalid evidence construction result');
  }
  const selected = selections.filter(selection => selection.decision === 'USE');
  if (result.constructedEvidence.length !== selected.length) {
    throw new TypeError('Constructed evidence coverage mismatch');
  }
  const candidates = new Map(candidateCollection.candidates.map(candidate => [candidate.reference, candidate]));
  const canonical = result.constructedEvidence.map((record, index) => {
    const selection = selected[index];
    const candidate = candidates.get(selection.reference);
    const article = articles[index];
    if (!candidate || !hasExactKeys(record, CNBC_CONSTRUCTED_EVIDENCE_RECORD_KEYS)
        || record.candidateReference !== candidate.reference
        || JSON.stringify(record.horizon) !== JSON.stringify(candidate.horizon)
        || JSON.stringify(record.selection) !== JSON.stringify(selection)) {
      throw new TypeError('Invalid constructed evidence linkage');
    }
    const evidenceItem = createEvidenceItem({
      sourceId: candidate.sourceId,
      market: candidate.market,
      evidenceCategory: candidate.evidenceCategory,
      title: candidate.title,
      summary: article.articleText,
      canonicalUrl: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt,
      symbols: candidate.symbols
    });
    const expected = {
      candidateReference: candidate.reference,
      horizon: candidate.horizon,
      selection,
      evidenceItem
    };
    if (JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new TypeError('Constructed evidence does not match canonical inputs');
    }
    return {
      candidateReference: candidate.reference,
      horizon: {...candidate.horizon},
      selection: {...selection},
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

function mapMaterialityFailure(result) {
  if (result?.type === 'REQUEST_TOO_LARGE') {
    return failure(
      'MATERIALITY_REQUEST_TOO_LARGE',
      'CNBC news materiality request exceeds its provisional size limit'
    );
  }
  if (result?.type === 'CONTRACT_FAILURE' || result?.type === 'INPUT_FAILURE') {
    return failure(
      'MATERIALITY_CONTRACT_FAILURE',
      'CNBC news materiality output failed validation'
    );
  }
  return failure('MATERIALITY_PROVIDER_FAILURE', 'CNBC news materiality invocation failed');
}

function createCnbcUsNewsResearchOrchestrationService({
  candidateAcquisition,
  invokeMaterialitySelection,
  selectedArticleRetrieval,
  evidenceConstruction,
  candidateBounds,
  articleRetrievalBounds,
  evidenceConstructionBounds,
  onDiagnostics
} = {}) {
  if (!candidateAcquisition || typeof candidateAcquisition.acquireCandidates !== 'function') {
    throw new TypeError('candidateAcquisition.acquireCandidates must be a function');
  }
  if (typeof invokeMaterialitySelection !== 'function') {
    throw new TypeError('invokeMaterialitySelection must be a function');
  }
  if (!selectedArticleRetrieval
      || typeof selectedArticleRetrieval.retrieveSelectedArticles !== 'function') {
    throw new TypeError('selectedArticleRetrieval.retrieveSelectedArticles must be a function');
  }
  if (!evidenceConstruction || typeof evidenceConstruction.constructEvidence !== 'function') {
    throw new TypeError('evidenceConstruction.constructEvidence must be a function');
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
    async researchNews({horizons} = {}) {
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
          timing: {...timing},
          counts: {...counts}
        });
        return result;
      }

      let candidateCollection;
      const acquisitionStarted = performance.now();
      try {
        const acquired = await candidateAcquisition.acquireCandidates({
          horizons,
          bounds: candidateLimits
        });
        candidateCollection = createNewsEvidenceCandidateCollection(acquired, {bounds: candidateLimits});
        if (candidateCollection.market !== 'US'
            || candidateCollection.candidates.length === 0
            || candidateCollection.candidates.some(candidate =>
              candidate.sourceId !== 'us.cnbc'
              || candidate.market !== 'US'
              || candidate.evidenceCategory !== 'news')) {
          throw new TypeError('Invalid CNBC candidate acquisition output');
        }
      } catch (error) {
        timing.candidateAcquisitionMs = elapsed(acquisitionStarted);
        return finish(failure(
          'CANDIDATE_ACQUISITION_FAILURE',
          'CNBC news candidate acquisition failed'
        ));
      }
      timing.candidateAcquisitionMs = elapsed(acquisitionStarted);
      counts.candidateCount = candidateCollection.candidates.length;

      let invocationResult;
      const materialityStarted = performance.now();
      counts.materialityInvocationCount = 1;
      try {
        invocationResult = await invokeMaterialitySelection({
          candidateCollection,
          candidateBounds: candidateLimits,
          onDiagnostics
        });
      } catch (error) {
        timing.materialitySelectionMs = elapsed(materialityStarted);
        return finish(failure(
          'MATERIALITY_PROVIDER_FAILURE',
          'CNBC news materiality invocation failed'
        ));
      }
      timing.materialitySelectionMs = elapsed(materialityStarted);
      if (!invocationResult || invocationResult.ok !== true) {
        return finish(mapMaterialityFailure(invocationResult));
      }

      let selections;
      try {
        selections = createClaudeNewsMaterialityOutput(
          invocationResult.output,
          candidateCollection,
          {candidateBounds: candidateLimits}
        ).selections;
      } catch (error) {
        return finish(failure(
          'MATERIALITY_CONTRACT_FAILURE',
          'CNBC news materiality output failed validation'
        ));
      }
      counts.useCount = selections.filter(selection => selection.decision === 'USE').length;
      counts.skipCount = selections.length - counts.useCount;

      let retrievedArticles;
      const retrievalStarted = performance.now();
      try {
        const retrievalResult = await selectedArticleRetrieval.retrieveSelectedArticles({
          candidateCollection,
          selections,
          articleRetrievalBounds: articleLimits
        });
        if (!retrievalResult || retrievalResult.ok !== true) {
          throw new TypeError('Selected article retrieval failed');
        }
        retrievedArticles = canonicalArticles(
          retrievalResult,
          candidateCollection,
          selections,
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
        const constructionResult = await evidenceConstruction.constructEvidence({
          candidateCollection,
          selections,
          retrievedArticles,
          evidenceConstructionBounds: evidenceLimits
        });
        if (!constructionResult || constructionResult.ok !== true) {
          throw new TypeError('Evidence construction failed');
        }
        constructedEvidence = canonicalConstructedEvidence(
          constructionResult,
          candidateCollection,
          selections,
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
        selections,
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

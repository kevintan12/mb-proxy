const {
  createCnbcUsMarketNewsCandidateAcquisitionService
} = require('./cnbc-us-market-news-candidate-acquisition');
const {
  invokeClaudeNewsMaterialitySelection
} = require('./claude-news-materiality-selection');
const {
  createCnbcArticleContentAcquisitionService
} = require('./cnbc-article-content-acquisition');
const {
  createCnbcSelectedArticleRetrievalOrchestrationService
} = require('./cnbc-selected-article-retrieval-orchestration');
const {
  createCnbcRetrievedArticleEvidenceConstructionService
} = require('./cnbc-retrieved-article-evidence-construction');
const {
  createCnbcUsNewsResearchOrchestrationService
} = require('./cnbc-us-news-research-orchestration');

const CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS = Object.freeze({
  candidateBounds: Object.freeze({
    maxCandidates: 20,
    maxTitleBytes: 512,
    maxSummaryBytes: 2048,
    maxExtractBytes: 2048,
    maxCollectionBytes: 32 * 1024
  }),
  articleRetrievalBounds: Object.freeze({
    timeoutMs: 4000,
    maxResponseBytes: 1024 * 1024,
    maxArticleTextBytes: 8 * 1024,
    maxTitleBytes: 512,
    maxResultBytes: 12 * 1024
  }),
  evidenceConstructionBounds: Object.freeze({
    maxEvidenceTextBytes: 8 * 1024,
    maxTitleBytes: 512,
    maxCollectionBytes: 64 * 1024
  })
});

function createCnbcNewsResearchRuntime({
  fetchImpl = global.fetch,
  apiKey,
  onDiagnostics
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const bounds = CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS;
  const candidateAcquisition = createCnbcUsMarketNewsCandidateAcquisitionService({fetchImpl});
  const articleContentAcquisition = createCnbcArticleContentAcquisitionService({fetchImpl});
  const selectedArticleRetrieval = createCnbcSelectedArticleRetrievalOrchestrationService({
    articleContentAcquisition,
    candidateBounds: bounds.candidateBounds,
    articleRetrievalBounds: bounds.articleRetrievalBounds,
    onDiagnostics
  });
  const evidenceConstruction = createCnbcRetrievedArticleEvidenceConstructionService({
    candidateBounds: bounds.candidateBounds,
    evidenceConstructionBounds: bounds.evidenceConstructionBounds
  });

  return createCnbcUsNewsResearchOrchestrationService({
    candidateAcquisition,
    invokeMaterialitySelection: input => invokeClaudeNewsMaterialitySelection({
      ...input,
      apiKey,
      fetchImpl
    }),
    selectedArticleRetrieval,
    evidenceConstruction,
    candidateBounds: bounds.candidateBounds,
    articleRetrievalBounds: bounds.articleRetrievalBounds,
    evidenceConstructionBounds: bounds.evidenceConstructionBounds,
    onDiagnostics
  });
}

module.exports = {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcNewsResearchRuntime
};

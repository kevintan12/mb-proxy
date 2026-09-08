const {createNewsEvidenceCandidateCollection} = require('./news-evidence-candidates');
const {createClaudeNewsMaterialityOutput} = require('./claude-news-materiality-selection');

const CNBC_US_NEWS_MATERIALITY_RESULT_TYPES = Object.freeze([
  'SUCCESS',
  'CANDIDATE_ACQUISITION_FAILURE',
  'MATERIALITY_PROVIDER_FAILURE',
  'MATERIALITY_CONTRACT_FAILURE',
  'MATERIALITY_REQUEST_TOO_LARGE'
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalBounds(bounds) {
  const empty = createNewsEvidenceCandidateCollection(
    {market: 'US', candidates: []},
    {bounds}
  );
  if (empty.market !== 'US') throw new TypeError('Invalid CNBC candidate bounds');
  return deepFreeze({
    maxCandidates: bounds.maxCandidates,
    maxTitleBytes: bounds.maxTitleBytes,
    maxSummaryBytes: bounds.maxSummaryBytes,
    maxExtractBytes: bounds.maxExtractBytes,
    maxCollectionBytes: bounds.maxCollectionBytes
  });
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message});
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
  return failure(
    'MATERIALITY_PROVIDER_FAILURE',
    'CNBC news materiality invocation failed'
  );
}

function createCnbcUsNewsMaterialityOrchestrationService({
  candidateAcquisition,
  invokeMaterialitySelection,
  candidateBounds,
  onDiagnostics
} = {}) {
  if (!candidateAcquisition || typeof candidateAcquisition.acquireCandidates !== 'function') {
    throw new TypeError('candidateAcquisition.acquireCandidates must be a function');
  }
  if (typeof invokeMaterialitySelection !== 'function') {
    throw new TypeError('invokeMaterialitySelection must be a function');
  }
  const bounds = canonicalBounds(candidateBounds);

  return Object.freeze({
    async selectMaterialNews({horizons} = {}) {
      let candidateCollection;
      try {
        const acquired = await candidateAcquisition.acquireCandidates({horizons, bounds});
        candidateCollection = createNewsEvidenceCandidateCollection(acquired, {bounds});
        if (candidateCollection.candidates.length === 0) {
          throw new TypeError('CNBC candidate collection is empty');
        }
      } catch (error) {
        return failure(
          'CANDIDATE_ACQUISITION_FAILURE',
          'CNBC news candidate acquisition failed'
        );
      }

      let invocationResult;
      try {
        invocationResult = await invokeMaterialitySelection({
          candidateCollection,
          candidateBounds: bounds,
          onDiagnostics
        });
      } catch (error) {
        return failure(
          'MATERIALITY_PROVIDER_FAILURE',
          'CNBC news materiality invocation failed'
        );
      }
      if (!invocationResult || invocationResult.ok !== true) {
        return mapMaterialityFailure(invocationResult);
      }

      let selections;
      try {
        selections = createClaudeNewsMaterialityOutput(
          invocationResult.output,
          candidateCollection,
          {candidateBounds: bounds}
        ).selections;
      } catch (error) {
        return failure(
          'MATERIALITY_CONTRACT_FAILURE',
          'CNBC news materiality output failed validation'
        );
      }

      return deepFreeze({
        ok: true,
        type: 'SUCCESS',
        candidateCollection,
        selections
      });
    }
  });
}

module.exports = {
  CNBC_US_NEWS_MATERIALITY_RESULT_TYPES,
  createCnbcUsNewsMaterialityOrchestrationService
};

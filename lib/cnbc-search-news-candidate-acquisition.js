const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection,
  NEWS_EVIDENCE_HORIZONS
} = require('./news-evidence-candidates');
const {
  CNBC_DISCOVERED_ARTICLE_RESULT_KEYS,
  CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES
} = require('./cnbc-article-content-acquisition');

const RESULT_KEYS = Object.freeze(['candidateCollection', 'retrievedArticles']);
const DISCOVERY_KEYS = Object.freeze(['rank', 'title', 'url', 'discoveredVia', 'targetSessionDate']);
const HORIZON_KEYS = Object.freeze(['classification', 'startsAtExclusive', 'endsAtInclusive']);
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_EXTRACTION_FAILURES = new Set(CNBC_EXTRACTION_DIAGNOSTIC_FAILURE_TYPES);

class CnbcSearchNewsCandidateAcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CnbcSearchNewsCandidateAcquisitionError';
    this.code = code;
  }
}

function fail(code, message) {
  return new CnbcSearchNewsCandidateAcquisitionError(code, message);
}

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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? value : null;
}

function canonicalHorizons(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const result = value.map(horizon => {
    if (!hasExactKeys(horizon, HORIZON_KEYS)
        || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)
        || typeof horizon.startsAtExclusive !== 'string' || !UTC.test(horizon.startsAtExclusive)
        || typeof horizon.endsAtInclusive !== 'string' || !UTC.test(horizon.endsAtInclusive)
        || Date.parse(horizon.startsAtExclusive) >= Date.parse(horizon.endsAtInclusive)) return null;
    return {...horizon};
  });
  return result.some(item => !item) ? null : deepFreeze(result);
}

function horizonFor(article, horizons) {
  return horizons.find(horizon => {
    const published = Date.parse(article.publishedAt);
    const updated = article.updatedAt === null ? published : Date.parse(article.updatedAt);
    return published > Date.parse(horizon.startsAtExclusive)
      && published <= Date.parse(horizon.endsAtInclusive)
      && updated > Date.parse(horizon.startsAtExclusive)
      && updated <= Date.parse(horizon.endsAtInclusive);
  }) || null;
}

function utf8Prefix(value, maxBytes) {
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return output.trim() || null;
}

function emit(onDiagnostics, value) {
  if (typeof onDiagnostics !== 'function') return;
  try { onDiagnostics(deepFreeze(value)); } catch (error) { /* diagnostics cannot alter acquisition */ }
}

function createCnbcSearchNewsCandidateAcquisitionService({
  discovery,
  articleContentAcquisition,
  onDiagnostics
} = {}) {
  if (!discovery || typeof discovery.discoverCnbcMarketNews !== 'function') {
    throw new TypeError('discovery.discoverCnbcMarketNews must be a function');
  }
  if (!articleContentAcquisition
      || typeof articleContentAcquisition.acquireDiscoveredArticleContent !== 'function') {
    throw new TypeError('articleContentAcquisition.acquireDiscoveredArticleContent must be a function');
  }
  return Object.freeze({
    async acquireCandidates({targetSessionDate, horizons, bounds, articleRetrievalBounds} = {}) {
      const canonicalTarget = canonicalDate(targetSessionDate);
      const canonicalWindows = canonicalHorizons(horizons);
      if (!canonicalTarget || !canonicalWindows) throw fail('INVALID_INPUT', 'Invalid CNBC search acquisition request');
      let discovered;
      try {
        discovered = await discovery.discoverCnbcMarketNews({targetSessionDate: canonicalTarget});
      } catch (error) {
        throw fail('DISCOVERY_PROVIDER_FAILURE', 'CNBC market-news discovery failed');
      }
      if (!discovered || discovered.ok !== true) {
        throw fail('DISCOVERY_PROVIDER_FAILURE', 'CNBC market-news discovery failed');
      }
      if (discovered.type === 'NOT_FOUND') {
        emit(onDiagnostics, {
          stage: 'cnbcCandidateAcquisition',
          outcome: 'ZERO_DISCOVERIES',
          discoveryCount: 0,
          pageAttemptCount: 0,
          pageFailureCount: 0,
          extractionFailureCount: 0,
          horizonFailureCount: 0,
          contractFailureCount: 0,
          candidateCount: 0
        });
        return deepFreeze({
          candidateCollection: createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds}),
          retrievedArticles: []
        });
      }
      if (discovered.type !== 'SUCCESS' || !Array.isArray(discovered.discoveries)) {
        throw fail('DISCOVERY_CONTRACT_FAILURE', 'CNBC market-news discovery output is invalid');
      }

      const candidates = [];
      const retrievedArticles = [];
      const counts = {
        discoveryCount: discovered.discoveries.length,
        pageAttemptCount: 0,
        pageFailureCount: 0,
        extractionFailureCount: 0,
        horizonFailureCount: 0,
        contractFailureCount: 0
      };
      for (const raw of discovered.discoveries) {
        if (!hasExactKeys(raw, DISCOVERY_KEYS) || raw.targetSessionDate !== canonicalTarget) {
          counts.contractFailureCount++;
          continue;
        }
        const discoveryInput = deepFreeze({...raw});
        let article;
        counts.pageAttemptCount++;
        try {
          article = await articleContentAcquisition.acquireDiscoveredArticleContent({
            discovery: discoveryInput,
            bounds: articleRetrievalBounds
          });
        } catch (error) {
          counts.pageFailureCount++;
          if (error?.code === 'EXTRACTION_FAILURE') counts.extractionFailureCount++;
          const diagnostic = {
            stage: 'cnbcDiscoveredArticleAcquisition',
            rank: Number.isSafeInteger(raw.rank) ? raw.rank : null,
            failureType: typeof error?.code === 'string' ? error.code : 'UNKNOWN_FAILURE'
          };
          if (error?.code === 'EXTRACTION_FAILURE') {
            diagnostic.extractionFailureType = SAFE_EXTRACTION_FAILURES.has(error.extractionFailureType)
              ? error.extractionFailureType : 'UNKNOWN_EXTRACTION_FAILURE';
          }
          emit(onDiagnostics, diagnostic);
          continue;
        }
        if (!hasExactKeys(article, CNBC_DISCOVERED_ARTICLE_RESULT_KEYS)
            || article.discoveryRank !== raw.rank || article.targetSessionDate !== canonicalTarget) {
          counts.contractFailureCount++;
          continue;
        }
        const horizon = horizonFor(article, canonicalWindows);
        if (!horizon) {
          counts.horizonFailureCount++;
          emit(onDiagnostics, {
            stage: 'cnbcDiscoveredArticleAcquisition', rank: raw.rank, failureType: 'HORIZON_MISMATCH'
          });
          continue;
        }
        const reference = `c${candidates.length + 1}`;
        try {
          const candidate = createNewsEvidenceCandidate({
            reference,
            horizon,
            sourceId: article.sourceId,
            market: 'US',
            evidenceCategory: 'news',
            title: article.title,
            summary: null,
            extract: utf8Prefix(article.articleText, bounds.maxExtractBytes),
            canonicalUrl: article.canonicalUrl,
            publishedAt: article.publishedAt,
            symbols: []
          }, {bounds});
          candidates.push(candidate);
          retrievedArticles.push(deepFreeze({
            reference,
            sourceId: article.sourceId,
            canonicalUrl: article.canonicalUrl,
            publishedAt: article.publishedAt,
            updatedAt: article.updatedAt,
            title: article.title,
            articleText: article.articleText,
            provenance: {...article.provenance}
          }));
        } catch (error) {
          counts.contractFailureCount++;
          emit(onDiagnostics, {
            stage: 'cnbcDiscoveredArticleAcquisition', rank: raw.rank,
            failureType: 'CANDIDATE_CONTRACT_FAILURE'
          });
        }
      }
      const outcome = candidates.length ? 'SUCCESS'
        : counts.pageAttemptCount > 0 && counts.pageFailureCount === counts.pageAttemptCount
          ? 'ALL_PAGES_FAILED'
          : counts.horizonFailureCount > 0
              && counts.horizonFailureCount + counts.pageFailureCount === counts.pageAttemptCount
            ? 'ALL_EXTRACTED_PAGES_OUT_OF_HORIZON'
            : 'NO_USABLE_CANDIDATES';
      emit(onDiagnostics, {
        stage: 'cnbcCandidateAcquisition',
        outcome,
        ...counts,
        candidateCount: candidates.length
      });
      const candidateCollection = createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds});
      const result = {candidateCollection, retrievedArticles};
      if (!hasExactKeys(result, RESULT_KEYS)) throw fail('CANDIDATE_CONTRACT_FAILURE', 'CNBC candidate acquisition failed');
      return deepFreeze(result);
    }
  });
}

module.exports = {
  CNBC_SEARCH_NEWS_ACQUISITION_RESULT_KEYS: RESULT_KEYS,
  CnbcSearchNewsCandidateAcquisitionError,
  createCnbcSearchNewsCandidateAcquisitionService
};

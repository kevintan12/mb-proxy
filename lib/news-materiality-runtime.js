const {
  NEWS_EVIDENCE_BOUND_KEYS,
  NEWS_EVIDENCE_HORIZONS,
  createNewsEvidenceCandidateCollection
} = require('./news-evidence-candidates');
const {
  createCnbcUsMarketNewsCandidateAcquisitionService
} = require('./cnbc-us-market-news-candidate-acquisition');
const {
  invokeClaudeNewsMaterialitySelection
} = require('./claude-news-materiality-selection');
const {
  createCnbcUsNewsMaterialityOrchestrationService
} = require('./cnbc-us-news-materiality-orchestration');

const NEWS_MATERIALITY_REQUEST_KEYS = Object.freeze(['market', 'horizons', 'bounds']);
const HORIZON_KEYS = Object.freeze(['classification', 'startsAtExclusive', 'endsAtInclusive']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

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
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function validateNewsMaterialityRequest(input) {
  if (!hasExactKeys(input, NEWS_MATERIALITY_REQUEST_KEYS) || input.market !== 'US'
      || !Array.isArray(input.horizons) || input.horizons.length === 0
      || !hasExactKeys(input.bounds, NEWS_EVIDENCE_BOUND_KEYS)) return false;
  if (NEWS_EVIDENCE_BOUND_KEYS.some(key => !Number.isSafeInteger(input.bounds[key]) || input.bounds[key] <= 0)) {
    return false;
  }
  try {
    createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds: input.bounds});
  } catch (error) {
    return false;
  }
  const windows = [];
  for (const horizon of input.horizons) {
    if (!hasExactKeys(horizon, HORIZON_KEYS)
        || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)) return false;
    const start = canonicalTimestamp(horizon.startsAtExclusive);
    const end = canonicalTimestamp(horizon.endsAtInclusive);
    if (!start || !end || Date.parse(start) >= Date.parse(end)) return false;
    windows.push({start: Date.parse(start), end: Date.parse(end)});
  }
  for (let left = 0; left < windows.length; left++) {
    for (let right = left + 1; right < windows.length; right++) {
      if (windows[left].start < windows[right].end && windows[right].start < windows[left].end) {
        return false;
      }
    }
  }
  return true;
}

function createNewsMaterialityRuntime({
  fetchImpl = global.fetch,
  apiKey,
  onDiagnostics
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const candidateAcquisition = createCnbcUsMarketNewsCandidateAcquisitionService({fetchImpl});

  return Object.freeze({
    async measure(request) {
      if (!validateNewsMaterialityRequest(request)) {
        return Object.freeze({ok: false, type: 'INVALID_REQUEST'});
      }
      const service = createCnbcUsNewsMaterialityOrchestrationService({
        candidateAcquisition,
        candidateBounds: request.bounds,
        onDiagnostics,
        invokeMaterialitySelection: input => invokeClaudeNewsMaterialitySelection({
          ...input,
          apiKey,
          fetchImpl
        })
      });
      const result = await service.selectMaterialNews({horizons: request.horizons});
      if (!result.ok) return result;

      const materialityCounts = {HIGH: 0, MEDIUM: 0, LOW: 0};
      let useCount = 0;
      let skipCount = 0;
      for (const selection of result.selections) {
        if (selection.decision === 'USE') useCount++;
        else skipCount++;
        materialityCounts[selection.materiality]++;
      }
      return Object.freeze({
        ok: true,
        type: 'SUCCESS',
        candidateCount: result.candidateCollection.candidates.length,
        useCount,
        skipCount,
        materialityCounts: Object.freeze(materialityCounts)
      });
    }
  });
}

let sharedNewsMaterialityRuntime = null;

function getNewsMaterialityRuntime() {
  if (!sharedNewsMaterialityRuntime) {
    sharedNewsMaterialityRuntime = createNewsMaterialityRuntime({
      apiKey: process.env.ANTHROPIC_API_KEY,
      onDiagnostics(diagnostics) {
        console.info('[news-materiality.invocation]', JSON.stringify(diagnostics));
      }
    });
  }
  return sharedNewsMaterialityRuntime;
}

module.exports = {
  NEWS_MATERIALITY_REQUEST_KEYS,
  validateNewsMaterialityRequest,
  createNewsMaterialityRuntime,
  getNewsMaterialityRuntime
};

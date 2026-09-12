const {MARKETS} = require('./evidence-sources');
const {
  createClaudeAnalysisInput,
  validateClaudeAnalysisInput
} = require('./claude-analysis-contract');

const ANALYSIS_PACKAGE_REQUEST_KEYS = Object.freeze([
  'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
]);
const ANALYSIS_PACKAGE_MEMBERSHIP_KEYS = Object.freeze(['market', 'symbol']);
const ANALYSIS_PACKAGE_MATERIAL_KEYS = Object.freeze(['marketPackages', 'portfolioContext']);
const SELECTED_SCOPES = Object.freeze([...MARKETS, 'ALL']);
const PACKAGE_ASSEMBLY_FAILURE_STAGES = new Set([
  'ANALYSIS_MATERIAL_ACQUISITION',
  'EVIDENCE_COLLECTION_CONSTRUCTION',
  'FUTURE_DATED_EVIDENCE_VALIDATION',
  'ACQUIRED_MATERIAL_VALIDATION',
  'CANONICAL_PACKAGE_CONSTRUCTION',
  'FINAL_CANONICAL_PACKAGE_VALIDATION'
]);

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

function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {timeZone: value.trim()}).resolvedOptions().timeZone;
  } catch (error) {
    return null;
  }
}

function getMarketCodeForSymbol(symbol) {
  if (symbol.endsWith('.SI') || symbol === '^STI') return 'SG';
  if (symbol.endsWith('.HK') || symbol === '^HSI') return 'HK';
  return 'US';
}

function marketsForScope(selectedScope) {
  return selectedScope === 'ALL' ? MARKETS.slice() : [selectedScope];
}

function canonicalMembershipList(value, allowedMarkets, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const seen = new Set();
  return value.map(item => {
    if (!hasExactKeys(item, ANALYSIS_PACKAGE_MEMBERSHIP_KEYS)) {
      throw new TypeError(`${name} contains an invalid membership item`);
    }
    const market = typeof item.market === 'string' ? item.market.trim().toUpperCase() : '';
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    const key = `${market}|${symbol}`;
    if (!allowedMarkets.has(market) || !symbol || getMarketCodeForSymbol(symbol) !== market) {
      throw new TypeError(`${name} contains invalid or cross-scope membership`);
    }
    if (seen.has(key)) throw new TypeError(`${name} contains duplicate membership`);
    seen.add(key);
    return {market, symbol};
  });
}

function canonicalizeAnalysisPackageRequest(request) {
  if (!hasExactKeys(request, ANALYSIS_PACKAGE_REQUEST_KEYS)) {
    throw new TypeError('Invalid analysis package request shape or order');
  }
  const selectedScope = typeof request.selectedScope === 'string'
    ? request.selectedScope.trim().toUpperCase()
    : '';
  const initiatingList = request.initiatingList;
  const userTimezone = canonicalTimeZone(request.userTimezone);
  if (!SELECTED_SCOPES.includes(selectedScope)) throw new TypeError('Invalid selectedScope');
  if (initiatingList !== 'myStocks' && initiatingList !== 'watchlist') {
    throw new TypeError('Invalid initiatingList');
  }
  if (!userTimezone) throw new TypeError('Invalid userTimezone');
  const allowedMarkets = new Set(marketsForScope(selectedScope));
  return deepFreeze({
    selectedScope,
    initiatingList,
    userTimezone,
    myStocks: canonicalMembershipList(request.myStocks, allowedMarkets, 'myStocks'),
    watchlist: canonicalMembershipList(request.watchlist, allowedMarkets, 'watchlist')
  });
}

function canonicalGeneratedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Package assembly clock returned an invalid time');
  return date.toISOString();
}

function hasAcquiredMarketContent(marketPackage) {
  const telemetry = marketPackage && marketPackage.telemetry;
  const evidenceCollection = marketPackage && marketPackage.evidenceCollection;
  return Array.isArray(telemetry && telemetry.benchmarkSnapshots)
    && Array.isArray(telemetry && telemetry.stockSnapshots)
    && telemetry.benchmarkSnapshots.length + telemetry.stockSnapshots.length > 0
    && Array.isArray(evidenceCollection && evidenceCollection.items)
    && evidenceCollection.items.length > 0;
}

function portfolioMembershipMatches(acquired, requested) {
  if (!Array.isArray(acquired) || acquired.length !== requested.length) return false;
  return acquired.every((item, index) => item && item.market === requested[index].market
    && item.symbol === requested[index].symbol);
}

function validateAcquiredMaterial(material, request, markets) {
  if (!hasExactKeys(material, ANALYSIS_PACKAGE_MATERIAL_KEYS)
      || !Array.isArray(material.marketPackages)
      || material.marketPackages.length !== markets.length
      || !material.marketPackages.every((marketPackage, index) =>
        marketPackage && marketPackage.market === markets[index] && hasAcquiredMarketContent(marketPackage))
      || !material.portfolioContext
      || !portfolioMembershipMatches(material.portfolioContext.myStocks, request.myStocks)
      || !portfolioMembershipMatches(material.portfolioContext.watchlist, request.watchlist)) {
    throw new TypeError('Required analysis package acquisition data is unavailable or inconsistent');
  }
}

function rejectFutureEvidence(material, generatedAt) {
  const generatedTime = Date.parse(generatedAt);
  if (material.marketPackages.some(marketPackage =>
    marketPackage.evidenceCollection.items.some(item => Date.parse(item.publishedAt) > generatedTime))) {
    throw new TypeError('Future-dated evidence is not allowed');
  }
}

function createAnalysisPackageService({
  acquireAnalysisMaterial,
  now = () => new Date(),
  onDiagnostics
} = {}) {
  if (typeof acquireAnalysisMaterial !== 'function') {
    throw new TypeError('acquireAnalysisMaterial must be a function');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  return Object.freeze({
    async assemble(request) {
      let failureStage = 'ANALYSIS_MATERIAL_ACQUISITION';
      const setFailureStage = value => {
        if (PACKAGE_ASSEMBLY_FAILURE_STAGES.has(value)) failureStage = value;
      };
      try {
        const canonicalRequest = canonicalizeAnalysisPackageRequest(request);
        const acquisitionStartedAt = canonicalGeneratedAt(now());
        const markets = marketsForScope(canonicalRequest.selectedScope);
        const acquisitionContext = deepFreeze({
          selectedScope: canonicalRequest.selectedScope,
          acquisitionStartedAt,
          markets,
          myStocks: canonicalRequest.myStocks,
          watchlist: canonicalRequest.watchlist
        });
        const material = await acquireAnalysisMaterial(acquisitionContext, setFailureStage);
        failureStage = 'ACQUIRED_MATERIAL_VALIDATION';
        validateAcquiredMaterial(material, canonicalRequest, markets);
        const generatedAt = canonicalGeneratedAt(now());
        failureStage = 'FUTURE_DATED_EVIDENCE_VALIDATION';
        rejectFutureEvidence(material, generatedAt);
        failureStage = 'CANONICAL_PACKAGE_CONSTRUCTION';
        const result = createClaudeAnalysisInput({
          analysisRequest: {
            selectedScope: canonicalRequest.selectedScope,
            initiatingList: canonicalRequest.initiatingList,
            generatedAt,
            userTimezone: canonicalRequest.userTimezone,
            reportType: 'MARKET_BRIEF'
          },
          marketPackages: material.marketPackages,
          portfolioContext: material.portfolioContext
        });
        failureStage = 'FINAL_CANONICAL_PACKAGE_VALIDATION';
        if (!validateClaudeAnalysisInput(result)) {
          throw new TypeError('Assembled analysis package failed canonical validation');
        }
        return result;
      } catch (error) {
        if (typeof onDiagnostics === 'function') {
          try {
            onDiagnostics(deepFreeze({
              stage: 'analysisPackageAssemblyFailure',
              failureStage
            }));
          } catch (diagnosticError) {
            // Observability must not alter package assembly behavior.
          }
        }
        throw error;
      }
    }
  });
}

module.exports = {
  ANALYSIS_PACKAGE_REQUEST_KEYS,
  ANALYSIS_PACKAGE_MEMBERSHIP_KEYS,
  canonicalizeAnalysisPackageRequest,
  createAnalysisPackageService
};

const MARKETS = Object.freeze(['US', 'SG', 'HK']);
const SOURCE_TIERS = Object.freeze(['core', 'supplementary']);
const SOURCE_CLASSIFICATIONS = Object.freeze(['core', 'supplementary', 'selective']);
const SOURCE_CATEGORIES = Object.freeze([
  'market-data-provider',
  'newswire',
  'financial-news',
  'exchange-disclosure',
  'regulator',
  'central-bank',
  'official-statistics',
  'research-provider',
  'company-primary'
]);
const EVIDENCE_CATEGORIES = Object.freeze([
  'market-data',
  'news',
  'company-disclosure',
  'regulatory-filings',
  'regulatory-policy',
  'monetary-policy',
  'economic-data',
  'market-research'
]);
const PROVENANCE_AUTHORITIES = Object.freeze(['primary', 'secondary']);
const SOURCE_JURISDICTIONS = Object.freeze(['GLOBAL', 'US', 'SG', 'HK', 'CN']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function source(id, name, market, tier, classification, sourceCategory, evidenceCategories, publisher, authority, sourceJurisdiction, homepage) {
  return {
    id,
    name,
    market,
    tier,
    classification,
    sourceCategory,
    evidenceCategories,
    provenance: {
      publisher,
      authority,
      homepage,
      applicableMarket: market,
      sourceJurisdiction,
      locator: homepage ? 'source-homepage' : 'company-specific'
    }
  };
}

const SOURCE_REGISTRY = deepFreeze([
  source('us.yahoo-finance', 'Yahoo Finance', 'US', 'core', 'core', 'market-data-provider', ['market-data', 'news'], 'Yahoo', 'secondary', 'GLOBAL', 'https://finance.yahoo.com/'),
  source('us.reuters', 'Reuters', 'US', 'core', 'core', 'newswire', ['news'], 'Reuters', 'secondary', 'GLOBAL', 'https://www.reuters.com/'),
  source('us.sec-edgar', 'SEC/EDGAR', 'US', 'core', 'core', 'regulator', ['company-disclosure', 'regulatory-filings'], 'U.S. Securities and Exchange Commission', 'primary', 'US', 'https://www.sec.gov/edgar'),
  source('us.federal-reserve', 'Federal Reserve', 'US', 'core', 'core', 'central-bank', ['monetary-policy', 'economic-data'], 'Board of Governors of the Federal Reserve System', 'primary', 'US', 'https://www.federalreserve.gov/'),
  source('us.bls', 'BLS', 'US', 'core', 'core', 'official-statistics', ['economic-data'], 'U.S. Bureau of Labor Statistics', 'primary', 'US', 'https://www.bls.gov/'),
  source('us.bea', 'BEA', 'US', 'core', 'core', 'official-statistics', ['economic-data'], 'U.S. Bureau of Economic Analysis', 'primary', 'US', 'https://www.bea.gov/'),
  source('us.cnbc', 'CNBC', 'US', 'supplementary', 'supplementary', 'financial-news', ['news'], 'CNBC', 'secondary', 'GLOBAL', 'https://www.cnbc.com/'),
  source('us.fred', 'FRED', 'US', 'supplementary', 'supplementary', 'official-statistics', ['economic-data'], 'Federal Reserve Bank of St. Louis', 'primary', 'US', 'https://fred.stlouisfed.org/'),
  source('us.company-ir', 'Company IR', 'US', 'supplementary', 'supplementary', 'company-primary', ['company-disclosure'], 'Issuer', 'primary', 'US', null),

  source('sg.yahoo-finance', 'Yahoo Finance', 'SG', 'core', 'core', 'market-data-provider', ['market-data'], 'Yahoo', 'secondary', 'GLOBAL', 'https://finance.yahoo.com/'),
  source('sg.reuters', 'Reuters', 'SG', 'core', 'core', 'newswire', ['news'], 'Reuters', 'secondary', 'GLOBAL', 'https://www.reuters.com/'),
  source('sg.cna', 'CNA', 'SG', 'core', 'core', 'financial-news', ['news'], 'Mediacorp', 'secondary', 'SG', 'https://www.channelnewsasia.com/'),
  source('sg.sgx-sgxnet', 'SGX/SGXNET', 'SG', 'core', 'core', 'exchange-disclosure', ['company-disclosure', 'regulatory-filings'], 'Singapore Exchange', 'primary', 'SG', 'https://www.sgx.com/securities/company-announcements'),
  source('sg.mas', 'MAS', 'SG', 'core', 'core', 'central-bank', ['monetary-policy', 'regulatory-policy', 'economic-data'], 'Monetary Authority of Singapore', 'primary', 'SG', 'https://www.mas.gov.sg/'),
  source('sg.singstat', 'SingStat', 'SG', 'core', 'core', 'official-statistics', ['economic-data'], 'Singapore Department of Statistics', 'primary', 'SG', 'https://www.singstat.gov.sg/'),
  source('sg.business-times', 'Business Times', 'SG', 'supplementary', 'supplementary', 'financial-news', ['news'], 'SPH Media', 'secondary', 'SG', 'https://www.businesstimes.com.sg/'),
  source('sg.straits-times', 'Straits Times', 'SG', 'supplementary', 'supplementary', 'financial-news', ['news'], 'SPH Media', 'secondary', 'SG', 'https://www.straitstimes.com/'),
  source('sg.stocksbnb', 'StocksBNB', 'SG', 'supplementary', 'supplementary', 'research-provider', ['market-research'], 'Phillip Securities Research', 'secondary', 'SG', 'https://www.stocksbnb.com/'),
  source('sg.company-ir', 'Company IR', 'SG', 'supplementary', 'supplementary', 'company-primary', ['company-disclosure'], 'Issuer', 'primary', 'SG', null),

  source('hk.yahoo-finance', 'Yahoo Finance', 'HK', 'core', 'core', 'market-data-provider', ['market-data'], 'Yahoo', 'secondary', 'GLOBAL', 'https://finance.yahoo.com/'),
  source('hk.reuters', 'Reuters', 'HK', 'core', 'core', 'newswire', ['news'], 'Reuters', 'secondary', 'GLOBAL', 'https://www.reuters.com/'),
  source('hk.hkexnews', 'HKEXnews', 'HK', 'core', 'core', 'exchange-disclosure', ['company-disclosure', 'regulatory-filings'], 'Hong Kong Exchanges and Clearing', 'primary', 'HK', 'https://www.hkexnews.hk/'),
  source('hk.hkma', 'HKMA', 'HK', 'core', 'core', 'central-bank', ['monetary-policy', 'regulatory-policy', 'economic-data'], 'Hong Kong Monetary Authority', 'primary', 'HK', 'https://www.hkma.gov.hk/'),
  source('hk.csd', 'C&SD', 'HK', 'core', 'core', 'official-statistics', ['economic-data'], 'Census and Statistics Department, Hong Kong SAR', 'primary', 'HK', 'https://www.censtatd.gov.hk/'),
  source('hk.cnbc-asia', 'CNBC Asia', 'HK', 'supplementary', 'supplementary', 'financial-news', ['news'], 'CNBC', 'secondary', 'GLOBAL', 'https://www.cnbc.com/asia/'),
  source('hk.nbs', 'NBS', 'HK', 'supplementary', 'selective', 'official-statistics', ['economic-data'], 'National Bureau of Statistics of China', 'primary', 'CN', 'https://www.stats.gov.cn/english/'),
  source('hk.pboc', 'PBOC', 'HK', 'supplementary', 'selective', 'central-bank', ['monetary-policy', 'economic-data'], "People's Bank of China", 'primary', 'CN', 'https://www.pbc.gov.cn/en/'),
  source('hk.csrc', 'CSRC', 'HK', 'supplementary', 'selective', 'regulator', ['regulatory-policy', 'regulatory-filings'], 'China Securities Regulatory Commission', 'primary', 'CN', 'https://www.csrc.gov.cn/csrc_en/'),
  source('hk.company-ir', 'Company IR', 'HK', 'supplementary', 'supplementary', 'company-primary', ['company-disclosure'], 'Issuer', 'primary', 'HK', null)
]);

const SOURCES_BY_ID = new Map(SOURCE_REGISTRY.map(item => [item.id, item]));

function normalizeId(id) {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

function getSourceById(id) {
  return SOURCES_BY_ID.get(normalizeId(id)) || null;
}

function isValidSourceId(id) {
  return SOURCES_BY_ID.has(normalizeId(id));
}

function listSources(filters = {}) {
  const market = typeof filters.market === 'string' ? filters.market.toUpperCase() : null;
  const tier = typeof filters.tier === 'string' ? filters.tier.toLowerCase() : null;
  const classification = typeof filters.classification === 'string' ? filters.classification.toLowerCase() : null;
  const sourceCategory = typeof filters.sourceCategory === 'string' ? filters.sourceCategory.toLowerCase() : null;
  const evidenceCategory = typeof filters.evidenceCategory === 'string' ? filters.evidenceCategory.toLowerCase() : null;
  return Object.freeze(SOURCE_REGISTRY.filter(item =>
    (!market || item.market === market)
    && (!tier || item.tier === tier)
    && (!classification || item.classification === classification)
    && (!sourceCategory || item.sourceCategory === sourceCategory)
    && (!evidenceCategory || item.evidenceCategories.includes(evidenceCategory))
  ));
}

function validateSource(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return deepFreeze({ valid: false, errors: ['source must be an object'] });
  }
  if (!/^(us|sg|hk)\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id || '')) errors.push('invalid id');
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) errors.push('invalid name');
  if (!MARKETS.includes(candidate.market)) errors.push('invalid market');
  if (!SOURCE_TIERS.includes(candidate.tier)) errors.push('invalid tier');
  if (!SOURCE_CLASSIFICATIONS.includes(candidate.classification)) errors.push('invalid classification');
  if (candidate.tier === 'core' && candidate.classification !== 'core') errors.push('core tier requires core classification');
  if (candidate.tier === 'supplementary' && candidate.classification === 'core') errors.push('supplementary tier cannot use core classification');
  if (!SOURCE_CATEGORIES.includes(candidate.sourceCategory)) errors.push('invalid source category');
  if (!Array.isArray(candidate.evidenceCategories) || candidate.evidenceCategories.length === 0) {
    errors.push('evidence categories required');
  } else if (candidate.evidenceCategories.some(category => !EVIDENCE_CATEGORIES.includes(category))) {
    errors.push('invalid evidence category');
  }
  const provenance = candidate.provenance;
  if (!provenance || typeof provenance !== 'object') {
    errors.push('provenance required');
  } else {
    if (typeof provenance.publisher !== 'string' || !provenance.publisher.trim()) errors.push('invalid provenance publisher');
    if (!PROVENANCE_AUTHORITIES.includes(provenance.authority)) errors.push('invalid provenance authority');
    if (provenance.applicableMarket !== candidate.market) errors.push('provenance applicable market mismatch');
    if (!SOURCE_JURISDICTIONS.includes(provenance.sourceJurisdiction)) errors.push('invalid source jurisdiction');
    if (provenance.homepage !== null && !/^https:\/\//.test(provenance.homepage || '')) errors.push('invalid provenance homepage');
    if (!['source-homepage', 'company-specific'].includes(provenance.locator)) errors.push('invalid provenance locator');
    if (provenance.locator === 'source-homepage' && !provenance.homepage) errors.push('source homepage required');
    if (provenance.locator === 'company-specific' && candidate.sourceCategory !== 'company-primary') errors.push('company-specific locator requires company-primary source');
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}

function validateSourceRegistry(registry = SOURCE_REGISTRY) {
  const errors = [];
  if (!Array.isArray(registry)) return deepFreeze({ valid: false, errors: ['registry must be an array'] });
  const ids = new Set();
  registry.forEach((candidate, index) => {
    const result = validateSource(candidate);
    result.errors.forEach(error => errors.push(`source[${index}]: ${error}`));
    if (candidate && typeof candidate.id === 'string') {
      if (ids.has(candidate.id)) errors.push(`source[${index}]: duplicate id`);
      ids.add(candidate.id);
    }
  });
  return deepFreeze({ valid: errors.length === 0, errors });
}

module.exports = {
  MARKETS,
  SOURCE_TIERS,
  SOURCE_CLASSIFICATIONS,
  SOURCE_CATEGORIES,
  EVIDENCE_CATEGORIES,
  SOURCE_REGISTRY,
  getSourceById,
  isValidSourceId,
  listSources,
  validateSource,
  validateSourceRegistry
};

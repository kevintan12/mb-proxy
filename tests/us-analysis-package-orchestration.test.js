const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCompletedRegularSession,
  createCurrentSessionOverlay,
  createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcNewsResearchRuntime
} = require('../lib/cnbc-news-research-runtime');
const {createCnbcRecapResearchRuntime} = require('../lib/cnbc-recap-research-runtime');
const {createYahooRecapResearchRuntime} = require('../lib/yahoo-recap-research-runtime');
const {
  createYahooRecapArticleContentAcquisitionService
} = require('../lib/yahoo-recap-article-content-acquisition');
const {
  createYahooRecapEvidenceConstructionService
} = require('../lib/yahoo-recap-evidence-construction');
const {
  REPORT_HEADER,
  REPORT_SECTION_NAMES,
  validateClaudeAnalysisInput,
  validateClaudeAnalysisOutput
} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES
} = require('../lib/claude-evidence-role-classification');
const {
  BENCHMARK_ANCHOR_KEYS,
  BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP,
  CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
  CNBC_RECAP_UNAVAILABLE_GAP,
  EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP,
  FEDERAL_RESERVE_UNAVAILABLE_GAP,
  YAHOO_RECAP_UNAVAILABLE_GAP,
  YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
  YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP,
  ORCHESTRATION_REQUEST_KEYS,
  ANALYSIS_MODES,
  ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS,
  analysisModeForMarketState,
  broadMarketNewsReferences,
  createUsAnalysisPackageOrchestrationService,
  validateUsAnalysisOrchestrationRequest
} = require('../lib/us-analysis-package-orchestration');

const GENERATED_AT = '2026-09-06T10:00:00.000Z';
const YAHOO_RECAP_ARTICLE_BOUNDS = Object.freeze({
  timeoutMs: 4000, maxResponseBytes: 1258291, maxHeadlineBytes: 512,
  maxPublisherNameBytes: 256, maxArticleTextBytes: 8192, maxResultBytes: 12288
});

function request(selectedScope = 'US', overrides = {}) {
  return {
    benchmarkAnchors: [{market: 'US', symbol: '^RUT'}],
    selectedScope,
    initiatingList: 'myStocks',
    userTimezone: 'Asia/Singapore',
    myStocks: [],
    watchlist: [],
    ...overrides
  };
}

function snapshot(symbol) {
  const sessions = [
    ['2026-08-31', 97, 96],
    ['2026-09-01', 98, 97],
    ['2026-09-02', 99, 98],
    ['2026-09-03', 100, 99],
    ['2026-09-04', 105, 100]
  ].map(([sessionDate, close, previousClose], index) => createCompletedRegularSession({
    market: 'US', sessionDate, open: close - 1, high: close + 5, low: close - 5,
    close, previousClose, volume: 900 + index * 25,
    asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance',
    validationState: 'VALIDATED'
  }));
  return createFiveSessionSnapshot({
    market: 'US',
    symbol,
    instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY',
    currency: 'USD',
    marketState: 'CLOSED',
    completedSessions: sessions,
    currentOverlay: null
  });
}

function snapshotWithoutCompletedSessions(symbol) {
  return createFiveSessionSnapshot({
    market: 'US',
    symbol,
    instrumentName: `${symbol} instrument`,
    instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY',
    currency: 'USD',
    marketState: 'CLOSED',
    completedSessions: [],
    currentOverlay: null
  });
}

function snapshotWithState(symbol, marketState, {
  sessionDate = '2026-09-08',
  overlayAsOf = '2026-09-08T11:30:00.000Z',
  hasOverlay = true
} = {}) {
  const base = snapshot(symbol);
  const currentOverlay = hasOverlay && ['PRE', 'REGULAR', 'POST'].includes(marketState)
    ? createCurrentSessionOverlay({
        market: 'US', marketState, sessionDate,
        asOf: overlayAsOf, lastPrice: 106,
        referenceClose: 105, volume: 1200, sourceId: 'us.yahoo-finance',
        validationState: 'VALIDATED'
      })
    : null;
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: base.instrumentName,
    instrumentType: base.instrumentType, currency: base.currency, marketState,
    completedSessions: base.completedSessions, currentOverlay
  });
}

function cnbcCandidate(reference, horizon, overrides = {}) {
  const number = reference.slice(1);
  const publishedAt = new Date(
    (Date.parse(horizon.startsAtExclusive) + Date.parse(horizon.endsAtInclusive)) / 2
  ).toISOString();
  return createNewsEvidenceCandidate({
    reference,
    horizon,
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title: `CNBC market news item ${number}`,
    summary: `CNBC candidate summary item ${number}.`,
    extract: `Bounded CNBC candidate extract item ${number}.`,
    canonicalUrl: `https://www.cnbc.com/2026/09/04/item-${number}.html`,
    publishedAt,
    symbols: [],
    ...overrides
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds});
}

function cnbcResearchSuccess(horizons, classifications = [], candidateOverrides = []) {
  const candidates = classifications.map((classification, index) => cnbcCandidate(
    `c${index + 1}`,
    horizons.find(horizon => horizon.classification === classification),
    candidateOverrides[index]
  ));
  const candidateCollection = createNewsEvidenceCandidateCollection({
    market: 'US',
    candidates
  }, {bounds: CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS.candidateBounds});
  const selections = [];
  const retrievedArticles = candidates.map(candidate => ({
    reference: candidate.reference,
    sourceId: candidate.sourceId,
    canonicalUrl: candidate.canonicalUrl,
    publishedAt: candidate.publishedAt,
    updatedAt: null,
    title: candidate.title,
    articleText: `Bounded CNBC article content item ${candidate.reference.slice(1)}.`,
    provenance: candidate.provenance
  }));
  const constructedEvidence = candidates.map((candidate, index) => ({
    candidateReference: candidate.reference,
    horizon: candidate.horizon,
    evidenceItem: createEvidenceItem({
      sourceId: candidate.sourceId,
      market: candidate.market,
      evidenceCategory: candidate.evidenceCategory,
      title: candidate.title,
      summary: candidate.extract,
      canonicalUrl: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt,
      symbols: candidate.symbols
    })
  }));
  return {ok: true, type: 'SUCCESS', candidateCollection, selections, retrievedArticles, constructedEvidence};
}

function cnbcNonmaterialSuccess(horizons) {
  return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
}

function yahooEvidence(symbol, publishedAt = '2026-09-05T20:00:00Z') {
  return createEvidenceCollection({
    market: 'US',
    items: [createEvidenceItem({
      sourceId: 'us.yahoo-finance',
      market: 'US',
      evidenceCategory: 'market-data',
      title: `${symbol} market data`,
      summary: `${symbol} factual market data.`,
      canonicalUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
      publishedAt,
      symbols: [symbol]
    })]
  });
}

function fedEvidence(publishedAt = '2026-09-05T18:00:00Z') {
  return createEvidenceCollection({
    market: 'US',
    items: [
      createEvidenceItem({
        sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
        title: 'Federal Reserve policy statement',
        canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm',
        publishedAt, symbols: []
      }),
      createEvidenceItem({
        sourceId: 'us.federal-reserve', market: 'US', evidenceCategory: 'monetary-policy',
        title: 'Federal Reserve minutes',
        canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
        publishedAt: '2026-09-04T18:00:00Z', symbols: []
      })
    ]
  });
}

function manyFedEvidence(count, summaryBytes = 0) {
  return createEvidenceCollection({
    market: 'US',
    items: Array.from({length: count}, (_, index) => createEvidenceItem({
      sourceId: 'us.federal-reserve',
      market: 'US',
      evidenceCategory: 'monetary-policy',
      title: `Federal Reserve release ${index + 1}`,
      ...(summaryBytes ? {summary: 'x'.repeat(summaryBytes)} : {}),
      canonicalUrl: `https://www.federalreserve.gov/newsevents/pressreleases/monetary202609${String(index + 1).padStart(2, '0')}a.htm`,
      publishedAt: '2026-09-04T18:00:00Z',
      symbols: []
    }))
  });
}

function yahooRecapResearchSuccess({
  title = 'Stock market today: September 4 recap',
  url = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
  publishedAt = '2026-09-04T20:03:54.000Z',
  updatedAt = null,
  targetSessionDate = '2026-09-04'
} = {}) {
  return {
    ok: true,
    type: 'VALIDATED',
    discovery: Object.freeze({
      title,
      url,
      discoveredVia: 'ANTHROPIC_WEB_SEARCH',
      targetSessionDate
    }),
    validation: Object.freeze({
      headline: title,
      url,
      datePublished: publishedAt,
      dateModified: updatedAt,
      targetSessionDate
    })
  };
}

function yahooRecapArticle({
  title = 'Stock market today: September 4 recap',
  url = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html',
  publishedAt = '2026-09-04T20:03:54.000Z',
  updatedAt = null,
  targetSessionDate = '2026-09-04'
} = {}) {
  return Object.freeze({
    sourceId: 'us.yahoo-finance',
    publisher: Object.freeze({name: 'Yahoo! Finance'}),
    canonicalUrl: url,
    headline: title,
    publishedAt,
    updatedAt,
    targetSessionDate,
    articleText: 'US stocks ended the completed session higher.'
  });
}

function yahooRecapEvidenceSuccess(article, horizon) {
  return {
    ok: true,
    type: 'SUCCESS',
    constructedEvidence: {
      targetSessionDate: article.targetSessionDate,
      updatedAt: article.updatedAt,
      horizon,
      evidenceItem: createEvidenceItem({
        sourceId: article.sourceId, market: 'US', evidenceCategory: 'news',
        title: article.headline, summary: article.articleText,
        canonicalUrl: article.canonicalUrl, publishedAt: article.publishedAt,
        symbols: [], publisher: article.publisher.name
      })
    }
  };
}

function cnbcRecapResearchSuccess({
  publishedAt = '2026-09-04T20:15:23.000Z',
  updatedAt = '2026-09-04T20:20:00.000Z',
  targetSessionDate = '2026-09-04',
  horizon
} = {}) {
  const canonicalUrl = 'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html';
  const title = 'Stock market news for Sept. 4, 2026';
  return {
    ok: true,
    type: 'SUCCESS',
    constructedEvidence: {
      targetSessionDate,
      updatedAt,
      horizon,
      evidenceItem: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news', title,
        summary: 'The major averages closed higher after the completed US session.',
        canonicalUrl, publishedAt, symbols: []
      })
    }
  };
}

function harness(overrides = {}) {
  const calls = {
    factories: [], telemetry: [], persistence: [], yahoo: [], fed: 0,
    yahooMostActive: 0, yahooLatestNews: 0, yahooCurrentNewsArticle: [],
    yahooRecapResearch: [], yahooRecapArticle: [], yahooRecapEvidence: [],
    cnbcRecapResearch: [], cnbc: [],
    evidenceRoleClassification: [], evidenceSubjectRepair: []
  };
  const dependencies = {
    createTelemetryAcquisition: ({generatedAt}) => {
      calls.factories.push(generatedAt);
      return {
        async acquireSnapshot({market, symbol}) {
          calls.telemetry.push({market, symbol, generatedAt});
          return snapshot(symbol);
        }
      };
    },
    snapshotPersistence: {
      async persistSnapshot(value) {
        calls.persistence.push(value.symbol);
        return value;
      }
    },
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) {
        calls.yahoo.push(symbol);
        return yahooEvidence(symbol);
      }
    },
    yahooMostActiveAcquisition: {
      async acquireMostActive() {
        calls.yahooMostActive++;
        return {ok: true, type: 'NOT_FOUND', candidates: []};
      }
    },
    yahooLatestNewsDiscovery: {
      async discoverLatestNews() {
        calls.yahooLatestNews++;
        return {ok: true, type: 'NOT_FOUND', candidates: []};
      }
    },
    yahooCurrentNewsArticleContentAcquisition: {
      async acquireArticleContent(value) {
        calls.yahooCurrentNewsArticle.push(value);
        return {ok: false, type: 'NO_USABLE_ARTICLE', articleContent: null};
      }
    },
    federalReserveEvidenceAcquisition: {
      async acquireEvidence() {
        calls.fed++;
        return fedEvidence();
      }
    },
    yahooRecapResearch: {
      async discoverAndValidateRecap(value) {
        calls.yahooRecapResearch.push(value);
        return {ok: true, type: 'NOT_FOUND', discovery: null, validation: null};
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent(value) {
        calls.yahooRecapArticle.push(value);
        throw new Error('not expected');
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        calls.yahooRecapEvidence.push(value);
        throw new Error('not expected');
      }
    },
    yahooRecapArticleContentBounds: YAHOO_RECAP_ARTICLE_BOUNDS,
    cnbcRecapResearch: {
      async researchCompletedSessionRecap(value) {
        calls.cnbcRecapResearch.push(value);
        return {ok: true, type: 'NOT_FOUND', constructedEvidence: null};
      }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        calls.cnbc.push(horizons);
        return cnbcNonmaterialSuccess(horizons);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        calls.evidenceRoleClassification.push(input);
        return {
          ok: true,
          type: 'SUCCESS',
          output: {
            classifications: input.evidence.map(({reference}) => ({
              reference,
              materiality: 'LOW',
              roles: [],
              subjects: []
            }))
          }
        };
      },
      async repairEvidenceSubjects(input) {
        calls.evidenceSubjectRepair.push(input);
        return {
          ok: true,
          type: 'SUCCESS',
          output: {
            repairs: input.evidence.map(({reference}) => ({reference, subjects: []}))
          }
        };
      }
    },
    now: () => new Date(GENERATED_AT),
    ...overrides
  };
  return {service: createUsAnalysisPackageOrchestrationService(dependencies), calls};
}

function roleClassificationSuccess(
  input,
  rolesByReference = {},
  subjectsByReference = {},
  materialityByReference = {}
) {
  return {
    ok: true,
    type: 'SUCCESS',
    output: {
      classifications: input.evidence.map(entry => {
        const roles = rolesByReference[entry.reference] || [];
        const materiality = materialityByReference[entry.reference] || 'HIGH';
        const subjects = Object.hasOwn(subjectsByReference, entry.reference)
          ? subjectsByReference[entry.reference]
          : entry.requiresBroadMarketSubjects
              && ['HIGH', 'MEDIUM'].includes(materiality)
              && roles.includes('MATERIAL_EVENT')
            ? [{kind: 'COMPANY', name: entry.item.title}]
            : [];
        return {
          reference: entry.reference,
          materiality,
          roles,
          subjects
        };
      })
    }
  };
}

test('maps supported US market states to explicit package-owned analysis modes', () => {
  for (const state of ['PRE', 'REGULAR', 'POST']) {
    assert.equal(analysisModeForMarketState(state), ANALYSIS_MODES.ACTIVE_SESSION);
  }
  for (const state of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    assert.equal(analysisModeForMarketState(state), ANALYSIS_MODES.COMPLETED_SESSION);
  }
  assert.throws(
    () => analysisModeForMarketState('UNSUPPORTED_SPECIAL_SESSION'),
    /Unsupported US market state/
  );
});

test('PRE, REGULAR and POST use bounded active Yahoo acquisition and skip completed-session research', async () => {
  for (const [marketState, generatedAt, overlayAsOf] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:30:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z']
  ]) {
    const diagnostics = [];
    const candidates = Array.from({length: 8}, (_, index) => ({
      headline: index === 7 ? 'NVDA leads active stocks' : `Current market story ${index + 1}`,
      url: `https://finance.yahoo.com/news/current-market-story-${index + 1}.html`,
      uuid: null,
      publisher: 'Yahoo Finance'
    }));
    const {service, calls} = harness({
      createTelemetryAcquisition: () => ({
        async acquireSnapshot({symbol}) {
          return snapshotWithState(symbol, marketState, {overlayAsOf});
        }
      }),
      yahooMostActiveAcquisition: {
        async acquireMostActive() {
          calls.yahooMostActive++;
          return {ok: true, type: 'SUCCESS', candidates: [{
            symbol: 'NVDA', shortName: 'Nvidia', longName: 'Nvidia Corporation'
          }]};
        }
      },
      yahooLatestNewsDiscovery: {
        async discoverLatestNews() {
          calls.yahooLatestNews++;
          return {ok: true, type: 'SUCCESS', candidates};
        }
      },
      yahooCurrentNewsArticleContentAcquisition: {
        async acquireArticleContent(candidate) {
          calls.yahooCurrentNewsArticle.push(candidate);
          return {
            ok: true, type: 'SUCCESS', articleContent: {
              sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url,
              headline: candidate.headline, publisher: 'Yahoo Finance',
              publishedAt: '2026-09-08T11:00:00.000Z', updatedAt: null,
              articleText: `Bounded current article for ${candidate.headline}.`
            }
          };
        }
      },
      now: () => new Date(generatedAt),
      onDiagnostics: value => diagnostics.push(value)
    });
    const output = await service.assemble(request());
    assert.equal(output.marketPackages[0].marketContext.marketState, marketState);
    assert.equal(output.marketPackages[0].marketContext.includesCurrentOverlay, true);
    assert.equal(output.marketPackages[0].telemetry.benchmarkSnapshots[0]
      .snapshot.completedSessions.length, 5);
    assert.equal(output.marketPackages[0].telemetry.benchmarkSnapshots[0]
      .snapshot.currentOverlay.marketState, marketState);
    assert.equal(calls.yahooMostActive, 1);
    assert.equal(calls.yahooLatestNews, 1);
    assert.equal(calls.yahooCurrentNewsArticle.length, ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS);
    assert.equal(calls.yahooCurrentNewsArticle[0].headline, 'NVDA leads active stocks');
    assert.equal(calls.yahooRecapResearch.length, 0);
    assert.equal(calls.cnbcRecapResearch.length, 0);
    assert.equal(calls.cnbc.length, 0);
    const currentEntries = calls.evidenceRoleClassification[0].evidence.filter(entry =>
      entry.item.evidenceCategory === 'news');
    assert.equal(currentEntries.length, ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS);
    assert.equal(currentEntries.every(entry => entry.horizon === 'CURRENT_SESSION'), true);
    assert.deepEqual(output.marketPackages[0].evidenceContext.subsequentDevelopments, []);
    assert.deepEqual(output.marketPackages[0].evidenceContext.furtherReadings, []);
    assert.ok(diagnostics.some(item => item.stage === 'analysisModeSelection'
      && item.analysisMode === 'ACTIVE_SESSION' && item.marketState === marketState));
    assert.ok(diagnostics.some(item => item.stage === 'activeYahooAcquisition'
      && item.mostActiveCount === 1 && item.latestNewsCandidateCount === 8
      && item.selectedCandidateCount === ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS
      && item.articleFetchAttemptCount === ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS
      && item.articleFetchSuccessCount === ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS
      && item.missingOrMalformedPublicationTimeCount === 0
      && item.beforeSessionWindowCount === 0
      && item.afterSessionWindowCount === 0
      && item.acquiredCurrentSessionCount === ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS));
    assert.ok(diagnostics.some(item => item.stage === 'activeYahooEvidenceHandoff'
      && item.admittedCurrentSessionCount === ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS
      && item.classifierAdmissionRejectedCount === 0));
    assert.ok(diagnostics.some(item => item.stage === 'completedSessionResearch'
      && item.outcome === 'SKIPPED_ACTIVE_SESSION'));
  }
});

test('one matching benchmark overlay admits current Yahoo evidence in PRE, REGULAR and POST', async () => {
  for (const [marketState, generatedAt, overlayAsOf, publishedAt] of [
    ['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:30:00.000Z', '2026-09-08T11:45:00.000Z'],
    ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
    ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']
  ]) {
    const diagnostics = [];
    const candidates = ['one', 'two'].map(slug => ({
      headline: `Current ${slug} story`,
      url: `https://finance.yahoo.com/news/current-${slug}.html`,
      uuid: null,
      publisher: 'Yahoo Finance'
    }));
    const {service, calls} = harness({
      createTelemetryAcquisition: () => ({
        async acquireSnapshot({symbol}) {
          return snapshotWithState(symbol, marketState, {
            overlayAsOf,
            hasOverlay: symbol === '^RUT'
          });
        }
      }),
      yahooLatestNewsDiscovery: {
        async discoverLatestNews() { return {ok: true, type: 'SUCCESS', candidates}; }
      },
      yahooCurrentNewsArticleContentAcquisition: {
        async acquireArticleContent(candidate) {
          return {ok: true, type: 'SUCCESS', articleContent: {
            sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url,
            headline: candidate.headline, publisher: 'Yahoo Finance',
            publishedAt, updatedAt: null,
            articleText: `Usable current-session content for ${candidate.headline}.`
          }};
        }
      },
      now: () => new Date(generatedAt),
      onDiagnostics: value => diagnostics.push(value)
    });
    const output = await service.assemble(request('US', {
      benchmarkAnchors: [{market: 'US', symbol: '^RUT'}, {market: 'US', symbol: '^DJI'}]
    }));
    const current = calls.evidenceRoleClassification[0].evidence.filter(entry =>
      entry.horizon === 'CURRENT_SESSION');
    assert.equal(current.length, 2);
    const providerInput = JSON.parse(buildClaudeAnalysisRequest(output).messages[0].content);
    assert.equal(providerInput.currentSessionContext[0].evidenceRefs.length, 2);
    const acquisition = diagnostics.find(item => item.stage === 'activeYahooAcquisition');
    assert.equal(acquisition.activeWindowUnavailableCount, 0);
    assert.equal(acquisition.benchmarkOverlayInvalidCount, 0);
    assert.equal(acquisition.acquiredCurrentSessionCount, 2);
  }
});

test('active Yahoo diagnostics count duplicate evidence independently of active-window failures', async () => {
  const diagnostics = [];
  const candidates = ['one', 'two'].map(slug => ({
    headline: `Current ${slug} story`,
    url: `https://finance.yahoo.com/news/current-${slug}.html`,
    uuid: null,
    publisher: 'Yahoo Finance'
  }));
  const {service} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) {
        return snapshotWithState(symbol, 'REGULAR', {overlayAsOf: '2026-09-08T14:55:00.000Z'});
      }
    }),
    yahooLatestNewsDiscovery: {
      async discoverLatestNews() { return {ok: true, type: 'SUCCESS', candidates}; }
    },
    yahooCurrentNewsArticleContentAcquisition: {
      async acquireArticleContent(candidate) {
        return {ok: true, type: 'SUCCESS', articleContent: {
          sourceId: 'us.yahoo-finance',
          canonicalUrl: 'https://finance.yahoo.com/news/one-current-article.html',
          headline: candidate.headline,
          publisher: 'Yahoo Finance',
          publishedAt: '2026-09-08T14:30:00.000Z', updatedAt: null,
          articleText: 'Usable current-session article content.'
        }};
      }
    },
    now: () => new Date('2026-09-08T15:00:00.000Z'),
    onDiagnostics: value => diagnostics.push(value)
  });
  await service.assemble(request());
  const acquisition = diagnostics.find(item => item.stage === 'activeYahooAcquisition');
  assert.equal(acquisition.duplicateEvidenceCount, 1);
  assert.equal(acquisition.activeWindowUnavailableCount, 0);
  assert.equal(acquisition.benchmarkOverlayInvalidCount, 0);
  assert.equal(acquisition.otherEvidenceConstructionRejectedCount, 0);
});

test('active Yahoo news becomes CURRENT_SESSION evidence and can support current catalysts and Section 4', async () => {
  const generatedAt = '2026-09-08T15:00:00.000Z';
  const {service, calls} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) {
        return snapshotWithState(symbol, 'REGULAR', {
          overlayAsOf: '2026-09-08T14:55:00.000Z'
        });
      }
    }),
    yahooMostActiveAcquisition: {
      async acquireMostActive() {
        calls.yahooMostActive++;
        return {ok: true, type: 'SUCCESS', candidates: [{
          symbol: 'MSFT', shortName: 'Microsoft', longName: 'Microsoft Corporation'
        }]};
      }
    },
    yahooLatestNewsDiscovery: {
      async discoverLatestNews() {
        calls.yahooLatestNews++;
        return {ok: true, type: 'SUCCESS', candidates: [{
          headline: 'Microsoft outlook lifts stocks',
          url: 'https://finance.yahoo.com/news/microsoft-outlook-lifts-stocks.html',
          uuid: null,
          publisher: 'Yahoo Finance'
        }]};
      }
    },
    yahooCurrentNewsArticleContentAcquisition: {
      async acquireArticleContent(candidate) {
        calls.yahooCurrentNewsArticle.push(candidate);
        return {ok: true, type: 'SUCCESS', articleContent: {
          sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url,
          headline: candidate.headline, publisher: 'Yahoo Finance',
          publishedAt: '2026-09-08T14:30:00.000Z', updatedAt: null,
          articleText: 'Microsoft raised its outlook during the active US session.'
        }};
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        calls.evidenceRoleClassification.push(input);
        return {ok: true, type: 'SUCCESS', output: {classifications: input.evidence.map(entry => ({
          reference: entry.reference,
          materiality: entry.horizon === 'CURRENT_SESSION' ? 'HIGH' : 'LOW',
          roles: entry.horizon === 'CURRENT_SESSION'
            ? ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'] : [],
          subjects: entry.horizon === 'CURRENT_SESSION'
            ? [{kind: 'COMPANY', name: 'Microsoft'}] : []
        }))}};
      },
      async repairEvidenceSubjects() { throw new Error('not expected'); }
    },
    now: () => new Date(generatedAt)
  });
  const output = await service.assemble(request('US', {
    myStocks: [{market: 'US', symbol: 'MSFT'}]
  }));
  const classificationInput = calls.evidenceRoleClassification[0];
  const current = classificationInput.evidence.find(entry => entry.horizon === 'CURRENT_SESSION');
  assert.ok(current);
  assert.equal(output.marketPackages[0].evidenceContext.materialEvents.includes(current.reference), true);
  assert.equal(output.marketPackages[0].evidenceContext.principalCatalysts.includes(current.reference), true);
  assert.equal(output.marketPackages[0].evidenceContext.subsequentDevelopments.includes(current.reference), false);
  assert.equal(output.portfolioContext.myStocks[0].evidenceRefs.includes(current.reference), true);
  assert.equal(Object.hasOwn(output, 'currentSessionContext'), false);
  assert.equal(Object.hasOwn(output.marketPackages[0].evidenceContext, 'currentSessionEvidence'), false);
  const providerInput = JSON.parse(buildClaudeAnalysisRequest(output).messages[0].content);
  assert.deepEqual(providerInput.currentSessionContext, [{
    market: 'US', sessionDate: '2026-09-08', evidenceRefs: [current.reference]
  }]);
  assert.equal(providerInput.sectionFourReferenceAllowlist.evidenceRefs.includes(current.reference), true);
  assert.deepEqual(output.marketPackages[0].evidenceContext.furtherReadings, []);
});

test('stale and future Yahoo news never become CURRENT_SESSION evidence', async () => {
  const generatedAt = '2026-09-08T15:00:00.000Z';
  const candidates = [
    ['Stale market story', 'stale', '2026-09-05T14:00:00.000Z'],
    ['Future market story', 'future', '2026-09-08T15:00:00.001Z'],
    ['Current market story', 'current', '2026-09-08T14:30:00.000Z'],
    ['Missing-time market story', 'missing-time', null],
    ['Malformed-time market story', 'malformed-time', 'not-a-date']
  ];
  const diagnostics = [];
  const {service, calls} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) {
        return snapshotWithState(symbol, 'REGULAR', {
          overlayAsOf: '2026-09-08T14:55:00.000Z'
        });
      }
    }),
    yahooMostActiveAcquisition: {
      async acquireMostActive() { return {ok: true, type: 'NOT_FOUND', candidates: []}; }
    },
    yahooLatestNewsDiscovery: {
      async discoverLatestNews() {
        return {ok: true, type: 'SUCCESS', candidates: candidates.map(([headline, slug]) => ({
          headline, url: `https://finance.yahoo.com/news/${slug}.html`,
          uuid: null, publisher: 'Yahoo Finance'
        }))};
      }
    },
    yahooCurrentNewsArticleContentAcquisition: {
      async acquireArticleContent(candidate) {
        const found = candidates.find(([, slug]) => candidate.url.endsWith(`/${slug}.html`));
        return {ok: true, type: 'SUCCESS', articleContent: {
          sourceId: 'us.yahoo-finance', canonicalUrl: candidate.url,
          headline: candidate.headline, publisher: 'Yahoo Finance',
          publishedAt: found[2], updatedAt: null,
          articleText: `PRIVATE_ARTICLE_BODY ${candidate.headline} has bounded usable content.`
        }};
      }
    },
    now: () => new Date(generatedAt),
    onDiagnostics: value => diagnostics.push(value)
  });
  const output = await service.assemble(request());
  const currentEntries = calls.evidenceRoleClassification[0].evidence.filter(entry =>
    entry.horizon === 'CURRENT_SESSION');
  assert.equal(currentEntries.length, 1);
  assert.equal(currentEntries[0].item.title, 'Current market story');
  assert.equal(output.marketPackages[0].evidenceContext.evidence.some(entry =>
    entry.item.title === 'Stale market story' || entry.item.title === 'Future market story'), false);
  const acquisition = diagnostics.find(item => item.stage === 'activeYahooAcquisition');
  assert.equal(acquisition.latestNewsCandidateCount, 5);
  assert.equal(acquisition.selectedCandidateCount, 5);
  assert.equal(acquisition.articleFetchAttemptCount, 5);
  assert.equal(acquisition.articleFetchSuccessCount, 5);
  assert.equal(acquisition.missingOrMalformedPublicationTimeCount, 2);
  assert.equal(acquisition.beforeSessionWindowCount, 1);
  assert.equal(acquisition.afterSessionWindowCount, 1);
  assert.equal(acquisition.acquiredCurrentSessionCount, 1);
  assert.equal(diagnostics.find(item => item.stage === 'activeYahooEvidenceHandoff')
    .admittedCurrentSessionCount, 1);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_ARTICLE_BODY'), false);
});

test('CLOSED, WEEKEND and HOLIDAY preserve completed research and skip active Yahoo acquisition', async () => {
  for (const marketState of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    const diagnostics = [];
    const {service, calls} = harness({
      createTelemetryAcquisition: () => ({
        async acquireSnapshot({symbol}) { return snapshotWithState(symbol, marketState); }
      }),
      onDiagnostics: value => diagnostics.push(value)
    });
    const output = await service.assemble(request());
    assert.equal(output.marketPackages[0].marketContext.marketState, marketState);
    assert.equal(calls.yahooMostActive, 0);
    assert.equal(calls.yahooLatestNews, 0);
    assert.equal(calls.yahooCurrentNewsArticle.length, 0);
    assert.equal(calls.yahooRecapResearch.length, 1);
    assert.equal(calls.cnbcRecapResearch.length, 1);
    assert.equal(calls.cnbc.length, 1);
    assert.deepEqual(diagnostics.find(item => item.stage === 'activeYahooAcquisition'), {
      stage: 'activeYahooAcquisition', outcome: 'SKIPPED_COMPLETED_SESSION',
      mostActiveCount: 0, latestNewsCandidateCount: 0,
      articleFetchAttemptCount: 0, articleFetchSuccessCount: 0
    });
    assert.equal(diagnostics.some(item => item.stage === 'activeYahooEvidenceHandoff'), false);
  }
});

test('unsupported special session fails closed before any news research path', async () => {
  const {service, calls} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) {
        return snapshotWithState(symbol, 'UNSUPPORTED_SPECIAL_SESSION');
      }
    })
  });
  await assert.rejects(service.assemble(request()), /Unsupported US market state/);
  assert.equal(calls.yahooMostActive, 0);
  assert.equal(calls.yahooLatestNews, 0);
  assert.equal(calls.yahooRecapResearch.length, 0);
  assert.equal(calls.cnbcRecapResearch.length, 0);
  assert.equal(calls.cnbc.length, 0);
});

test('assembles a canonical US package with supplied benchmarks and deterministic refs', async () => {
  const {service, calls} = harness();
  const output = await service.assemble(request('US', {
    benchmarkAnchors: [
      {market: 'us', symbol: ' ^rut '},
      {market: 'US', symbol: '^DJI'},
      {market: 'US', symbol: '^RUT'}
    ],
    myStocks: [{market: 'US', symbol: 'MSFT'}, {market: 'US', symbol: 'AAPL'}],
    watchlist: [{market: 'US', symbol: 'AAPL'}, {market: 'US', symbol: 'NVDA'}]
  }));

  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(output.analysisRequest.generatedAt, GENERATED_AT);
  assert.equal(output.analysisRequest.initiatingList, 'myStocks');
  assert.equal(output.analysisRequest.userTimezone, 'Asia/Singapore');
  assert.deepEqual(calls.factories, [GENERATED_AT]);
  assert.deepEqual(calls.telemetry, [
    {market: 'US', symbol: '^RUT', generatedAt: GENERATED_AT},
    {market: 'US', symbol: '^DJI', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'MSFT', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'AAPL', generatedAt: GENERATED_AT},
    {market: 'US', symbol: 'NVDA', generatedAt: GENERATED_AT}
  ]);
  assert.deepEqual(calls.persistence, ['^RUT', '^DJI', 'MSFT', 'AAPL', 'NVDA']);
  assert.deepEqual(calls.yahoo, ['^RUT', '^DJI', 'MSFT', 'AAPL', 'NVDA']);
  assert.equal(calls.fed, 1);
  assert.deepEqual(calls.yahooRecapResearch, [{targetSessionDate: '2026-09-04'}]);
  assert.deepEqual(calls.yahooRecapArticle, []);
  assert.deepEqual(calls.yahooRecapEvidence, []);
  assert.equal(calls.cnbc.length, 1);
  assert.equal(calls.evidenceRoleClassification.length, 1);
  assert.deepEqual(calls.cnbc[0], [
    {
      classification: 'COMPLETED_SESSION',
      startsAtExclusive: '2026-09-03T20:00:00.000Z',
      endsAtInclusive: '2026-09-04T20:00:00.000Z'
    },
    {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-04T20:00:00.000Z',
      endsAtInclusive: GENERATED_AT
    }
  ]);

  const marketPackage = output.marketPackages[0];
  assert.deepEqual(marketPackage.telemetry.benchmarkSnapshots.map(item => [item.reference, item.snapshot.symbol]), [
    ['t1', '^RUT'], ['t2', '^DJI']
  ]);
  assert.deepEqual(marketPackage.telemetry.stockSnapshots.map(item => [item.reference, item.snapshot.symbol]), [
    ['t3', 'MSFT'], ['t4', 'AAPL'], ['t5', 'NVDA']
  ]);
  assert.deepEqual(marketPackage.evidenceContext.evidence.map(item => [item.reference, item.item.sourceId, item.item.symbols[0] || null]), [
    ['e1', 'us.yahoo-finance', '^RUT'],
    ['e2', 'us.yahoo-finance', '^DJI'],
    ['e3', 'us.yahoo-finance', 'MSFT'],
    ['e4', 'us.yahoo-finance', 'AAPL'],
    ['e5', 'us.yahoo-finance', 'NVDA'],
    ['e6', 'us.federal-reserve', null],
    ['e7', 'us.federal-reserve', null]
  ]);
  assert.deepEqual(marketPackage.evidenceContext.materialEvents, []);
  assert.deepEqual(marketPackage.evidenceContext.principalCatalysts, []);
  assert.deepEqual(marketPackage.evidenceContext.authoritativeFacts, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.deepEqual(marketPackage.evidenceContext.supportingEvidence, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.deepEqual(marketPackage.evidenceContext.furtherReadings, []);
  assert.equal(marketPackage.marketContext.calendarContext, null);

  assert.deepEqual(output.portfolioContext.myStocks, [
    {market: 'US', symbol: 'MSFT', telemetryRefs: ['t3'], evidenceRefs: ['e3'], upcomingEvents: []},
    {market: 'US', symbol: 'AAPL', telemetryRefs: ['t4'], evidenceRefs: ['e4'], upcomingEvents: []}
  ]);
  assert.deepEqual(output.portfolioContext.watchlist, [
    {market: 'US', symbol: 'AAPL', telemetryRefs: ['t4'], evidenceRefs: ['e4'], upcomingEvents: []},
    {market: 'US', symbol: 'NVDA', telemetryRefs: ['t5'], evidenceRefs: ['e5'], upcomingEvents: []}
  ]);
});

test('classifies package-owned ordered evidence refs once and derives both role arrays', async () => {
  let classifierCalls = 0;
  let classifierInput;
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifierCalls++;
        classifierInput = input;
        return roleClassificationSuccess(input, {
          e1: ['MATERIAL_EVENT'],
          e2: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'],
          e5: ['MATERIAL_EVENT']
        });
      }
    }
  });

  const output = await service.assemble(request());
  const marketPackage = output.marketPackages[0];
  assert.equal(classifierCalls, 1);
  assert.deepEqual(classifierInput.marketContext, {
    market: 'US',
    exchangeTimezone: 'America/New_York',
    marketState: 'CLOSED',
    primaryCompletedSessionDate: '2026-09-04'
  });
  assert.deepEqual(classifierInput.benchmarkTelemetry.map(entry => [entry.reference, entry.snapshot.symbol]), [
    ['t1', '^RUT']
  ]);
  assert.deepEqual(classifierInput.evidence.map(entry => [
    entry.reference, entry.horizon, entry.item.canonicalUrl
  ]), [
    ['e1', 'COMPLETED_SESSION', 'https://finance.yahoo.com/quote/%5ERUT/'],
    ['e2', 'COMPLETED_SESSION', 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260905a.htm'],
    ['e3', 'COMPLETED_SESSION', 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm'],
    ['e4', 'COMPLETED_SESSION', 'https://www.cnbc.com/2026/09/04/item-1.html'],
    ['e5', 'SUBSEQUENT_DEVELOPMENT', 'https://www.cnbc.com/2026/09/04/item-2.html']
  ]);
  assert.deepEqual(marketPackage.evidenceContext.materialEvents, ['e1', 'e2', 'e4']);
  assert.deepEqual(marketPackage.evidenceContext.principalCatalysts, ['e2']);
  assert.equal(marketPackage.evidenceContext.evidence[3].item.sourceId, 'us.cnbc');
  assert.equal(marketPackage.evidenceContext.evidence[3].reference, 'e4');
  assert.equal(marketPackage.evidenceContext.evidence[3].item.canonicalUrl,
    'https://www.cnbc.com/2026/09/04/item-2.html');
});

test('fails package assembly when required evidence-role classification fails or is invalid', async () => {
  const cases = [
    {
      evidenceRoleClassification: {
        async classifyEvidenceRoles() {
          return {
            ok: false,
            type: 'CONTRACT_FAILURE',
            message: 'Claude evidence role classification result was malformed',
            upstreamStatus: 200
          };
        }
      }
    },
    {
      evidenceRoleClassification: {
        async classifyEvidenceRoles(input) {
          const result = roleClassificationSuccess(input);
          result.output.classifications[0].reference = 'e999';
          return result;
        }
      }
    }
  ];
  for (const [index, evidenceRoleClassification] of cases.entries()) {
    const diagnostics = [];
    const {service} = harness({
      ...evidenceRoleClassification,
      onDiagnostics(value) { diagnostics.push(value); }
    });
    await assert.rejects(service.assemble(request()), /Evidence-role classification|references/);
    if (index === 0) {
      assert.deepEqual(diagnostics.find(value => value.stage === 'evidenceRoleClassificationFailure'), {
        stage: 'evidenceRoleClassificationFailure',
        failureType: 'CONTRACT_FAILURE',
        failureMessage: 'Claude evidence role classification result was malformed',
        upstreamStatus: 200
      });
    } else {
      assert.equal(diagnostics.some(value => value.stage === 'evidenceRoleClassificationFailure'), false);
    }
    assert.deepEqual(diagnostics.find(value => value.stage === 'analysisPackageAssemblyFailure'), {
      stage: 'analysisPackageAssemblyFailure',
      failureStage: 'EVIDENCE_ROLE_CLASSIFICATION'
    });
  }
});

test('fails closed when classifier assigns a subsequent development as principal catalyst', async () => {
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['SUBSEQUENT_DEVELOPMENT']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {
          e4: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST']
        });
      }
    }
  });
  await assert.rejects(
    service.assemble(request()),
    /subsequent development cannot be a principal catalyst/
  );
});

test('reports sanitized non-negative timings for existing package stages', async () => {
  const diagnostics = [];
  const {service} = harness({onDiagnostics(value) { diagnostics.push(value); }});
  const output = await service.assemble(request('US', {
    myStocks: [{market: 'US', symbol: 'MSFT'}]
  }));

  assert.equal(validateClaudeAnalysisInput(output), true);
  const timingDiagnostic = diagnostics.find(value => value.timing);
  assert.ok(timingDiagnostic);
  assert.deepEqual(Object.keys(timingDiagnostic), ['timing']);
  assert.deepEqual(Object.keys(timingDiagnostic.timing), [
    'yahooTelemetryAcquisitionMs',
    'postgresPersistenceReadbackMs',
    'yahooMarketDataEvidenceAcquisitionMs',
    'yahooMostActiveAcquisitionMs',
    'yahooLatestNewsDiscoveryMs',
    'yahooCurrentNewsArticleAcquisitionMs',
    'federalReserveEvidenceAcquisitionMs',
    'yahooRecapResearchMs',
    'yahooRecapArticleContentAcquisitionMs',
    'yahooRecapEvidenceConstructionMs',
    'cnbcRecapResearchMs',
    'cnbcNewsResearchMs',
    'evidenceRoleClassificationMs',
    'packageAssemblyFinalizationMs',
    'packageRuntimeTotalMs'
  ]);
  for (const elapsed of Object.values(timingDiagnostic.timing)) {
    assert.equal(typeof elapsed, 'number');
    assert.equal(Number.isFinite(elapsed), true);
    assert.equal(elapsed >= 0, true);
  }
  assert.equal(Object.isFrozen(timingDiagnostic), true);
  assert.equal(Object.isFrozen(timingDiagnostic.timing), true);
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes('MSFT'), false);
  assert.equal(serialized.includes('Federal Reserve policy statement'), false);
});

test('attributes Yahoo recap timings without hiding or double-counting them in finalization', async () => {
  let clock = 0;
  const articleContent = yahooRecapArticle();
  const diagnostics = [];
  const instrumented = harness({
    monotonicNow() { return clock; },
    yahooRecapResearch: {
      async discoverAndValidateRecap() { clock += 5; return yahooRecapResearchSuccess(); }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        clock += 7;
        return {ok: true, type: 'SUCCESS', articleContent};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        clock += 11;
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    },
    onDiagnostics(value) { diagnostics.push(value); }
  }).service;
  await instrumented.assemble(request());
  const timing = diagnostics.find(value => value.timing).timing;
  assert.equal(timing.yahooRecapResearchMs, 5);
  assert.equal(timing.yahooRecapArticleContentAcquisitionMs, 7);
  assert.equal(timing.yahooRecapEvidenceConstructionMs, 11);
  assert.equal(timing.packageRuntimeTotalMs, 23);
  assert.equal(timing.packageAssemblyFinalizationMs, 0);
  assert.equal(Object.values(timing).slice(0, -2).reduce((sum, value) => sum + value, 0)
    + timing.packageAssemblyFinalizationMs, timing.packageRuntimeTotalMs);
});

test('integrates a validated Yahoo recap with package-owned ordering, identity and horizon', async () => {
  const article = yahooRecapArticle();
  const articleCalls = [];
  const evidenceCalls = [];
  const rememberedDiscoveries = [];
  const {service, calls} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap(value) {
        calls.yahooRecapResearch.push(value);
        return yahooRecapResearchSuccess();
      },
      rememberValidatedDiscovery(value) {
        rememberedDiscoveries.push(value);
        return true;
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent(value) {
        articleCalls.push(value);
        return {ok: true, type: 'SUCCESS', articleContent: article};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        evidenceCalls.push(value);
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    }
  });

  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(calls.yahooRecapResearch, [{targetSessionDate: '2026-09-04'}]);
  assert.equal(articleCalls.length, 1);
  assert.deepEqual(articleCalls[0], {
    discovery: yahooRecapResearchSuccess().discovery,
    validation: yahooRecapResearchSuccess().validation,
    bounds: YAHOO_RECAP_ARTICLE_BOUNDS
  });
  assert.equal(evidenceCalls.length, 1);
  assert.deepEqual(rememberedDiscoveries, [{
    targetSessionDate: '2026-09-04',
    discovery: yahooRecapResearchSuccess().discovery
  }]);
  assert.deepEqual(evidenceCalls[0].horizon, {
    classification: 'SUBSEQUENT_DEVELOPMENT',
    startsAtExclusive: '2026-09-04T20:00:00.000Z',
    endsAtInclusive: GENERATED_AT
  });
  assert.deepEqual(context.evidence.map(record => [
    record.reference, record.item.sourceId, record.item.evidenceCategory
  ]), [
    ['e1', 'us.yahoo-finance', 'market-data'],
    ['e2', 'us.yahoo-finance', 'news'],
    ['e3', 'us.federal-reserve', 'monetary-policy'],
    ['e4', 'us.federal-reserve', 'monetary-policy']
  ]);
  assert.equal(context.evidence[1].item.provenance.publisher, 'Yahoo! Finance');
  assert.deepEqual(context.authoritativeFacts, ['e1', 'e3', 'e4']);
  assert.deepEqual(context.supportingEvidence, ['e1', 'e3', 'e4']);
  assert.deepEqual(context.subsequentDevelopments, ['e2']);
  assert.deepEqual(context.principalCatalysts, []);
  assert.deepEqual(context.sessionAssociations, [{
    evidenceRef: 'e2', sessionDate: '2026-09-04'
  }]);
  assert.deepEqual(context.unresolvedGaps, [CNBC_RECAP_UNAVAILABLE_GAP]);
  assert.deepEqual(context.furtherReadings, [{
    evidenceRef: 'e2', sessionDate: '2026-09-04'
  }]);
  assert.equal(JSON.stringify(output).includes('c1'), false);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('evicts a Yahoo cache hit after article failure and completes through cold fallback discovery', async () => {
  const cachedResearch = yahooRecapResearchSuccess({
    title: 'Stale cached identity',
    url: 'https://finance.yahoo.com/markets/live/stale-cached-identity.html'
  });
  const fallbackResearch = yahooRecapResearchSuccess();
  const researchCalls = [];
  const evictions = [];
  const remembered = [];
  let acquisitionCalls = 0;
  const {service} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap(value) {
        researchCalls.push(value);
        return researchCalls.length === 1 ? cachedResearch : fallbackResearch;
      },
      isValidatedCacheHit(value) { return value === cachedResearch; },
      evictValidatedCacheHit(value) {
        evictions.push(value);
        return value === cachedResearch;
      },
      rememberValidatedDiscovery(value) {
        remembered.push(value);
        return true;
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        acquisitionCalls += 1;
        return acquisitionCalls === 1
          ? {ok: false, type: 'INVALID_METADATA'}
          : {ok: true, type: 'SUCCESS', articleContent: yahooRecapArticle()};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    }
  });

  const output = await service.assemble(request());
  assert.equal(researchCalls.length, 2);
  assert.equal(acquisitionCalls, 2);
  assert.deepEqual(evictions, [cachedResearch]);
  assert.deepEqual(remembered, [{
    targetSessionDate: '2026-09-04', discovery: fallbackResearch.discovery
  }]);
  assert.equal(output.marketPackages[0].evidenceContext.evidence.some(record =>
    record.item.sourceId === 'us.yahoo-finance'
      && record.item.evidenceCategory === 'news'), true);
  assert.equal(output.marketPackages[0].evidenceContext.unresolvedGaps.includes(
    YAHOO_RECAP_RETRIEVAL_FAILURE_GAP
  ), false);
});

test('broad-market news lane uses validated record identity, not provider or portfolio membership', () => {
  const portfolioOnly = createEvidenceItem({
    sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
    title: 'Portfolio-only company update', summary: 'One followed company update.',
    canonicalUrl: 'https://www.reuters.com/world/us/portfolio-only-update/',
    publishedAt: '2026-09-04T19:00:00Z', symbols: ['AAPL']
  });
  const broadMarket = createEvidenceItem({
    sourceId: 'us.reuters', market: 'US', evidenceCategory: 'news',
    title: 'Semiconductor sector leadership', summary: 'Semiconductor companies led the market.',
    canonicalUrl: 'https://www.reuters.com/world/us/sector-leadership/',
    publishedAt: '2026-09-04T19:00:00Z', symbols: []
  });
  const background = yahooEvidence('^RUT').items[0];
  assert.deepEqual([...broadMarketNewsReferences(
    [portfolioOnly, background, broadMarket], [broadMarket, background]
  )], ['e3']);
  assert.deepEqual([...broadMarketNewsReferences(
    [portfolioOnly, background, broadMarket], []
  )], []);
});

test('Yahoo, CNBC recap, and general CNBC can independently or jointly supply Section 3 focus', async () => {
  const yahooArticle = Object.freeze({
    ...yahooRecapArticle(),
    articleText: 'Microsoft led broad-market technology shares.'
  });
  const cnbcRecap = ({horizons}) => {
    const result = cnbcRecapResearchSuccess({horizon: horizons[1]});
    const original = result.constructedEvidence.evidenceItem;
    return {
      ...result,
      constructedEvidence: {
        ...result.constructedEvidence,
        evidenceItem: createEvidenceItem({
          sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
          title: original.title, summary: 'Nvidia led semiconductor shares.',
          canonicalUrl: original.canonicalUrl, publishedAt: original.publishedAt,
          symbols: []
        })
      }
    };
  };
  const cases = [
    {name: 'Yahoo only', yahoo: true, recap: false, general: false,
      expected: [['e2', 'Microsoft']]},
    {name: 'CNBC recap only', yahoo: false, recap: true, general: false,
      expected: [['e4', 'Nvidia']]},
    {name: 'general CNBC only', yahoo: false, recap: false, general: true,
      expected: [['e4', 'Broadcom']]},
    {name: 'Yahoo and both CNBC paths', yahoo: true, recap: true, general: true,
      expected: [['e2', 'Microsoft'], ['e5', 'Nvidia'], ['e6', 'Broadcom']]},
    {name: 'no eligible news', yahoo: false, recap: false, general: false,
      expected: []}
  ];
  for (const scenario of cases) {
    let classifiedInput;
    const {service} = harness({
      yahooRecapResearch: {
        async discoverAndValidateRecap() {
          return scenario.yahoo ? yahooRecapResearchSuccess()
            : {ok: true, type: 'NOT_FOUND', discovery: null, validation: null};
        }
      },
      yahooRecapArticleContentAcquisition: {
        async acquireArticleContent() {
          return {ok: true, type: 'SUCCESS', articleContent: yahooArticle};
        }
      },
      yahooRecapEvidenceConstruction: {
        constructEvidence(value) {
          return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
        }
      },
      cnbcRecapResearch: {
        async researchCompletedSessionRecap(value) {
          return scenario.recap ? cnbcRecap(value)
            : {ok: true, type: 'NOT_FOUND', constructedEvidence: null};
        }
      },
      cnbcNewsResearch: {
        async researchNews({horizons}) {
          return scenario.general ? cnbcResearchSuccess(horizons,
            ['COMPLETED_SESSION'], [{
              title: 'Broadcom leads semiconductor stocks',
              summary: 'Broadcom led semiconductor shares.',
              extract: 'Broadcom led semiconductor shares.'
            }]) : {ok: true, type: 'NOT_FOUND'};
        }
      },
      evidenceRoleClassification: {
        async classifyEvidenceRoles(input) {
          classifiedInput = input;
          const roles = {};
          const subjects = {};
          for (const entry of input.evidence) {
            if (!entry.requiresBroadMarketSubjects) continue;
            roles[entry.reference] = ['MATERIAL_EVENT'];
            const name = ['Microsoft', 'Nvidia', 'Broadcom'].find(candidate =>
              `${entry.item.title} ${entry.item.summary}`.includes(candidate));
            subjects[entry.reference] = [{kind: 'COMPANY', name}];
          }
          return roleClassificationSuccess(input, roles, subjects);
        }
      }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    assert.deepEqual(context.broadMarketFocus.map(entry => [
      entry.evidenceRef, entry.subjects[0].name
    ]), scenario.expected, scenario.name);
    assert.deepEqual(classifiedInput.evidence.filter(entry =>
      entry.requiresBroadMarketSubjects).map(entry => entry.reference),
    scenario.expected.map(([reference]) => reference), scenario.name);
    assert.equal(validateClaudeAnalysisInput(output), true, scenario.name);
  }
});

test('subject repair covers omitted Yahoo and CNBC recap subjects without changing material roles', async () => {
  const article = Object.freeze({
    ...yahooRecapArticle(), articleText: 'Microsoft led technology shares.'
  });
  let classifiedInput;
  let repairInput;
  const {service} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: article};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    },
    cnbcRecapResearch: {
      async researchCompletedSessionRecap({horizons}) {
        const result = cnbcRecapResearchSuccess({horizon: horizons[1]});
        const item = result.constructedEvidence.evidenceItem;
        return {
          ...result,
          constructedEvidence: {
            ...result.constructedEvidence,
            evidenceItem: createEvidenceItem({
              sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
              title: item.title, summary: 'Nvidia led semiconductor shares.',
              canonicalUrl: item.canonicalUrl, publishedAt: item.publishedAt,
              symbols: []
            })
          }
        };
      }
    },
    cnbcNewsResearch: {
      async researchNews() { return {ok: true, type: 'NOT_FOUND'}; }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifiedInput = input;
        return roleClassificationSuccess(input, {
          e2: ['MATERIAL_EVENT'], e5: ['MATERIAL_EVENT']
        }, {e2: [], e5: []});
      },
      async repairEvidenceSubjects(input) {
        repairInput = input;
        return {ok: true, type: 'SUCCESS', output: {repairs: [
          {reference: 'e2', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
          {reference: 'e5', subjects: [{kind: 'COMPANY', name: 'Nvidia'}]}
        ]}};
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(classifiedInput.evidence.filter(entry =>
    entry.requiresBroadMarketSubjects).map(entry => entry.reference), ['e2', 'e5']);
  assert.deepEqual(repairInput.evidence.map(entry => entry.reference), ['e2', 'e5']);
  assert.deepEqual(context.broadMarketFocus, [
    {evidenceRef: 'e2', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
    {evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Nvidia'}]}
  ]);
  assert.deepEqual(context.materialEvents, ['e2', 'e5']);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('validated Yahoo focus survives general CNBC classifier-capacity rejection', async () => {
  const article = Object.freeze({
    ...yahooRecapArticle(), articleText: 'Microsoft led technology shares.'
  });
  let classifiedInput;
  const {service} = harness({
    federalReserveEvidenceAcquisition: {
      async acquireEvidence() { return manyFedEvidence(48); }
    },
    yahooRecapResearch: {
      async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: article};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifiedInput = input;
        return roleClassificationSuccess(input, {e2: ['MATERIAL_EVENT']}, {
          e2: [{kind: 'COMPANY', name: 'Microsoft'}]
        });
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(classifiedInput.evidence.length, 50);
  assert.deepEqual(context.broadMarketFocus, [{
    evidenceRef: 'e2', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]
  }]);
  assert.equal(context.unresolvedGaps.includes(BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP), true);
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('real Yahoo validation, article acquisition and evidence construction reach Further Readings', async () => {
  const url = 'https://finance.yahoo.com/markets/live/stock-market-today-september-4.html';
  const title = 'Stock market today: September 4 recap';
  const publishedAt = '2026-09-04T20:03:54Z';
  const updatedAt = '2026-09-04T20:20:00Z';
  const html = `<link rel="canonical" href="${url}"><script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting', headline: title, datePublished: publishedAt,
    dateModified: updatedAt, url,
    publisher: {'@type': 'Organization', name: 'Yahoo Finance'},
    articleBody: 'The US stock market finished the September 4 session higher.'
  })}</script>`;
  const requests = [];
  const fetchImpl = async requestedUrl => {
    requests.push(requestedUrl);
    if (requestedUrl === 'https://api.anthropic.com/v1/messages') {
      return {
        ok: true, status: 200, headers: {get: () => null},
        async json() {
          return {content: [{type: 'web_search_tool_result', content: [{
            type: 'web_search_result', title, url
          }]}]};
        }
      };
    }
    assert.equal(requestedUrl, url);
    return {
      ok: true, status: 200, url,
      headers: {get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null},
      async text() { return html; }
    };
  };
  const {service} = harness({
    yahooRecapResearch: createYahooRecapResearchRuntime({apiKey: 'test-key', fetchImpl}),
    yahooRecapArticleContentAcquisition:
      createYahooRecapArticleContentAcquisitionService({fetchImpl}),
    yahooRecapEvidenceConstruction: createYahooRecapEvidenceConstructionService({
      evidenceConstructionBounds: {
        maxHeadlineBytes: 512, maxPublisherNameBytes: 256,
        maxEvidenceTextBytes: 8192, maxResultBytes: 12288
      }
    })
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(requests, ['https://api.anthropic.com/v1/messages', url, url]);
  assert.equal(context.evidence[1].reference, 'e2');
  assert.equal(context.evidence[1].item.sourceId, 'us.yahoo-finance');
  assert.equal(context.evidence[1].item.canonicalUrl, url);
  assert.equal(context.evidence[1].item.publishedAt, '2026-09-04T20:03:54.000Z');
  assert.equal(context.evidence[1].item.provenance.publisher, 'Yahoo Finance');
  assert.deepEqual(context.furtherReadings, [{evidenceRef: 'e2', sessionDate: '2026-09-04'}]);
  assert.equal(context.unresolvedGaps.includes(YAHOO_RECAP_RETRIEVAL_FAILURE_GAP), false);
  assert.equal(context.unresolvedGaps.includes(YAHOO_RECAP_UNAVAILABLE_GAP), false);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('later second-fetch Yahoo dateModified becomes authoritative through evidence construction', async () => {
  const url = 'https://finance.yahoo.com/markets/live/stock-market-today-september-4.html';
  const title = 'Stock market today: September 4 recap';
  const publishedAt = '2026-09-04T20:03:54Z';
  const validationUpdatedAt = '2026-09-04T20:10:00Z';
  const acquisitionUpdatedAt = '2026-09-04T22:30:00Z';
  const page = updatedAt => `<link rel="canonical" href="${url}"><script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting', headline: title, datePublished: publishedAt,
    dateModified: updatedAt, url,
    publisher: {'@type': 'Organization', name: 'Yahoo Finance'},
    articleBody: 'The US stock market finished the September 4 session higher.'
  })}</script>`;
  let pageFetches = 0;
  let constructedArticle = null;
  const evidenceConstruction = createYahooRecapEvidenceConstructionService({
    evidenceConstructionBounds: {
      maxHeadlineBytes: 512, maxPublisherNameBytes: 256,
      maxEvidenceTextBytes: 8192, maxResultBytes: 12288
    }
  });
  const fetchImpl = async requestedUrl => {
    if (requestedUrl === 'https://api.anthropic.com/v1/messages') {
      return {
        ok: true, status: 200, headers: {get: () => null},
        async json() {
          return {content: [{type: 'web_search_tool_result', content: [{
            type: 'web_search_result', title, url
          }]}]};
        }
      };
    }
    pageFetches++;
    return {
      ok: true, status: 200, url,
      headers: {get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null},
      async text() {
        return page(pageFetches === 1 ? validationUpdatedAt : acquisitionUpdatedAt);
      }
    };
  };
  const {service} = harness({
    yahooRecapResearch: createYahooRecapResearchRuntime({apiKey: 'test-key', fetchImpl}),
    yahooRecapArticleContentAcquisition:
      createYahooRecapArticleContentAcquisitionService({fetchImpl}),
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        constructedArticle = value.articleContent;
        return evidenceConstruction.constructEvidence(value);
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(pageFetches, 2);
  assert.equal(constructedArticle.updatedAt, '2026-09-04T22:30:00.000Z');
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.yahoo-finance'
    && entry.item.evidenceCategory === 'news'), true);
  assert.deepEqual(context.sessionAssociations, [{evidenceRef: 'e2', sessionDate: '2026-09-04'}]);
  assert.deepEqual(context.furtherReadings, [{evidenceRef: 'e2', sessionDate: '2026-09-04'}]);
  assert.equal(context.unresolvedGaps.includes(YAHOO_RECAP_RETRIEVAL_FAILURE_GAP), false);
});

test('advanced Yahoo updatedAt must remain inside the same canonical evidence horizon', async () => {
  const cases = [
    {
      name: 'completed publication with post-close update',
      publishedAt: '2026-09-04T19:45:00.000Z',
      validatedUpdatedAt: '2026-09-04T19:50:00.000Z',
      acquiredUpdatedAt: '2026-09-04T20:20:00.000Z'
    },
    {
      name: 'update after final generatedAt',
      publishedAt: '2026-09-04T20:03:54.000Z',
      validatedUpdatedAt: '2026-09-04T20:10:00.000Z',
      acquiredUpdatedAt: '2026-09-06T10:00:00.001Z'
    }
  ];
  for (const item of cases) {
    const diagnostics = [];
    const research = yahooRecapResearchSuccess({
      publishedAt: item.publishedAt,
      updatedAt: item.validatedUpdatedAt
    });
    const article = yahooRecapArticle({
      publishedAt: item.publishedAt,
      updatedAt: item.acquiredUpdatedAt
    });
    const {service} = harness({
      yahooRecapResearch: {async discoverAndValidateRecap() { return research; }},
      yahooRecapArticleContentAcquisition: {
        async acquireArticleContent() {
          return {ok: true, type: 'SUCCESS', articleContent: article};
        }
      },
      onDiagnostics(value) { diagnostics.push(value); }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.yahoo-finance'
      && entry.item.evidenceCategory === 'news'), false, item.name);
    assert.deepEqual(context.sessionAssociations, [], item.name);
    assert.equal(context.unresolvedGaps.includes(YAHOO_RECAP_RETRIEVAL_FAILURE_GAP), true,
      item.name);
    assert.deepEqual(diagnostics.find(value => value.stage === 'yahooRecapIntegration'), {
      stage: 'yahooRecapIntegration', outcome: 'FAILURE', researchType: 'VALIDATED',
      failureType: 'HORIZON_MISMATCH', candidateRank: null
    }, item.name);
  }
});

test('Yahoo orchestration accepts an added update timestamp but rejects a removed one', async () => {
  const publishedAt = '2026-09-04T20:03:54.000Z';
  const acquiredUpdatedAt = '2026-09-04T20:20:00.000Z';
  const addedArticle = yahooRecapArticle({publishedAt, updatedAt: acquiredUpdatedAt});
  const added = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() {
        return yahooRecapResearchSuccess({publishedAt, updatedAt: null});
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: addedArticle};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    }
  });
  const addedOutput = await added.service.assemble(request());
  assert.equal(addedOutput.marketPackages[0].evidenceContext.evidence.some(entry =>
    entry.item.sourceId === 'us.yahoo-finance' && entry.item.evidenceCategory === 'news'), true);

  const diagnostics = [];
  const removed = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() {
        return yahooRecapResearchSuccess({publishedAt, updatedAt: acquiredUpdatedAt});
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: yahooRecapArticle({
          publishedAt, updatedAt: null
        })};
      }
    },
    onDiagnostics(value) { diagnostics.push(value); }
  });
  const removedOutput = await removed.service.assemble(request());
  assert.equal(removedOutput.marketPackages[0].evidenceContext.evidence.some(entry =>
    entry.item.sourceId === 'us.yahoo-finance' && entry.item.evidenceCategory === 'news'), false);
  assert.deepEqual(diagnostics.find(value => value.stage === 'yahooRecapIntegration'), {
    stage: 'yahooRecapIntegration', outcome: 'FAILURE', researchType: 'VALIDATED',
    failureType: 'ARTICLE_CONTRACT_FAILURE', candidateRank: null
  });
});

test('real Yahoo article retrieval failure remains optional after validated research', async () => {
  let fetches = 0;
  const {service} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }
    },
    yahooRecapArticleContentAcquisition: createYahooRecapArticleContentAcquisitionService({
      async fetchImpl(url) {
        fetches++;
        assert.equal(url, yahooRecapResearchSuccess().discovery.url);
        return {ok: false, status: 503};
      }
    })
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(fetches, 1);
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.yahoo-finance'
    && entry.item.evidenceCategory === 'news'), false);
  assert.deepEqual(context.furtherReadings, []);
  assert.equal(context.unresolvedGaps.includes(YAHOO_RECAP_RETRIEVAL_FAILURE_GAP), true);
  assert.equal(context.unresolvedGaps.includes(CNBC_RECAP_UNAVAILABLE_GAP), true);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('places a recap published inside the completed-session boundary in supporting evidence', async () => {
  const publishedAt = '2026-09-04T19:45:00.000Z';
  const article = yahooRecapArticle({publishedAt});
  const research = yahooRecapResearchSuccess({publishedAt});
  const {service} = harness({
    yahooRecapResearch: {async discoverAndValidateRecap() { return research; }},
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() { return {ok: true, type: 'SUCCESS', articleContent: article}; }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) { return yahooRecapEvidenceSuccess(value.articleContent, value.horizon); }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(context.supportingEvidence, ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(context.subsequentDevelopments, []);
  assert.deepEqual(context.sessionAssociations, []);
});

test('associates a Yahoo recap only during the bounded post-close relevance window', async () => {
  for (const publishedAt of [
    '2026-09-04T20:00:00.000Z',
    '2026-09-04T19:59:59.999Z',
    '2026-09-04T22:00:00.001Z'
  ]) {
    const article = yahooRecapArticle({publishedAt});
    const research = yahooRecapResearchSuccess({publishedAt});
    const {service} = harness({
      yahooRecapResearch: {async discoverAndValidateRecap() { return research; }},
      yahooRecapArticleContentAcquisition: {
        async acquireArticleContent() { return {ok: true, type: 'SUCCESS', articleContent: article}; }
      },
      yahooRecapEvidenceConstruction: {
        constructEvidence(value) { return yahooRecapEvidenceSuccess(value.articleContent, value.horizon); }
      }
    });
    const output = await service.assemble(request());
    assert.deepEqual(output.marketPackages[0].evidenceContext.sessionAssociations, []);
  }
});

test('associates a Yahoo recap published exactly two hours after canonical close', async () => {
  const publishedAt = '2026-09-04T22:00:00.000Z';
  const article = yahooRecapArticle({publishedAt});
  const research = yahooRecapResearchSuccess({publishedAt});
  const {service} = harness({
    yahooRecapResearch: {async discoverAndValidateRecap() { return research; }},
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() { return {ok: true, type: 'SUCCESS', articleContent: article}; }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) { return yahooRecapEvidenceSuccess(value.articleContent, value.horizon); }
    }
  });
  const output = await service.assemble(request());
  assert.deepEqual(output.marketPackages[0].evidenceContext.sessionAssociations, [{
    evidenceRef: 'e2', sessionDate: '2026-09-04'
  }]);
});

test('treats Yahoo recap absence and wrong-session validation as optional without article retrieval', async () => {
  for (const result of [
    {ok: true, type: 'NOT_FOUND', discovery: null, validation: null},
    {ok: true, type: 'NOT_VALIDATED', discovery: yahooRecapResearchSuccess().discovery, validation: null},
    {
      ...yahooRecapResearchSuccess(),
      discovery: Object.freeze({
        ...yahooRecapResearchSuccess().discovery,
        targetSessionDate: '2026-09-03'
      }),
      validation: Object.freeze({
        ...yahooRecapResearchSuccess().validation,
        targetSessionDate: '2026-09-03'
      })
    }
  ]) {
    let articleCalls = 0;
    const {service} = harness({
      yahooRecapResearch: {async discoverAndValidateRecap() { return result; }},
      yahooRecapArticleContentAcquisition: {
        async acquireArticleContent() { articleCalls++; throw new Error('not expected'); }
      }
    });
    const output = await service.assemble(request());
    assert.equal(articleCalls, 0);
    assert.equal(output.marketPackages[0].evidenceContext.evidence.some(
      record => record.item.evidenceCategory === 'news' && record.item.sourceId === 'us.yahoo-finance'
    ), false);
    assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
      result.type === 'VALIDATED'
        ? YAHOO_RECAP_RETRIEVAL_FAILURE_GAP : YAHOO_RECAP_UNAVAILABLE_GAP,
      CNBC_RECAP_UNAVAILABLE_GAP
    ]);
    assert.deepEqual(output.marketPackages[0].evidenceContext.sessionAssociations, []);
  }
});

test('maps Yahoo recap stage failures to sanitized deterministic gaps', async () => {
  const cases = [
    {
      expectedGap: YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
      expectedResearchType: 'DISCOVERY_FAILURE',
      expectedType: 'UPSTREAM_FAILURE',
      overrides: {
        yahooRecapResearch: {
          async discoverAndValidateRecap() {
            return {ok: false, type: 'DISCOVERY_FAILURE', failureType: 'UPSTREAM_FAILURE'};
          }
        }
      }
    },
    {
      expectedGap: YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
      expectedResearchType: 'VALIDATED',
      expectedType: 'HTTP_FAILURE',
      overrides: {
        yahooRecapResearch: {async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }},
        yahooRecapArticleContentAcquisition: {
          async acquireArticleContent() { return {ok: false, type: 'HTTP_FAILURE'}; }
        }
      }
    },
    {
      expectedGap: YAHOO_RECAP_EVIDENCE_CONSTRUCTION_FAILURE_GAP,
      expectedResearchType: 'VALIDATED',
      expectedType: 'EVIDENCE_CONTRACT_FAILURE',
      overrides: {
        yahooRecapResearch: {async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }},
        yahooRecapArticleContentAcquisition: {
          async acquireArticleContent() {
            return {ok: true, type: 'SUCCESS', articleContent: yahooRecapArticle()};
          }
        },
        yahooRecapEvidenceConstruction: {
          constructEvidence() { return {ok: false, type: 'EVIDENCE_CONTRACT_FAILURE'}; }
        }
      }
    }
  ];
  for (const item of cases) {
    const diagnostics = [];
    const rememberedDiscoveries = [];
    const originalResearch = item.overrides.yahooRecapResearch;
    const {service} = harness({
      ...item.overrides,
      ...(originalResearch ? {
        yahooRecapResearch: {
          ...originalResearch,
          rememberValidatedDiscovery(value) {
            rememberedDiscoveries.push(value);
            return true;
          }
        }
      } : {}),
      onDiagnostics(value) { diagnostics.push(value); }
    });
    const output = await service.assemble(request());
    assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
      item.expectedGap, CNBC_RECAP_UNAVAILABLE_GAP
    ]);
    assert.deepEqual(diagnostics.find(value => value.stage === 'yahooRecapIntegration'), {
      stage: 'yahooRecapIntegration', outcome: 'FAILURE',
      researchType: item.expectedResearchType,
      failureType: item.expectedType,
      candidateRank: null
    });
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('articleText'), false);
    assert.equal(serialized.includes('canonicalUrl'), false);
    assert.deepEqual(rememberedDiscoveries, []);
  }
});

test('keeps thrown Yahoo recap failures sanitized in integration diagnostics', async () => {
  const diagnostics = [];
  const {service} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() { throw new Error('secret provider response body'); }
    },
    onDiagnostics(value) { diagnostics.push(value); }
  });
  const output = await service.assemble(request());
  assert.equal(output.marketPackages[0].evidenceContext.unresolvedGaps.includes(
    YAHOO_RECAP_RETRIEVAL_FAILURE_GAP
  ), true);
  assert.deepEqual(diagnostics.find(value => value.stage === 'yahooRecapIntegration'), {
    stage: 'yahooRecapIntegration', outcome: 'FAILURE', researchType: null,
    failureType: 'THROWN_FAILURE', candidateRank: null
  });
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of [
    'articleBody', 'rawHtml', 'authorization', 'apiKey', 'secret', 'provider response body'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('skips Yahoo recap research when the canonical primary session date is null', async () => {
  let researchCalls = 0;
  const {service, calls} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) { return snapshotWithoutCompletedSessions(symbol); }
    }),
    yahooRecapResearch: {
      async discoverAndValidateRecap() { researchCalls++; throw new Error('not expected'); }
    }
  });
  const output = await service.assemble(request());
  assert.equal(output.marketPackages[0].marketContext.primaryCompletedSessionDate, null);
  assert.equal(researchCalls, 0);
  assert.equal(output.marketPackages[0].evidenceContext.evidence.some(
    record => record.item.evidenceCategory === 'news' && record.item.sourceId === 'us.yahoo-finance'
  ), false);
  assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
    YAHOO_RECAP_UNAVAILABLE_GAP,
    CNBC_RECAP_UNAVAILABLE_GAP,
    CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP,
    EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP
  ]);
  assert.deepEqual(output.marketPackages[0].evidenceContext.materialEvents, []);
  assert.deepEqual(output.marketPackages[0].evidenceContext.principalCatalysts, []);
  assert.equal(calls.evidenceRoleClassification.length, 0);
  assert.equal(output.marketPackages[0].evidenceContext.unresolvedGaps.filter(
    gap => gap === EVIDENCE_ROLE_CLASSIFICATION_UNAVAILABLE_GAP
  ).length, 1);
});

test('does not reuse a previous successful Yahoo recap when the current discovery is absent', async () => {
  const article = yahooRecapArticle();
  let discoveryCalls = 0;
  const {service} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() {
        discoveryCalls++;
        return discoveryCalls === 1
          ? yahooRecapResearchSuccess()
          : {ok: true, type: 'NOT_FOUND', discovery: null, validation: null};
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() { return {ok: true, type: 'SUCCESS', articleContent: article}; }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) { return yahooRecapEvidenceSuccess(value.articleContent, value.horizon); }
    }
  });
  const first = await service.assemble(request());
  const second = await service.assemble(request());
  const hasYahooRecap = output => output.marketPackages[0].evidenceContext.evidence.some(
    record => record.item.evidenceCategory === 'news' && record.item.sourceId === 'us.yahoo-finance'
  );
  assert.equal(discoveryCalls, 2);
  assert.equal(hasYahooRecap(first), true);
  assert.equal(hasYahooRecap(second), false);
  assert.deepEqual(second.marketPackages[0].evidenceContext.unresolvedGaps, [
    YAHOO_RECAP_UNAVAILABLE_GAP, CNBC_RECAP_UNAVAILABLE_GAP
  ]);
});

test('keeps portfolio membership validation independent of the Claude byte guard', () => {
  const memberships = Array.from({length: 50}, (_, index) => ({
    market: 'US',
    symbol: `STOCK${index + 1}`
  }));
  const result = validateUsAnalysisOrchestrationRequest(request('US', {myStocks: memberships}));
  assert.equal(result.canonicalRequest.myStocks.length, 50);
});

test('supports an empty portfolio without fabricating stock or event context', async () => {
  const {service, calls} = harness();
  const output = await service.assemble(request());
  assert.deepEqual(calls.telemetry.map(item => item.symbol), ['^RUT']);
  assert.deepEqual(output.marketPackages[0].telemetry.stockSnapshots, []);
  assert.deepEqual(output.portfolioContext, {myStocks: [], watchlist: []});
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('rejects SG, HK and ALL explicitly before runtime acquisition', async () => {
  for (const selectedScope of ['SG', 'HK', 'ALL']) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request(selectedScope)), /supports selectedScope US only/);
    assert.deepEqual(calls.factories, []);
  }
});

test('rejects overlap between supplied anchors and either portfolio list before any acquisition', async () => {
  const cases = [
    {myStocks: [{market: 'US', symbol: '^RUT'}]},
    {watchlist: [{market: 'US', symbol: '^RUT'}]}
  ];
  for (const membership of cases) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request('US', membership)), /cannot be portfolio membership/);
    assert.deepEqual(calls, {
      factories: [], telemetry: [], persistence: [], yahoo: [], fed: 0,
      yahooMostActive: 0, yahooLatestNews: 0, yahooCurrentNewsArticle: [],
      yahooRecapResearch: [], yahooRecapArticle: [], yahooRecapEvidence: [],
      cnbcRecapResearch: [], cnbc: [],
      evidenceRoleClassification: [], evidenceSubjectRepair: []
    });
  }
});

test('integrates one CNBC recap before general CNBC with package-owned association ordering', async () => {
  const yahooArticle = yahooRecapArticle();
  const {service, calls} = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap(value) {
        calls.yahooRecapResearch.push(value);
        return yahooRecapResearchSuccess();
      }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: yahooArticle};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) {
        return yahooRecapEvidenceSuccess(value.articleContent, value.horizon);
      }
    },
    cnbcRecapResearch: {
      async researchCompletedSessionRecap(value) {
        calls.cnbcRecapResearch.push(value);
        return cnbcRecapResearchSuccess({horizon: value.horizons[1]});
      }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        calls.cnbc.push(horizons);
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {
          e6: ['MATERIAL_EVENT'], e7: ['MATERIAL_EVENT']
        });
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(calls.cnbcRecapResearch, [{
    targetSessionDate: '2026-09-04',
    horizons: calls.cnbc[0]
  }]);
  assert.deepEqual(context.evidence.map(({reference, item}) => [
    reference, item.sourceId, item.title
  ]), [
    ['e1', 'us.yahoo-finance', '^RUT market data'],
    ['e2', 'us.yahoo-finance', 'Stock market today: September 4 recap'],
    ['e3', 'us.federal-reserve', 'Federal Reserve policy statement'],
    ['e4', 'us.federal-reserve', 'Federal Reserve minutes'],
    ['e5', 'us.cnbc', 'Stock market news for Sept. 4, 2026'],
    ['e6', 'us.cnbc', 'CNBC market news item 1'],
    ['e7', 'us.cnbc', 'CNBC market news item 2']
  ]);
  assert.deepEqual(context.supportingEvidence, ['e1', 'e3', 'e4', 'e6']);
  assert.deepEqual(context.subsequentDevelopments, ['e2', 'e5', 'e7']);
  assert.deepEqual(context.sessionAssociations, [
    {evidenceRef: 'e2', sessionDate: '2026-09-04'},
    {evidenceRef: 'e5', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(context.furtherReadings, [
    {evidenceRef: 'e2', sessionDate: '2026-09-04'},
    {evidenceRef: 'e5', sessionDate: '2026-09-04'},
    {evidenceRef: 'e6', sessionDate: '2026-09-04'},
    {evidenceRef: 'e7', sessionDate: '2026-09-04'}
  ]);
  assert.equal(context.principalCatalysts.includes('e5'), false);
  assert.deepEqual(context.unresolvedGaps, []);
  assert.equal(context.evidence[4].item.provenance.publisher, 'CNBC');
  assert.equal(context.evidence[4].item.canonicalUrl,
    'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html');
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('validated CNBC daily recap uses one package evidence ref for analysis and Further Readings', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html';
  const recapTitle = 'Stock market news for Sep. 5, 2026';
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'LiveBlogPosting', headline: recapTitle,
    liveBlogUpdate: [{
      '@type': 'BlogPosting', headline: 'Overnight markets',
      datePublished: '2026-09-05T12:15:00Z',
      dateModified: '2026-09-05T12:20:00Z',
      articleBody: 'US stocks finished the Friday session after a volatile close.'
    }]
  })}</script>`;
  const fetched = [];
  const cnbcRecapResearch = createCnbcRecapResearchRuntime({
    fetchImpl: async url => {
      fetched.push(url);
      return {
            ok: true, status: 200, url: recapUrl,
            headers: {get: name => name === 'content-type' ? 'text/html' : null},
            async text() { return html; }
          };
    }
  });
  const {service} = harness({
    cnbcRecapResearch,
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        const recap = input.evidence.find(entry => entry.item.canonicalUrl === recapUrl);
        assert.ok(recap);
        return roleClassificationSuccess(input, {[recap.reference]: ['MATERIAL_EVENT']}, {
          [recap.reference]: []
        });
      },
      async repairEvidenceSubjects(input) {
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(entry => ({
          reference: entry.reference, subjects: []
        }))}};
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  const recapEntries = context.evidence.filter(entry => entry.item.canonicalUrl === recapUrl);
  assert.equal(recapEntries.length, 1);
  const recapReference = recapEntries[0].reference;
  assert.equal(recapEntries[0].item.title, recapTitle);
  assert.ok(context.materialEvents.includes(recapReference));
  assert.ok(context.subsequentDevelopments.includes(recapReference));
  assert.equal(context.principalCatalysts.includes(recapReference), false);
  assert.deepEqual(context.furtherReadings.filter(entry => entry.evidenceRef === recapReference), [
    {evidenceRef: recapReference, sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(fetched, [recapUrl]);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('predicted CNBC recap remains analysis evidence and Further Reading with unusable timestamp metadata', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html';
  for (const metadata of [
    {datePublished: 'not-a-date', dateModified: 'also-invalid', expectedPublishedAt: null},
    {datePublished: undefined, dateModified: undefined, expectedPublishedAt: null},
    {datePublished: '2026-09-04T20:15:00Z', dateModified: '2026-09-04T19:00:00Z',
      expectedPublishedAt: '2026-09-04T20:15:00.000Z'},
    {datePublished: '2026-09-03T12:00:00Z', dateModified: null,
      expectedPublishedAt: '2026-09-03T12:00:00.000Z'},
    {datePublished: '2026-09-07T12:00:00Z', dateModified: null,
      expectedPublishedAt: null}
  ]) {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'LiveBlogPosting', headline: 'Unrelated editorial date',
      liveBlogUpdate: [{
        '@type': 'BlogPosting', articleBody: 'US stocks finished Friday after sector rotation.',
        datePublished: metadata.datePublished, dateModified: metadata.dateModified
      }]
    })}</script>`;
    const fetched = [];
    const cnbcRecapResearch = createCnbcRecapResearchRuntime({
      fetchImpl: async url => {
        fetched.push(url);
        return {
          ok: true, status: 200, url: recapUrl,
          headers: {get: name => name === 'content-type' ? 'text/html' : null},
          async text() { return html; }
        };
      }
    });
    const {service} = harness({
      cnbcRecapResearch,
      evidenceRoleClassification: {
        async classifyEvidenceRoles(input) {
          const recap = input.evidence.find(entry => entry.item.canonicalUrl === recapUrl);
          assert.ok(recap);
          assert.equal(recap.horizon, 'SUBSEQUENT_DEVELOPMENT');
          assert.equal(recap.item.publishedAt, metadata.expectedPublishedAt);
          return roleClassificationSuccess(input, {[recap.reference]: ['MATERIAL_EVENT']}, {
            [recap.reference]: []
          });
        },
        async repairEvidenceSubjects(input) {
          return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(entry => ({
            reference: entry.reference, subjects: []
          }))}};
        }
      }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    const recapEntries = context.evidence.filter(entry => entry.item.canonicalUrl === recapUrl);
    assert.equal(recapEntries.length, 1);
    const reference = recapEntries[0].reference;
    assert.equal(recapEntries[0].item.publishedAt, metadata.expectedPublishedAt);
    assert.ok(context.materialEvents.includes(reference));
    assert.ok(context.subsequentDevelopments.includes(reference));
    assert.equal(context.principalCatalysts.includes(reference), false);
    assert.deepEqual(context.furtherReadings.filter(entry => entry.evidenceRef === reference), [
      {evidenceRef: reference, sessionDate: '2026-09-04'}
    ]);
    assert.deepEqual(fetched, [recapUrl]);
    assert.equal(validateClaudeAnalysisInput(output), true);
  }
});

test('CNBC recap optional outcomes and failures never block general CNBC research', async () => {
  for (const result of [
    {ok: true, type: 'NOT_FOUND', constructedEvidence: null},
    {ok: true, type: 'NOT_VALIDATED', constructedEvidence: null},
    {ok: false, type: 'ARTICLE_ACQUISITION_FAILURE', failureType: 'HTTP_FAILURE'}
  ]) {
    let generalCalls = 0;
    const {service} = harness({
      cnbcRecapResearch: {async researchCompletedSessionRecap() { return result; }},
      cnbcNewsResearch: {
        async researchNews({horizons}) {
          generalCalls++;
          return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        }
      },
      evidenceRoleClassification: {
        async classifyEvidenceRoles(input) {
          return roleClassificationSuccess(input, {e4: ['MATERIAL_EVENT']});
        }
      }
    });
    const context = (await service.assemble(request())).marketPackages[0].evidenceContext;
    assert.equal(generalCalls, 1);
    assert.equal(context.evidence.filter(entry => entry.item.sourceId === 'us.cnbc').length, 1);
    assert.equal(context.unresolvedGaps.filter(gap => gap === CNBC_RECAP_UNAVAILABLE_GAP).length, 1);
    assert.deepEqual(context.sessionAssociations, []);
  }
});

test('CNBC recap association excludes exact-close, pre-close, and over-two-hour evidence', async () => {
  for (const publishedAt of [
    '2026-09-04T20:00:00.000Z',
    '2026-09-04T19:59:59.999Z',
    '2026-09-04T22:00:00.001Z'
  ]) {
    const {service} = harness({
      cnbcRecapResearch: {
        async researchCompletedSessionRecap({horizons}) {
          const classification = publishedAt <= '2026-09-04T20:00:00.000Z'
            ? 'COMPLETED_SESSION' : 'SUBSEQUENT_DEVELOPMENT';
          return cnbcRecapResearchSuccess({
            publishedAt,
            updatedAt: publishedAt,
            horizon: horizons.find(item => item.classification === classification)
          });
        }
      }
    });
    const context = (await service.assemble(request())).marketPackages[0].evidenceContext;
    assert.deepEqual(context.sessionAssociations, []);
  }
});

test('integrates completed and subsequent CNBC evidence after Yahoo and Fed with package-owned refs', async () => {
  let researchCalls = 0;
  let researchTargetSessionDate = null;
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({targetSessionDate, horizons}) {
        researchCalls++;
        researchTargetSessionDate = targetSessionDate;
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {
          e4: ['MATERIAL_EVENT'], e5: ['MATERIAL_EVENT']
        });
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.equal(researchCalls, 1);
  assert.equal(researchTargetSessionDate, '2026-09-04');
  assert.deepEqual(context.evidence.map(entry => [entry.reference, entry.item.sourceId]), [
    ['e1', 'us.yahoo-finance'],
    ['e2', 'us.federal-reserve'],
    ['e3', 'us.federal-reserve'],
    ['e4', 'us.cnbc'],
    ['e5', 'us.cnbc']
  ]);
  assert.deepEqual(context.supportingEvidence, ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(context.subsequentDevelopments, ['e5']);
  assert.deepEqual(context.principalCatalysts, []);
  assert.deepEqual(context.furtherReadings, [
    {evidenceRef: 'e4', sessionDate: '2026-09-04'},
    {evidenceRef: 'e5', sessionDate: '2026-09-04'}
  ]);
  assert.equal(JSON.stringify(output).includes('c1'), false);
  assert.equal(JSON.stringify(output).includes('c2'), false);
});

test('filters five provisional CNBC items and compacts every retained reference-bearing path', async () => {
  let repairInput;
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, [
          'COMPLETED_SESSION', 'COMPLETED_SESSION', 'COMPLETED_SESSION',
          'SUBSEQUENT_DEVELOPMENT', 'SUBSEQUENT_DEVELOPMENT'
        ]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(
          input,
          {
            e5: ['MATERIAL_EVENT'],
            e7: ['MATERIAL_EVENT'],
            e8: ['MATERIAL_EVENT']
          },
          {
            e5: [],
            e7: [{kind: 'SECTOR', name: 'CNBC market news item 4'}],
            e8: [{kind: 'COMPANY', name: 'CNBC market news item 5'}]
          },
          {e4: 'LOW', e5: 'HIGH', e6: 'MEDIUM', e7: 'MEDIUM', e8: 'LOW'}
        );
      },
      async repairEvidenceSubjects(input) {
        repairInput = input;
        return {ok: true, type: 'SUCCESS', output: {repairs: [{
          reference: 'e4', subjects: [{kind: 'COMPANY', name: 'CNBC market news item 2'}]
        }]}};
      }
    }
  });

  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(context.evidence.map(entry => [entry.reference, entry.item.title]), [
    ['e1', '^RUT market data'],
    ['e2', 'Federal Reserve policy statement'],
    ['e3', 'Federal Reserve minutes'],
    ['e4', 'CNBC market news item 2'],
    ['e5', 'CNBC market news item 4']
  ]);
  assert.deepEqual(context.materialEvents, ['e4', 'e5']);
  assert.deepEqual(context.principalCatalysts, []);
  assert.deepEqual(context.supportingEvidence, ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(context.subsequentDevelopments, ['e5']);
  assert.deepEqual(context.broadMarketFocus, [
    {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'CNBC market news item 2'}]},
    {evidenceRef: 'e5', subjects: [{kind: 'SECTOR', name: 'CNBC market news item 4'}]}
  ]);
  assert.deepEqual(context.furtherReadings, [
    {evidenceRef: 'e4', sessionDate: '2026-09-04'},
    {evidenceRef: 'e5', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(repairInput.evidence.map(entry => [entry.reference, entry.title]), [
    ['e4', 'CNBC market news item 2']
  ]);
  assert.equal(JSON.stringify(output).includes('CNBC market news item 1'), false);
  assert.equal(JSON.stringify(output).includes('CNBC market news item 3'), false);
  assert.equal(JSON.stringify(output).includes('CNBC market news item 5'), false);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('excludes generic market and broad-index labels from broad-market focus', async () => {
  const candidateOverrides = [
    {
      title: 'US stocks, the S&P 500 and Microsoft rose',
      summary: 'US stocks followed the S&P 500 and Microsoft higher.',
      extract: 'US stocks, the S&P 500 and Microsoft rose.'
    },
    {
      title: 'Nasdaq, Dow, equities and Financials advanced',
      summary: 'Nasdaq and Dow gains accompanied Financials strength.',
      extract: 'Nasdaq, Dow, equities and Financials advanced.'
    },
    {
      title: 'Technology and Nvidia led US stocks',
      summary: 'Technology shares and Nvidia outperformed US stocks.',
      extract: 'Technology and Nvidia led US stocks.'
    }
  ];
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(
          horizons,
          ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'COMPLETED_SESSION'],
          candidateOverrides
        );
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(
          input,
          {e4: ['MATERIAL_EVENT'], e5: ['MATERIAL_EVENT'], e6: ['MATERIAL_EVENT']},
          {
            e4: [
              {kind: 'SECTOR', name: 'US stocks'},
              {kind: 'SECTOR', name: 'S&P 500'},
              {kind: 'COMPANY', name: 'Microsoft'}
            ],
            e5: [
              {kind: 'SECTOR', name: 'Nasdaq'},
              {kind: 'SECTOR', name: 'Dow'},
              {kind: 'SECTOR', name: 'equities'},
              {kind: 'SECTOR', name: 'Financials'}
            ],
            e6: [
              {kind: 'SECTOR', name: 'US stocks'},
              {kind: 'SECTOR', name: 'Technology'},
              {kind: 'COMPANY', name: 'Nvidia'}
            ]
          }
        );
      }
    }
  });

  const output = await service.assemble(request());
  assert.deepEqual(output.marketPackages[0].evidenceContext.broadMarketFocus, [
    {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]},
    {evidenceRef: 'e5', subjects: [{kind: 'SECTOR', name: 'Financials'}]},
    {evidenceRef: 'e6', subjects: [
      {kind: 'SECTOR', name: 'Technology'},
      {kind: 'COMPANY', name: 'Nvidia'}
    ]}
  ]);
  assert.equal(validateClaudeAnalysisInput(output), true);

  const yahooArticle = yahooRecapArticle();
  const genericOnly = harness({
    yahooRecapResearch: {
      async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }
    },
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() {
        return {ok: true, type: 'SUCCESS', articleContent: yahooArticle};
      }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence({articleContent, horizon}) {
        return yahooRecapEvidenceSuccess(articleContent, horizon);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {e2: ['MATERIAL_EVENT']}, {
          e2: [{kind: 'SECTOR', name: 'US stocks'}]
        });
      }
    }
  }).service;
  const genericOnlyOutput = await genericOnly.assemble(request());
  assert.deepEqual(genericOnlyOutput.marketPackages[0].evidenceContext.broadMarketFocus, []);
  assert.equal(validateClaudeAnalysisInput(genericOnlyOutput), true);
});

test('localizes missing or generic CNBC subjects while preserving valid peers and material roles', async () => {
  let classifiedInput;
  let repairInput;
  const diagnostics = [];
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, [
          'COMPLETED_SESSION', 'COMPLETED_SESSION', 'COMPLETED_SESSION'
        ], [
          {
            title: 'Microsoft, Apple and Financials lead the session',
            summary: 'Microsoft and Apple rose while Financials, Bank of America and Goldman Sachs led.',
            extract: 'Microsoft and Apple rose while Financials, Bank of America and Goldman Sachs led.'
          },
          {
            title: 'US stocks rebound after the selloff',
            summary: 'US stocks and the S&P 500 recovered.',
            extract: 'US stocks and the S&P 500 recovered.'
          },
          {
            title: 'Intel, Micron and Boeing lead notable movers',
            summary: 'Intel, Micron, Boeing, GE Vernova and Eaton moved on company developments.',
            extract: 'Intel, Micron, Boeing, GE Vernova and Eaton moved on company developments.'
          }
        ]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifiedInput = input;
        return roleClassificationSuccess(
          input,
          {e4: ['MATERIAL_EVENT'], e5: ['MATERIAL_EVENT'], e6: ['PRINCIPAL_CATALYST']},
          {
            e4: [],
            e5: [{kind: 'SECTOR', name: 'US stocks'}],
            e6: []
          },
          {e4: 'HIGH', e5: 'MEDIUM', e6: 'HIGH'}
        );
      },
      async repairEvidenceSubjects(input) {
        repairInput = input;
        return {
          ok: true,
          type: 'SUCCESS',
          output: {repairs: [
            {reference: 'e4', subjects: [
              {kind: 'COMPANY', name: 'Microsoft'},
              {kind: 'COMPANY', name: 'Apple'},
              {kind: 'SECTOR', name: 'Financials'},
              {kind: 'COMPANY', name: 'Bank of America'},
              {kind: 'COMPANY', name: 'Goldman Sachs'}
            ]},
            {reference: 'e5', subjects: [{kind: 'SECTOR', name: 'US stocks'}]},
            {reference: 'e6', subjects: [
              {kind: 'COMPANY', name: 'Intel'},
              {kind: 'COMPANY', name: 'Micron'},
              {kind: 'COMPANY', name: 'Boeing'},
              {kind: 'COMPANY', name: 'GE Vernova'},
              {kind: 'COMPANY', name: 'Eaton'}
            ]}
          ]}
        };
      }
    },
    onDiagnostics: value => diagnostics.push(value)
  });

  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(context.materialEvents.slice(-2), ['e4', 'e5']);
  assert.deepEqual(context.principalCatalysts, ['e6']);
  assert.deepEqual(context.broadMarketFocus, [
    {evidenceRef: 'e4', subjects: [
      {kind: 'COMPANY', name: 'Microsoft'},
      {kind: 'COMPANY', name: 'Apple'},
      {kind: 'SECTOR', name: 'Financials'},
      {kind: 'COMPANY', name: 'Bank of America'},
      {kind: 'COMPANY', name: 'Goldman Sachs'}
    ]},
    {evidenceRef: 'e6', subjects: [
      {kind: 'COMPANY', name: 'Intel'},
      {kind: 'COMPANY', name: 'Micron'},
      {kind: 'COMPANY', name: 'Boeing'},
      {kind: 'COMPANY', name: 'GE Vernova'},
      {kind: 'COMPANY', name: 'Eaton'}
    ]}
  ]);
  assert.deepEqual(repairInput.evidence.map(entry => entry.reference), ['e4', 'e5', 'e6']);
  assert.deepEqual(Object.keys(repairInput.evidence[0]), ['reference', 'title', 'summary']);
  const repairDiagnostic = diagnostics.find(value => value.stage === 'evidenceSubjectRepair');
  assert.deepEqual(repairDiagnostic, {
    stage: 'evidenceSubjectRepair',
    primaryOmittedSubjectCount: null,
    primarySanitizedEmptySubjectCount: null,
    attemptedReferenceCount: 3,
    repairedReferenceCount: 2,
    outcome: 'PARTIAL_SUCCESS',
    failureType: null
  });
  assert.equal(classifiedInput.evidence.slice(-3)
    .every(entry => entry.requiresBroadMarketSubjects === true), true);
  assert.equal(classifiedInput.evidence.slice(0, -3)
    .every(entry => entry.requiresBroadMarketSubjects === false), true);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('keeps subject repair failure local and skips repair when primary subjects are valid', async () => {
  let failedRepairCalls = 0;
  const diagnostics = [];
  const failing = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION'], [{
          title: 'Microsoft and Financials lead',
          summary: 'Microsoft rose as Financials led the session.',
          extract: 'Microsoft rose as Financials led the session.'
        }]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {e4: ['MATERIAL_EVENT']}, {e4: []});
      },
      async repairEvidenceSubjects() {
        failedRepairCalls++;
        return {ok: false, type: 'UPSTREAM_FAILURE', message: 'sanitized'};
      }
    },
    onDiagnostics: value => diagnostics.push(value)
  });
  const failedOutput = await failing.service.assemble(request());
  const failedContext = failedOutput.marketPackages[0].evidenceContext;
  assert.equal(failedRepairCalls, 1);
  assert.deepEqual(failedContext.materialEvents, ['e4']);
  assert.deepEqual(failedContext.broadMarketFocus, []);
  assert.equal(validateClaudeAnalysisInput(failedOutput), true);
  assert.equal(diagnostics.find(value => value.stage === 'evidenceSubjectRepair').outcome,
    'FAILURE');
  assert.equal(diagnostics.find(value => value.stage === 'evidenceSubjectRepair').failureType,
    'UPSTREAM_FAILURE');

  const emptyDiagnostics = [];
  const emptyRepair = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION'], [{
          title: 'US stocks advance', summary: 'US stocks advanced.', extract: 'US stocks advanced.'
        }]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {e4: ['MATERIAL_EVENT']}, {e4: []});
      },
      async repairEvidenceSubjects(input) {
        return {ok: true, type: 'SUCCESS', output: {repairs: input.evidence.map(entry => ({
          reference: entry.reference, subjects: [{kind: 'SECTOR', name: 'US stocks'}]
        }))}};
      }
    },
    onDiagnostics: value => emptyDiagnostics.push(value)
  });
  const emptyOutput = await emptyRepair.service.assemble(request());
  assert.deepEqual(emptyOutput.marketPackages[0].evidenceContext.broadMarketFocus, []);
  assert.equal(emptyDiagnostics.find(value => value.stage === 'evidenceSubjectRepair').outcome,
    'REMAINED_EMPTY');

  let unnecessaryRepairCalls = 0;
  const valid = harness({
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION'], [{
          title: 'Microsoft and Financials lead',
          summary: 'Microsoft rose as Financials led the session.',
          extract: 'Microsoft rose as Financials led the session.'
        }]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {e5: ['MATERIAL_EVENT']}, {
          e5: [{kind: 'COMPANY', name: 'Microsoft'}]
        });
      },
      async repairEvidenceSubjects() { unnecessaryRepairCalls++; }
    }
  });
  const validOutput = await valid.service.assemble(request('US', {
    myStocks: [{market: 'US', symbol: 'AAPL'}]
  }));
  assert.equal(unnecessaryRepairCalls, 0);
  assert.deepEqual(validOutput.marketPackages[0].evidenceContext.broadMarketFocus, [{
    evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Microsoft'}]
  }]);
  assert.deepEqual(validOutput.portfolioContext.myStocks[0].evidenceRefs, ['e2']);
});

test('admits provisional CNBC evidence only while the 50-item classifier bound remains safe', async () => {
  let classifiedInput = null;
  const {service} = harness({
    federalReserveEvidenceAcquisition: {
      async acquireEvidence() { return manyFedEvidence(48); }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION', 'COMPLETED_SESSION']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifiedInput = input;
        return roleClassificationSuccess(input, {e50: ['MATERIAL_EVENT']});
      }
    }
  });

  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(classifiedInput.evidence.length, 50);
  assert.equal(classifiedInput.evidence.at(-1).item.title, 'CNBC market news item 1');
  assert.equal(context.evidence.length, 50);
  assert.equal(context.evidence.at(-1).reference, 'e50');
  assert.equal(context.evidence.at(-1).item.title, 'CNBC market news item 1');
  assert.equal(JSON.stringify(context).includes('CNBC market news item 2'), false);
  assert.equal(context.unresolvedGaps.includes(BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP), false);
});

test('keeps oversized provisional CNBC evidence optional at the 64 KiB classifier preflight', async () => {
  const benchmark = snapshot('^RUT');
  const yahooItem = yahooEvidence('^RUT').items[0];
  const provisional = cnbcResearchSuccess(
    [
      {classification: 'COMPLETED_SESSION', startsAtExclusive: '2026-09-03T20:00:00.000Z', endsAtInclusive: '2026-09-04T20:00:00.000Z'},
      {classification: 'SUBSEQUENT_DEVELOPMENT', startsAtExclusive: '2026-09-04T20:00:00.000Z', endsAtInclusive: GENERATED_AT}
    ],
    ['COMPLETED_SESSION']
  ).constructedEvidence[0].evidenceItem;
  function classifierBytes(items) {
    const requestBody = buildClaudeEvidenceRoleClassificationRequest({
      marketContext: {
        market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04'
      },
      benchmarkTelemetry: [{reference: 't1', snapshot: benchmark}],
      evidence: items.map((item, index) => ({
        reference: `e${index + 1}`, horizon: 'COMPLETED_SESSION',
        requiresBroadMarketSubjects: false, item
      }))
    });
    return Buffer.byteLength(JSON.stringify(requestBody), 'utf8');
  }
  let low = 0;
  let high = 4000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const items = [yahooItem, ...manyFedEvidence(20, middle).items];
    if (classifierBytes(items) <= CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const fedCollection = manyFedEvidence(20, low);
  const baseItems = [yahooItem, ...fedCollection.items];
  assert.equal(classifierBytes(baseItems)
    <= CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES, true);
  assert.equal(classifierBytes(baseItems.concat(provisional))
    > CLAUDE_EVIDENCE_ROLE_CLASSIFICATION_PROVISIONAL_MAX_REQUEST_BYTES, true);

  let classifiedInput = null;
  const {service} = harness({
    federalReserveEvidenceAcquisition: {
      async acquireEvidence() { return fedCollection; }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        classifiedInput = input;
        return roleClassificationSuccess(input);
      }
    }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(classifiedInput.evidence.length, baseItems.length);
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
  assert.deepEqual(context.broadMarketFocus, []);
  assert.equal(context.unresolvedGaps.includes(BROAD_MARKET_EVIDENCE_UNAVAILABLE_GAP), true);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('roleless low-materiality CNBC provisional evidence adds no final evidence or gap', async () => {
  const {service} = harness();
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
  assert.deepEqual(context.unresolvedGaps, [YAHOO_RECAP_UNAVAILABLE_GAP, CNBC_RECAP_UNAVAILABLE_GAP]);
  assert.deepEqual(context.furtherReadings, []);
});

test('non-portfolio company and sector CNBC evidence survives package roles without stock telemetry and follows recap anchors in Further Readings', async () => {
  const yahooArticle = yahooRecapArticle();
  const companyUrl = 'https://www.cnbc.com/2026/09/04/broadcom-semiconductor-leadership.html';
  const sectorUrl = 'https://www.cnbc.com/2026/09/04/health-care-sector-advances.html';
  const unusableUrl = 'https://www.cnbc.com/2026/09/04/bodyless-market-page.html';
  let searchCall = 0;
  const pageCalls = [];
  const cnbcDiagnostics = [];
  const cnbcNewsResearch = createCnbcNewsResearchRuntime({
    apiKey: 'server-key',
    onDiagnostics: value => cnbcDiagnostics.push(value),
    fetchImpl: async (url, options) => {
      if (url === 'https://api.anthropic.com/v1/messages') {
        const requestBody = JSON.parse(options.body);
        if (requestBody.tools) {
          const results = searchCall++ === 0
            ? [
                ...Array.from({length: 8}, (_, index) => ({
                  type: 'web_search_result',
                  title: `Rejected result ${index + 1}`,
                  url: `https://example.test/rejected-${index + 1}.html`
                })),
                {type: 'web_search_result', title: 'Bodyless market page', url: unusableUrl},
                {type: 'web_search_result', title: 'Broadcom result', url: companyUrl}
              ]
            : [
                {type: 'web_search_result', title: 'Duplicate Broadcom result', url: companyUrl},
                {type: 'web_search_result', title: 'Health-care sector result', url: sectorUrl}
              ];
          return {
            ok: true, status: 200,
            async json() {
              return {
                content: [{type: 'web_search_tool_result', content: results}],
                usage: {server_tool_use: {web_search_requests: 1}}
              };
            }
          };
        }
        throw new Error('standalone CNBC materiality invocation is forbidden');
      }
      pageCalls.push(url);
      const article = url === unusableUrl ? {
        '@context': 'https://schema.org', '@type': 'NewsArticle',
        headline: 'Bodyless market page', datePublished: '2026-09-04T19:00:00+00:00'
      } : {
        '@context': 'https://schema.org', '@type': 'NewsArticle',
        headline: url === companyUrl
          ? 'Broadcom leads broad-market semiconductor gains'
          : 'Health-care sector advances on constructive developments',
        datePublished: '2026-09-04T19:00:00+00:00',
        articleBody: url === companyUrl
          ? 'Broadcom led semiconductor shares higher after a material company development.'
          : 'Health-care shares advanced as constructive industry developments supported the sector.'
      };
      const html = `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
      return {
        ok: true, status: 200, url,
        headers: {get: name => name === 'content-type' ? 'text/html' : null},
        async text() { return html; }
      };
    }
  });
  const {service} = harness({
    yahooRecapResearch: {async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }},
    yahooRecapArticleContentAcquisition: {
      async acquireArticleContent() { return {ok: true, type: 'SUCCESS', articleContent: yahooArticle}; }
    },
    yahooRecapEvidenceConstruction: {
      constructEvidence(value) { return yahooRecapEvidenceSuccess(value.articleContent, value.horizon); }
    },
    cnbcRecapResearch: {
      async researchCompletedSessionRecap({horizons}) {
        return cnbcRecapResearchSuccess({horizon: horizons[1]});
      }
    },
    cnbcNewsResearch,
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(
          input,
          {e8: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], e9: ['MATERIAL_EVENT']},
          {
            e8: [{kind: 'COMPANY', name: 'Broadcom'}],
            e9: [{kind: 'SECTOR', name: 'Health-care sector'}]
          }
        );
      }
    }
  });
  const output = await service.assemble(request('US', {
    myStocks: [{market: 'US', symbol: 'AAPL'}],
    watchlist: [{market: 'US', symbol: 'NVDA'}]
  }));
  const context = output.marketPackages[0];
  assert.equal(context.evidenceContext.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP),
    false, JSON.stringify(cnbcDiagnostics));
  assert.deepEqual(context.telemetry.stockSnapshots.map(entry => entry.snapshot.symbol), ['AAPL', 'NVDA']);
  const broadMarket = context.evidenceContext.evidence.slice(-2);
  assert.deepEqual(broadMarket.map(entry => [entry.reference, entry.item.title, entry.item.symbols]), [
    ['e8', 'Broadcom leads broad-market semiconductor gains', []],
    ['e9', 'Health-care sector advances on constructive developments', []]
  ]);
  assert.deepEqual(context.evidenceContext.materialEvents.slice(-2), ['e8', 'e9']);
  assert.deepEqual(context.evidenceContext.broadMarketFocus, [
    {evidenceRef: 'e8', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
    {evidenceRef: 'e9', subjects: [{kind: 'SECTOR', name: 'Health-care sector'}]}
  ]);
  assert.deepEqual(context.evidenceContext.supportingEvidence.slice(-2), ['e8', 'e9']);
  assert.deepEqual(context.evidenceContext.furtherReadings, [
    {evidenceRef: 'e4', sessionDate: '2026-09-04'},
    {evidenceRef: 'e7', sessionDate: '2026-09-04'},
    {evidenceRef: 'e8', sessionDate: '2026-09-04'},
    {evidenceRef: 'e9', sessionDate: '2026-09-04'}
  ]);
  assert.deepEqual(output.portfolioContext.myStocks.map(item => item.symbol), ['AAPL']);
  assert.deepEqual(output.portfolioContext.watchlist.map(item => item.symbol), ['NVDA']);
  assert.equal(searchCall, 2);
  assert.deepEqual(pageCalls, [unusableUrl, companyUrl, sectorUrl]);
  const discoveryDiagnostic = cnbcDiagnostics.find(item => item.stage === 'cnbcMarketNewsDiscovery');
  assert.deepEqual({
    outcome: discoveryDiagnostic.outcome,
    resultCount: discoveryDiagnostic.resultCount,
    inspectedResultCount: discoveryDiagnostic.inspectedResultCount,
    retainedResultCount: discoveryDiagnostic.retainedResultCount,
    rejectionCounts: discoveryDiagnostic.rejectionCounts
  }, {
    outcome: 'SUCCESS',
    resultCount: 12,
    inspectedResultCount: 12,
    retainedResultCount: 3,
    rejectionCounts: {
      INVALID_URL: 8,
      PATH_MISMATCH: 0,
      INVALID_TITLE: 0,
      DUPLICATE: 1,
      RETAINED_LIMIT: 0
    }
  });
  assert.deepEqual(discoveryDiagnostic.retainedResults, [
    {rank: 9, searchIndex: 1, path: '/2026/09/04/bodyless-market-page.html', outcome: 'RETAINED'},
    {rank: 10, searchIndex: 1, path: '/2026/09/04/broadcom-semiconductor-leadership.html', outcome: 'RETAINED'},
    {rank: 12, searchIndex: 2, path: '/2026/09/04/health-care-sector-advances.html', outcome: 'RETAINED'}
  ]);
  const failedAcquisition = cnbcDiagnostics.find(item =>
    item.stage === 'cnbcDiscoveredArticleAcquisition');
  assert.equal(failedAcquisition.rank, discoveryDiagnostic.retainedResults[0].rank);
  assert.equal(discoveryDiagnostic.retainedResults[0].path,
    new URL(unusableUrl).pathname);
  const acquisitionDiagnostic = cnbcDiagnostics.find(item => item.stage === 'cnbcCandidateAcquisition');
  assert.deepEqual(acquisitionDiagnostic, {
    stage: 'cnbcCandidateAcquisition',
    outcome: 'SUCCESS',
    discoveryCount: 3,
    pageAttemptCount: 3,
    pageFailureCount: 1,
    extractionFailureCount: 1,
    horizonFailureCount: 0,
    contractFailureCount: 0,
    candidateCount: 2
  });
  const researchDiagnostic = cnbcDiagnostics.find(item => item.stage === 'cnbcNewsResearch');
  assert.equal(researchDiagnostic.outcome, 'SUCCESS');
  assert.deepEqual(researchDiagnostic.counts, {
    candidateCount: 2,
    useCount: 0,
    skipCount: 0,
    retrievedArticleCount: 2,
    constructedEvidenceCount: 2,
    materialityInvocationCount: 0
  });
  const serializedDiagnostics = JSON.stringify(cnbcDiagnostics);
  for (const forbidden of [
    'articleBody', 'rawHtml', 'authorization', 'apiKey', 'secret', 'provider response body',
    'Broadcom result', 'Health-care sector result'
  ]) assert.equal(serializedDiagnostics.includes(forbidden), false, forbidden);

  const finalRequest = buildClaudeAnalysisRequest(output);
  const finalInput = JSON.parse(finalRequest.messages[0].content);
  assert.deepEqual(finalInput.marketPackages[0].evidenceContext.evidence.slice(-2)
    .map(entry => [entry.reference, entry.item.title]), [
      ['e8', 'Broadcom leads broad-market semiconductor gains'],
      ['e9', 'Health-care sector advances on constructive developments']
    ]);
  const sections = REPORT_SECTION_NAMES.map((name, index) => ({
    name,
    content: index === 7 ? null
      : index === 2 ? 'Broadcom led semiconductor shares and health-care stocks advanced.'
        : index === 3 ? 'Apple was material to the initiating My Stocks list.'
          : index === 5 ? 'Constructive Health-care sector developments support an opportunity.'
            : 'The supplied evidence supports this market conclusion.',
    evidenceRefs: index === 7 ? [] : index === 2 ? ['e8', 'e9'] : index === 3 ? ['e2']
      : index === 5 ? ['e9'] : ['e8'],
    telemetryRefs: index === 7 ? [] : index === 3 ? ['t2'] : ['t1'],
    uncertainties: []
  }));
  const finalOutput = {
    status: 'NORMAL',
    reportContext: {
      header: REPORT_HEADER,
      selectedScope: 'US',
      generatedAt: output.analysisRequest.generatedAt,
      userTimezone: 'Asia/Singapore',
      reportType: 'MARKET_BRIEF',
      markets: ['US']
    },
    sections,
    evidenceReferences: ['e8', 'e9', 'e2'],
    furtherReadings: ['e4', 'e7', 'e8', 'e9'],
    evidenceGaps: []
  };
  assert.equal(validateClaudeAnalysisOutput(finalOutput, output).valid, true);
  assert.deepEqual(finalOutput.sections[2].evidenceRefs, ['e8', 'e9']);
  assert.deepEqual(finalOutput.sections[5].evidenceRefs, ['e9']);

  const leakedBroadMarketReference = JSON.parse(JSON.stringify(finalOutput));
  leakedBroadMarketReference.sections[3].evidenceRefs = ['e8'];
  leakedBroadMarketReference.sections[3].telemetryRefs = [];
  assert.equal(validateClaudeAnalysisOutput(
    leakedBroadMarketReference, output
  ).errors.includes('sections[3]: evidence references must belong to the initiating list'), true);
});

test('Further Readings deduplicates general CNBC evidence against mandatory recap anchors by canonical URL', async () => {
  const recapUrl = 'https://www.cnbc.com/2026/09/03/stock-market-today-live-updates.html';
  const {service} = harness({
    cnbcRecapResearch: {
      async researchCompletedSessionRecap({horizons}) {
        return cnbcRecapResearchSuccess({horizon: horizons[1]});
      }
    },
    cnbcNewsResearch: {
      async researchNews({horizons}) {
        return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION'], [{canonicalUrl: recapUrl}]);
      }
    },
    evidenceRoleClassification: {
      async classifyEvidenceRoles(input) {
        return roleClassificationSuccess(input, {e5: ['MATERIAL_EVENT']});
      }
    }
  });
  const context = (await service.assemble(request())).marketPackages[0].evidenceContext;
  assert.equal(context.evidence.filter(entry => entry.item.canonicalUrl === recapUrl).length, 2);
  assert.deepEqual(context.furtherReadings, [{evidenceRef: 'e4', sessionDate: '2026-09-04'}]);
});

test('Further Readings preserves each available recap anchor before validated general CNBC evidence', async () => {
  for (const scenario of [
    {yahoo: true, cnbc: false, expected: [
      'Stock market today: September 4 recap', 'CNBC market news item 1'
    ]},
    {yahoo: false, cnbc: true, expected: [
      'Stock market news for Sept. 4, 2026', 'CNBC market news item 1'
    ]}
  ]) {
    const overrides = {
      cnbcNewsResearch: {
        async researchNews({horizons}) {
          return cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        }
      },
      evidenceRoleClassification: {
        async classifyEvidenceRoles(input) {
          return roleClassificationSuccess(input, {e5: ['MATERIAL_EVENT']});
        }
      }
    };
    if (scenario.yahoo) {
      const article = yahooRecapArticle();
      overrides.yahooRecapResearch = {
        async discoverAndValidateRecap() { return yahooRecapResearchSuccess(); }
      };
      overrides.yahooRecapArticleContentAcquisition = {
        async acquireArticleContent() {
          return {ok: true, type: 'SUCCESS', articleContent: article};
        }
      };
      overrides.yahooRecapEvidenceConstruction = {
        constructEvidence({horizon}) { return yahooRecapEvidenceSuccess(article, horizon); }
      };
    }
    if (scenario.cnbc) {
      overrides.cnbcRecapResearch = {
        async researchCompletedSessionRecap({horizons}) {
          return cnbcRecapResearchSuccess({horizon: horizons[1]});
        }
      };
    }
    const {service} = harness(overrides);
    const context = (await service.assemble(request())).marketPackages[0].evidenceContext;
    const evidenceByReference = new Map(context.evidence.map(entry => [entry.reference, entry.item]));
    assert.deepEqual(context.furtherReadings.map(reading =>
      evidenceByReference.get(reading.evidenceRef).title), scenario.expected);
  }
});

test('CNBC bounded-search NOT_FOUND remains optional and adds the existing deterministic gap', async () => {
  const diagnostics = [];
  const {service} = harness({
    cnbcNewsResearch: {
      async researchNews() {
        return {
          ok: true,
          type: 'NOT_FOUND',
          candidateCollection: {market: 'US', candidates: []},
          selections: [],
          retrievedArticles: [],
          constructedEvidence: []
        };
      }
    },
    onDiagnostics(value) { diagnostics.push(value); }
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.equal(validateClaudeAnalysisInput(output), true);
  assert.deepEqual(context.unresolvedGaps, [
    YAHOO_RECAP_UNAVAILABLE_GAP,
    CNBC_RECAP_UNAVAILABLE_GAP,
    CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP
  ]);
  assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
  assert.equal(diagnostics.some(item =>
    item.stage === 'cnbcNewsResearchIntegration'
      && item.failureType === 'NOT_FOUND'), true);
});

test('successful CNBC recap remains in the package when general bounded search finds nothing', async () => {
  const {service} = harness({
    cnbcRecapResearch: {
      async researchCompletedSessionRecap({horizons}) {
        return cnbcRecapResearchSuccess({horizon: horizons[1]});
      }
    },
    cnbcNewsResearch: {
      async researchNews() {
        return {
          ok: true,
          type: 'NOT_FOUND',
          candidateCollection: {market: 'US', candidates: []},
          selections: [],
          retrievedArticles: [],
          constructedEvidence: []
        };
      }
    }
  });
  const context = (await service.assemble(request())).marketPackages[0].evidenceContext;
  const cnbcEvidence = context.evidence.filter(entry => entry.item.sourceId === 'us.cnbc');
  assert.equal(cnbcEvidence.length, 1);
  assert.deepEqual(context.sessionAssociations, [{
    evidenceRef: cnbcEvidence[0].reference,
    sessionDate: '2026-09-04'
  }]);
  assert.deepEqual(context.furtherReadings, [{
    evidenceRef: cnbcEvidence[0].reference,
    sessionDate: '2026-09-04'
  }]);
  assert.equal(context.unresolvedGaps.includes(CNBC_RECAP_UNAVAILABLE_GAP), false);
  assert.equal(context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true);
});

test('every CNBC stage failure degrades to one deterministic package gap', async () => {
  for (const type of [
    'DISCOVERY_PROVIDER_FAILURE',
    'CANDIDATE_ACQUISITION_FAILURE',
    'MATERIALITY_PROVIDER_FAILURE',
    'MATERIALITY_CONTRACT_FAILURE',
    'MATERIALITY_REQUEST_TOO_LARGE',
    'ARTICLE_RETRIEVAL_FAILURE',
    'EVIDENCE_CONSTRUCTION_FAILURE'
  ]) {
    const diagnostics = [];
    const {service} = harness({
      cnbcNewsResearch: {async researchNews() { return {ok: false, type}; }},
      onDiagnostics(value) { diagnostics.push(value); }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    assert.equal(validateClaudeAnalysisInput(output), true);
    assert.deepEqual(context.unresolvedGaps, [
      YAHOO_RECAP_UNAVAILABLE_GAP,
      CNBC_RECAP_UNAVAILABLE_GAP,
      CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP
    ]);
    assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false);
    assert.equal(diagnostics.some(item => item.failureType === type), true);
  }
});

test('CNBC integration diagnostics distinguish strict failure subtypes without changing package behavior', async () => {
  const cases = [
    {
      failureType: 'RESEARCH_NEWS_THROW',
      researchNews() { throw new Error('simulated research failure'); }
    },
    {
      failureType: 'INVALID_RESEARCH_RESULT',
      researchNews() { return null; }
    },
    {
      failureType: 'CANDIDATE_COVERAGE_MISMATCH',
      researchNews({horizons}) {
        const result = cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        return {...result, retrievedArticles: []};
      }
    },
    {
      failureType: 'CANDIDATE_REFERENCE_ORDERING_MISMATCH',
      researchNews({horizons}) {
        const result = cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        return {
          ...result,
          candidateCollection: {
            ...result.candidateCollection,
            candidates: [{...result.candidateCollection.candidates[0], reference: 'c2'}]
          }
        };
      }
    },
    {
      failureType: 'HORIZON_MISMATCH',
      researchNews({horizons}) {
        const result = cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        return {
          ...result,
          constructedEvidence: [{
            ...result.constructedEvidence[0],
            horizon: horizons.find(item => item.classification === 'SUBSEQUENT_DEVELOPMENT')
          }]
        };
      }
    },
    {
      failureType: 'CONSTRUCTED_EVIDENCE_MISMATCH',
      researchNews({horizons}) {
        const result = cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        const candidate = result.candidateCollection.candidates[0];
        return {
          ...result,
          constructedEvidence: [{
            ...result.constructedEvidence[0],
            evidenceItem: createEvidenceItem({
              sourceId: candidate.sourceId,
              market: candidate.market,
              evidenceCategory: candidate.evidenceCategory,
              title: candidate.title,
              summary: 'Different but otherwise canonical summary.',
              canonicalUrl: candidate.canonicalUrl,
              publishedAt: candidate.publishedAt,
              symbols: candidate.symbols
            })
          }]
        };
      }
    },
    {
      failureType: 'INTEGRATION_CONTRACT_MISMATCH',
      researchNews({horizons}) {
        const result = cnbcResearchSuccess(horizons, ['COMPLETED_SESSION']);
        const original = result.candidateCollection.candidates[0];
        const evidenceItem = createEvidenceItem({
          sourceId: 'us.reuters',
          market: 'US',
          evidenceCategory: 'news',
          title: original.title,
          summary: original.extract,
          canonicalUrl: original.canonicalUrl,
          publishedAt: original.publishedAt,
          symbols: original.symbols
        });
        const candidate = {
          ...original,
          sourceId: 'us.reuters',
          provenance: evidenceItem.provenance
        };
        return {
          ...result,
          candidateCollection: {...result.candidateCollection, candidates: [candidate]},
          constructedEvidence: [{...result.constructedEvidence[0], evidenceItem}]
        };
      }
    }
  ];

  for (const scenario of cases) {
    const diagnostics = [];
    const {service} = harness({
      cnbcNewsResearch: {researchNews: scenario.researchNews},
      onDiagnostics(value) { diagnostics.push(value); }
    });
    const output = await service.assemble(request());
    const context = output.marketPackages[0].evidenceContext;
    assert.equal(validateClaudeAnalysisInput(output), true, scenario.failureType);
    assert.equal(context.evidence.some(entry => entry.item.sourceId === 'us.cnbc'), false,
      scenario.failureType);
    assert.equal(context.unresolvedGaps.includes(CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP), true,
      scenario.failureType);
    assert.deepEqual(diagnostics.find(item => item.stage === 'cnbcNewsResearchIntegration'), {
      stage: 'cnbcNewsResearchIntegration',
      outcome: 'FAILURE',
      failureType: scenario.failureType
    });
  }
});

test('unavailable or inconsistent canonical benchmark boundaries degrade CNBC only', async () => {
  const oneSession = createFiveSessionSnapshot({
    market: 'US', symbol: '^RUT', instrumentName: 'benchmark', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED',
    completedSessions: [snapshot('^RUT').completedSessions[1]], currentOverlay: null
  });
  let researchCalls = 0;
  const diagnostics = [];
  const {service} = harness({
    createTelemetryAcquisition: () => ({async acquireSnapshot() { return oneSession; }}),
    cnbcNewsResearch: {async researchNews() { researchCalls++; }},
    onDiagnostics(value) { diagnostics.push(value); }
  });
  const output = await service.assemble(request());
  assert.equal(researchCalls, 0);
  assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
    YAHOO_RECAP_RETRIEVAL_FAILURE_GAP,
    CNBC_RECAP_UNAVAILABLE_GAP,
    CNBC_NEWS_RESEARCH_UNAVAILABLE_GAP
  ]);
  assert.deepEqual(diagnostics.find(item => item.stage === 'cnbcNewsResearchIntegration'), {
    stage: 'cnbcNewsResearchIntegration',
    outcome: 'FAILURE',
    failureType: 'MISSING_CANONICAL_HORIZONS'
  });
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('requires non-empty normalized US anchors without any backend symbol assumption', async () => {
  assert.deepEqual(ORCHESTRATION_REQUEST_KEYS, [
    'benchmarkAnchors', 'selectedScope', 'initiatingList', 'userTimezone', 'myStocks', 'watchlist'
  ]);
  assert.deepEqual(BENCHMARK_ANCHOR_KEYS, ['market', 'symbol']);
  for (const benchmarkAnchors of [[], [{market: 'SG', symbol: '^STI'}], [{market: 'US', symbol: '0700.HK'}]]) {
    const {service, calls} = harness();
    await assert.rejects(service.assemble(request('US', {benchmarkAnchors})), /benchmarkAnchors/);
    assert.deepEqual(calls.factories, []);
  }

  const {service, calls} = harness();
  const output = await service.assemble(request('US', {
    benchmarkAnchors: [{market: 'US', symbol: 'CUSTOM-BENCH'}]
  }));
  assert.deepEqual(calls.telemetry.map(entry => entry.symbol), ['CUSTOM-BENCH']);
  assert.deepEqual(output.marketPackages[0].telemetry.benchmarkSnapshots.map(entry => entry.snapshot.symbol), ['CUSTOM-BENCH']);
  assert.deepEqual(output.marketPackages[0].telemetry.stockSnapshots, []);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('continues with one deterministic unresolved gap when Federal Reserve acquisition fails', async () => {
  const {service} = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { throw new Error('unavailable'); }}
  });
  const output = await service.assemble(request());
  const context = output.marketPackages[0].evidenceContext;
  assert.deepEqual(context.evidence.map(item => item.item.sourceId), ['us.yahoo-finance']);
  assert.deepEqual(context.unresolvedGaps, [
    FEDERAL_RESERVE_UNAVAILABLE_GAP, YAHOO_RECAP_UNAVAILABLE_GAP, CNBC_RECAP_UNAVAILABLE_GAP
  ]);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

test('fails closed for future-dated Yahoo or Federal Reserve evidence', async () => {
  const future = '2026-09-07T10:00:00Z';
  const yahoo = harness({
    yahooEvidenceAcquisition: {async acquireEvidence({symbol}) { return yahooEvidence(symbol, future); }}
  }).service;
  await assert.rejects(yahoo.assemble(request()), /Future-dated evidence/);

  const fed = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return fedEvidence(future); }}
  }).service;
  await assert.rejects(fed.assemble(request()), /Future-dated evidence/);
});

test('uses acquisition start for research and final assembly time for strict future-evidence validation', async () => {
  const acquisitionStartedAt = '2026-09-06T10:00:00.000Z';
  const evidencePublishedAt = '2026-09-06T10:00:01.000Z';
  const finalGeneratedAt = '2026-09-06T10:00:02.000Z';
  const clock = [acquisitionStartedAt, finalGeneratedAt];
  const accepted = harness({
    now: () => new Date(clock.shift()),
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) { return yahooEvidence(symbol, evidencePublishedAt); }
    }
  });
  const output = await accepted.service.assemble(request());
  assert.equal(output.analysisRequest.generatedAt, finalGeneratedAt);
  assert.deepEqual(accepted.calls.factories, [acquisitionStartedAt]);
  assert.equal(output.marketPackages[0].evidenceContext.evidence[0].item.publishedAt, evidencePublishedAt);

  const boundaryClock = [acquisitionStartedAt, finalGeneratedAt];
  const boundary = harness({
    now: () => new Date(boundaryClock.shift()),
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) { return yahooEvidence(symbol, finalGeneratedAt); }
    }
  });
  assert.equal((await boundary.service.assemble(request())).analysisRequest.generatedAt, finalGeneratedAt);

  const diagnostics = [];
  const futureClock = [acquisitionStartedAt, finalGeneratedAt];
  const future = harness({
    now: () => new Date(futureClock.shift()),
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) { return yahooEvidence(symbol, '2026-09-06T10:00:03.000Z'); }
    },
    onDiagnostics(value) { diagnostics.push(value); }
  });
  await assert.rejects(future.service.assemble(request()), /Future-dated evidence/);
  assert.deepEqual(diagnostics.find(value => value.stage === 'analysisPackageAssemblyFailure'), {
    stage: 'analysisPackageAssemblyFailure',
    failureStage: 'FUTURE_DATED_EVIDENCE_VALIDATION'
  });
});

test('fails closed for required telemetry, persistence and Yahoo evidence failures', async () => {
  const telemetry = harness({
    createTelemetryAcquisition: () => ({async acquireSnapshot() { throw new Error('telemetry failed'); }})
  }).service;
  await assert.rejects(telemetry.assemble(request()), /telemetry failed/);

  const persistence = harness({
    snapshotPersistence: {async persistSnapshot() { throw new Error('persistence failed'); }}
  }).service;
  await assert.rejects(persistence.assemble(request()), /persistence failed/);

  const yahoo = harness({
    yahooEvidenceAcquisition: {async acquireEvidence() { throw new Error('Yahoo failed'); }}
  }).service;
  await assert.rejects(yahoo.assemble(request()), /Yahoo failed/);
});

test('rejects inconsistent persisted reconstruction and malformed provider material', async () => {
  const wrongPersistence = harness({
    snapshotPersistence: {async persistSnapshot() { return snapshot('WRONG'); }}
  }).service;
  await assert.rejects(wrongPersistence.assemble(request()), /Invalid canonical US snapshot/);

  const malformedFed = harness({
    federalReserveEvidenceAcquisition: {async acquireEvidence() { return null; }}
  });
  const output = await malformedFed.service.assemble(request());
  assert.deepEqual(output.marketPackages[0].evidenceContext.unresolvedGaps, [
    FEDERAL_RESERVE_UNAVAILABLE_GAP,
    YAHOO_RECAP_UNAVAILABLE_GAP,
    CNBC_RECAP_UNAVAILABLE_GAP
  ]);
});

test('returns immutable output without mutating membership or acquired canonical objects', async () => {
  const input = request('US', {
    myStocks: [{market: 'US', symbol: 'aapl'}],
    watchlist: [{market: 'US', symbol: 'msft'}]
  });
  const original = JSON.parse(JSON.stringify(input));
  const acquiredSnapshot = snapshot('^RUT');
  const acquiredEvidence = yahooEvidence('^RUT');
  const {service} = harness({
    createTelemetryAcquisition: () => ({
      async acquireSnapshot({symbol}) { return symbol === '^RUT' ? acquiredSnapshot : snapshot(symbol); }
    }),
    yahooEvidenceAcquisition: {
      async acquireEvidence({symbol}) { return symbol === '^RUT' ? acquiredEvidence : yahooEvidence(symbol); }
    }
  });
  const output = await service.assemble(input);
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.marketPackages), true);
  assert.equal(Object.isFrozen(output.portfolioContext.myStocks), true);
  assert.equal(Object.isFrozen(acquiredSnapshot), true);
  assert.equal(Object.isFrozen(acquiredEvidence), true);
  assert.equal(validateClaudeAnalysisInput(output), true);
});

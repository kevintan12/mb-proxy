// Step 9F.6a.3: the Yahoo news source for the shared source reader
// (lib/source-reader.js). It supplies only what is Yahoo's own: how the
// candidate list is found (the US and Singapore news listing pages) and how
// one article page is read. Everything else is the shared reader's.
'use strict';

const {AUDIT_FIELD_LIMITS, truncatedText} = require('../source-audit');

const YAHOO_NEWS_SOURCE_ID = 'us.yahoo-finance';

// The listing counts Yahoo reports, sanitised, in the order the reading summary
// has always logged them.
function yahooDiscoveryStats(result) {
  return {
    usNewsOutcome: truncatedText(result.usOutcome || 'NOT_CONFIGURED',
      AUDIT_FIELD_LIMITS.listingOutcomeCharacters, AUDIT_FIELD_LIMITS.listingOutcomeBytes),
    usNewsSectionCount: Number.isSafeInteger(result.usSectionCount) ? result.usSectionCount : 0,
    usNewsCandidateCount: Number.isSafeInteger(result.usCandidateCount) ? result.usCandidateCount : 0,
    singaporeNewsCandidateCount: Number.isSafeInteger(result.singaporeCandidateCount)
      ? result.singaporeCandidateCount : 0,
    crossEditionDuplicateCount: Number.isSafeInteger(result.crossEditionDuplicateCount)
      ? result.crossEditionDuplicateCount : 0
  };
}

function createYahooNewsSource({yahooLatestNewsDiscovery, yahooCurrentNewsArticleContentAcquisition}) {
  return Object.freeze({
    sourceId: YAHOO_NEWS_SOURCE_ID,
    async findCandidates() {
      let result;
      try {
        result = await yahooLatestNewsDiscovery.discoverLatestNews();
      } catch (error) {
        return {ok: false, candidates: [], discoveryStats: yahooDiscoveryStats({})};
      }
      const ok = result?.ok === true && Array.isArray(result.candidates);
      return {ok, candidates: ok ? result.candidates : [], discoveryStats: yahooDiscoveryStats(result || {})};
    },
    // The listing headline is passed on: Yahoo's page reader checks the page's
    // own headline against it.
    readPage(url, {headline} = {}) {
      return yahooCurrentNewsArticleContentAcquisition.acquireArticleContent({url, headline});
    }
  });
}

module.exports = {YAHOO_NEWS_SOURCE_ID, createYahooNewsSource};

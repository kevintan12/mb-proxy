const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS,
  createCnbcNewsResearchRuntime
} = require('../lib/cnbc-news-research-runtime');

const targetSessionDate = '2026-09-11';
const horizons = [{
  classification: 'COMPLETED_SESSION',
  startsAtExclusive: '2026-09-10T20:00:00.000Z',
  endsAtInclusive: '2026-09-11T20:00:00.000Z'
}, {
  classification: 'SUBSEQUENT_DEVELOPMENT',
  startsAtExclusive: '2026-09-11T20:00:00.000Z',
  endsAtInclusive: '2026-09-12T20:00:00.000Z'
}];
const urls = [
  'https://www.cnbc.com/2026/09/11/sector-leaders.html',
  'https://www.cnbc.com/2026/09/11/notable-movers.html'
];

function searchResponse() {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() {
      return {content: [{type: 'web_search_tool_result', content: urls.map((url, index) => ({
        type: 'web_search_result', title: `Search result ${index + 1}`, url,
        encrypted_content: 'never evidence'
      }))}], usage: {server_tool_use: {web_search_requests: 1}}};
    }
  };
}
function articleResponse(url, index) {
  const article = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: `Provider headline ${index + 1}`,
    datePublished: index === 0 ? '2026-09-11T19:00:00+0000' : '2026-09-11T20:30:00+0000',
    dateModified: index === 0 ? null : '2026-09-11T21:00:00+0000',
    articleBody: `Provider-owned market article ${index + 1}.`
  };
  const html = `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
  return {ok: true, status: 200, url, headers: {get: name => name === 'content-type' ? 'text/html' : null}, async text() { return html; }};
}

test('owns the unchanged deeply immutable production bounds', () => {
  assert.deepEqual(CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS, {
    candidateBounds: {maxCandidates: 20, maxTitleBytes: 512, maxSummaryBytes: 2048, maxExtractBytes: 2048, maxCollectionBytes: 32768},
    articleRetrievalBounds: {timeoutMs: 4000, maxResponseBytes: 1310720, maxArticleTextBytes: 8192, maxTitleBytes: 512, maxResultBytes: 12288},
    evidenceConstructionBounds: {maxEvidenceTextBytes: 8192, maxTitleBytes: 512, maxCollectionBytes: 65536}
  });
  assert.equal(Object.values(CNBC_US_NEWS_RESEARCH_PRODUCTION_BOUNDS).every(Object.isFrozen), true);
});

test('composes two bounded searches, one fetch per retained page, and no standalone materiality call', async () => {
  const calls = [];
  let anthropicCalls = 0;
  const service = createCnbcNewsResearchRuntime({
    apiKey: 'server-key',
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url === 'https://api.anthropic.com/v1/messages') {
        anthropicCalls++;
        return searchResponse();
      }
      return articleResponse(url, urls.indexOf(url));
    }
  });
  const result = await service.researchNews({targetSessionDate, horizons});
  assert.equal(result.ok, true);
  assert.equal(anthropicCalls, 2);
  assert.deepEqual(urls.map(url => calls.filter(value => value === url).length), [1, 1]);
  assert.deepEqual(result.candidateCollection.candidates.map(item => [item.reference, item.title]), [
    ['c1', 'Provider headline 1'], ['c2', 'Provider headline 2']
  ]);
  assert.deepEqual(result.retrievedArticles.map(item => item.reference), ['c1', 'c2']);
  assert.deepEqual(result.constructedEvidence.map(item => item.candidateReference), ['c1', 'c2']);
  assert.deepEqual(result.constructedEvidence.map(item => item.evidenceItem.summary), [
    'Provider-owned market article 1.', 'Provider-owned market article 2.'
  ]);
});

test('contains no RSS or duplicate selected-article retrieval production dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cnbc-news-research-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /cnbc-us-market-news-candidate-acquisition|selected-article-retrieval|Market Insider|RSS/i);
  assert.match(source, /claude-bounded-cnbc-market-news-discovery/);
  assert.match(source, /cnbc-search-news-candidate-acquisition/);
  assert.doesNotMatch(source, /claude-news-materiality-selection|invokeClaudeNewsMaterialitySelection/);
});

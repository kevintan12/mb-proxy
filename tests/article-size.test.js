// Step 9F.1f: the Yahoo article read size (news list and recap), the classifier's
// first 8 KB, the subject repair, and the shared writer budget search.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLASSIFIER_ARTICLE_BYTES,
  WRITER_ARTICLE_FLOOR_BYTES,
  yahooArticleBounds,
  firstBytes,
  classifierArticleText,
  fitArticlesToBudget
} = require('../lib/reading-window');
const {yahooRecapPackageBounds} = require('../lib/analysis-package-runtime');
const {
  createYahooCurrentNewsArticleContentAcquisitionService
} = require('../lib/yahoo-current-news-article-content-acquisition');
const {
  createYahooRecapArticleContentAcquisitionService
} = require('../lib/yahoo-recap-article-content-acquisition');
const {
  createYahooRecapEvidenceConstructionService
} = require('../lib/yahoo-recap-evidence-construction');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  buildClaudeEvidenceSubjectRepairRequest,
  createClaudeEvidenceRoleClassificationOutput,
  createClaudeEvidenceSubjectRepairOutput
} = require('../lib/claude-evidence-role-classification');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');

const KB = 1024;

function longText(seed, bytes) {
  let text = seed;
  let index = 0;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += ` Sentence ${++index} about rates and earnings.`;
  return text;
}

// News list stand-in page (same layout as the fetcher's own tests).
const newsUrl = 'https://finance.yahoo.com/news/long-market-story-120000123.html';
const newsHeadline = 'Long market story';
function newsPage(body) {
  const article = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: newsHeadline,
    url: newsUrl, mainEntityOfPage: {'@id': newsUrl}, publisher: {name: 'Yahoo Finance'},
    datePublished: '2026-09-20T12:00:00Z', articleBody: body
  };
  return `<html><head><link rel="canonical" href="${newsUrl}"><script type="application/ld+json">${JSON.stringify(article)}</script></head><body></body></html>`;
}
function htmlResponse(html, url) {
  return {
    ok: true, status: 200, url,
    headers: {get: name => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null},
    text: async () => html
  };
}

// Recap stand-in page.
const recapUrl = 'https://finance.yahoo.com/markets/live/stock-market-today-example.html';
function recapPage(body) {
  const article = {
    '@type': 'NewsArticle', headline: 'Stock market today: September 9 recap',
    datePublished: '2026-09-09T16:30:00-04:00', dateModified: '2026-09-09T17:00:00-04:00',
    mainEntityOfPage: {'@type': 'WebPage', '@id': recapUrl},
    publisher: {'@type': 'Organization', name: 'Yahoo Finance'}, articleBody: body
  };
  return `<link rel="canonical" href="${recapUrl}"><script type="application/ld+json">${JSON.stringify(article)}</script>`;
}
function recapInput(bounds) {
  return {
    discovery: Object.freeze({
      title: 'Stock market today: September 9 recap', url: recapUrl,
      discoveredVia: 'ANTHROPIC_WEB_SEARCH', targetSessionDate: '2026-09-09'
    }),
    validation: Object.freeze({
      headline: 'Stock market today: September 9 recap', url: recapUrl,
      datePublished: '2026-09-09T20:30:00.000Z', dateModified: '2026-09-09T21:00:00.000Z',
      targetSessionDate: '2026-09-09'
    }),
    bounds
  };
}

const SIZE_ROWS = [
  {value: 1, kb: 2},
  {value: 2, kb: 2},
  {value: 16, kb: 16},
  {value: 32, kb: 32},
  {value: 40, kb: 32}
];

for (const row of SIZE_ROWS) {
  test(`Step 9F.1f article size ${row.value} KB reads ${row.kb} KB in the news list and the recap`, async () => {
    const env = {ARTICLE_KB: String(row.value)};
    const max = row.kb * KB;
    assert.deepEqual({...yahooArticleBounds({env})},
      {maxArticleTextBytes: max, maxResultBytes: max + 4 * KB});
    const recapBounds = yahooRecapPackageBounds(env);
    assert.equal(recapBounds.articleContentBounds.maxArticleTextBytes, max);
    assert.equal(recapBounds.articleContentBounds.maxResultBytes, max + 4 * KB);
    assert.equal(recapBounds.evidenceConstructionBounds.maxEvidenceTextBytes, max);
    assert.equal(recapBounds.evidenceConstructionBounds.maxResultBytes, max + 4 * KB);

    const full = longText('Stocks rose as investors weighed the outlook.', 40 * KB);

    const news = await createYahooCurrentNewsArticleContentAcquisitionService({
      fetchImpl: async () => htmlResponse(newsPage(full), newsUrl),
      ...yahooArticleBounds({env})
    }).acquireArticleContent({url: newsUrl, headline: newsHeadline});
    assert.equal(news.type, 'SUCCESS');
    assert.equal(news.articleContent.articleText, firstBytes(full, max));
    assert.equal(full.startsWith(news.articleContent.articleText), true);
    assert.ok(Buffer.byteLength(news.articleContent.articleText, 'utf8') <= max);
    assert.ok(Buffer.byteLength(news.articleContent.articleText, 'utf8') > max - 64);

    const recap = await createYahooRecapArticleContentAcquisitionService({
      fetchImpl: async () => htmlResponse(recapPage(full), recapUrl)
    }).acquireArticleContent(recapInput(recapBounds.articleContentBounds));
    assert.equal(recap.type, 'SUCCESS');
    assert.equal(recap.articleContent.articleText, firstBytes(full, max));
    assert.ok(Buffer.byteLength(JSON.stringify(recap.articleContent), 'utf8')
      <= recapBounds.articleContentBounds.maxResultBytes);
    // The stored evidence cap matches, so the cut recap is accepted whole.
    const constructed = createYahooRecapEvidenceConstructionService({
      evidenceConstructionBounds: recapBounds.evidenceConstructionBounds
    }).constructEvidence({articleContent: recap.articleContent, horizon: Object.freeze({
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-09T20:00:00.000Z',
      endsAtInclusive: '2026-09-10T12:00:00.000Z'
    })});
    assert.equal(constructed.type, 'SUCCESS', constructed.message);
    assert.equal(constructed.constructedEvidence.evidenceItem.summary, recap.articleContent.articleText);
  });
}

test('Step 9F.1f an article within the size is read unchanged (the old text is a prefix of the new)', async () => {
  const text = longText('Short story.', 6 * KB);
  const result = await createYahooCurrentNewsArticleContentAcquisitionService({
    fetchImpl: async () => htmlResponse(newsPage(text), newsUrl)
  }).acquireArticleContent({url: newsUrl, headline: newsHeadline});
  assert.equal(result.articleContent.articleText, text);
});

test('Step 9F.1f the cut never splits a character and leaves no trailing space', () => {
  assert.equal(firstBytes('abc', 10), 'abc');
  assert.equal(firstBytes(null, 10), null);
  assert.equal(firstBytes('ab cd', 3), 'ab');
  const accented = 'é'.repeat(10); // 2 bytes each
  assert.equal(firstBytes(accented, 5), 'éé');
  const emoji = `a${'😀'.repeat(3)}`; // 1 + 4 bytes each
  assert.equal(firstBytes(emoji, 6), 'a😀');
  assert.equal(firstBytes(emoji, 4), 'a');
  for (let bytes = 0; bytes <= 13; bytes++) {
    const cut = firstBytes(emoji, bytes);
    assert.equal(emoji.startsWith(cut), true);
    assert.equal(cut.includes('�'), false);
  }
});

function classifierSnapshot() {
  return createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED',
    completedSessions: [createCompletedRegularSession({
      market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
      close: 104, previousClose: 100, volume: 1000000,
      asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    })],
    currentOverlay: null
  });
}

function yahooItem(summary, index = 1) {
  return createEvidenceItem({
    sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news',
    title: `Yahoo story ${index}`, summary,
    canonicalUrl: `https://finance.yahoo.com/news/yahoo-story-${index}.html`,
    publishedAt: '2026-09-11T19:30:00Z', symbols: [], publisher: 'Yahoo Finance'
  });
}

function classifierInput(items) {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: classifierSnapshot()}],
    evidence: items.map((item, index) => ({
      reference: `e${index + 1}`, horizon: 'COMPLETED_SESSION',
      requiresBroadMarketSubjects: true, item
    }))
  };
}

// A 16 KB article: Microsoft in the first 8 KB, Nvidia only after it.
const SIXTEEN_KB_ARTICLE = `${longText('Microsoft shares rose on cloud demand.', 9 * KB)} Nvidia shares fell. ${longText('More text.', 6 * KB)}`
  .slice(0, 16 * KB).trim();

test('Step 9F.1f the classifier receives only the first 8 KB of a 16 KB article, identical to sending that 8 KB', () => {
  assert.equal(CLASSIFIER_ARTICLE_BYTES, 8 * KB);
  assert.ok(Buffer.byteLength(SIXTEEN_KB_ARTICLE, 'utf8') > 15 * KB);
  const fromFull = buildClaudeEvidenceRoleClassificationRequest(classifierInput([yahooItem(SIXTEEN_KB_ARTICLE)]));
  const first8 = classifierArticleText(SIXTEEN_KB_ARTICLE);
  const fromCut = buildClaudeEvidenceRoleClassificationRequest(classifierInput([yahooItem(first8)]));
  assert.deepEqual(fromFull, fromCut);
  const sent = JSON.parse(fromFull.messages[0].content).evidence[0].item.summary;
  assert.equal(sent, first8);
  assert.ok(Buffer.byteLength(sent, 'utf8') <= 8 * KB);
  assert.equal(SIXTEEN_KB_ARTICLE.startsWith(sent), true);
  assert.equal(sent.includes('Nvidia'), false);
});

test('Step 9F.1f a classifier subject is grounded only in the first 8 KB it was shown', () => {
  const input = classifierInput([yahooItem(SIXTEEN_KB_ARTICLE)]);
  const output = createClaudeEvidenceRoleClassificationOutput({classifications: [{
    reference: 'e1', materiality: 'HIGH', roles: ['MATERIAL_EVENT'],
    subjects: [{kind: 'COMPANY', name: 'Microsoft'}, {kind: 'COMPANY', name: 'Nvidia'}]
  }]}, input);
  assert.deepEqual(output.classifications[0].subjects, [{kind: 'COMPANY', name: 'Microsoft'}]);
});

test('Step 9F.1f the subject repair accepts a 16 KB article, sends its first 8 KB and grounds only there', () => {
  const repairInput = {evidence: [{reference: 'e1', title: 'Yahoo story 1', summary: SIXTEEN_KB_ARTICLE}]};
  const request = buildClaudeEvidenceSubjectRepairRequest(repairInput);
  const sent = JSON.parse(request.messages[0].content).evidence[0].summary;
  assert.equal(sent, classifierArticleText(SIXTEEN_KB_ARTICLE));
  const output = createClaudeEvidenceSubjectRepairOutput({repairs: [{
    reference: 'e1',
    subjects: [{kind: 'COMPANY', name: 'Microsoft'}, {kind: 'COMPANY', name: 'Nvidia'}]
  }]}, repairInput);
  assert.deepEqual(output.repairs[0].subjects, [{kind: 'COMPANY', name: 'Microsoft'}]);
});

// The shared budget search, with a stand-in size: 1000 bytes plus the texts.
function standInMeasure(texts) {
  return 1000 + [...texts.values()].reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
}
const textOf = bytes => 'x'.repeat(bytes);

const BUDGET_ROWS = [
  {name: 'fits: nothing trimmed', lengths: [9000, 5000], cap: 20000, fits: true, level: null, after: [9000, 5000]},
  {name: 'longest only', lengths: [16000, 6000, 3000], cap: 1000 + 6000 + 3000 + 8000, fits: true, level: 8000, after: [8000, 6000, 3000]},
  {name: 'longest two to a common length', lengths: [16000, 12000, 3000], cap: 1000 + 3000 + 2 * 7000, fits: true, level: 7000, after: [7000, 7000, 3000]},
  {name: 'stops at the 4 KB floor exactly', lengths: [16000, 12000], cap: 1000 + 2 * 4096, fits: true, level: 4096, after: [4096, 4096]},
  {name: 'does not fit at the floor: flagged, nothing dropped', lengths: [16000, 12000, 3000], cap: 5000, fits: false, level: 0, after: [4096, 4096, 3000]},
  {name: 'a grounding minimum above the floor is kept', lengths: [16000, 16000], minimums: [10000, 0], cap: 1000 + 10000 + 4096, fits: true, after: [10000, 4096]}
];

for (const row of BUDGET_ROWS) {
  test(`Step 9F.1f writer budget search: ${row.name}`, () => {
    const articles = row.lengths.map((bytes, index) => ({
      key: `k${index}`, text: textOf(bytes), minBytes: row.minimums ? row.minimums[index] : 0
    }));
    const fit = fitArticlesToBudget({articles, measure: standInMeasure, capBytes: row.cap});
    assert.equal(fit.fits, row.fits);
    if ('level' in row) assert.equal(fit.levelBytes, row.level);
    assert.deepEqual(articles.map(article => fit.texts.get(article.key).length), row.after);
    assert.equal(fit.texts.size, articles.length);
    assert.equal(fit.requestBytesBefore, standInMeasure(new Map(articles.map(a => [a.key, a.text]))));
    assert.equal(fit.requestBytesAfter, standInMeasure(fit.texts));
    if (row.fits) assert.ok(fit.requestBytesAfter <= row.cap);
    assert.deepEqual(fit.trimmed.map(entry => entry.key),
      articles.filter((article, index) => row.after[index] < row.lengths[index]).map(article => article.key));
  });
}

test('Step 9F.1f writer budget floor is 4 KB', () => {
  assert.equal(WRITER_ARTICLE_FLOOR_BYTES, 4 * KB);
});

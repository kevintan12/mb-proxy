// 9AV Build 4: closes the proof gaps found in Proof Group C. Tests only; no lib file and no setting changes.
//   1a  Yahoo Finance named, no Yahoo item cited in that section: the phrase is dropped.
//   1c  a Yahoo market-data item (registry publisher "Yahoo") counts as Yahoo Finance: sentence kept.
//   6   the source check does not run on the code-built Section 4 table; one source line per section.
//   16  a bare weekday exactly three days before or after the report date resolves to the right week.
//   7   source check versus the 9AT time cleanup order: both on, one sentence with a time and a source.
// Free tests only: made-up text, fake fetch, no paid call. Wiring helpers copied from the 9AV Build 1 and
// 9AT Build 2 wiring tests (those files are left untouched).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {findEventDayClaims, sameEventDayConflicts} = require('../lib/report-accuracy-source');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createClaudeAnalysisInput} = require('../lib/claude-analysis-contract');
const {anthropicResponse, marketStateCase, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['SOURCE_MATCHES_ARTICLE_ENABLED', 'SAME_EVENT_DAY_CHECK_ENABLED', 'CLOSE_MARKER_ORDER_ENABLED',
  'TIME_MATCHES_ARTICLE_ENABLED'];
const COVERED = [0, 1, 2, 4, 5, 6];
const COMPLETED = MARKET_STATE_CASES.filter(row => !row[2]);

async function runWith(env, input, makeFetch) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  const diagnostics = [];
  let calls = 0;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => { calls++; return makeFetch(); },
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, calls, diagnostics,
      source: diagnostics.filter(d => d.violationCategory === 'SOURCE_ARTICLE_MISMATCH'),
      time: diagnostics.filter(d => d.violationCategory === 'TIME_ARTICLE_MISMATCH')};
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

const run = (env, input, output) => runWith(env, input, () => anthropicResponse(output));

function citedText(input, section) {
  const items = new Map(input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.evidence.map(entry => [entry.reference, entry.item])));
  return section.evidenceRefs.map(reference => {
    const item = items.get(reference);
    return `${item?.provenance?.publisher ?? ''} ${item?.title ?? ''} ${item?.summary ?? ''}`;
  }).join(' ');
}

function plant(output, sentence, indexes = COVERED) {
  const planted = structuredClone(output);
  for (const index of indexes) planted.sections[index].content = `${planted.sections[index].content} ${sentence}`;
  return planted;
}

// ---------------------------------------------------------------------------
// 1a: the Yahoo Finance rule. Kept only when a cited article in that section carries it.
// ---------------------------------------------------------------------------
test('9AV Build 4 (1a): Yahoo Finance is named but no Yahoo article is cited in that section: the phrase is dropped', async () => {
  const wrong = 'Yahoo Finance reported that futures were steady.';
  const fixed = 'Futures were steady.';
  let dropped = 0;
  let kept = 0;
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const planted = plant(output, wrong);
    const on = await run({}, input, planted);
    const off = await run({SOURCE_MATCHES_ARTICLE_ENABLED: 'off'}, input, planted);
    assert.equal(on.result.ok, true, state);
    assert.equal(on.calls, 1, state);
    for (const index of COVERED) {
      const offText = off.result.output.sections[index].content;
      assert.ok(offText.endsWith(` ${wrong}`), `${state} off, section ${index + 1}`);
      const carried = /Yahoo Finance/.test(citedText(input, output.sections[index]));
      if (carried) {
        // A cited Yahoo article carries the name: the sentence is kept as written.
        assert.equal(on.result.output.sections[index].content, offText, `${state} section ${index + 1} kept`);
        kept++;
      } else {
        assert.equal(on.result.output.sections[index].content, offText.replace(wrong, fixed),
          `${state} section ${index + 1} dropped`);
        dropped++;
      }
    }
  }
  // Both outcomes are reached: the completed days cite no Yahoo article in Sections 1 to 3, 5 and 6.
  assert.ok(dropped >= 15, `dropped ${dropped}`);
  assert.ok(kept >= 1, `kept ${kept}`);
});

// ---------------------------------------------------------------------------
// A compact completed-day input with a Yahoo market-data item (publisher "Yahoo"), a Reuters-published
// article, and a Thomson Reuters stock in My Stocks (for the Section 4 table). Copied from the 9AT
// completed-day input; extra items go after the six base items so e1 to e6 keep their references.
// ---------------------------------------------------------------------------
const COMPLETED_TIMES = {
  CLOSED: '2026-09-04T22:00:00.000Z', WEEKEND: '2026-09-06T10:00:00.000Z', HOLIDAY: '2026-09-07T16:00:00.000Z'
};
const MD_TITLE = 'Index quote record for the completed session';
const RT_TITLE = 'Oil prices fall 2% on supply worries';

function snapshotFor(symbol, name, marketState, instrumentType = 'INDEX') {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: name, instrumentType, currency: 'USD', marketState, currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) => createCompletedRegularSession({
      market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2, close, previousClose,
      volume: 1000 + index, asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance',
      validationState: 'VALIDATED'
    }))
  });
}

function newsItem(sourceId, title, canonicalUrl, publishedAt, evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title, summary: `${title} supplies bounded factual context.`,
    canonicalUrl, publishedAt, symbols: [], ...(sourceId === 'us.yahoo-finance' ? {publisher: 'Yahoo Finance'} : {})
  });
}

function completedInput(marketState) {
  const evidence = [
    newsItem('us.yahoo-finance', 'Stock market today: stocks close higher',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html', '2026-09-04T21:00:00Z'),
    newsItem('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/04/stock-market-today-live-updates.html', '2026-09-04T19:30:00Z'),
    newsItem('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm', '2026-09-04T18:00:00Z',
      'monetary-policy'),
    newsItem('us.cnbc', 'Broadcom leads semiconductor shares after a major company development',
      'https://www.cnbc.com/2026/09/04/broadcom-semiconductor-leadership.html', '2026-09-04T19:00:00Z'),
    newsItem('us.yahoo-finance', 'Netflix gives a weaker fourth-quarter forecast and its shares fall 6% late',
      'https://finance.yahoo.com/news/netflix-forecast-example.html', '2026-09-04T20:30:00Z'),
    newsItem('us.yahoo-finance', 'Treasury yields edge up in evening trading',
      'https://finance.yahoo.com/news/treasury-yields-example.html', '2026-09-04T21:15:00Z'),
    // A Yahoo market-data item: no editorial publisher, so its publisher is the registry's "Yahoo".
    createEvidenceItem({
      sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'market-data', title: MD_TITLE,
      summary: 'Closing levels for the major indexes in the completed session.',
      canonicalUrl: 'https://finance.yahoo.com/quote/%5EGSPC/', publishedAt: '2026-09-04T20:10:00Z', symbols: []
    }),
    createEvidenceItem({
      sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news', title: RT_TITLE,
      summary: 'Brent crude fell 2% to $78 a barrel.', canonicalUrl: 'https://finance.yahoo.com/news/oil-pool-1.html',
      publishedAt: '2026-09-04T18:30:00Z', symbols: [], publisher: 'Reuters'
    })
  ];
  return createClaudeAnalysisInput({
    analysisRequest: {selectedScope: 'US', initiatingList: 'myStocks', generatedAt: COMPLETED_TIMES[marketState],
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'},
    marketPackages: [{
      market: 'US',
      marketContext: {exchangeTimezone: 'America/New_York', marketState, primaryCompletedSessionDate: '2026-09-04',
        includesCurrentOverlay: false, calendarContext: 'Canonical US regular-session calendar.'},
      telemetry: {benchmarkSnapshots: [snapshotFor('^GSPC', '^GSPC instrument', marketState)],
        stockSnapshots: [snapshotFor('MSFT', 'Microsoft', marketState, 'EQUITY'),
          snapshotFor('TRI', 'Thomson Reuters', marketState, 'EQUITY')]},
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5', 'e7', 'e8'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4', 'e7', 'e8'], supportingEvidence: ['e2', 'e3', 'e4', 'e7', 'e8'],
        conflictingEvidence: [], subsequentDevelopments: ['e1', 'e5', 'e6'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [{evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          {evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Netflix'}]}],
        unresolvedGaps: [],
        furtherReadings: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}, {evidenceRef: 'e2', sessionDate: '2026-09-04'}],
        sinceCloseDevelopments: ['e5', 'e6']
      }
    }],
    portfolioContext: {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2', 'e8'], upcomingEvents: []},
        {market: 'US', symbol: 'TRI', telemetryRefs: ['t3'], evidenceRefs: [], upcomingEvents: []}],
      watchlist: []
    }
  });
}

function referenceOf(input, title) {
  const entry = input.marketPackages[0].evidenceContext.evidence.find(candidate => candidate.item.title === title);
  assert.ok(entry, title);
  return entry.reference;
}

// One writer reply for the completed-day input above. `extra[n]` is added to the section n (1 to 7) text and
// `cite[n]` adds references to that section.
function completedTransport(input, extra = {}, cite = {}) {
  const base = [
    ['Stocks closed higher on Friday.', ['e2', 'e3'], ['t1']],
    ['Federal Reserve policy context shaped the completed session.', ['e2', 'e3'], []],
    ['Broadcom led semiconductor shares in the session.', ['e4'], []],
    [null, [], []],
    ['Policy expectations framed the completed session.', ['e3'], []],
    ['Policy uncertainty remains a risk for stocks.', ['e3'], []],
    ['Investors will watch the next Federal Reserve communication.', ['e3'], []]
  ];
  const transport = {status: 'NORMAL', evidenceGaps: []};
  base.forEach(([content, refs, telemetry], position) => {
    const number = position + 1;
    const text = extra[number] ? (content ? `${content} ${extra[number]}` : extra[number]) : content;
    const references = number === 4 && extra[4] ? ['e2'] : [...refs];
    for (const title of cite[number] || []) references.push(referenceOf(input, title));
    transport[`s${number}`] = {content: text, evidenceRefs: references.join('|'),
      telemetryRefs: telemetry.join('|'), uncertainties: ''};
  });
  transport.s8 = {};
  return transport;
}

const fakeEnvelope = transport => () => {
  const envelope = {id: 'planted', content: [{type: 'text', text: JSON.stringify(transport)}],
    usage: {input_tokens: 1, output_tokens: 1}};
  return {ok: true, status: 200, headers: {get: () => null}, clone() { return this; },
    text: async () => JSON.stringify(envelope), json: async () => envelope};
};

// ---------------------------------------------------------------------------
// 1c: a Yahoo market-data item (publisher "Yahoo") counts as Yahoo Finance.
// ---------------------------------------------------------------------------
test('9AV Build 4 (1c): a cited Yahoo market-data item (publisher "Yahoo") counts as Yahoo Finance: sentence kept unchanged', async () => {
  const sentence = 'Yahoo Finance reported that futures were steady.';
  for (const marketState of Object.keys(COMPLETED_TIMES)) {
    const input = completedInput(marketState);
    const marketData = input.marketPackages[0].evidenceContext.evidence
      .find(entry => entry.item.title === MD_TITLE).item;
    assert.equal(marketData.provenance.publisher, 'Yahoo', marketState);
    assert.ok(!/Yahoo Finance/.test(`${marketData.title} ${marketData.summary}`), marketState);
    // Section 6 cites e3 (Federal Reserve) only: with the market-data item added it is kept; without, dropped.
    const withItem = completedTransport(input, {6: sentence}, {6: [MD_TITLE]});
    const without = completedTransport(input, {6: sentence});
    const keptRun = await runWith({}, input, fakeEnvelope(withItem));
    const droppedRun = await runWith({}, input, fakeEnvelope(without));
    const offRun = await runWith({SOURCE_MATCHES_ARTICLE_ENABLED: 'off'}, input, fakeEnvelope(withItem));
    assert.equal(keptRun.result.ok, true, marketState);
    assert.equal(keptRun.calls, 1, marketState);
    assert.equal(keptRun.result.output.sections[5].content, offRun.result.output.sections[5].content, marketState);
    assert.ok(keptRun.result.output.sections[5].content.endsWith(` ${sentence}`), marketState);
    assert.ok(!keptRun.source.some(event => event.sectionIndex === 5), `${marketState}: no source line`);
    // Control: without the market-data item the same sentence loses its source phrase.
    assert.ok(droppedRun.result.output.sections[5].content.endsWith(' Futures were steady.'), marketState);
    assert.ok(droppedRun.source.some(event => event.sectionIndex === 5 && event.droppedSourceCount === 1), marketState);
  }
});

// ---------------------------------------------------------------------------
// 6: the source check does not run on the code-built Section 4 table; one source line per section.
// ---------------------------------------------------------------------------
test('9AV Build 4 (6): the Section 4 table is never source-checked: "Thomson Reuters | TRI" stays, one source line per section', async () => {
  const cases = [
    // Reuters is carried by the cited article: nothing dropped, no Section 4 source line.
    {name: 'carried', sentence: 'Reuters reported that Microsoft raised its cloud outlook.', cite: [RT_TITLE], dropped: 0},
    // Reuters is not carried: the writer's sentence loses its phrase, once, and the table is not touched.
    {name: 'uncarried', sentence: 'Reuters reported that Microsoft raised its cloud outlook.', cite: [], dropped: 1}
  ];
  for (const marketState of Object.keys(COMPLETED_TIMES)) {
    for (const {name, sentence, cite, dropped} of cases) {
      const input = completedInput(marketState);
      const transport = completedTransport(input, {4: sentence, 1: 'Reuters reported that stocks rose.'}, {4: cite});
      const on = await runWith({}, input, fakeEnvelope(transport));
      const label = `${marketState} ${name}`;
      assert.equal(on.result.ok, true, label);
      assert.equal(on.calls, 1, label);
      const table = on.result.output.sections[3].content;
      assert.match(table, /Thomson Reuters/, `${label}: the table row keeps its name`);
      assert.match(table, /TRI/, label);
      assert.doesNotMatch(table, /\bThomson\b(?! Reuters)/, label);
      // One source-check line per section, never two.
      const perSection = new Map();
      for (const event of on.source) perSection.set(event.sectionIndex, (perSection.get(event.sectionIndex) || 0) + 1);
      for (const [index, count] of perSection) assert.equal(count, 1, `${label}: section ${index + 1} has ${count} lines`);
      assert.equal(perSection.get(0), 1, `${label}: the Section 1 control sentence is logged once`);
      const sectionFour = on.source.filter(event => event.sectionIndex === 3);
      if (dropped === 0) assert.equal(sectionFour.length, 0, label);
      else assert.deepEqual(sectionFour.map(event => [event.droppedSourceCount, event.presenceMismatchCount]), [[1, 1]], label);
      assert.ok(!on.source.some(event => /Thomson|bTRIb/.test(JSON.stringify(event))), label);
    }
  }
});

// ---------------------------------------------------------------------------
// 16: a bare weekday exactly three days either way of the report date resolves to the near week.
// ---------------------------------------------------------------------------
test('9AV Build 4 (16): a bare weekday three days away resolves to the nearer week for the same-day check', () => {
  const subjects = ['Klarna'];
  const claimDate = (sentence, reportDate) => {
    const claims = findEventDayClaims(sentence, {subjects, reportDate});
    assert.equal(claims.length, 1, sentence);
    return claims[0].date;
  };
  // Monday 7 Sep 2026 naming "Thursday": Thursday 10 Sep, three days ahead (not Thursday 3 Sep, four days back).
  assert.equal(claimDate('The Klarna debut came on Thursday.', '2026-09-07'), '2026-09-10');
  // Thursday 10 Sep 2026 naming "Monday": Monday 7 Sep, three days back (not Monday 14 Sep, four days ahead).
  assert.equal(claimDate('The Klarna debut came on Monday.', '2026-09-10'), '2026-09-07');
  // So a bare weekday and the same date in full are one day, and no conflict is made.
  const conflicts = (reportDate, first, second) => sameEventDayConflicts([
    {sectionIndex: 0, ...findEventDayClaims(first, {subjects, reportDate})[0]},
    {sectionIndex: 4, ...findEventDayClaims(second, {subjects, reportDate})[0]}]);
  assert.deepEqual(conflicts('2026-09-07', 'The Klarna debut came on Thursday.', 'The Klarna debut came on September 10.'), []);
  assert.deepEqual(conflicts('2026-09-10', 'The Klarna debut came on Monday.', 'The Klarna debut came on September 7.'), []);
  // The other week is still a different day.
  assert.equal(conflicts('2026-09-07', 'The Klarna debut came on Thursday.', 'The Klarna debut came on September 3.').length, 1);
  // Four days away takes the other side: Monday report, "Friday" is the Friday just gone.
  assert.equal(claimDate('The Klarna debut came on Friday.', '2026-09-07'), '2026-09-04');
  assert.equal(claimDate('The Klarna debut came on Friday.', '2026-09-10'), '2026-09-11');
});

// ---------------------------------------------------------------------------
// 7: source check versus the 9AT time cleanup: the time check runs first, so the source phrase is then
// at the start of the sentence and the source check can take it off. Run the other way round, the source
// phrase sits behind "At 3:17 am ET," (a form the source check leaves alone) and survives.
// ---------------------------------------------------------------------------
test('9AV Build 4 (7): a sentence with an ET time and an uncarried source: both on gives the bare sentence in all six states', async () => {
  const wrong = 'At 3:17 am ET, Reuters reported that futures were steady.';
  const timeOnly = 'Reuters reported that futures were steady.';
  const both = 'Futures were steady.';
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    for (const index of COVERED) assert.ok(!/Reuters/.test(citedText(input, output.sections[index])), state);
    const planted = plant(output, wrong);
    const bothOn = await run({}, input, planted);
    const timeOnlyRun = await run({SOURCE_MATCHES_ARTICLE_ENABLED: 'off'}, input, planted);
    const sourceOnlyRun = await run({TIME_MATCHES_ARTICLE_ENABLED: 'off'}, input, planted);
    const bothOff = await run({SOURCE_MATCHES_ARTICLE_ENABLED: 'off', TIME_MATCHES_ARTICLE_ENABLED: 'off'}, input, planted);
    for (const run_ of [bothOn, timeOnlyRun, sourceOnlyRun, bothOff]) {
      assert.equal(run_.result.ok, true, state);
      assert.equal(run_.calls, 1, state);
    }
    for (const index of COVERED) {
      const at = `${state} section ${index + 1}`;
      const offText = bothOff.result.output.sections[index].content;
      assert.ok(offText.endsWith(` ${wrong}`), at);
      assert.equal(timeOnlyRun.result.output.sections[index].content, offText.replace(wrong, timeOnly), at);
      assert.equal(sourceOnlyRun.result.output.sections[index].content, offText, `${at}: source check alone leaves it`);
      assert.equal(bothOn.result.output.sections[index].content, offText.replace(wrong, both), `${at}: both on`);
    }
    assert.deepEqual(bothOn.time.map(event => [event.sectionIndex, event.droppedTimeCount]).sort(),
      COVERED.map(index => [index, 1]), state);
    assert.deepEqual(bothOn.source.map(event => [event.sectionIndex, event.droppedSourceCount]).sort(),
      COVERED.map(index => [index, 1]), state);
    assert.ok(!/Reuters|futures/.test(JSON.stringify([bothOn.time, bothOn.source])), state);
  }
});

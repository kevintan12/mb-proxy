// Step 9AT Build 2: the time-matches-article check (lib/report-accuracy-time.js) runs in the report
// cleanup right after the Step 9AP weekday check, behind timeMatchesArticleEnabled. Only the time
// phrase is dropped, never the sentence; a right time whose source no cited article names is logged
// only. Free tests only: made-up text, fake fetch, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {exchangeTimeLabel} = require('../lib/us-active-session-evidence');
const {anthropicResponse, marketStateCase, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');

const ENV = 'TIME_MATCHES_ARTICLE_ENABLED';
const COVERED = [0, 1, 2, 4, 5, 6];
const WRONG = 'At 3:17 am ET, Reuters reported that futures were steady.';
const WRONG_FIXED = 'Reuters reported that futures were steady.';

async function run(env, input, output) {
  const diagnostics = [];
  let calls = 0;
  const saved = process.env[ENV];
  if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => { calls++; return anthropicResponse(output); },
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, calls, events: diagnostics.filter(value => value.violationCategory === 'TIME_ARTICLE_MISMATCH')};
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
}

function evidenceItems(input) {
  return new Map(input.marketPackages.flatMap(marketPackage =>
    marketPackage.evidenceContext.evidence.map(entry => [entry.reference, entry.item])));
}

function plant(output, sentenceFor) {
  const planted = structuredClone(output);
  for (const index of COVERED) {
    const section = planted.sections[index];
    section.content = `${section.content} ${sentenceFor(section, index)}`;
  }
  return planted;
}

test('Step 9AT Build 2: the registry row (Admin boolean, on by default, env TIME_MATCHES_ARTICLE_ENABLED)', () => {
  const entry = SETTINGS_REGISTRY.timeMatchesArticleEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('timeMatchesArticleEnabled', {env: {}}), true);
  assert.equal(settingValue('timeMatchesArticleEnabled', {env: {[ENV]: 'off'}}), false);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('timeMatchesArticleEnabled'), names.indexOf('sectionFourBigMoverPercent') + 1);
});

test('Step 9AT Build 2: switch on, all six states, Sections 1 to 7: only the time phrase goes, TRIMMED count-only events', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const items = evidenceItems(input);
    for (const index of COVERED) {
      for (const reference of output.sections[index].evidenceRefs) {
        assert.ok(!String(exchangeTimeLabel(items.get(reference)?.publishedAt)).includes('3:17 am'), state);
      }
    }
    const planted = plant(output, () => WRONG);
    const on = await run(undefined, input, planted);
    assert.equal(on.result.ok, true, state);
    assert.equal(on.calls, 1, `${state}: no retry`);
    for (const index of COVERED) {
      const text = on.result.output.sections[index].content;
      assert.ok(text.endsWith(` ${WRONG_FIXED}`), `${state} section ${index + 1}: ${text}`);
      assert.ok(!text.includes('3:17'), `${state} section ${index + 1}: ${text}`);
    }
    assert.deepEqual(on.events.map(event => event.sectionIndex).sort(), COVERED, state);
    for (const event of on.events) {
      assert.equal(event.action, 'TRIMMED', state);
      assert.equal(event.droppedTimeCount, 1, state);
      assert.equal(event.shortenedSentenceCount, 1, state);
      assert.equal(event.timeMismatchCount, 1, state);
      assert.equal(event.sourceUnsupportedCount, 0, state);
      assert.equal(event.removedSentenceCount, 0, state);
      assert.ok(!/3:17|Reuters|futures/.test(JSON.stringify(event)), `event carries text in ${state}`);
    }

    const off = await run('off', input, planted);
    assert.equal(off.result.ok, true, state);
    assert.equal(off.calls, 1, state);
    assert.equal(on.result.output.status, off.result.output.status, `${state}: a dropped time must not degrade the report`);
    for (const index of COVERED) {
      const offText = off.result.output.sections[index].content;
      assert.ok(offText.endsWith(` ${WRONG}`), `${state} off, section ${index + 1}`);
      // Every other character is the same with the switch on.
      assert.equal(on.result.output.sections[index].content, offText.replace(WRONG, WRONG_FIXED), state);
    }
    assert.deepEqual(off.events, [], state);
    // Nothing outside the shortened sentences differs.
    const restore = structuredClone(on.result.output);
    for (const index of COVERED) restore.sections[index].content = off.result.output.sections[index].content;
    assert.deepEqual(restore, off.result.output, state);
  }
});

test('Step 9AT Build 2: switch off is identical to no step at all (no time claims, and planted claims)', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    // A report with no time claim: on and off give the same result and no event.
    const cleanOn = await run(undefined, input, output);
    const cleanOff = await run('off', input, output);
    assert.deepEqual(cleanOn.result, cleanOff.result, state);
    assert.deepEqual(cleanOn.events, [], state);
    // Off keeps a wrong time exactly as written (other steps may add text in front, e.g. the
    // completed-day since-close line in Section 1).
    const planted = plant(output, () => WRONG);
    const off = await run('false', input, planted);
    for (const index of COVERED) {
      assert.ok(off.result.output.sections[index].content.endsWith(planted.sections[index].content),
        `${state} section ${index + 1}`);
    }
    assert.deepEqual(off.events, [], state);
  }
});

test('Step 9AT Build 2: a right time whose source no cited article names is log only (no text change)', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const items = evidenceItems(input);
    const sentenceFor = section => {
      const item = items.get(section.evidenceRefs[0]);
      const label = exchangeTimeLabel(item.publishedAt);
      const time = label.slice(label.indexOf(', ') + 2);
      for (const reference of section.evidenceRefs) {
        const cited = items.get(reference);
        assert.ok(!/Financial Times/.test(`${cited?.provenance?.publisher} ${cited?.title} ${cited?.summary}`), state);
      }
      return `At ${time}, the Financial Times reported that futures were steady.`;
    };
    const planted = plant(output, sentenceFor);
    const on = await run(undefined, input, planted);
    const off = await run('off', input, planted);
    assert.equal(on.result.ok, true, state);
    assert.deepEqual(on.result, off.result, `${state}: log only changes no text`);
    assert.equal(on.calls, 1, state);
    assert.deepEqual(on.events.map(event => event.sectionIndex).sort(), COVERED, state);
    for (const event of on.events) {
      assert.equal(event.action, 'TRIMMED', state);
      assert.equal(event.droppedTimeCount, 0, state);
      assert.equal(event.shortenedSentenceCount, 0, state);
      assert.equal(event.sourceUnsupportedCount, 1, state);
      assert.ok(!/Financial Times|futures/.test(JSON.stringify(event)), `event carries text in ${state}`);
    }
    assert.deepEqual(off.events, [], state);
  }
});

test('Step 9AT Build 2: a time that matches a cited article from the named source passes untouched', async () => {
  // The active fixtures' e1 is a Yahoo Finance article (publisher Yahoo Finance).
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES.filter(row => row[2])) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const label = exchangeTimeLabel(evidenceItems(input).get('e1').publishedAt);
    const time = label.slice(label.indexOf(', ') + 2);
    const planted = structuredClone(output);
    planted.sections[1].content += ` At ${time}, Yahoo Finance reported that Microsoft raised its outlook.`;
    const on = await run(undefined, input, planted);
    const off = await run('off', input, planted);
    assert.deepEqual(on.result, off.result, state);
    assert.deepEqual(on.events, [], state);
  }
});

// ---------------------------------------------------------------------------
// Option B (Kevin, 14 Nov 2026): on a completed day with the Step 9V since-close cleanup on, a time that
// is a since-close article's publish time is left for Step 9V, which removes the whole Section 2
// sentence. Dropping only the time first would hide it from Step 9V and keep post-close news in Key
// Market Drivers. A compact copy of the completed-day input in tests/completed-since-close.test.js.
// ---------------------------------------------------------------------------
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createClaudeAnalysisInput} = require('../lib/claude-analysis-contract');

const SINCE_CLOSE_ENV = 'COMPLETED_SINCE_CLOSE_ENABLED';
const COMPLETED_TIMES = {
  CLOSED: '2026-09-04T22:00:00.000Z', WEEKEND: '2026-09-06T10:00:00.000Z', HOLIDAY: '2026-09-07T16:00:00.000Z'
};

function completedSnapshot(symbol, marketState, instrumentType = 'INDEX') {
  const facts = [['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`, instrumentType, currency: 'USD', marketState,
    currentOverlay: null,
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

// e5 Netflix (Fri 4 Sep, 4:30 pm ET) and e6 Treasury yields (5:15 pm ET) are after the close.
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
      'https://finance.yahoo.com/news/treasury-yields-example.html', '2026-09-04T21:15:00Z')
  ];
  return createClaudeAnalysisInput({
    analysisRequest: {selectedScope: 'US', initiatingList: 'myStocks', generatedAt: COMPLETED_TIMES[marketState],
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'},
    marketPackages: [{
      market: 'US',
      marketContext: {exchangeTimezone: 'America/New_York', marketState, primaryCompletedSessionDate: '2026-09-04',
        includesCurrentOverlay: false, calendarContext: 'Canonical US regular-session calendar.'},
      telemetry: {benchmarkSnapshots: [completedSnapshot('^GSPC', marketState)],
        stockSnapshots: [completedSnapshot('MSFT', marketState, 'EQUITY')]},
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', 'e5'], authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'], supportingEvidence: ['e2', 'e3', 'e4'], conflictingEvidence: [],
        subsequentDevelopments: ['e1', 'e5', 'e6'],
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [{evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          {evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Netflix'}]}],
        unresolvedGaps: [],
        furtherReadings: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}, {evidenceRef: 'e2', sessionDate: '2026-09-04'}],
        sinceCloseDevelopments: ['e5', 'e6']
      }
    }],
    portfolioContext: {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2'], upcomingEvents: []}],
      watchlist: []
    }
  });
}

const EMPTY_SLOT = {content: null, evidenceRefs: '', telemetryRefs: '', uncertainties: ''};
const SECTION_TWO = 'Federal Reserve policy context shaped the completed session. At 4:30 pm ET, Yahoo Finance '
  + 'reported that Netflix gave a weaker forecast.';

function sectionTwoTransport() {
  return {
    status: 'DEGRADED', evidenceGaps: ['Not enough data to cover every part of this report.'],
    s1: {content: 'Stocks closed higher on Friday.', evidenceRefs: 'e2|e3|e6', telemetryRefs: 't1', uncertainties: ''},
    s2: {content: SECTION_TWO, evidenceRefs: 'e2|e3', telemetryRefs: '', uncertainties: ''},
    s3: {content: 'Broadcom led semiconductor shares in the session.', evidenceRefs: 'e4|e5', telemetryRefs: '',
      uncertainties: ''},
    s4: {...EMPTY_SLOT}, s5: {...EMPTY_SLOT}, s6: {...EMPTY_SLOT}, s7: {...EMPTY_SLOT}, s8: {}
  };
}

async function runCompleted(env, input) {
  const saved = {[ENV]: process.env[ENV], [SINCE_CLOSE_ENV]: process.env[SINCE_CLOSE_ENV]};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const diagnostics = [];
  try {
    const envelope = {id: 'planted', content: [{type: 'text', text: JSON.stringify(sectionTwoTransport())}],
      usage: {input_tokens: 1, output_tokens: 1}};
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'planted-no-network', onDiagnostics: value => diagnostics.push(value),
      fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => null}, clone() { return this; },
        text: async () => JSON.stringify(envelope), json: async () => envelope})
    });
    return {result, diagnostics, events: diagnostics.filter(d => d.violationCategory === 'TIME_ARTICLE_MISMATCH')};
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('Step 9AT Build 2 (option B): a since-close time in Section 2 is left for Step 9V, which removes the sentence', async () => {
  for (const marketState of Object.keys(COMPLETED_TIMES)) {
    const input = completedInput(marketState);
    const on = await runCompleted({[ENV]: undefined, [SINCE_CLOSE_ENV]: 'on'}, input);
    const off = await runCompleted({[ENV]: 'off', [SINCE_CLOSE_ENV]: 'on'}, input);
    assert.equal(on.result.ok, true, marketState);
    assert.equal(on.result.output.sections[1].content, 'Federal Reserve policy context shaped the completed session.',
      marketState);
    assert.deepEqual(on.result, off.result, `${marketState}: the time check changes nothing here`);
    assert.deepEqual(on.events, [], marketState);
    assert.ok(on.diagnostics.some(d => d.stage === 'completedSinceCloseCleanup'
      && d.violationCategory === 'SINCE_CLOSE_SECTION_TWO' && d.removedSentenceCount === 1), marketState);
  }
});

test('Step 9AT Build 2 (option B): with Step 9V off, the same time is checked and only the phrase goes', async () => {
  for (const marketState of Object.keys(COMPLETED_TIMES)) {
    const {result, events} = await runCompleted({[ENV]: undefined, [SINCE_CLOSE_ENV]: 'off'},
      completedInput(marketState));
    assert.equal(result.ok, true, marketState);
    assert.equal(result.output.sections[1].content, 'Federal Reserve policy context shaped the completed session. '
      + 'Yahoo Finance reported that Netflix gave a weaker forecast.', marketState);
    assert.deepEqual(events.map(event => [event.sectionIndex, event.droppedTimeCount, event.timeMismatchCount]),
      [[1, 1, 1]], marketState);
  }
});

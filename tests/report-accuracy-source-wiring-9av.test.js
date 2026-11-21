// 9AV Build 1: the close-marker reorder (C) and the source-name check (A) run in the report cleanup right
// after the 9AT time check, before the up/down word check; the same-event-day count (B) is read once on
// the finished report. Three Admin switches, default on. Free tests only: made-up text, fake fetch.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  anthropicResponse, marketStateCase, MARKET_STATE_CASES, ACTIVE_MARKET_STATES
} = require('./fixtures/market-state-cases');

const SOURCE_ENV = 'SOURCE_MATCHES_ARTICLE_ENABLED';
const DAY_ENV = 'SAME_EVENT_DAY_CHECK_ENABLED';
const ORDER_ENV = 'CLOSE_MARKER_ORDER_ENABLED';
const ALL_OFF = {[SOURCE_ENV]: 'off', [DAY_ENV]: 'off', [ORDER_ENV]: 'off'};
const ALL_ON = {[SOURCE_ENV]: undefined, [DAY_ENV]: undefined, [ORDER_ENV]: undefined};
const COVERED = [0, 1, 2, 4, 5, 6];
const NEW_CATEGORIES = ['SOURCE_ARTICLE_MISMATCH', 'CLOSE_MARKER_ORDER'];

async function run(env, input, output) {
  const names = [SOURCE_ENV, DAY_ENV, ORDER_ENV];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  const diagnostics = [];
  let calls = 0;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => { calls++; return anthropicResponse(output); },
      onDiagnostics: value => diagnostics.push(value)
    });
    return {
      result, calls, diagnostics,
      source: diagnostics.filter(d => d.violationCategory === 'SOURCE_ARTICLE_MISMATCH'),
      order: diagnostics.filter(d => d.violationCategory === 'CLOSE_MARKER_ORDER'),
      sameDay: diagnostics.filter(d => d.stage === 'sameEventDayResidue')
    };
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

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

test('9AV Build 1: the three registry rows (Admin booleans, on by default), placed after timeMatchesArticleEnabled', () => {
  const rows = [['sourceMatchesArticleEnabled', SOURCE_ENV], ['sameEventDayCheckEnabled', DAY_ENV],
    ['closeMarkerOrderEnabled', ORDER_ENV]];
  const names = Object.keys(SETTINGS_REGISTRY);
  rows.forEach(([name, env], offset) => {
    const entry = SETTINGS_REGISTRY[name];
    assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean], [true, 'Admin', env, true, true]);
    assert.equal(settingValue(name, {env: {}}), true);
    assert.equal(settingValue(name, {env: {[env]: 'off'}}), false);
    assert.equal(names.indexOf(name), names.indexOf('timeMatchesArticleEnabled') + 1 + offset);
  });
});

test('9AV Build 1 (A1): all six states, Sections 1 to 7: an uncarried source loses only its phrase', async () => {
  const wrong = 'Reuters reported that futures were steady.';
  const fixed = 'Futures were steady.';
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    for (const index of COVERED) assert.ok(!/Reuters/.test(citedText(input, output.sections[index])), state);
    const planted = plant(output, wrong);
    const on = await run(ALL_ON, input, planted);
    const off = await run(ALL_OFF, input, planted);
    assert.equal(on.result.ok, true, state);
    assert.equal(on.calls, 1, `${state}: no retry`);
    assert.equal(off.calls, 1, state);
    assert.equal(on.result.output.status, off.result.output.status, `${state}: a dropped source must not degrade`);
    for (const index of COVERED) {
      const offText = off.result.output.sections[index].content;
      assert.ok(offText.endsWith(` ${wrong}`), `${state} off, section ${index + 1}`);
      assert.equal(on.result.output.sections[index].content, offText.replace(wrong, fixed), `${state} section ${index + 1}`);
    }
    assert.deepEqual(on.source.map(event => event.sectionIndex).sort(), COVERED, state);
    for (const event of on.source) {
      assert.equal(event.action, 'TRIMMED', state);
      assert.deepEqual([event.droppedSourceCount, event.presenceMismatchCount, event.shortenedSentenceCount,
        event.removedSentenceCount, event.unrecognisedFormCount, event.causalGuardCount], [1, 1, 1, 0, 0, 0], state);
      assert.ok(!/Reuters|futures/.test(JSON.stringify(event)), `event carries text in ${state}`);
    }
    // Nothing outside the shortened sentences differs.
    const restore = structuredClone(on.result.output);
    for (const index of COVERED) restore.sections[index].content = off.result.output.sections[index].content;
    assert.deepEqual(restore, off.result.output, state);
    for (const category of NEW_CATEGORIES) assert.ok(!off.diagnostics.some(d => d.violationCategory === category), state);
  }
});

test('9AV Build 1: all switches off is the same as no step at all (clean reports and planted wording)', async () => {
  const planted = 'At the close on Tuesday, Reuters reported that futures were steady. A Reuters article said bonds rose.';
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    // A report with no source name: on and off give the same result and no new event.
    const cleanOn = await run(ALL_ON, input, output);
    const cleanOff = await run(ALL_OFF, input, output);
    assert.deepEqual(cleanOn.result, cleanOff.result, state);
    assert.deepEqual([cleanOn.source, cleanOn.order, cleanOn.sameDay], [[], [], []], state);
    // Off keeps the planted wording exactly as written and logs nothing new.
    const plantedOutput = plant(output, planted);
    const off = await run(ALL_OFF, input, plantedOutput);
    for (const index of COVERED) {
      assert.ok(off.result.output.sections[index].content.endsWith(plantedOutput.sections[index].content),
        `${state} section ${index + 1}`);
    }
    assert.deepEqual([off.source, off.order, off.sameDay], [[], [], []], state);
  }
});

test('9AV Build 1 (C then A1): the close marker is reordered first, then the uncarried source phrase goes', async () => {
  const wrong = 'At the close on Tuesday, Reuters reported that futures were steady.';
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const planted = plant(output, wrong);
    const both = await run(ALL_ON, input, planted);
    const orderOnly = await run({...ALL_ON, [SOURCE_ENV]: 'off'}, input, planted);
    const sourceOnly = await run({...ALL_ON, [ORDER_ENV]: 'off'}, input, planted);
    for (const index of COVERED) {
      assert.ok(both.result.output.sections[index].content.endsWith(' At the close on Tuesday, futures were steady.'),
        `${state} section ${index + 1}`);
      assert.ok(orderOnly.result.output.sections[index].content
        .endsWith(' Reuters reported that at the close on Tuesday, futures were steady.'), `${state} section ${index + 1}`);
      // Without the reorder the source phrase is not at the sentence start: kept and counted.
      assert.ok(sourceOnly.result.output.sections[index].content.endsWith(` ${wrong}`), `${state} section ${index + 1}`);
    }
    assert.deepEqual(both.order.map(event => [event.sectionIndex, event.reorderedSentenceCount, event.action]).sort(),
      COVERED.map(index => [index, 1, 'TRIMMED']), state);
    assert.ok(sourceOnly.source.every(event => event.unrecognisedFormCount === 1 && event.droppedSourceCount === 0), state);
    assert.equal(both.calls, 1, state);
    for (const event of both.order) assert.ok(!/Reuters|Tuesday|futures/.test(JSON.stringify(event)), state);
  }
});

test('9AV Build 1 (A1): a carried source and an unknown form are left as written', async () => {
  // The active fixtures' e1 is a Yahoo Finance article cited in Section 2.
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES.filter(row => row[2])) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    assert.ok(/Yahoo/.test(citedText(input, output.sections[1])), state);
    const planted = structuredClone(output);
    planted.sections[1].content += ' Yahoo Finance reported that Microsoft raised its outlook.';
    const on = await run(ALL_ON, input, planted);
    const off = await run(ALL_OFF, input, planted);
    assert.deepEqual(on.result, off.result, state);
    assert.ok(!on.source.some(event => event.sectionIndex === 1), state);

    const unknown = plant(output, 'A Reuters article said futures were steady.');
    const onUnknown = await run(ALL_ON, input, unknown);
    const offUnknown = await run(ALL_OFF, input, unknown);
    assert.deepEqual(onUnknown.result, offUnknown.result, `${state}: an unknown form changes no text`);
    for (const event of onUnknown.source) {
      assert.deepEqual([event.droppedSourceCount, event.presenceMismatchCount, event.unrecognisedFormCount], [0, 1, 1], state);
    }
  }
});

test('9AV Build 1 (A1): a drop that would newly trip the direct-cause check is not made (counted)', async () => {
  // Without the inline phrase "sent" and "stocks lower" fall within the cause check's reach.
  const sentence = "Tariff news sent the Treasury yield curve sharply steeper again, from CNBC's live blog coverage, and stocks lower.";
  const {hasActiveDirectMarketCausalClaim} = require('../lib/claude-analysis-contract');
  assert.equal(hasActiveDirectMarketCausalClaim(sentence), false);
  assert.equal(hasActiveDirectMarketCausalClaim(sentence.replace(", from CNBC's live blog coverage, ", ' ')), true);
  let guarded = 0;
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const index = 5;
    if (/CNBC/.test(citedText(input, output.sections[index]))) continue;
    const planted = plant(output, sentence, [index]);
    const on = await run(ALL_ON, input, planted);
    const off = await run(ALL_OFF, input, planted);
    assert.equal(on.result.output.sections[index].content, off.result.output.sections[index].content, state);
    const event = on.source.find(entry => entry.sectionIndex === index);
    if (off.result.output.sections[index].content.includes(sentence)) {
      assert.deepEqual([event.causalGuardCount, event.droppedSourceCount, event.shortenedSentenceCount], [1, 0, 0], state);
      guarded++;
    }
    assert.equal(on.calls, off.calls, state);
  }
  assert.ok(guarded >= 1, 'the guard was reached in at least one state');
});

// As in the 9AT Section 4 test: the fixture's lists are empty, so the fixed Section 4 text replaces the
// writer's text after the cleanup; the event shows the writer sentence was checked.
test('9AV Build 1 (A1): writer sentences in Section 4 are checked (active states)', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES.filter(([s]) => ACTIVE_MARKET_STATES.has(s))) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    assert.ok(!/Reuters/.test(citedText(input, output.sections[3])), state);
    const planted = plant(output, 'Reuters reported that Microsoft shares were steady.', [3]);
    const on = await run(ALL_ON, input, planted);
    const off = await run(ALL_OFF, input, planted);
    assert.equal(on.result.ok, true, state);
    const event = on.source.find(entry => entry.sectionIndex === 3);
    assert.deepEqual([event.droppedSourceCount, event.presenceMismatchCount, event.action], [1, 1, 'TRIMMED'], state);
    assert.deepEqual(off.source, [], state);
    assert.deepEqual(on.result.output.sections[3], off.result.output.sections[3], state);
  }
});

test('9AV Build 1 (B): two sections giving one event two days: one counts-only log line, no text change', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const planted = structuredClone(output);
    // "today" / "tomorrow": a bare weekday would be cut first by the live-day date checks.
    planted.sections[0].content += ' The CPI report is due today.';
    planted.sections[6].content += ' The CPI report is due tomorrow.';
    const on = await run(ALL_ON, input, planted);
    const off = await run({...ALL_ON, [DAY_ENV]: 'off'}, input, planted);
    assert.deepEqual(on.result, off.result, `${state}: log only`);
    assert.equal(on.calls, 1, state);
    assert.equal(on.sameDay.length, 1, state);
    assert.deepEqual({...on.sameDay[0]}, {stage: 'sameEventDayResidue', marketState: state, conflictCount: 1,
      conflicts: [{eventClass: 'release', sectionIndexes: [0, 6]}]}, state);
    assert.ok(!/CPI|today|tomorrow/.test(JSON.stringify(on.sameDay)), state);
    assert.deepEqual(off.sameDay, [], state);
    // Same day in both sections: no line.
    const agree = structuredClone(output);
    agree.sections[0].content += ' The CPI report is due tomorrow.';
    agree.sections[6].content += ' The CPI report is due tomorrow.';
    assert.deepEqual((await run(ALL_ON, input, agree)).sameDay, [], state);
  }
});

// ---------------------------------------------------------------------------
// 9V interplay (as 9AT option B): on a completed day with the since-close cleanup on, a Section 2
// sentence about a since-close article is still removed whole by the since-close cleanup, whether or
// not the source check dropped its source phrase first. Copies the 9AT completed-day input.
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
const KEPT = 'Federal Reserve policy context shaped the completed session.';

async function runCompleted(env, input, sectionTwo) {
  const names = [SOURCE_ENV, ORDER_ENV, SINCE_CLOSE_ENV];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  const transport = {
    status: 'DEGRADED', evidenceGaps: ['Not enough data to cover every part of this report.'],
    s1: {content: 'Stocks closed higher on Friday.', evidenceRefs: 'e2|e3|e6', telemetryRefs: 't1', uncertainties: ''},
    s2: {content: `${KEPT} ${sectionTwo}`, evidenceRefs: 'e2|e3', telemetryRefs: '', uncertainties: ''},
    s3: {content: 'Broadcom led semiconductor shares in the session.', evidenceRefs: 'e4|e5', telemetryRefs: '',
      uncertainties: ''},
    s4: {...EMPTY_SLOT}, s5: {...EMPTY_SLOT}, s6: {...EMPTY_SLOT}, s7: {...EMPTY_SLOT}, s8: {}
  };
  const diagnostics = [];
  try {
    const envelope = {id: 'planted', content: [{type: 'text', text: JSON.stringify(transport)}],
      usage: {input_tokens: 1, output_tokens: 1}};
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'planted-no-network', onDiagnostics: value => diagnostics.push(value),
      fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => null}, clone() { return this; },
        text: async () => JSON.stringify(envelope), json: async () => envelope})
    });
    return {result, diagnostics};
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

test('9AV Build 1 (9V interplay): a since-close Section 2 sentence is still removed whole by the since-close cleanup', async () => {
  const sentences = [
    'Reuters reported that Netflix gave a weaker forecast at 4:30 pm ET.',
    'At the close on Friday, Reuters reported that Netflix gave a weaker forecast at 4:30 pm ET.'
  ];
  for (const marketState of Object.keys(COMPLETED_TIMES)) {
    const input = completedInput(marketState);
    for (const sentence of sentences) {
      const on = await runCompleted({[SOURCE_ENV]: undefined, [ORDER_ENV]: undefined, [SINCE_CLOSE_ENV]: 'on'}, input, sentence);
      const off = await runCompleted({[SOURCE_ENV]: 'off', [ORDER_ENV]: 'off', [SINCE_CLOSE_ENV]: 'on'}, input, sentence);
      assert.equal(on.result.ok, true, marketState);
      assert.equal(on.result.output.sections[1].content, KEPT, `${marketState}: ${sentence}`);
      assert.equal(off.result.output.sections[1].content, KEPT, `${marketState}: ${sentence}`);
      assert.ok(on.diagnostics.some(d => d.stage === 'completedSinceCloseCleanup'
        && d.violationCategory === 'SINCE_CLOSE_SECTION_TWO' && d.removedSentenceCount === 1), marketState);
    }
  }
});

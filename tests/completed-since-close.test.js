// Step 9V: Closed, Weekend and Holiday "since the close" paragraphs (switch
// completedSinceCloseEnabled, default on). Free tests only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {withEnv} = require('./fixtures/step-8w-switches');
const {MARKET_STATE_CASES, activeUsInput} = require('./fixtures/market-state-cases');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {createClaudeAnalysisInput, REPORT_SECTION_NAMES} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  completedSessionCloseAt,
  completedSinceLastCloseContext
} = require('../lib/us-active-session-evidence');
const {
  sinceCloseRepeatCut,
  sinceCloseTimePattern,
  sinceCloseFigures,
  sinceCloseNoNewsSentence
} = require('../lib/section-rules');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {splitReportSentences} = require('../lib/claude-analysis-contract');

const ENV = 'COMPLETED_SINCE_CLOSE_ENABLED';
const on = fn => withEnv(ENV, 'on', fn);
const off = fn => withEnv(ENV, 'off', fn);

const COMPLETED_TIMES = {
  CLOSED: '2026-09-04T22:00:00.000Z', // Fri 4 Sep, 6:00 pm ET
  WEEKEND: '2026-09-06T10:00:00.000Z', // Sun 6 Sep
  HOLIDAY: '2026-09-07T16:00:00.000Z' // Labor Day, Mon 7 Sep
};

function snapshot(symbol, marketState, instrumentType = 'INDEX') {
  const facts = [
    ['2026-08-31', 100, 99], ['2026-09-01', 101, 100], ['2026-09-02', 99, 101],
    ['2026-09-03', 102, 99], ['2026-09-04', 105, 102]
  ];
  return createFiveSessionSnapshot({
    market: 'US', symbol, instrumentName: `${symbol} instrument`, instrumentType,
    currency: 'USD', marketState, currentOverlay: null,
    completedSessions: facts.map(([sessionDate, close, previousClose], index) =>
      createCompletedRegularSession({
        market: 'US', sessionDate, open: close - 1, high: close + 2, low: close - 2,
        close, previousClose, volume: 1000 + index,
        asOf: `${sessionDate}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
      }))
  });
}

function item(sourceId, title, canonicalUrl, publishedAt, evidenceCategory = 'news') {
  return createEvidenceItem({
    sourceId, market: 'US', evidenceCategory, title,
    summary: `${title} supplies bounded factual context.`, canonicalUrl, publishedAt, symbols: [],
    ...(sourceId === 'us.yahoo-finance' ? {publisher: 'Yahoo Finance'} : {})
  });
}

// e1 Yahoo recap (after the close, session-associated), e2 CNBC completed-session news,
// e3 Federal Reserve, e4 Broadcom (focus, completed session), e5 Netflix (after the close,
// focus -> home Section 3), e6 Treasury yields (after the close, not focus -> home Section 1).
function completedInput({marketState = 'CLOSED', withList = true, afterClose = true} = {}) {
  const evidence = [
    item('us.yahoo-finance', 'Stock market today: stocks close higher',
      'https://finance.yahoo.com/markets/live/stock-market-today-example.html', '2026-09-04T21:00:00Z'),
    item('us.cnbc', 'Stock market news for Sept. 4, 2026',
      'https://www.cnbc.com/2026/09/04/stock-market-today-live-updates.html', '2026-09-04T19:30:00Z'),
    item('us.federal-reserve', 'Federal Reserve policy context',
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm',
      '2026-09-04T18:00:00Z', 'monetary-policy'),
    item('us.cnbc', 'Broadcom leads semiconductor shares after a major company development',
      'https://www.cnbc.com/2026/09/04/broadcom-semiconductor-leadership.html', '2026-09-04T19:00:00Z'),
    ...(afterClose ? [
      item('us.yahoo-finance', 'Netflix gives a weaker fourth-quarter forecast and its shares fall 6% late',
        'https://finance.yahoo.com/news/netflix-forecast-example.html', '2026-09-04T20:30:00Z'),
      item('us.yahoo-finance', 'Treasury yields edge up in evening trading',
        'https://finance.yahoo.com/news/treasury-yields-example.html', '2026-09-04T21:15:00Z')
    ] : [])
  ];
  const subsequent = afterClose ? ['e1', 'e5', 'e6'] : ['e1'];
  return createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'US', initiatingList: 'myStocks', generatedAt: COMPLETED_TIMES[marketState],
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'US',
      marketContext: {
        exchangeTimezone: 'America/New_York', marketState,
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Canonical US regular-session calendar.'
      },
      telemetry: {benchmarkSnapshots: [snapshot('^GSPC', marketState)],
        stockSnapshots: [snapshot('MSFT', marketState, 'EQUITY')]},
      evidenceCollection: createEvidenceCollection({market: 'US', items: evidence}),
      evidenceContext: {
        materialEvents: ['e1', 'e2', 'e3', 'e4', ...(afterClose ? ['e5'] : [])],
        authoritativeFacts: ['e3'],
        principalCatalysts: ['e2', 'e3', 'e4'],
        supportingEvidence: ['e2', 'e3', 'e4'],
        conflictingEvidence: [],
        subsequentDevelopments: subsequent,
        sessionAssociations: [{evidenceRef: 'e1', sessionDate: '2026-09-04'}],
        broadMarketFocus: [
          {evidenceRef: 'e4', subjects: [{kind: 'COMPANY', name: 'Broadcom'}]},
          ...(afterClose ? [{evidenceRef: 'e5', subjects: [{kind: 'COMPANY', name: 'Netflix'}]}] : [])
        ],
        unresolvedGaps: [],
        furtherReadings: [{evidenceRef: 'e1', sessionDate: '2026-09-04'},
          {evidenceRef: 'e2', sessionDate: '2026-09-04'}],
        ...(withList ? {sinceCloseDevelopments: afterClose ? ['e5', 'e6'] : []} : {})
      }
    }],
    portfolioContext: {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2'], upcomingEvents: []}],
      watchlist: []
    }
  });
}

function userContent(request) {
  return JSON.parse(request.messages[0].content);
}

// --- switch -----------------------------------------------------------------

test('Step 9V: completedSinceCloseEnabled is a registered Admin on/off setting, on by default', () => {
  const entry = SETTINGS_REGISTRY.completedSinceCloseEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('completedSinceCloseEnabled', {env: {}}), true);
  assert.equal(settingValue('completedSinceCloseEnabled', {env: {[ENV]: 'false'}}), false);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('completedSinceCloseEnabled'), names.indexOf('sinceCloseLeadEnabled') + 1);
});

// --- the close and the context ---------------------------------------------

test('Step 9V: the close is the calendar close of the completed session; holidays and unsupported early closes give none', () => {
  assert.equal(completedSessionCloseAt('2026-09-04'), '2026-09-04T20:00:00.000Z'); // 4:00 pm EDT
  assert.equal(completedSessionCloseAt('2026-11-30'), '2026-11-30T21:00:00.000Z'); // 4:00 pm EST
  assert.equal(completedSessionCloseAt('2026-09-07'), null); // Labor Day
  assert.equal(completedSessionCloseAt('2026-09-05'), null); // Saturday
  // The calendar marks early-close days as unsupported, so no since-close part is built.
  assert.equal(completedSessionCloseAt('2026-11-27'), null);
  assert.equal(completedSessionCloseAt('not-a-date'), null);
});

for (const marketState of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
  test(`Step 9V: ${marketState} lists the after-close news, never the recap, with one home section each`, () => {
    const [context] = completedSinceLastCloseContext(completedInput({marketState}));
    assert.equal(context.mode, 'COMPLETED');
    assert.equal(context.marketState, marketState);
    assert.equal(context.refsSource, 'package');
    assert.equal(context.lastCloseAt, '2026-09-04T20:00:00.000Z');
    assert.equal(context.lastCloseEt, 'Fri 4 Sep, 4:00 pm ET');
    assert.deepEqual(context.evidenceRefs, ['e5', 'e6']);
    assert.deepEqual(context.homes.map(home => [home.evidenceRef, home.sectionIndex, home.subjects]),
      [['e5', 2, ['Netflix']], ['e6', 0, []]]);
  });
}

test('Step 9V: the close matches the after-close horizon instant the package already uses', () => {
  const input = completedInput();
  const asOf = input.marketPackages[0].telemetry.benchmarkSnapshots[0].snapshot.completedSessions.at(-1).asOf;
  assert.equal(Date.parse(completedSinceLastCloseContext(input)[0].lastCloseAt), Date.parse(asOf));
});

test('Step 9V: a package saved before Step 9V falls back to the non-associated after-close news and says so', () => {
  const [context] = completedSinceLastCloseContext(completedInput({withList: false}));
  assert.equal(context.refsSource, 'fallback');
  assert.deepEqual(context.evidenceRefs, ['e5', 'e6']);
});

test('Step 9V: active states and non-US inputs get no completed context', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES.slice(0, 3)) {
    assert.deepEqual(completedSinceLastCloseContext(
      activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt})), [], marketState);
  }
  assert.deepEqual(completedSinceLastCloseContext(null), []);
});

// --- contract --------------------------------------------------------------

test('Step 9V: the contract accepts the optional list only as a subset of subsequentDevelopments', () => {
  assert.deepEqual(completedInput().marketPackages[0].evidenceContext.sinceCloseDevelopments, ['e5', 'e6']);
  assert.equal(Object.hasOwn(completedInput({withList: false}).marketPackages[0].evidenceContext,
    'sinceCloseDevelopments'), false);
  const raw = completedInput();
  assert.throws(() => createClaudeAnalysisInput({
    analysisRequest: {...raw.analysisRequest, reportType: undefined, ...{reportType: 'MARKET_BRIEF'}},
    marketPackages: [{
      market: 'US', marketContext: raw.marketPackages[0].marketContext,
      telemetry: {benchmarkSnapshots: raw.marketPackages[0].telemetry.benchmarkSnapshots.map(e => e.snapshot),
        stockSnapshots: raw.marketPackages[0].telemetry.stockSnapshots.map(e => e.snapshot)},
      evidenceCollection: createEvidenceCollection({market: 'US',
        items: raw.marketPackages[0].evidenceContext.evidence.map(e => e.item)}),
      evidenceContext: {...Object.fromEntries(Object.entries(raw.marketPackages[0].evidenceContext)
        .filter(([key]) => key !== 'evidence')), sinceCloseDevelopments: ['e2']}
    }],
    portfolioContext: {
      myStocks: [{market: 'US', symbol: 'MSFT', telemetryRefs: ['t2'], evidenceRefs: ['e2'], upcomingEvents: []}],
      watchlist: []
    }
  }), TypeError);
});

// --- writer request --------------------------------------------------------

test('Step 9V: switch on, the completed request marks each item with its time and home and adds the paragraphs instruction', () => on(() => {
  const request = buildClaudeAnalysisRequest(completedInput());
  const user = userContent(request);
  assert.deepEqual(user.sinceLastClose, [{
    market: 'US', marketState: 'CLOSED', mode: 'COMPLETED', lastCloseEt: 'Fri 4 Sep, 4:00 pm ET',
    reportTimeEt: 'Fri 4 Sep, 6:00 pm ET', evidenceRefs: ['e5', 'e6'],
    homeSections: [{evidenceRef: 'e5', section: 3}, {evidenceRef: 'e6', section: 1}]
  }]);
  const byRef = new Map(user.marketPackages[0].evidenceContext.evidence.map(e => [e.reference, e.item]));
  assert.equal(byRef.get('e5').sinceLastClose, true);
  assert.equal(byRef.get('e5').publishedEt, 'Fri 4 Sep, 4:30 pm ET');
  assert.equal(byRef.get('e5').sinceCloseHomeSection, 3);
  assert.equal(byRef.get('e6').sinceCloseHomeSection, 1);
  assert.equal(byRef.get('e1').sinceLastClose, undefined);
  assert.match(request.system, /SINCE-THE-CLOSE PARAGRAPHS \(CLOSED, WEEKEND and HOLIDAY\)/);
  assert.match(request.system, /Keep the closing analysis first/);
  assert.match(request.system, /Section 2 stays about the completed session only/);
  assert.match(request.system, /Never use an unnamed source such as "according to reports"/);
  assert.match(request.system, /never join them with words such as "because"/);
  assert.match(request.system, /items whose sinceCloseHomeSection is 3 \(e5\)/);
  assert.match(request.system, /sinceCloseHomeSection is 1 \(e6\)/);
  assert.doesNotMatch(request.system, /SINCE-THE-CLOSE LEAD/);
}));

test('Step 9V: switch on with no after-close news, the instruction quotes the fixed no-news sentence', () => on(() => {
  const request = buildClaudeAnalysisRequest(completedInput({afterClose: false}));
  assert.ok(request.system.includes(
    'Open Section 1 with exactly this sentence: "No new market news has been published since the close on Fri 4 Sep, 4:00 pm ET."'));
  assert.equal(sinceCloseNoNewsSentence('Fri 4 Sep, 4:00 pm ET'),
    'No new market news has been published since the close on Fri 4 Sep, 4:00 pm ET.');
}));

test('Step 9V: switch off, a completed request carries none of the since-close additions', () => off(() => {
  const request = buildClaudeAnalysisRequest(completedInput({withList: false}));
  const user = userContent(request);
  assert.equal(user.sinceLastClose, undefined);
  assert.doesNotMatch(request.system, /SINCE-THE-CLOSE/);
  assert.equal(JSON.stringify(user).includes('sinceCloseHomeSection'), false);
}));

test('Step 9V: PRE, REGULAR and POST writer requests are byte-identical with the switch on or off', () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES.slice(0, 3)) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt});
    const withOn = withEnvSync('on', () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    const withOff = withEnvSync('off', () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    assert.equal(withOn, withOff, marketState);
  }
});

function withEnvSync(value, fn) {
  const saved = process.env[ENV];
  process.env[ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
}

test('Step 9V: the switch-on request adds a few KB at most and no article text', () => {
  const input = completedInput();
  const bytesOn = withEnvSync('on', () => Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input))));
  const bytesOff = withEnvSync('off', () => Buffer.byteLength(JSON.stringify(buildClaudeAnalysisRequest(input))));
  assert.ok(bytesOn > bytesOff && bytesOn - bytesOff < 6 * 1024, `${bytesOn - bytesOff} bytes`);
});

// --- SINCE_CLOSE_REPEAT -----------------------------------------------------

test('Step 9V: time patterns and figures are read the same way the writer writes them', () => {
  const pattern = sinceCloseTimePattern('Fri 4 Sep, 4:30 pm ET');
  for (const text of ['At 4:30 pm ET', 'at 4:30 p.m. ET', 'at 4:30pm']) assert.equal(pattern.test(text), true, text);
  for (const text of ['at 14:30 pm', 'at 4:30 am', 'at 4:35 pm']) assert.equal(pattern.test(text), false, text);
  assert.deepEqual([...sinceCloseFigures('fell 6% to $1,200, a 12 points move, 6 percent')],
    ['6%', '$1200', '12points']);
});

function sections(contents) {
  return REPORT_SECTION_NAMES.map((name, index) => ({
    name, content: contents[index] ?? null, evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
}

const ITEMS = [
  {homeSectionIndex: 2, publishedEt: 'Fri 4 Sep, 4:30 pm ET', subjects: ['Netflix']},
  {homeSectionIndex: 0, publishedEt: 'Fri 4 Sep, 5:15 pm ET', subjects: []}
];

test('Step 9V: a repeated time or subject-plus-figure outside the home section is removed; the home and pointer are kept', () => {
  const before = sections([
    'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported that Treasury yields edged up. '
      + 'After the close, Netflix reported results (see Stocks & Sectors in Focus). Netflix shares fell 6% late.',
    'Policy news shaped the session.',
    'Broadcom led chip shares. At 4:30 pm ET, Yahoo Finance reported that Netflix gave a weaker forecast; '
      + 'its shares fell 6% late. At 5:15 pm ET, yields edged up.',
    null, null, null,
    'Netflix holds its investor call next week. At 4:30 pm ET Netflix gave a weaker forecast.'
  ]);
  const result = sinceCloseRepeatCut(before, ITEMS, splitReportSentences);
  assert.equal(result.sections[0].content, 'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported '
    + 'that Treasury yields edged up. After the close, Netflix reported results (see Stocks & Sectors in Focus).');
  assert.equal(result.sections[2].content, 'Broadcom led chip shares. At 4:30 pm ET, Yahoo Finance reported that '
    + 'Netflix gave a weaker forecast; its shares fell 6% late.');
  assert.equal(result.sections[6].content, 'Netflix holds its investor call next week.');
  assert.deepEqual(result.removed, {0: 1, 2: 1, 6: 1});
  assert.equal(result.sections[1], before[1]);
  assert.deepEqual(result.keptToAvoidBlank, []);
});

test('Step 9V: a since-close time in Section 2 is removed; a section is never blanked', () => {
  const before = sections([
    'Stocks closed higher on Friday.',
    'Policy news shaped the session. At 4:30 pm ET, Netflix gave a weaker forecast.',
    null, null, null, null,
    'At 5:15 pm ET, yields edged up.'
  ]);
  const result = sinceCloseRepeatCut(before, ITEMS, splitReportSentences);
  assert.equal(result.sections[1].content, 'Policy news shaped the session.');
  assert.deepEqual(result.removed, {1: 1});
  assert.equal(result.sections[6], before[6]);
  assert.deepEqual(result.keptToAvoidBlank, [6]);
});

test('Step 9V: with nothing to cut, every section is returned unchanged (same object)', () => {
  const before = sections(['Stocks closed higher on Friday.', 'Policy news shaped the session.']);
  const result = sinceCloseRepeatCut(before, ITEMS, splitReportSentences);
  before.forEach((section, index) => assert.equal(result.sections[index], section));
});

// --- full invocation with planted writer replies (stand-in writer, no network) ----------

const EMPTY = {content: null, evidenceRefs: '', telemetryRefs: '', uncertainties: 'No data available for this run.'};

function reply({s1, s2, s3, s7}, {afterClose = true} = {}) {
  return {
    status: 'DEGRADED', evidenceGaps: ['Not enough data to cover every part of this report.'],
    s1: {content: s1, evidenceRefs: afterClose ? 'e2|e3|e6' : 'e2|e3', telemetryRefs: 't1', uncertainties: ''},
    s2: {content: s2, evidenceRefs: 'e2|e3', telemetryRefs: '', uncertainties: ''},
    s3: s3 ? {content: s3, evidenceRefs: 'e4|e5', telemetryRefs: '', uncertainties: ''} : {...EMPTY},
    s4: {...EMPTY}, s5: {...EMPTY}, s6: {...EMPTY},
    s7: s7 ? {content: s7, evidenceRefs: 'e5', telemetryRefs: '', uncertainties: ''} : {...EMPTY},
    s8: {}
  };
}

async function invokeWith(input, transport) {
  const diagnostics = [];
  const envelope = {id: 'planted', content: [{type: 'text', text: JSON.stringify(transport)}],
    usage: {input_tokens: 1, output_tokens: 1}};
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'planted-no-network', onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => null}, clone() { return this; },
      text: async () => JSON.stringify(envelope), json: async () => envelope})
  });
  return {result, diagnostics};
}

const PLANTED_REPEAT = {
  s1: 'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported that Treasury yields edged up. '
    + 'Netflix shares fell 6% late.',
  s2: 'Federal Reserve policy context shaped the completed session. At 4:30 pm ET, Yahoo Finance reported '
    + 'that Netflix gave a weaker forecast.',
  s3: 'Broadcom led semiconductor shares in the session. At 4:30 pm ET, Yahoo Finance reported that Netflix '
    + 'gave a weaker fourth-quarter forecast. Yahoo Finance said Netflix shares fell 6% late. At 5:15 pm ET, '
    + 'Treasury yields edged up.',
  s7: 'Netflix holds its investor call next week. At 5:15 pm ET, Treasury yields edged up.'
};

test('Step 9V planted reply: repeats across Sections 1, 3 and 7 and a Section 2 time are removed; status is not degraded by the cut', () => on(async () => {
  const {result, diagnostics} = await invokeWith(completedInput(), reply(PLANTED_REPEAT));
  assert.equal(result.ok, true, result.message);
  const out = result.output.sections;
  assert.equal(out[0].content, 'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported that '
    + 'Treasury yields edged up.');
  assert.equal(out[1].content, 'Federal Reserve policy context shaped the completed session.');
  assert.equal(out[2].content, 'Broadcom led semiconductor shares in the session. At 4:30 pm ET, Yahoo Finance '
    + 'reported that Netflix gave a weaker fourth-quarter forecast. Yahoo Finance said Netflix shares fell 6% late.');
  assert.equal(out[6].content, 'Netflix holds its investor call next week.');
  const cleanup = diagnostics.filter(d => d.stage === 'completedSinceCloseCleanup');
  assert.deepEqual(cleanup.map(d => [d.sectionIndex, d.violationCategory, d.action, d.removedSentenceCount]), [
    [0, 'SINCE_CLOSE_REPEAT', 'TRIMMED', 1], [1, 'SINCE_CLOSE_SECTION_TWO', 'TRIMMED', 1],
    [2, 'SINCE_CLOSE_REPEAT', 'TRIMMED', 1], [6, 'SINCE_CLOSE_REPEAT', 'TRIMMED', 1]
  ]);
  const context = diagnostics.find(d => d.stage === 'completedSinceCloseContext');
  assert.deepEqual([context.refsSource, context.itemCount, context.sectionOneRefs, context.sectionThreeRefs],
    ['package', 2, ['e6'], ['e5']]);
}));

test('Step 9V planted reply: switch off, the same reply is left exactly as the writer wrote it', () => off(async () => {
  const {result, diagnostics} = await invokeWith(completedInput({withList: false}), reply(PLANTED_REPEAT));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.output.sections[6].content, PLANTED_REPEAT.s7);
  assert.equal(result.output.sections[0].content, PLANTED_REPEAT.s1);
  assert.equal(diagnostics.some(d => String(d.stage).startsWith('completedSinceClose')), false);
}));

test('Step 9V planted reply: no after-close news and no mention of the close adds the exact no-news sentence first', () => on(async () => {
  const {result, diagnostics} = await invokeWith(completedInput({afterClose: false}), reply({
    s1: 'Stocks closed higher on Friday.', s2: 'Federal Reserve policy context shaped the completed session.'
  }, {afterClose: false}));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.output.sections[0].content,
    'No new market news has been published since the close on Fri 4 Sep, 4:00 pm ET. Stocks closed higher on Friday.');
  assert.deepEqual(diagnostics.filter(d => d.stage === 'completedSinceCloseCleanup')
    .map(d => [d.violationCategory, d.action]), [['SINCE_CLOSE_NO_NEWS_LINE', 'ADDED']]);
}));

test('Step 9V planted reply: a Section 1 that already says nothing new since the close is left as written', () => on(async () => {
  const s1 = 'Nothing new has been reported since the close. Stocks closed higher on Friday.';
  const {result, diagnostics} = await invokeWith(completedInput({afterClose: false}), reply({
    s1, s2: 'Federal Reserve policy context shaped the completed session.'
  }, {afterClose: false}));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.output.sections[0].content, s1);
  assert.equal(diagnostics.some(d => d.stage === 'completedSinceCloseCleanup'), false);
}));

test('Step 9V planted reply: an after-close cause in Section 3 meets the same causal rule with the switch on or off', async () => {
  const causal = {
    s1: 'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported that Treasury yields edged up.',
    s2: 'Federal Reserve policy context shaped the completed session.',
    s3: 'Broadcom led semiconductor shares in the session. At 4:30 pm ET, Netflix shares fell 6% late because '
      + 'of a weaker forecast, Yahoo Finance reported.'
  };
  const withOn = await on(() => invokeWith(completedInput({withList: false}), reply(causal)));
  const withOff = await off(() => invokeWith(completedInput({withList: false}), reply(causal)));
  assert.equal(withOn.result.ok, withOff.result.ok);
  assert.equal(withOn.result.ok, true, withOn.result.message);
  // Rule 16 is unchanged by Step 9V. Known gap (recorded under Step 9V in docs/DECISIONS.md):
  // it checks market-wide cause claims, so a single company's after-close cause survives either
  // way; Step 9V's no-cause rule for after-close news is a writer instruction only.
  assert.deepEqual(withOn.result.output.sections[2], withOff.result.output.sections[2]);
});

test('Step 9V planted reply: a cut that would empty Section 7 is not made and is logged', () => on(async () => {
  const {result, diagnostics} = await invokeWith(completedInput(), reply({
    s1: 'Stocks closed higher on Friday. At 5:15 pm ET, Yahoo Finance reported that Treasury yields edged up.',
    s2: 'Federal Reserve policy context shaped the completed session.',
    s3: 'Broadcom led semiconductor shares in the session.',
    s7: 'At 5:15 pm ET, Treasury yields edged up.'
  }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.output.sections[6].content, 'At 5:15 pm ET, Treasury yields edged up.');
  assert.deepEqual(diagnostics.filter(d => d.stage === 'completedSinceCloseCleanup')
    .map(d => [d.sectionIndex, d.action]), [[6, 'KEPT_TO_AVOID_BLANK']]);
}));

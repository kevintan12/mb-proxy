// Step 9F.4c + 8W: the guided labelling retry, the date accuracy labels, instruction and
// check, and the "Section 1 leads with current news" log measure's day-before-month fix.
// No paid call: every Anthropic request here is a stub.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {
  invokeClaudeEvidenceRoleClassification,
  classifierFailureCategories,
  canonicalClassificationInput
} = require('../lib/claude-evidence-role-classification');
const {retryOnContractFailure} = require('../lib/contract-retry');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {splitReportSentences, hasActiveSessionOpening} = require('../lib/claude-analysis-contract');
const {dateAccuracyContext, dateAccuracyCut, explicitDates} = require('../lib/section-rules');
const {exchangeDateParts} = require('../lib/us-active-session-evidence');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {withEnv} = require('./fixtures/step-8w-switches');
const {MARKET_STATE_CASES, marketStateCase, activeUsInput} = require('./fixtures/market-state-cases');

// ---------------------------------------------------------------------------
// 9F.4c: the guided labelling retry
// ---------------------------------------------------------------------------
function snapshot() {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  });
  return createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: 'S&P 500', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
}

function classifierInput() {
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot: snapshot()}],
    evidence: ['COMPLETED_SESSION', 'COMPLETED_SESSION', 'SUBSEQUENT_DEVELOPMENT'].map((horizon, index) => ({
      reference: `e${index + 1}`, horizon, requiresBroadMarketSubjects: false,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
        title: `Secret article title ${index + 1}`, summary: `Secret article body ${index + 1}.`,
        canonicalUrl: `https://www.cnbc.com/2026/09/11/evidence-${index + 1}.html`,
        publishedAt: '2026-09-11T19:30:00Z', symbols: []
      })
    }))
  };
}

const GOOD = {classifications: [
  {reference: 'e1', materiality: 'MEDIUM', roles: ['MATERIAL_EVENT'], subjects: []},
  {reference: 'e2', materiality: 'HIGH', roles: ['MATERIAL_EVENT', 'PRINCIPAL_CATALYST'], subjects: []},
  {reference: 'e3', materiality: 'LOW', roles: [], subjects: []}
]};
// e3 is a SUBSEQUENT_DEVELOPMENT, so PRINCIPAL_CATALYST breaks the rule.
const BAD = {classifications: GOOD.classifications.map((entry, index) =>
  index === 2 ? {...entry, roles: ['PRINCIPAL_CATALYST']} : entry)};

function reply(output) {
  return {ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: JSON.stringify(output)}], usage: {}}; }};
}

async function runClassifier(replies, env = {}) {
  const bodies = [];
  const diagnostics = [];
  let calls = 0;
  const result = await invokeClaudeEvidenceRoleClassification({
    input: classifierInput(), apiKey: 'test-key', env,
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, options) => { bodies.push(JSON.parse(options.body)); return reply(replies[calls++]); }
  });
  return {result, bodies, diagnostics, calls};
}

test('Step 9F.4c: the guided labelling retry request differs from the first only by the guidance', async () => {
  const {result, bodies, diagnostics, calls} = await runClassifier([BAD, GOOD]);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  const [first, second] = bodies;
  assert.deepEqual({...second, system: first.system}, first);
  assert.equal(second.system.startsWith(`${first.system} RETRY: `), true);
  const guidance = second.system.slice(first.system.length + 1);
  assert.match(guidance, /SUBSEQUENT_DEVELOPMENT was given PRINCIPAL_CATALYST/);
  assert.match(guidance, /\(references e3\)/);
  assert.equal(/Secret article/.test(guidance), false);
  const fired = diagnostics.filter(value => value.stage === 'classifierRetryGuidance');
  assert.deepEqual(JSON.parse(JSON.stringify(fired)), [{
    stage: 'classifierRetryGuidance', attempt: 1,
    failures: [{category: 'SUBSEQUENT_PRINCIPAL_CATALYST', references: ['e3']}]
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('Secret article'), false);
  assert.equal(JSON.stringify(diagnostics).includes('test-key'), false);
});

test('Step 9F.4c: guidance off repeats the identical request, as in f8d56c9', async () => {
  const {result, bodies, diagnostics} = await runClassifier([BAD, GOOD],
    {CLASSIFIER_RETRY_GUIDANCE_ENABLED: 'off'});
  assert.equal(result.ok, true);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(diagnostics.some(value => value.stage === 'classifierRetryGuidance'), false);
  const retry = diagnostics.find(value => value.stage === 'contractRetry');
  assert.equal(Object.hasOwn(retry, 'guided'), false);
});

test('Step 9F.4c: classifierRetryCount 0, 1 and 2 give 1, 2 and 3 calls; default 1, range 0-2', async () => {
  assert.equal(settingValue('classifierRetryCount'), 1);
  assert.equal(settingValue('classifierRetryCount', {env: {CLASSIFIER_RETRY_COUNT: '9'}}), 2);
  assert.equal(SETTINGS_REGISTRY.classifierRetryCount.admin, 'Admin');
  for (const [count, expected] of [['0', 1], ['1', 2], ['2', 3]]) {
    const {result, calls, diagnostics} = await runClassifier([BAD, BAD, BAD], {CLASSIFIER_RETRY_COUNT: count});
    assert.equal(result.type, 'CONTRACT_FAILURE', count);
    assert.equal(calls, expected, count);
    assert.deepEqual(diagnostics.filter(value => value.stage === 'classifierRetryGuidance')
      .map(value => value.attempt), Array.from({length: expected - 1}, (_, index) => index + 1), count);
  }
  const recovered = await runClassifier([BAD, BAD, GOOD], {CLASSIFIER_RETRY_COUNT: '2'});
  assert.equal(recovered.result.ok, true);
});

test('Step 9F.4c: a reply cut off at the token limit is still never retried', async () => {
  let calls = 0;
  const result = await invokeClaudeEvidenceRoleClassification({
    input: classifierInput(), apiKey: 'test-key', env: {CLASSIFIER_RETRY_COUNT: '2'},
    fetchImpl: async () => {
      calls++;
      return {ok: true, status: 200, headers: {get: () => null},
        async json() { return {content: [{type: 'text', text: '{"classifications": ['}], stop_reason: 'max_tokens'}; }};
    }
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(calls, 1);
});

test('Step 9F.4c: failure categories name rules and references only', () => {
  const canonical = canonicalClassificationInput(classifierInput());
  assert.deepEqual(JSON.parse(JSON.stringify(classifierFailureCategories(BAD, canonical))),
    [{category: 'SUBSEQUENT_PRINCIPAL_CATALYST', references: ['e3']}]);
  const mixed = {classifications: [
    {reference: 'e1', materiality: 'HUGE', roles: [], subjects: []},
    {reference: 'e9', materiality: 'LOW', roles: [], subjects: []}
  ]};
  assert.deepEqual(JSON.parse(JSON.stringify(classifierFailureCategories(mixed, canonical))), [
    {category: 'INVALID_MATERIALITY', references: ['e1']},
    {category: 'REFERENCE_ORDER', references: ['e9']},
    {category: 'MISSING_REFERENCE', references: ['e2', 'e3']}
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(classifierFailureCategories('free text', canonical))),
    [{category: 'MALFORMED_REPLY', references: []}]);
});

test('Step 9F.4c: the shared retry hook with maxRetries 1 behaves exactly as Step 8L', async () => {
  const failure = {ok: false, type: 'CONTRACT_FAILURE', message: 'x'};
  const contexts = [];
  const result = await retryOnContractFailure(async context => { contexts.push(context); return failure; }, {});
  assert.equal(result, failure);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], undefined);
  assert.equal(contexts[1].previousFailure, failure);
});

// ---------------------------------------------------------------------------
// 8W: the date check (unit level)
// ---------------------------------------------------------------------------
function dateInput({generatedAt, completedDate, articles}) {
  return {
    analysisRequest: {generatedAt},
    marketPackages: [{
      market: 'US',
      marketContext: {primaryCompletedSessionDate: completedDate},
      evidenceContext: {evidence: articles.map(([reference, publishedAt, title, summary]) =>
        ({reference, item: {title, summary, publishedAt}}))},
      telemetry: {benchmarkSnapshots: [], stockSnapshots: []}
    }]
  };
}

function cut(input, sectionIndex, content, evidenceRefs) {
  const section = {name: 'S', content, evidenceRefs, telemetryRefs: [], uncertainties: []};
  return dateAccuracyCut(section, dateAccuracyContext(input, section, sectionIndex), splitReportSentences);
}

// 11 Oct 2026 (Sunday): the Fri 9 Oct article said "next Tuesday"; the writer wrote "Monday".
const OCT_11 = dateInput({
  generatedAt: '2026-10-11T14:00:00.000Z', completedDate: '2026-10-09',
  articles: [['e1', '2026-10-09T20:00:00.000Z', 'Big banks kick off earnings season',
    'JPMorgan, Wells Fargo and Citigroup report third-quarter results next Tuesday.']]
});

test('Step 8W: the 11 Oct "Monday" for "next Tuesday" sentence is trimmed (Sections 3 and 7)', () => {
  for (const sectionIndex of [2, 6]) {
    const result = cut(OCT_11, sectionIndex,
      'JPMorgan and Citigroup report results on Monday. Bank shares could move on the numbers.', ['e1']);
    assert.equal(result.section.content, 'Bank shares could move on the numbers.', String(sectionIndex));
    assert.deepEqual(result.counts, {WEEKDAY: 1, PAST_DATE: 0});
  }
  // The right day is kept.
  const right = cut(OCT_11, 6, 'JPMorgan and Citigroup report results on Tuesday.', ['e1']);
  assert.equal(right.removedSentenceCount, 0);
});

test('Step 8W: a correct weekday is kept when the article gives a date instead of a day name', () => {
  const input = dateInput({
    generatedAt: '2026-10-11T14:00:00.000Z', completedDate: '2026-10-09',
    articles: [['e1', '2026-10-09T20:00:00.000Z', 'Banks to report', 'The banks report on Oct. 13.']]
  });
  assert.equal(exchangeDateParts('2026-10-13T16:00:00.000Z').weekday, 'Tuesday');
  const kept = cut(input, 6, 'The banks report on Tuesday 13 Oct.', ['e1']);
  assert.equal(kept.removedSentenceCount, 0);
  const wrong = cut(input, 6, 'The banks report on Wednesday. Watch the results.', ['e1']);
  assert.equal(wrong.section.content, 'Watch the results.');
});

test('Step 8W: the report day, a cited article\'s publish day and the completed session day are allowed', () => {
  const kept = cut(OCT_11, 0, 'On Sunday, futures had not opened yet. On Friday, Reuters reported bank news. '
    + 'At 4:00 pm ET on Fri 9 Oct, stocks closed higher.', ['e1']);
  assert.equal(kept.removedSentenceCount, 0);
  // A weekday is only allowed through an article the section actually cites.
  const uncited = cut(OCT_11, 2, 'Banks report on Tuesday. Bank shares rose.', []);
  assert.equal(uncited.section.content, 'Bank shares rose.');
});

test('Step 8W: in Section 7 only, a sentence with an explicit date before the report date is removed', () => {
  const content = 'The jobs report came out on Oct 2. Inflation data is due on Oct 15. '
    + 'Retail sales on 8 October were strong. Earnings start on 2026-10-13.';
  const section7 = cut(OCT_11, 6, content, ['e1']);
  assert.equal(section7.section.content, 'Inflation data is due on Oct 15. Earnings start on 2026-10-13.');
  assert.deepEqual(section7.counts, {WEEKDAY: 0, PAST_DATE: 2});
  // The report date itself is not "before the report date".
  assert.equal(cut(OCT_11, 6, 'Futures open on Oct 11.', ['e1']).removedSentenceCount, 0);
  // Other sections keep past dates (they may describe what already happened).
  assert.equal(cut(OCT_11, 4, content, ['e1']).removedSentenceCount, 0);
  // A year-less January date in late December is next year, not the past.
  assert.deepEqual(explicitDates('Due Jan 5.', '2026-12-20'), ['2027-01-05']);
  // "may 5%" is not a date.
  assert.deepEqual(explicitDates('Stocks may 5% lower.', '2026-10-11'), []);
});

test('Step 8W: a section whose every sentence breaks a date rule is emptied, not left with made-up dates', () => {
  const result = cut(OCT_11, 6, 'Banks report on Monday. The jobs report came out on Oct 2.', ['e1']);
  assert.equal(result.section.content, null);
  assert.deepEqual(result.counts, {WEEKDAY: 1, PAST_DATE: 1});
});

test('Step 8W: KNOWN LIMIT - the Warsh-type past event with no day or date is NOT caught', () => {
  // 17 Oct 2026 (Saturday) run; the articles were published Thu 15 Oct and Fri 16 Oct and said
  // traders "will turn their attention to" his remarks, which had already happened. Code cannot
  // tell this from a genuinely upcoming event; only the instruction reduces it.
  const input = dateInput({
    generatedAt: '2026-10-17T14:00:00.000Z', completedDate: '2026-10-16',
    articles: [['e1', '2026-10-15T20:14:00.000Z', 'Stocks rise ahead of Fed speakers',
      'Traders will turn their attention to remarks from Fed Governor Kevin Warsh.']]
  });
  const result = cut(input, 6, 'Traders will turn their attention to remarks from Fed Governor Kevin Warsh.', ['e1']);
  assert.equal(result.removedSentenceCount, 0);
  assert.equal(result.section.content, 'Traders will turn their attention to remarks from Fed Governor Kevin Warsh.');
});

// ---------------------------------------------------------------------------
// 8W: the writer request in all six market states
// ---------------------------------------------------------------------------
test('Step 8W: in every state each article carries publishedEt and the request one reportTimeEt; off adds none', async () => {
  for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv('DATE_ACCURACY_ENABLED', 'on', () => buildClaudeAnalysisRequest(input));
    const onInput = JSON.parse(on.messages[0].content);
    assert.equal(typeof onInput.reportTimeEt, 'string', marketState);
    assert.match(onInput.reportTimeEt, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} [ap]m ET$/, marketState);
    for (const entry of onInput.marketPackages.flatMap(item => item.evidenceContext.evidence)) {
      assert.match(entry.item.publishedEt, / ET$/, `${marketState} ${entry.reference}`);
    }
    assert.equal((on.system.match(/DATES \(every market state, every section\)/g) || []).length, 1, marketState);
    assert.equal(on.system.includes(`(${onInput.reportTimeEt})`), true, marketState);
    await withEnv('DATE_ACCURACY_ENABLED', 'off', () => {
      const off = buildClaudeAnalysisRequest(input);
      const offInput = JSON.parse(off.messages[0].content);
      assert.equal(Object.hasOwn(offInput, 'reportTimeEt'), false, marketState);
      assert.equal(off.system.includes('DATES (every market state'), false, marketState);
      assert.equal(on.system.replace(/ DATES \(every market state[^]*?do not work out dates yourself\./, ''),
        off.system, marketState);
    });
  }
});

// ---------------------------------------------------------------------------
// E: the "Section 1 leads with current news" log measure
// ---------------------------------------------------------------------------
test('Step 8W (E): the log measure is true on the real 15 Oct opening "At 11:34 am ET on Thu 15 Oct"', () => {
  const input = activeUsInput({
    marketState: 'REGULAR', generatedAt: '2026-10-15T15:40:00.000Z',
    overlayAsOf: '2026-10-15T15:35:00.000Z', currentPublishedAt: '2026-10-15T15:34:00.000Z',
    includeOverlay: false
  });
  const opening = 'At 11:34 am ET on Thu 15 Oct, Reuters reported that chip stocks rose. More text follows.';
  assert.equal(hasActiveSessionOpening(opening, input), true);
  assert.equal(hasActiveSessionOpening('At 11:34 am ET on Thursday, Oct 15, Reuters reported gains.', input), true);
  // A different day in the same format is still not the current session.
  assert.equal(hasActiveSessionOpening('At 11:34 am ET on Wed 14 Oct, Reuters reported gains.', input), false);
});

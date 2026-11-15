// Step 9AN: tighter date checks on live days (dateAccuracyTighterEnabled). Fix A: a completed
// session day of a cited price record counts only when the same sentence gives that session's date.
// Fix B: the recent past (completed-session day up to the day before the report day) in Section 7,
// or with upcoming wording in Sections 1 to 6. Completed-day states never run it. Free tests only:
// made-up text, fake fetch, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {splitReportSentences} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  dateAccuracyContext, dateAccuracyCut, dateAccuracyTighterContext, dateAccuracyTighterCut
} = require('../lib/section-rules');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  activeUsInput, normalOutput, anthropicResponse, marketStateCase, MARKET_STATE_CASES
} = require('./fixtures/market-state-cases');

const ENV = 'DATE_ACCURACY_TIGHTER_ENABLED';

// ---------------------------------------------------------------------------
// Unit level: Wednesday 4 Nov 2026 (ET) report; completed session Tuesday 3 Nov.
// The price record t1 has five sessions: Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Mon 2 Nov, Tue 3 Nov.
// Article e1 was published on the report day (Wednesday) and names Thursday as a coming day.
// ---------------------------------------------------------------------------
const SESSIONS = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'];

function wednesdayInput() {
  return {
    analysisRequest: {generatedAt: '2026-11-04T15:00:00.000Z'},
    marketPackages: [{
      market: 'US',
      marketContext: {primaryCompletedSessionDate: '2026-11-03', marketState: 'PRE'},
      evidenceContext: {evidence: [{reference: 'e1', item: {
        title: 'Apple moves before the open',
        summary: 'Apple shares rose in premarket trading. Results come Thursday.',
        publishedAt: '2026-11-04T13:00:00.000Z'
      }}]},
      telemetry: {
        benchmarkSnapshots: [],
        stockSnapshots: [{reference: 't1', snapshot: {completedSessions: SESSIONS.map(sessionDate => ({sessionDate}))}}]
      }
    }]
  };
}

const PLAIN = {articleSummary: 'Apple shares rose in premarket trading.'};
const section = (content, evidenceRefs = ['e1'], telemetryRefs = ['t1']) =>
  ({name: 'S', content, evidenceRefs, telemetryRefs, uncertainties: []});

function tighter(index, content, options = {}) {
  const input = wednesdayInput();
  if (options.articleSummary) input.marketPackages[0].evidenceContext.evidence[0].item.summary = options.articleSummary;
  const target = section(content, options.evidenceRefs || ['e1'], options.telemetryRefs || ['t1']);
  const context = dateAccuracyTighterContext(input, target, index, {live: options.live !== false});
  return context ? dateAccuracyTighterCut(target, context, splitReportSentences) : null;
}

test('Step 9AN Fix A: the Apple premarket "Thursday" sentence is removed, the rest of the line stays', () => {
  const result = tighter(3, 'Apple shares rose 0.5% in premarket trading on Thursday, according to the same '
    + 'article. Apple has gained for three sessions.', PLAIN);
  assert.equal(result.section.content, 'Apple has gained for three sessions.');
  assert.deepEqual(result.counts, {SESSION_DAY_NO_DATE: 1, RECENT_PAST: 0});
});

test('Step 9AN Fix A: the same session day with its date in the sentence is kept', () => {
  for (const sentence of ['Apple closed higher on Thursday 29 Oct.', 'Apple closed higher on Thu 29 Oct.',
    'On Thursday, Oct 29, Apple closed higher.', 'Apple closed higher on Thursday (2026-10-29).']) {
    // e1 here does not name Thursday, so only the telemetry could support it.
    const result = tighter(3, `${sentence} Volume was steady.`, PLAIN);
    assert.equal(result.removedSentenceCount, 0, sentence);
  }
  // A date that is not that session's date does not back the weekday.
  const wrong = tighter(3, 'Apple closed higher on Thursday 5 Nov 2026. Volume was steady.', PLAIN);
  assert.equal(wrong.section.content, 'Volume was steady.');
});

test('Step 9AN Fix A: report day, completed-session day and article-stated days stay allowed', () => {
  const plain = {articleSummary: 'Apple shares rose in premarket trading.'};
  for (const sentence of ['Apple rose on Wednesday.', 'Apple closed higher on Tuesday.']) {
    assert.equal(tighter(3, `${sentence} Volume was steady.`, plain).removedSentenceCount, 0, sentence);
  }
  // An article that names Thursday keeps Thursday allowed.
  assert.equal(tighter(3, 'Apple reports on Thursday. Volume was steady.').removedSentenceCount, 0);
  // Not citing the price record: the weekday was never supported by it, so Step 8W's cut owns it.
  assert.equal(tighter(3, 'Apple closed higher on Friday. Volume was steady.', {...plain, telemetryRefs: []})
    .removedSentenceCount, 0);
});

test('Step 9AN Fix A: Step 8W alone still allows the session day (the narrowing is only the new rule)', () => {
  const input = wednesdayInput();
  input.marketPackages[0].evidenceContext.evidence[0].item.summary = 'Apple shares rose in premarket trading.';
  const target = section('Apple shares rose in premarket trading on Thursday. Volume was steady.');
  const old = dateAccuracyCut(target, dateAccuracyContext(input, target, 3), splitReportSentences);
  assert.equal(old.removedSentenceCount, 0);
});

test('Step 9AN Fix B: the AMD "due after the bell on Tuesday" sentence is removed in Section 5', () => {
  const result = tighter(4, 'AMD\'s third-quarter results, due after the bell on Tuesday, will show whether its '
    + 'premarket gain holds. Chip stocks were mixed.');
  assert.equal(result.section.content, 'Chip stocks were mixed.');
  assert.deepEqual(result.counts, {SESSION_DAY_NO_DATE: 0, RECENT_PAST: 1});
});

test('Step 9AN Fix B, Sections 1 to 6: past weekday without upcoming wording, or upcoming wording without a past weekday, is kept', () => {
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const kept = tighter(index, 'Stocks closed higher on Tuesday. Chip stocks were mixed. '
      + 'Results are due on Thursday. Apple will report soon.');
    assert.equal(kept.removedSentenceCount, 0, String(index));
  }
  for (const wording of ['due', 'expected to report', 'will report', 'scheduled to', 'set to report', 'ahead of']) {
    const sentence = `AMD is ${wording} on Tuesday after a strong premarket move.`;
    assert.equal(tighter(1, `${sentence} Chip stocks were mixed.`).section.content, 'Chip stocks were mixed.', wording);
  }
  // Monday 2 Nov is before the completed day, so it is not in the window.
  // (Fix A removes it instead, as Monday 2 Nov is an undated session day: the counts say which rule.)
  assert.equal(tighter(1, 'AMD is due on Monday. Chip stocks were mixed.').counts.RECENT_PAST, 0);
});

test('Step 9AN Fix B, Section 7: a recent-past weekday (no "next") or a date in the window is removed', () => {
  const result = tighter(6, 'Earnings arrive on Tuesday. The jobs report came out Nov 3. Retail sales are out next '
    + 'Tuesday. Fed speakers talk on Thursday. Futures open Nov 4. Claims data comes Nov 5.');
  assert.equal(result.section.content,
    'Retail sales are out next Tuesday. Fed speakers talk on Thursday. Futures open Nov 4. Claims data comes Nov 5.');
  assert.equal(result.counts.RECENT_PAST, 2);
});

test('Step 9AN Fix B: the window runs from the completed day to the day before the report day', () => {
  // Monday 9 Nov report after a Friday 6 Nov close: recent past is Fri 6, Sat 7, Sun 8.
  const input = wednesdayInput();
  input.analysisRequest.generatedAt = '2026-11-09T15:00:00.000Z';
  input.marketPackages[0].marketContext.primaryCompletedSessionDate = '2026-11-06';
  const target = section('Earnings arrive on Friday. Earnings arrive on Sunday. Results are due on Thursday. Futures open Nov 9.');
  const context = dateAccuracyTighterContext(input, target, 6, {live: true});
  assert.deepEqual([...context.recentPastDates].sort(), ['2026-11-06', '2026-11-07', '2026-11-08']);
  const result = dateAccuracyTighterCut(target, context, splitReportSentences);
  assert.equal(result.section.content, 'Results are due on Thursday. Futures open Nov 9.');
});

test('Step 9AN: a section is never blanked (Section 7 and Sections 1 to 6)', () => {
  const seven = tighter(6, 'Earnings arrive on Tuesday. The jobs report came out Nov 3.');
  assert.equal(seven.removedSentenceCount, 0);
  assert.equal(seven.keptToAvoidBlank, true);
  assert.equal(seven.section.content, 'Earnings arrive on Tuesday. The jobs report came out Nov 3.');
  const five = tighter(4, 'AMD is due after the bell on Tuesday.');
  assert.equal(five.section.content, 'AMD is due after the bell on Tuesday.');
  assert.equal(five.keptToAvoidBlank, true);
  const fix = tighter(3, 'Apple rose on Thursday in premarket trading.',
    {articleSummary: 'Apple shares rose in premarket trading.'});
  assert.equal(fix.keptToAvoidBlank, true);
  assert.notEqual(fix.section.content, null);
});

test('Step 9AN: completed-day states (not live) get no context, so nothing is cut', () => {
  assert.equal(tighter(6, 'Earnings arrive on Tuesday. Chip stocks were mixed.', {live: false}), null);
});

test('Step 9AN: the registry row (Admin boolean, on by default, env DATE_ACCURACY_TIGHTER_ENABLED)', () => {
  const entry = SETTINGS_REGISTRY.dateAccuracyTighterEnabled;
  assert.equal(entry.default, true);
  assert.equal(entry.admin, 'Admin');
  assert.equal(entry.envVar, ENV);
  assert.equal(entry.boolean, true);
  assert.equal(entry.wired, true);
  assert.equal(settingValue('dateAccuracyTighterEnabled', {env: {}}), true);
  assert.equal(settingValue('dateAccuracyTighterEnabled', {env: {[ENV]: 'off'}}), false);
});

// ---------------------------------------------------------------------------
// Whole cleanup path (fake fetch). Default fixture: Tuesday 8 Sep 2026 REGULAR, completed session
// Friday 4 Sep, so the recent past is Fri 4, Sat 5, Sun 6 and Mon 7 Sep.
// ---------------------------------------------------------------------------
async function runWith(env, input, output) {
  const diagnostics = [];
  const saved = process.env[ENV];
  if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, events: diagnostics.filter(value => value.stage === 'claudeAnalysisSectionNormalization'
      && /^DATE_ACCURACY_TIGHTER/.test(value.violationCategory))};
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
}

function planted(input, sevenText, fiveText) {
  const output = normalOutput(input);
  output.sections[6] = {...output.sections[6], content: sevenText};
  if (fiveText) output.sections[4] = {...output.sections[4], content: fiveText};
  return output;
}

const SEVEN = 'Microsoft earnings arrive on Friday. Fed speakers talk next Friday.';
const FIVE = 'Microsoft\'s results, due after the bell on Friday, will test the rally. Microsoft raised its outlook.';

test('Step 9AN: live day, switch on trims the recent-past sentences with TRIMMED events; switch off keeps them', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES.filter(row => row[2])) {
    const {input} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const on = await runWith(undefined, input, planted(input, SEVEN, FIVE));
    assert.equal(on.result.ok, true, state);
    assert.equal(on.result.output.status, 'NORMAL', state);
    assert.equal(on.result.output.sections[6].content, 'Fed speakers talk next Friday.', state);
    assert.equal(on.result.output.sections[4].content, 'Microsoft raised its outlook.', state);
    assert.deepEqual(on.events.map(event => [event.sectionIndex, event.action, event.removedSentenceCount]),
      [[4, 'TRIMMED', 1], [6, 'TRIMMED', 1]], state);
    const off = await runWith('off', input, planted(input, SEVEN, FIVE));
    assert.equal(off.result.ok, true, state);
    assert.equal(off.result.output.sections[6].content, SEVEN, state);
    assert.equal(off.result.output.sections[4].content, FIVE, state);
    assert.deepEqual(off.events, [], state);
  }
});

test('Step 9AN: live day, a Section 7 of only recent-past sentences is kept, not blanked', async () => {
  const input = activeUsInput();
  const only = 'Microsoft earnings arrive on Friday.';
  const on = await runWith(undefined, input, planted(input, only));
  assert.equal(on.result.ok, true);
  assert.equal(on.result.output.sections[6].content, only);
  assert.deepEqual(on.events, []);
});

test('Step 9AN: completed days (Closed, Weekend, Holiday) are the same with the switch on or off', async () => {
  for (const [state, generatedAt] of MARKET_STATE_CASES.filter(row => !row[2])) {
    const {input, output} = marketStateCase(state, generatedAt);
    const text = 'Earnings arrive on Friday. Chip stocks were mixed.';
    const plantedOutput = structuredClone(output);
    plantedOutput.sections[6] = {...plantedOutput.sections[6], content: text};
    const on = await runWith(undefined, input, plantedOutput);
    const off = await runWith('off', input, plantedOutput);
    assert.deepEqual(on.result, off.result, state);
    assert.deepEqual(on.events, [], state);
    assert.deepEqual(off.events, [], state);
  }
});

test('Step 9AN: the tighter rule needs Step 8W on (dateAccuracyEnabled off gives no trim)', async () => {
  const input = activeUsInput();
  const saved = process.env.DATE_ACCURACY_ENABLED;
  process.env.DATE_ACCURACY_ENABLED = 'off';
  try {
    const result = await runWith(undefined, input, planted(input, SEVEN));
    assert.equal(result.result.output.sections[6].content, SEVEN);
    assert.deepEqual(result.events, []);
  } finally {
    if (saved === undefined) delete process.env.DATE_ACCURACY_ENABLED; else process.env.DATE_ACCURACY_ENABLED = saved;
  }
});

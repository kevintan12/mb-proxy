// Step 9Z.1: on Pre-market, Trading and After-Hours days Section 1 is a themed summary with no
// publish times (switch liveThemedSummaryEnabled, default on); Section 2 keeps its timed
// since-close lead. Free tests only: no network, no paid call. Every reply here is made up.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  activeUsInput,
  marketStateCase,
  normalOutput,
  anthropicResponse
} = require('./fixtures/market-state-cases');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {splitReportSentences} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {sinceCloseRepeatCut} = require('../lib/section-rules');

const ENV = 'LIVE_THEMED_SUMMARY_ENABLED';
const ENV_NAMES = [ENV, 'SINCE_CLOSE_LEAD_ENABLED', 'SHORT_EXECUTIVE_SUMMARY_ENABLED', 'MODEL_CHOICE_ENABLED',
  'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED', 'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

async function withEnv(values, callback) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function count(text, part) {
  return text.split(part).length - 1;
}

const ACTIVE_CASES = MARKET_STATE_CASES.filter(([state]) => ACTIVE_MARKET_STATES.has(state));
const COMPLETED_CASES = MARKET_STATE_CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state));

// The four Section 1 parts of the live since-close lead: [b7a5bb1 text (switch off), new text (on)].
// An independent copy: the code's constants are not imported.
const FOUR_PARTS = [
  ['Open Section 1 and Section 2 with what has happened since the last close, taken only from ',
    'Open Section 2 with what has happened since the last close, taken only from '],
  ['This order is required, not optional, and it overrides any other instruction or example about how '
    + 'Sections 1 and 2 begin. ',
  'This order is required, not optional, and it overrides any other instruction or example about how '
    + 'Section 2 begins. '],
  ['Section 1 order: the first sentence of Section 1 must report a since-close item with its publishedEt '
    + 'day and time; never open Section 1 with the close or with index figures. Section 1 ends with '
    + 'exactly one short last sentence on the last completed session, as where we left off: that one '
    + 'sentence gives the S&P 500, the NASDAQ Composite and the Dow Jones Industrial Average, each with '
    + 'its points and percentage in the index movement pattern, and no other detail about that session. '
    + 'Give no other index figures from the close in Section 1. That one sentence may run over 25 words. ',
  'Section 1 order: Section 1 follows the Section 1 summary instruction: start with what has changed '
    + 'since the last close, by theme, with no publish times and no "reported at"; end with the one index '
    + 'sentence (live figures where supplied, then where we left off). '],
  ['Section 1: "At [time] ET on [day], [Publisher] reported that [since-close fact]. At [time] ET, '
    + '[Publisher] reported that [second since-close fact]. Where we left off: at the close on [day], '
    + '[Index A] [gained/fell] by [points] points ([percent]%) to [level], [Index B] [gained/fell] by '
    + '[points] points ([percent]%) to [level] and [Index C] [gained/fell] by [points] points '
    + '([percent]%) to [level]." ',
  'Section 1: "[First since-close theme, in plain words]. [Second since-close theme]. [The overall '
    + 'mood]. [Live index figures where supplied]; where we left off: at the close on [day], [Index A] '
    + '[gained/fell] by [points] points ([percent]%) to [level], [Index B] [gained/fell] by [points] '
    + 'points ([percent]%) to [level] and [Index C] [gained/fell] by [points] points ([percent]%) to '
    + '[level]." ']
];

// The Section 2 lead, word for word as at b7a5bb1 (it must stay in the new request).
const SECTION_TWO_LEAD = 'Section 2 order: the first sentence of Section 2 must give the main since-close '
  + 'driver with its publishedEt day and time. Drivers from the last completed session come only after '
  + 'every since-close driver, each marked as from the close, for example "At the close on [day], ...". ';
const SECTION_TWO_EXAMPLE = 'Section 2: "At [time] ET on [day], [Publisher] reported that [main since-close '
  + 'driver]. [Publisher] said [cause stated in that article]. At the close on [day], [close-session driver '
  + 'from a cited article]."';

// The model settings a writer request can be built under.
const MODEL_SETUPS = [
  ['default model', {}],
  ['Haiku 4.5', {CLAUDE_MODEL: 'haiku-4.5'}],
  ['Haiku 5.5', {CLAUDE_MODEL: 'haiku-5.5'}],
  ['Haiku 5.5 depth off', {CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'}],
  ['9Z off', {SHORT_EXECUTIVE_SUMMARY_ENABLED: 'off'}]
];

// sha256 of JSON.stringify(writer request) with the switch on, recorded at the Step 9Z.1 build,
// per live fixture state: the default model and Haiku 5.5. These pin the NEW live request; the
// wrapped Step 9AE.2/9AF/9AG/9AH/9AI tests keep pinning the old one with the switch off.
// The three haiku55 values were re-recorded at Step 9AR.2 (one added Section 4 sentence with
// readerWordingEnabled on; the 9AQ test in tests/reader-wording-focus-pointer.test.js checks that
// it is the only difference). The default values are unchanged.
const NEW_LIVE_REQUEST_9Z1 = Object.freeze({
  PRE: {default: 'cb7152d6210f8ae2d2564b8aef4bf345677e236897efc2af377b68529e654938',
    haiku55: '6c392126dfd2db7ca82fc743eb81b3e280cfc0edfdc0b627dcac6c07eb96c987'},
  REGULAR: {default: 'f32cbc8b5a5d2602a6c4b37235ea8425407b025c5a4bfd7dd6a1654d47f0e9c1',
    haiku55: 'ce189aceaf2696b7a2a34a828b38364c3ef56a1513a98e60ec24a7bc3dc41147'},
  POST: {default: 'db94828b2d61ba1737376ac3ba99bbf9041bd5c9cb382cd6afe64264370b05b5',
    haiku55: 'b50ab5cf68ada285b986d6981f44c18a859c457031dfade6120973656270180e'}
});

// --- setting ----------------------------------------------------------------

test('Step 9Z.1: liveThemedSummaryEnabled is one Admin on/off switch, default on, after executiveSummaryGuideWords', () => {
  const entry = SETTINGS_REGISTRY.liveThemedSummaryEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('liveThemedSummaryEnabled'), names.indexOf('executiveSummaryGuideWords') + 1);
  for (const value of ['off', 'false', '0']) assert.equal(settingValue('liveThemedSummaryEnabled', {env: {[ENV]: value}}), false);
  for (const value of ['on', 'true', '1']) assert.equal(settingValue('liveThemedSummaryEnabled', {env: {[ENV]: value}}), true);
  assert.equal(settingValue('liveThemedSummaryEnabled', {env: {}}), true);
});

// --- the new live request (switch on) ----------------------------------------

for (const [marketState, ...times] of ACTIVE_CASES) {
  test(`Step 9Z.1: ${marketState} -- switch on, the lead opens only Section 2 with timed items and Section 1 is themed`, async () => {
    const {input} = marketStateCase(marketState, ...times);
    const {system} = await withEnv({}, () => buildClaudeAnalysisRequest(input));
    const lead = system.slice(system.indexOf('SINCE-THE-CLOSE LEAD'));
    for (const [, now] of FOUR_PARTS) assert.equal(count(lead, now), 1, `${marketState}: ${now}`);
    for (const [old] of FOUR_PARTS) assert.equal(lead.includes(old), false, `${marketState}: ${old}`);
    for (const gone of ['Open Section 1 and Section 2', 'Sections 1 and 2 begin',
      'the first sentence of Section 1 must report a since-close item',
      'never open Section 1 with the close or with index figures'])
      assert.equal(lead.includes(gone), false, `${marketState}: ${gone}`);
    // Section 2's timed lead and its half of the example are unchanged, word for word.
    assert.equal(count(lead, SECTION_TWO_LEAD), 1, marketState);
    assert.equal(system.endsWith(SECTION_TWO_EXAMPLE), true, marketState);
    assert.ok(lead.indexOf('Section 1 order:') < lead.indexOf('Section 2 order:'), marketState);
    // The Section 1 half of the example: themes, then the one index sentence; no times, no digits.
    const example = lead.slice(lead.indexOf('Format example only'));
    const sectionOne = example.slice(example.indexOf('Section 1:') + 'Section 1:'.length,
      example.indexOf('Section 2:'));
    assert.equal(/\d/.test(sectionOne), false, marketState);
    assert.equal(sectionOne.includes('[time]'), false, marketState);
    assert.equal(sectionOne.includes('reported'), false, marketState);
    assert.ok(sectionOne.indexOf('[First since-close theme') < sectionOne.indexOf('where we left off'), marketState);
    // The 8P.2(a) active line, the cause and source rules and Section 3 lead are still there once.
    for (const kept of ['open Section 1 and Section 2 by describing the current session itself',
      'Never present a since-close article as the cause of the earlier completed-session move.',
      'Naming sources, in every section:', 'In Section 3, discuss first the companies and sectors',
      'Section 4 causes:', 'Use the publishedEt time; do not work out times yourself.'])
      assert.equal(count(system, kept), 1, `${marketState}: ${kept}`);
  });

  test(`Step 9Z.1: ${marketState} -- switch on is the switch-off request with only the four Section 1 parts swapped, under every model setting`, async () => {
    const {input} = marketStateCase(marketState, ...times);
    for (const [label, env] of MODEL_SETUPS) {
      const on = await withEnv(env, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
      const off = await withEnv({...env, [ENV]: 'off'}, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
      let swapped = off;
      for (const [old, now] of FOUR_PARTS) {
        const oldJson = JSON.stringify(old).slice(1, -1);
        assert.equal(count(swapped, oldJson), 1, `${marketState} ${label}: ${old}`);
        swapped = swapped.replace(oldJson, () => JSON.stringify(now).slice(1, -1));
      }
      assert.equal(on, swapped, `${marketState} ${label}`);
      // The user message (the projected package) is the same either way.
      assert.equal(JSON.parse(on).messages[0].content, JSON.parse(off).messages[0].content, label);
    }
  });

  test(`Step 9Z.1: ${marketState} -- the new live request is pinned (default model and Haiku 5.5)`, async () => {
    const {input} = marketStateCase(marketState, ...times);
    const pinned = NEW_LIVE_REQUEST_9Z1[marketState];
    assert.equal(fingerprint(await withEnv({}, () => buildClaudeAnalysisRequest(input))), pinned.default,
      `${marketState} default`);
    assert.equal(fingerprint(await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input))),
      pinned.haiku55, `${marketState} Haiku 5.5`);
  });
}

test('Step 9Z.1: with no article after the close the one-sentence note is the same on and off', async () => {
  for (const [marketState, generatedAt, overlayAsOf] of ACTIVE_CASES) {
    const input = activeUsInput({marketState, generatedAt, overlayAsOf, currentPublishedAt: '2026-08-01T00:00:00.000Z'});
    const on = await withEnv({}, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    const off = await withEnv({[ENV]: 'off'}, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    assert.equal(on, off, marketState);
    assert.equal(on.includes('SINCE-THE-CLOSE LEAD: no admitted article was published'), true, marketState);
  }
});

test('Step 9Z.1: with sinceCloseLeadEnabled off the live request is the same on and off', async () => {
  for (const [marketState, ...times] of ACTIVE_CASES) {
    const {input} = marketStateCase(marketState, ...times);
    const on = await withEnv({SINCE_CLOSE_LEAD_ENABLED: 'off'}, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    const off = await withEnv({SINCE_CLOSE_LEAD_ENABLED: 'off', [ENV]: 'off'},
      () => JSON.stringify(buildClaudeAnalysisRequest(input)));
    assert.equal(on, off, marketState);
  }
});

test('Step 9Z.1: CLOSED, WEEKEND and HOLIDAY requests are byte-identical on and off, under every model setting', async () => {
  for (const [marketState, ...times] of COMPLETED_CASES) {
    const {input} = marketStateCase(marketState, ...times);
    for (const [label, env] of MODEL_SETUPS) {
      const on = await withEnv(env, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
      const off = await withEnv({...env, [ENV]: 'off'}, () => JSON.stringify(buildClaudeAnalysisRequest(input)));
      assert.equal(on, off, `${marketState} ${label}`);
      for (const [, now] of FOUR_PARTS) assert.equal(on.includes(JSON.stringify(now).slice(1, -1)), false, label);
    }
  }
});

// --- the live repeat cut (sinceCloseRepeatCut, live mode) ---------------------

function reportSections(sectionOne, sectionTwo, others = 'Supported analysis.') {
  return Array.from({length: 8}, (_, index) => ({
    name: `S${index + 1}`,
    content: index === 0 ? sectionOne : index === 1 ? sectionTwo : index === 7 ? null : others,
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
}

const LIVE_ITEM = {homeSectionIndex: 1, publishedEt: 'Tue 8 Sep, 10:30 am ET', subjects: ['Microsoft']};

test('Step 9Z.1: live mode trims a Section 1 time repeat and a subject-plus-figure repeat, and keeps the rest', () => {
  const sectionTwo = 'At 10:30 am ET on Tue 8 Sep, Yahoo Finance reported that Microsoft raised its outlook. '
    + 'Microsoft shares were 3% higher.';
  const sections = reportSections('Technology news has led since the close. '
    + 'At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook. '
    + 'Microsoft is 3% higher. The mood is steady.', sectionTwo);
  const cut = sinceCloseRepeatCut(sections, [LIVE_ITEM], splitReportSentences, null, {live: true});
  assert.equal(cut.sections[0].content, 'Technology news has led since the close. The mood is steady.');
  assert.deepEqual(cut.removed, {0: 2});
  assert.deepEqual(cut.keptToAvoidBlank, []);
  assert.equal(cut.sections[1], sections[1]);
});

test('Step 9Z.1: live mode never touches Sections 2-8, even when they carry the time', () => {
  const timed = 'At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook. Other text.';
  const sections = reportSections('A theme sentence.', timed, timed);
  const cut = sinceCloseRepeatCut(sections, [LIVE_ITEM], splitReportSentences, null, {live: true});
  for (let index = 0; index < 8; index++) assert.equal(cut.sections[index], sections[index], `section ${index + 1}`);
  assert.deepEqual(cut.removed, {});
});

test('Step 9Z.1: live mode keeps the index sentence that names the S&P 500, NASDAQ and Dow, even with the time', () => {
  const index = 'At 10:30 am ET the S&P 500 was up 0.4%, the NASDAQ Composite up 0.8% and the Dow Jones '
    + 'Industrial Average down 0.6%.';
  const sections = reportSections(`A theme sentence. ${index}`, 'At 10:30 am ET Microsoft rose 0.4%.');
  const cut = sinceCloseRepeatCut(sections, [LIVE_ITEM], splitReportSentences, null, {live: true});
  assert.equal(cut.sections[0], sections[0]);
  // Naming only two of the three is not the index sentence.
  const two = reportSections('A theme sentence. At 10:30 am ET the S&P 500 and the NASDAQ rose.', 'x.');
  assert.equal(sinceCloseRepeatCut(two, [LIVE_ITEM], splitReportSentences, null, {live: true})
    .sections[0].content, 'A theme sentence.');
});

test('Step 9Z.1: live mode never blanks Section 1', () => {
  const sections = reportSections('At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook.',
    'At 10:30 am ET Microsoft rose.');
  const cut = sinceCloseRepeatCut(sections, [LIVE_ITEM], splitReportSentences, null, {live: true});
  assert.equal(cut.sections[0], sections[0]);
  assert.deepEqual(cut.keptToAvoidBlank, [0]);
  assert.deepEqual(cut.removed, {});
});

test('Step 9Z.1: without the live option the completed-day cut is unchanged', () => {
  const items = [{homeSectionIndex: 0, publishedEt: 'Fri 4 Sep, 5:10 pm ET', subjects: ['Apple']}];
  const sections = reportSections('Closing analysis. At 5:10 pm ET Apple reported results.',
    'Closing driver. At 5:10 pm ET Apple reported results.', 'Apple results at 5:10 pm ET. Other text.');
  const plain = sinceCloseRepeatCut(sections, items, splitReportSentences);
  const explicit = sinceCloseRepeatCut(sections, items, splitReportSentences, null, {live: false});
  assert.deepEqual(explicit, plain);
  assert.deepEqual(plain.removed, {1: 1, 2: 1, 6: 1});
});

// --- the live cleanup in a full (mocked) writer call --------------------------

const PLANTED_ONE = 'Technology news has led the session since the close. '
  + 'At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook. '
  + 'Microsoft shares are 3% higher. '
  + 'The mood is steady.';
const PLANTED_TWO = 'At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook. '
  + 'Microsoft shares are 3% higher.';

async function plantedRun(env, input = activeUsInput()) {
  const output = normalOutput(input);
  output.sections[0] = {...output.sections[0], content: PLANTED_ONE};
  output.sections[1] = {...output.sections[1], content: PLANTED_TWO};
  const diagnostics = [];
  const result = await withEnv(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  }));
  return {result, events: diagnostics.filter(value => value.stage === 'liveSinceCloseRepeatCleanup')};
}

test('Step 9Z.1: a planted timed list in Section 1 is trimmed; Section 2 is untouched; nothing is blanked', async () => {
  const {result, events} = await plantedRun({});
  assert.equal(result.ok, true);
  assert.equal(result.output.sections[0].content, 'Technology news has led the session since the close. '
    + 'The mood is steady.');
  assert.equal(result.output.sections[1].content, PLANTED_TWO);
  assert.deepEqual(events, [{stage: 'liveSinceCloseRepeatCleanup', sectionIndex: 0,
    violationCategory: 'LIVE_SINCE_CLOSE_REPEAT', action: 'TRIMMED', marketState: 'REGULAR',
    removedSentenceCount: 2}]);
});

test('Step 9Z.1: switch off, or sinceCloseLeadEnabled off, the planted reply keeps Section 1 and logs nothing', async () => {
  for (const env of [{[ENV]: 'off'}, {SINCE_CLOSE_LEAD_ENABLED: 'off'}]) {
    const {result, events} = await plantedRun(env);
    assert.equal(result.ok, true);
    assert.equal(result.output.sections[0].content, PLANTED_ONE, JSON.stringify(env));
    assert.equal(result.output.sections[1].content, PLANTED_TWO, JSON.stringify(env));
    assert.deepEqual(events, [], JSON.stringify(env));
  }
});

test('Step 9Z.1: a Section 1 made only of repeats is kept as written and logged KEPT_TO_AVOID_BLANK', async () => {
  const input = activeUsInput();
  const output = normalOutput(input);
  output.sections[0] = {...output.sections[0],
    content: 'At 10:30 am ET Yahoo Finance reported that Microsoft raised its outlook.'};
  output.sections[1] = {...output.sections[1], content: PLANTED_TWO};
  const diagnostics = [];
  const result = await withEnv({}, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
    onDiagnostics: value => diagnostics.push(value)
  }));
  assert.equal(result.output.sections[0].content, output.sections[0].content);
  assert.deepEqual(diagnostics.filter(value => value.stage === 'liveSinceCloseRepeatCleanup'),
    [{stage: 'liveSinceCloseRepeatCleanup', sectionIndex: 0, violationCategory: 'LIVE_SINCE_CLOSE_REPEAT',
      action: 'KEPT_TO_AVOID_BLANK', marketState: 'REGULAR'}]);
});

test('Step 9Z.1: completed days never run the live cleanup, and their results are the same on and off', async () => {
  for (const [marketState, ...times] of COMPLETED_CASES) {
    const {input, output} = marketStateCase(marketState, ...times);
    const run = async env => {
      const diagnostics = [];
      const result = await withEnv(env, () => invokeClaudeAnalysis({
        input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
        onDiagnostics: value => diagnostics.push(value)
      }));
      return {result, diagnostics};
    };
    const on = await run({});
    const off = await run({[ENV]: 'off'});
    assert.equal(on.diagnostics.some(value => value.stage === 'liveSinceCloseRepeatCleanup'), false, marketState);
    assert.deepEqual(on.result, off.result, marketState);
  }
});

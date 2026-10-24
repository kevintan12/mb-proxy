// Step 9Z: Section 1 as a summary by theme with a soft length guide (switch
// shortExecutiveSummaryEnabled, default on; guide executiveSummaryGuideWords, default 150).
// Free tests only: no network, no paid call. Every reply here is made up.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {withEnv} = require('./fixtures/step-8w-switches');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  marketStateCase,
  anthropicResponse
} = require('./fixtures/market-state-cases');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {splitReportSentences} = require('../lib/claude-analysis-contract');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {sectionOneLength} = require('../lib/section-rules');

const ENV = 'SHORT_EXECUTIVE_SUMMARY_ENABLED';
const GUIDE_ENV = 'EXECUTIVE_SUMMARY_GUIDE_WORDS';
const on = fn => withEnv(ENV, 'on', fn);
const off = fn => withEnv(ENV, 'off', fn);
const OLD_LINE_START = 'For Section 1 EXECUTIVE MARKET SUMMARY, write two or three concise paragraphs';
const NEW_LINE_START = 'For Section 1 EXECUTIVE MARKET SUMMARY, write a true summary of the market\'s story organised by theme';

function systemFor(input) {
  return buildClaudeAnalysisRequest(input).system;
}

// The one sentence-level difference between two system texts, as [before, after].
function onlyDifference(before, after) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return [before.slice(start, endBefore), after.slice(start, endAfter)];
}

// --- settings ---------------------------------------------------------------

test('Step 9Z: the switch and the soft guide are registered Admin settings next to sinceCloseFixesEnabled', () => {
  const entry = SETTINGS_REGISTRY.shortExecutiveSummaryEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  const guide = SETTINGS_REGISTRY.executiveSummaryGuideWords;
  assert.deepEqual([guide.default, guide.min, guide.max, guide.admin, guide.envVar, guide.wired],
    [150, 60, 300, 'Admin', GUIDE_ENV, true]);
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('shortExecutiveSummaryEnabled'), names.indexOf('sinceCloseFixesEnabled') + 1);
  assert.equal(names.indexOf('executiveSummaryGuideWords'), names.indexOf('shortExecutiveSummaryEnabled') + 1);
  assert.equal(settingValue('executiveSummaryGuideWords', {env: {[GUIDE_ENV]: '59'}}), 60);
  assert.equal(settingValue('executiveSummaryGuideWords', {env: {[GUIDE_ENV]: '301'}}), 300);
  assert.equal(settingValue('executiveSummaryGuideWords', {env: {[GUIDE_ENV]: 'abc'}}), 150);
});

// --- writer instruction -----------------------------------------------------

test('Step 9Z: switch off, every state keeps the old Section 1 line and no new wording', () => off(async () => {
  for (const [marketState, ...times] of MARKET_STATE_CASES) {
    for (const bothLists of ['on', 'off']) {
      await withEnv('SECTION_FOUR_BOTH_LISTS_ENABLED', bothLists, () => {
        const system = systemFor(marketStateCase(marketState, ...times).input);
        assert.equal(system.split(OLD_LINE_START).length, 2, `${marketState} ${bothLists}`);
        assert.equal(system.includes('organised by theme'), false, marketState);
        assert.equal(system.includes('words as a guide'), false, marketState);
      });
    }
  }
}));

test('Step 9Z: switch on, exactly the Section 1 line changes, in every state and both Section 4 prompts', async () => {
  for (const [marketState, ...times] of MARKET_STATE_CASES) {
    for (const bothLists of ['on', 'off']) {
      await withEnv('SECTION_FOUR_BOTH_LISTS_ENABLED', bothLists, async () => {
        const input = marketStateCase(marketState, ...times).input;
        const before = await off(() => systemFor(input));
        const after = await on(() => systemFor(input));
        const [removed, added] = onlyDifference(before, after);
        const label = `${marketState} both-lists ${bothLists}`;
        assert.equal(after.split(NEW_LINE_START).length, 2, label);
        assert.equal(after.includes(OLD_LINE_START), false, label);
        assert.equal(added.includes('about 150 words as a guide; write more if the themes need it; never pad'), true, label);
        assert.equal(/\bexactly\b|\bmaximum\b/i.test(added), false, label);
        assert.equal(/two or three concise paragraphs/.test(removed), true, label);
        assert.equal(after.replace(added, removed), before, label);
      });
    }
  }
});

test('Step 9Z: the new line names the themes, the one index sentence and the since-close exemption', () => on(() => {
  const [marketState, ...times] = MARKET_STATE_CASES[3];
  const system = systemFor(marketStateCase(marketState, ...times).input);
  for (const phrase of [
    'the semiconductor industry, the automobile industry, artificial intelligence in general, and any other major significant news',
    'Cover only the themes the supplied evidence supports',
    'Never invent a theme or add one to fill the section',
    'Leave the detail, causes and figures behind each theme to Section 2 KEY MARKET DRIVERS',
    'the S&P 500, the NASDAQ Composite and the Dow Jones Industrial Average together in one sentence',
    'that sentence may run over 25 words',
    'the since-the-close paragraph, its pointer sentence and the fixed no-news sentence are outside this guide',
    'Avoid low-value repetition and padding.'
  ]) assert.equal(system.includes(phrase), true, phrase);
}));

test('Step 9Z: the guide number comes from the Admin setting and is clamped', () => on(async () => {
  const [marketState, ...times] = MARKET_STATE_CASES[0];
  const input = marketStateCase(marketState, ...times).input;
  for (const [value, expected] of [['200', 200], ['10', 60], ['999', 300], ['abc', 150]]) {
    await withEnv(GUIDE_ENV, value, () => {
      assert.equal(systemFor(input).includes(`about ${expected} words as a guide`), true, value);
    });
  }
}));

test('Step 9Z: the since-close fixes switch on or off leaves only the Section 1 line different', async () => {
  for (const fixes of ['on', 'off']) {
    await withEnv('SINCE_CLOSE_FIXES_ENABLED', fixes, async () => {
      for (const [marketState, ...times] of MARKET_STATE_CASES) {
        const input = marketStateCase(marketState, ...times).input;
        const before = await off(() => systemFor(input));
        const after = await on(() => systemFor(input));
        const [removed, added] = onlyDifference(before, after);
        assert.equal(removed.includes('two or three concise paragraphs'), true, `${fixes} ${marketState}`);
        assert.equal(added.includes('words as a guide'), true, `${fixes} ${marketState}`);
        assert.equal(after.replace(added, removed), before, `${fixes} ${marketState}`);
      }
    });
  }
});

// --- the length counter -----------------------------------------------------

const INDEX_SENTENCE = 'The S&P 500 fell 39.75 points (0.52%) to 7,623.68, the NASDAQ Composite fell 53.52 points '
  + '(0.21%) to 25,955.34 and the Dow Jones Industrial Average fell 652.82 points (1.23%) to 52,215.16.';
const words = text => text.trim().split(/\s+/).length;

test('Step 9Z: the counter counts words, sentences and the three index names', () => {
  const story = 'Chip stocks rose on strong demand. Car makers fell.';
  const result = sectionOneLength({content: `${story} ${INDEX_SENTENCE}`}, null, splitReportSentences);
  assert.deepEqual(result, {
    words: words(`${story} ${INDEX_SENTENCE}`), guidedWords: words(`${story} ${INDEX_SENTENCE}`),
    sinceCloseWords: 0, sentences: 3, indexNamesFound: 3
  });
  assert.equal(sectionOneLength({content: 'The Dow was quiet. Nasdaq names led.'}, null,
    splitReportSentences).indexNamesFound, 0);
  assert.equal(sectionOneLength({content: 'The Nasdaq rose 1%.'}, null, splitReportSentences).indexNamesFound, 1);
});

test('Step 9Z: on completed days timed since-close, pointer and no-news sentences are outside the guide', () => {
  const timed = 'At 11:36 pm ET on Friday, Reuters reported that Bloom Energy shares fell 10%.';
  const pointer = 'After the close, Apple and Intel reported results (see Stocks & Sectors in Focus).';
  const noNews = 'No new market news has been published since the close on Fri 23 Oct, 4:00 pm ET.';
  const story = 'Energy shares rose. Chip stocks were mixed.';
  const content = `${noNews} ${story} ${INDEX_SENTENCE}\n${timed} ${pointer}`;
  const items = [{publishedEt: 'Fri 23 Oct, 11:36 pm ET'}];
  const result = sectionOneLength({content}, items, splitReportSentences);
  assert.equal(result.words, words(content));
  assert.equal(result.sinceCloseWords, words(noNews) + words(timed) + words(pointer));
  assert.equal(result.guidedWords, words(story) + words(INDEX_SENTENCE));
  // The same text on an active day: everything is part of the story.
  const active = sectionOneLength({content}, null, splitReportSentences);
  assert.equal(active.sinceCloseWords, 0);
  assert.equal(active.guidedWords, active.words);
  // A completed day with no items still keeps the pointer and no-news sentences outside.
  assert.equal(sectionOneLength({content}, [], splitReportSentences).sinceCloseWords,
    words(noNews) + words(pointer));
});

test('Step 9Z: an empty or null Section 1 counts as zero', () => {
  for (const section of [{content: null}, {content: ''}, {content: '   '}, null, undefined]) {
    assert.deepEqual(sectionOneLength(section, [], splitReportSentences),
      {words: 0, guidedWords: 0, sinceCloseWords: 0, sentences: 0, indexNamesFound: 0});
  }
});

// --- the log line -----------------------------------------------------------

async function invokeLogged(input, replies) {
  const diagnostics = [];
  const bodies = [];
  let call = 0;
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return anthropicResponse(replies[Math.min(call++, replies.length - 1)]);
    },
    onDiagnostics: value => diagnostics.push(value)
  });
  return {result, diagnostics, bodies};
}

test('Step 9Z: switch on, one sectionOneLength line per finished report in every state; Section 1 unchanged', async () => {
  for (const [marketState, ...times] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(marketState, ...times);
    const longContent = `${output.sections[0].content} ${'Stocks moved. '.repeat(120).trim()}`;
    const reply = {...output, sections: output.sections.map((section, index) =>
      index === 0 ? {...section, content: longContent} : section)};
    const {result, diagnostics} = await on(() => invokeLogged(input, [reply]));
    const lines = diagnostics.filter(value => value.stage === 'sectionOneLength');
    assert.equal(lines.length, 1, marketState);
    const line = lines[0];
    assert.deepEqual(Object.keys(line), ['stage', 'marketState', 'guideWords', 'words', 'guidedWords',
      'sinceCloseWords', 'sentences', 'indexNamesFound', 'aboveGuide'], marketState);
    assert.equal(line.marketState, marketState);
    assert.equal(line.guideWords, 150);
    assert.equal(line.aboveGuide, true, marketState);
    if (ACTIVE_MARKET_STATES.has(marketState)) assert.equal(line.sinceCloseWords, 0, marketState);
    // Logged only: nothing in Section 1 is cut.
    assert.equal(result.ok, true, marketState);
    assert.equal(result.output.sections[0].content.endsWith('Stocks moved.'), true, marketState);
    assert.equal(line.words, words(result.output.sections[0].content), marketState);
  }
});

test('Step 9Z: switch off, no sectionOneLength line and the same report', async () => {
  for (const [marketState, ...times] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(marketState, ...times);
    const offRun = await off(() => invokeLogged(input, [output]));
    const onRun = await on(() => invokeLogged(input, [output]));
    assert.equal(offRun.diagnostics.some(value => value.stage === 'sectionOneLength'), false, marketState);
    assert.deepEqual(onRun.result, offRun.result, marketState);
  }
});

test('Step 9Z: a section-retry round carries the new line and the length line comes after it', () => on(async () => {
  const [marketState, ...times] = MARKET_STATE_CASES[1];
  const {input, output} = marketStateCase(marketState, ...times);
  const withEmptySeven = {...output, status: 'DEGRADED', evidenceGaps: ['Not enough news for the outlook.'],
    sections: output.sections.map((section, index) => index === 6
      ? {...section, content: null, evidenceRefs: [], telemetryRefs: [], uncertainties: ['No outlook news.']}
      : section)};
  const {diagnostics, bodies} = await invokeLogged(input, [withEmptySeven, output]);
  assert.equal(bodies.length >= 2, true);
  for (const body of bodies) assert.equal(body.system.includes(NEW_LINE_START), true);
  const stages = diagnostics.map(value => value.stage);
  const lengthIndex = stages.indexOf('sectionOneLength');
  assert.equal(stages.filter(stage => stage === 'sectionOneLength').length, 1);
  assert.equal(lengthIndex, stages.length - 1);
}));

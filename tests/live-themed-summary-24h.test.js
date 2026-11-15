// Step 9Z.1a: on live days (liveThemedSummaryEnabled on) the Section 1 repeat cleanup also trims a
// sentence that gives a since-close item's publish time in its exact 24-hour form. Completed days
// and the switch-off path are unchanged. Free tests only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {activeUsInput, normalOutput, anthropicResponse} = require('./fixtures/market-state-cases');
const {splitReportSentences} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {sinceCloseRepeatCut} = require('../lib/section-rules');

const ENV = 'LIVE_THEMED_SUMMARY_ENABLED';

function reportSections(sectionOne, sectionTwo, others = 'Supported analysis.') {
  return Array.from({length: 8}, (_, index) => ({
    name: `S${index + 1}`,
    content: index === 0 ? sectionOne : index === 1 ? sectionTwo : index === 7 ? null : others,
    evidenceRefs: [], telemetryRefs: [], uncertainties: []
  }));
}

const THEME = 'Chip stocks led the theme since the close.';
const item = publishedEt => ({homeSectionIndex: 1, publishedEt, subjects: ['Microsoft']});
const live = (sectionOne, items, sectionTwo = 'A Section 2 driver.') =>
  sinceCloseRepeatCut(reportSections(`${THEME} ${sectionOne}`, sectionTwo), items, splitReportSentences, null, {live: true});

test('Step 9Z.1a: a pm item is trimmed in its exact 24-hour form only', () => {
  const pm = [item('Tue 8 Sep, 4:30 pm ET')];
  for (const sentence of ['At 16:30 ET a report said demand held.', 'A 16:30 report said demand held.']) {
    const cut = live(sentence, pm);
    assert.equal(cut.sections[0].content, THEME, sentence);
    assert.deepEqual(cut.removed, {0: 1}, sentence);
  }
  for (const sentence of ['At 4:30 ET a report said demand held.', 'At 14:30 ET a report said demand held.',
    'At 116:30 ET a report said demand held.', 'At 16:305 ET a report said demand held.',
    'At 16:31 ET a report said demand held.']) {
    assert.deepEqual(live(sentence, pm).removed, {}, sentence);
  }
});

test('Step 9Z.1a: an am item is trimmed as 04:30 or 4:30 without am/pm, never as 16:30 or 4:30 pm', () => {
  const am = [item('Tue 8 Sep, 4:30 am ET')];
  for (const sentence of ['At 04:30 ET a report said demand held.', 'At 4:30 ET a report said demand held.']) {
    assert.deepEqual(live(sentence, am).removed, {0: 1}, sentence);
  }
  for (const sentence of ['At 16:30 ET a report said demand held.', 'At 4:30 pm ET a report said demand held.',
    'At 4:30 p.m. ET a report said demand held.', 'At 14:30 ET a report said demand held.']) {
    assert.deepEqual(live(sentence, am).removed, {}, sentence);
  }
});

test('Step 9Z.1a: 12 am is 00:mm or 0:mm, 12 pm is 12:mm', () => {
  const midnight = [item('Tue 8 Sep, 12:05 am ET')];
  assert.deepEqual(live('At 00:05 ET a report said demand held.', midnight).removed, {0: 1});
  assert.deepEqual(live('At 0:05 ET a report said demand held.', midnight).removed, {0: 1});
  assert.deepEqual(live('At 12:05 ET a report said demand held.', midnight).removed, {});
  const noon = [item('Tue 8 Sep, 12:05 pm ET')];
  assert.deepEqual(live('At 12:05 ET a report said demand held.', noon).removed, {0: 1});
  assert.deepEqual(live('At 00:05 ET a report said demand held.', noon).removed, {});
});

test('Step 9Z.1a: the 12-hour forms are still trimmed', () => {
  const pm = [item('Tue 8 Sep, 4:30 pm ET')];
  for (const sentence of ['At 4:30 pm ET a report said demand held.', 'At 4:30 p.m. ET a report said demand held.',
    'At 4:30PM ET a report said demand held.', 'On Tue 8 Sep, 4:30 pm ET a report said demand held.']) {
    assert.deepEqual(live(sentence, pm).removed, {0: 1}, sentence);
  }
});

test('Step 9Z.1a: Section 1 made only of 24-hour repeats is kept and reported; the index sentence is kept', () => {
  const pm = [item('Tue 8 Sep, 4:30 pm ET')];
  const only = sinceCloseRepeatCut(reportSections('At 16:30 ET a report said demand held. A 16:30 ET note agreed.',
    'x.'), pm, splitReportSentences, null, {live: true});
  assert.deepEqual(only.removed, {});
  assert.deepEqual(only.keptToAvoidBlank, [0]);
  const index = 'At 16:30 ET the S&P 500 was up 0.4%, the NASDAQ Composite up 0.8% and the Dow Jones '
    + 'Industrial Average down 0.6%.';
  assert.deepEqual(live(index, pm).removed, {});
});

test('Step 9Z.1a: Section 2 is never touched, even when it gives the 24-hour time', () => {
  const pm = [item('Tue 8 Sep, 4:30 pm ET')];
  const sections = reportSections(`${THEME} At 16:30 ET a report said demand held.`, 'At 16:30 ET Microsoft rose 3%.');
  const cut = sinceCloseRepeatCut(sections, pm, splitReportSentences, null, {live: true});
  assert.equal(cut.sections[0].content, THEME);
  for (let index = 1; index < 8; index++) assert.equal(cut.sections[index], sections[index], `section ${index + 1}`);
});

test('Step 9Z.1a: the completed-day cut does not use the 24-hour form', () => {
  const items = [{homeSectionIndex: 0, publishedEt: 'Fri 4 Sep, 5:10 pm ET', subjects: ['Apple']}];
  const sections = reportSections('Closing analysis.', 'Closing driver. At 17:10 ET Apple reported results.',
    'Apple results at 17:10 ET. Other text.');
  const plain = sinceCloseRepeatCut(sections, items, splitReportSentences);
  assert.deepEqual(plain.removed, {});
  assert.deepEqual(sinceCloseRepeatCut(sections, items, splitReportSentences, null, {live: false}), plain);
});

// --- in a full (mocked) writer call: the fixture's since-close item is 10:30 am ET -------------

async function run(env, sectionOne) {
  const input = activeUsInput();
  const output = normalOutput(input);
  output.sections[0] = {...output.sections[0], content: sectionOne};
  const diagnostics = [];
  const saved = process.env[ENV];
  if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, events: diagnostics.filter(value => value.stage === 'liveSinceCloseRepeatCleanup')};
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
}

test('Step 9Z.1a: a 24-hour repeat in a mocked live reply is trimmed on, kept off', async () => {
  const planted = 'Technology news has led the session since the close. '
    + 'At 10:30 ET Yahoo Finance reported that Microsoft raised its outlook. The mood is steady.';
  const on = await run(undefined, planted);
  assert.equal(on.result.ok, true);
  assert.equal(on.result.output.sections[0].content,
    'Technology news has led the session since the close. The mood is steady.');
  assert.deepEqual(on.events.map(event => [event.sectionIndex, event.action, event.removedSentenceCount]),
    [[0, 'TRIMMED', 1]]);
  const off = await run('off', planted);
  assert.equal(off.result.ok, true);
  assert.equal(off.result.output.sections[0].content, planted);
  assert.deepEqual(off.events, []);
});

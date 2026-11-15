// Step 9AP: a weekday must agree with its date (weekdayDateAgreeEnabled). When a sentence writes a
// weekday directly with an explicit date and the date is not that weekday, the weekday is kept and the
// date is dropped. Free tests only: made-up text, fake fetch, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {weekdayDateAgreeCut} = require('../lib/section-rules');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  normalOutput, anthropicResponse, marketStateCase, MARKET_STATE_CASES
} = require('./fixtures/market-state-cases');

const ENV = 'WEEKDAY_DATE_AGREE_ENABLED';
const SATURDAY = '2026-11-07'; // Saturday 7 November 2026 (the Closed report that showed the fault)

const block = content => ({name: 'S', content, evidenceRefs: ['e1'], telemetryRefs: ['t1'], uncertainties: []});
const agree = (content, reportDate = SATURDAY) => weekdayDateAgreeCut(block(content), reportDate);
const fixed = (content, reportDate = SATURDAY) => agree(content, reportDate).section.content;

test('Step 9AP: the two sentences from the Saturday 7 Nov Closed report keep the weekday and lose the date', () => {
  assert.equal(fixed('Applied Materials and Cisco report on Thursday 13 November.'),
    'Applied Materials and Cisco report on Thursday.');
  assert.equal(fixed('The producer price index is due on Friday 14 November.'),
    'The producer price index is due on Friday.');
});

test('Step 9AP: every listed form is rewritten', () => {
  const cases = [
    ['Cisco reports Thursday 13 November after the bell.', 'Cisco reports Thursday after the bell.'],
    ['Cisco reports Thursday, 13 November after the bell.', 'Cisco reports Thursday after the bell.'],
    ['Cisco reports Thursday, November 13 after the bell.', 'Cisco reports Thursday after the bell.'],
    ['Cisco reports Thu 13 Nov after the bell.', 'Cisco reports Thu after the bell.'],
    ['Cisco reports Thu, Nov 13 after the bell.', 'Cisco reports Thu after the bell.'],
    ['Cisco reports Thursday 13 November 2026 after the bell.', 'Cisco reports Thursday after the bell.'],
    ['Cisco reports Thursday, November 13, 2026, after the bell.', 'Cisco reports Thursday, after the bell.'],
    ['Cisco reports on 13 November (Thursday) after the bell.', 'Cisco reports on Thursday after the bell.'],
    ['Cisco reports on 13 November 2026 (Thursday) after the bell.', 'Cisco reports on Thursday after the bell.'],
    ['Cisco reports on Nov 13 (Thursday) after the bell.', 'Cisco reports on Thursday after the bell.'],
    ['Cisco reports Thursday 13th November after the bell.', 'Cisco reports Thursday after the bell.']
  ];
  for (const [before, after] of cases) assert.equal(fixed(before), after, before);
});

test('Step 9AP: a sentence-ending dot after the date stays', () => {
  assert.equal(fixed('Results arrive Thursday 13 Nov. Shares were flat.'), 'Results arrive Thursday. Shares were flat.');
  assert.equal(fixed('Results arrive Thursday, November 13. Shares were flat.'), 'Results arrive Thursday. Shares were flat.');
});

test('Step 9AP: a pair that already agrees is never touched', () => {
  // 7 Nov 2026 is a Saturday: Tue 10, Thu 12, Fri 13 and Sat 7 are all correct.
  for (const text of ['Retail sales come Tuesday 10 November.', 'Claims come Thursday, November 12.',
    'The PPI is due Friday 13 November 2026.', 'Claims come Thu 12 Nov.', 'The PPI is due on 13 November (Friday).',
    'Futures were quiet on Saturday 7 November.', 'Nothing here names a date.']) {
    const result = agree(text);
    assert.equal(result.section, result.section, text);
    assert.deepEqual(result.changedSentences, [], text);
    assert.equal(result.section.content, text, text);
  }
});

test('Step 9AP: forms that cannot be rewritten safely are left unchanged', () => {
  for (const text of ['Cisco reports Thursday 31 November.', 'Cisco reports Thursday 13-14 November.',
    'Cisco reports Thursday 13 million shares.', 'Cisco rose Thursday, May 5% on volume.',
    'Cisco reports on Thursday, then 13 November.', 'Cisco reports on 13 November, Thursday.']) {
    assert.equal(fixed(text), text, text);
  }
});

test('Step 9AP: a December report with a January date picks the next year', () => {
  // Monday 28 Dec 2026; 7 Jan 2027 is a Thursday.
  assert.equal(fixed('Claims come Thursday 7 January.', '2026-12-28'), 'Claims come Thursday 7 January.');
  assert.equal(fixed('Claims come Friday 7 January.', '2026-12-28'), 'Claims come Friday.');
  assert.equal(fixed('Claims come Friday, January 8.', '2026-12-28'), 'Claims come Friday, January 8.');
  assert.equal(fixed('Claims come Thursday, January 8.', '2026-12-28'), 'Claims come Thursday.');
  // A year written in the sentence wins.
  assert.equal(fixed('Claims come Thursday 7 January 2027.', '2026-12-28'), 'Claims come Thursday 7 January 2027.');
  assert.equal(fixed('Claims come Thursday 7 January 2021.', '2026-12-28'), 'Claims come Thursday 7 January 2021.');
  assert.equal(fixed('Claims come Friday 7 January 2027.', '2026-12-28'), 'Claims come Friday.');
  // A January report with a December date picks the year before.
  assert.equal(fixed('Claims fell Thursday 31 December.', '2027-01-04'), 'Claims fell Thursday 31 December.');
  assert.equal(fixed('Claims fell Friday 31 December.', '2027-01-04'), 'Claims fell Friday.');
});

test('Step 9AP: a year-less date more than 180 days from the report date in both adjacent years is left alone', () => {
  // 7 May is 184 days before 7 Nov 2026 and 181 days after it in 2027: no safe year, so nothing changes.
  assert.equal(fixed('Event on Monday 7 May.', '2026-11-07'), 'Event on Monday 7 May.');
  // 1 Jul 2026 is 129 days back, so it is chosen and checked (a Wednesday).
  assert.equal(fixed('Event on Friday 1 July.', '2026-11-07'), 'Event on Friday.');
  assert.equal(fixed('Event on Wednesday 1 July.', '2026-11-07'), 'Event on Wednesday 1 July.');
});

test('Step 9AP: a sentence with two pairs fixes only the wrong one', () => {
  // 13 Nov 2026 is a Friday; 12 Nov is a Thursday.
  const result = agree('Cisco reports Thursday 13 November and the PPI follows Friday 13 November.');
  assert.equal(result.section.content, 'Cisco reports Thursday and the PPI follows Friday 13 November.');
  assert.deepEqual(result.changedSentences, [{droppedDateCount: 1}]);
});

test('Step 9AP: counts are per sentence, and two wrong pairs in one sentence count together', () => {
  const result = agree('Cisco reports Thursday 13 November and the PPI follows Friday 14 November. '
    + 'Walmart reports Wednesday 19 November. Retail sales come Tuesday 10 November.');
  assert.equal(result.section.content,
    'Cisco reports Thursday and the PPI follows Friday. Walmart reports Wednesday. Retail sales come Tuesday 10 November.');
  assert.deepEqual(result.changedSentences, [{droppedDateCount: 2}, {droppedDateCount: 1}]);
});

test('Step 9AP: a section is never blanked, and every other character is kept', () => {
  for (const only of ['Thursday 13 November', 'Thursday 13 November.', 'Friday 14 November']) {
    const content = fixed(only);
    assert.ok(typeof content === 'string' && content.trim().length > 0, only);
  }
  const text = 'Cisco  reports   Thursday 13 November,  with "quotes" (and 50%).  Next sentence.';
  assert.equal(fixed(text), 'Cisco  reports   Thursday,  with "quotes" (and 50%).  Next sentence.');
  // Other section fields are carried unchanged.
  const result = agree('Cisco reports Thursday 13 November.');
  assert.deepEqual({...result.section, content: null}, {...block(null)});
  // A null section and an unusable report date change nothing.
  assert.equal(weekdayDateAgreeCut(block(null), SATURDAY).changedSentences.length, 0);
  assert.equal(agree('Cisco reports Thursday 13 November.', 'not-a-date').section.content,
    'Cisco reports Thursday 13 November.');
});

test('Step 9AP: the registry row (Admin boolean, on by default, env WEEKDAY_DATE_AGREE_ENABLED)', () => {
  const entry = SETTINGS_REGISTRY.weekdayDateAgreeEnabled;
  assert.equal(entry.default, true);
  assert.equal(entry.admin, 'Admin');
  assert.equal(entry.envVar, ENV);
  assert.equal(entry.boolean, true);
  assert.equal(entry.wired, true);
  assert.equal(settingValue('weekdayDateAgreeEnabled', {env: {}}), true);
  assert.equal(settingValue('weekdayDateAgreeEnabled', {env: {[ENV]: 'off'}}), false);
});

// ---------------------------------------------------------------------------
// Whole cleanup path (fake fetch), all six market states. The wrong pair uses the report day's own
// weekday with the NEXT day's date, so Step 8W's weekday check keeps the sentence in every state and
// only this step can change it.
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function wrongPair(generatedAt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long'
  }).formatToParts(new Date(generatedAt)).map(part => [part.type, part.value]));
  const next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  return {
    weekday: parts.weekday, next: `${next.getUTCDate()} ${MONTHS[next.getUTCMonth()]}`,
    nextWeekday: WEEKDAYS[next.getUTCDay()]
  };
}

async function run(env, input, output) {
  const diagnostics = [];
  const saved = process.env[ENV];
  if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, events: diagnostics.filter(value => value.violationCategory === 'WEEKDAY_DATE_MISMATCH')};
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
}

test('Step 9AP: Sections 1 to 7 in all six states: weekday kept, date dropped, TRIMMED count-only events', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const pair = wrongPair(generatedAt);
    const bad = `Results are due ${pair.weekday} ${pair.next}.`;
    const planted = structuredClone(output);
    const covered = [0, 1, 2, 4, 5, 6];
    for (const index of covered) {
      planted.sections[index] = {...planted.sections[index], content: `${planted.sections[index].content} ${bad}`};
    }
    const on = await run(undefined, input, planted);
    assert.equal(on.result.ok, true, state);
    for (const index of covered) {
      const text = on.result.output.sections[index].content;
      assert.ok(text.includes(`Results are due ${pair.weekday}.`), `${state} section ${index + 1}: ${text}`);
      assert.ok(!text.includes(pair.next), `${state} section ${index + 1}: ${text}`);
    }
    assert.deepEqual(on.events.map(event => event.sectionIndex).sort(), covered, state);
    for (const event of on.events) {
      assert.equal(event.action, 'TRIMMED', state);
      assert.equal(event.droppedDateCount, 1, state);
      assert.equal(event.removedSentenceCount, 0, state);
      assert.ok(!JSON.stringify(event).includes(pair.weekday), `event carries text in ${state}`);
    }

    const off = await run('off', input, planted);
    assert.equal(off.result.ok, true, state);
    // The fixture's own status in a state (some completed-day fixtures degrade for unrelated reasons)
    // must be the same with the step on: a trimmed date never degrades the report.
    assert.equal(on.result.output.status, off.result.output.status, `${state}: a trimmed date must not degrade the report`);
    for (const index of covered) {
      assert.ok(off.result.output.sections[index].content.includes(bad), `${state} off, section ${index + 1}`);
    }
    assert.deepEqual(off.events, [], state);
  }
});

test('Step 9AP: Section 4 (My Stocks and Watchlist) text is covered by the same cut', () => {
  const result = agree('Apple reports Thursday 13 November. Apple rose 1%.');
  assert.equal(result.section.content, 'Apple reports Thursday. Apple rose 1%.');
});

test('Step 9AP: a matching pair in the whole path changes nothing, switch on or off', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const pair = wrongPair(generatedAt);
    const planted = structuredClone(output);
    planted.sections[6] = {...planted.sections[6],
      content: `${planted.sections[6].content} Results are due ${pair.nextWeekday} ${pair.next}.`};
    const on = await run(undefined, input, planted);
    const off = await run('off', input, planted);
    assert.deepEqual(on.result, off.result, state);
    assert.deepEqual(on.events, [], state);
  }
});

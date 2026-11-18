// 9AV Build 2: check B (same event, two days) reads a subject from the report's own wording and lets
// "the company" borrow the subject of the sentence just before. Log only. Free tests: made-up text.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findEventDayClaims, findEventDayClaimsInSection, sameEventDayConflicts
} = require('../lib/report-accuracy-source');

const reportDate = '2026-11-18'; // a Wednesday
const S0 = "Anthropic's initial public offering is the next big test.";
const S1 = "Anthropic's stock market debut, due later on Wednesday, is seen as a major test of investor appetite for AI companies.";
const S7 = 'Reuters reported that the company is aiming for a valuation of as much as $1.4 trillion, with pricing set for Wednesday and a trading debut on Thursday.';

function conflictsFor(sections, subjects = []) {
  const claims = [];
  for (const [sectionIndex, sentences] of sections) {
    for (const claim of findEventDayClaimsInSection(sentences, {subjects, reportDate})) {
      claims.push({...claim, sectionIndex});
    }
  }
  return sameEventDayConflicts(claims);
}

test('9AV Build 2: the report\'s own wording names the subject (possessive + stock market debut)', () => {
  assert.deepEqual(findEventDayClaims(S1, {subjects: [], reportDate}),
    [{subject: 'COMPANY:anthropic', eventClass: 'debut', date: '2026-11-18'}]);
});

test('9AV Build 2: "initial public offering" is an IPO word', () => {
  const claims = findEventDayClaims("Anthropic's initial public offering is set for Thursday.", {subjects: [], reportDate});
  assert.deepEqual(claims, [{subject: 'COMPANY:anthropic', eventClass: 'ipo', date: '2026-11-19'}]);
});

test('9AV Build 2: Section 1 against Section 7 (S0 + S7) gives exactly one conflict, debut, sections 1 and 7', () => {
  const found = conflictsFor([[1, [S1]], [7, [S0, S7]]]);
  assert.deepEqual(found.map(entry => ({...entry})), [{eventClass: 'debut', sectionIndexes: [1, 7]}]);
});

test('9AV Build 2: Section 7 alone gives none', () => {
  assert.deepEqual(conflictsFor([[7, [S0, S7]]]), []);
});

test('9AV Build 2: "the company" borrows only from the sentence just before, and only one subject', () => {
  // Two subjects in the sentence before: no borrow.
  const two = "Anthropic's initial public offering and OpenAI's IPO are the next big tests.";
  assert.deepEqual(findEventDayClaimsInSection([two, S7], {subjects: [], reportDate}), []);
  // The borrowed subject is the sentence before, not one two sentences back.
  assert.deepEqual(findEventDayClaimsInSection([S0, 'Markets were quiet.', S7], {subjects: [], reportDate}), []);
  // No sentence before: no borrow.
  assert.deepEqual(findEventDayClaimsInSection([S7], {subjects: [], reportDate}), []);
  // One subject before: borrowed (pricing Wednesday, debut Thursday).
  assert.deepEqual(findEventDayClaimsInSection([S0, S7], {subjects: [], reportDate})
    .map(claim => `${claim.subject}|${claim.eventClass}|${claim.date}`),
  ['COMPANY:anthropic|pricing|2026-11-18', 'COMPANY:anthropic|debut|2026-11-19']);
});

test('9AV Build 2: a sentence that already has a subject does not borrow; a macro subject is not borrowed', () => {
  const own = 'Acme said its trading debut is on Friday, and the company priced shares on Thursday.';
  const claims = findEventDayClaimsInSection([S0, own], {subjects: ['Acme'], reportDate});
  assert.ok(claims.every(claim => claim.subject === 'COMPANY:acme'), JSON.stringify(claims));
  const macro = 'The Fed meeting is on Wednesday.';
  assert.deepEqual(findEventDayClaimsInSection([macro, 'The company has a debut on Thursday.'],
    {subjects: [], reportDate}), [{subject: 'MACRO:FOMC', eventClass: 'decision', date: '2026-11-18'}]);
});

test('9AV Build 2: a listed subject wins over the same name in the wording; sentence-start names need the \'s', () => {
  const listed = findEventDayClaims("Acme AI's stock market debut is on Thursday.", {subjects: ['Acme AI'], reportDate});
  assert.deepEqual(listed.map(claim => claim.subject), ['COMPANY:acme ai']);
  assert.deepEqual(findEventDayClaims('Strong pricing is expected on Thursday.', {subjects: [], reportDate}), []);
  assert.deepEqual(findEventDayClaims('Reuters pricing is due Thursday.', {subjects: [], reportDate}), []);
});

// ---------------------------------------------------------------------------
// Wiring: the finished report, all six states. The log line is counts only; the report never changes.
// ---------------------------------------------------------------------------
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {anthropicResponse, marketStateCase, MARKET_STATE_CASES} = require('./fixtures/market-state-cases');

async function runDay(envValue, input, output) {
  const saved = process.env.SAME_EVENT_DAY_CHECK_ENABLED;
  if (envValue === undefined) delete process.env.SAME_EVENT_DAY_CHECK_ENABLED;
  else process.env.SAME_EVENT_DAY_CHECK_ENABLED = envValue;
  const diagnostics = [];
  try {
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key', fetchImpl: async () => anthropicResponse(output),
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, sameDay: diagnostics.filter(entry => entry.stage === 'sameEventDayResidue')};
  } finally {
    if (saved === undefined) delete process.env.SAME_EVENT_DAY_CHECK_ENABLED;
    else process.env.SAME_EVENT_DAY_CHECK_ENABLED = saved;
  }
}

test('9AV Build 2 (wiring): the report\'s own wording and "the company" are read on the finished report; log only', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
    const base = await runDay(undefined, input, output);
    const planted = structuredClone(output);
    // Written with "today"/"tomorrow" so the live-day date checks leave the sentences alone.
    planted.sections[0].content += " Anthropic's stock market debut, due later today, is a major test.";
    planted.sections[6].content += " Anthropic's initial public offering is the next big test."
      + ' The company is aiming for pricing today and a trading debut tomorrow.';
    const on = await runDay(undefined, input, planted);
    const off = await runDay('off', input, planted);
    assert.deepEqual(on.result, off.result, `${state}: log only`);
    assert.deepEqual(off.sameDay, [], state);
    assert.equal(base.sameDay.length, 0, `${state}: the unplanted reply logs nothing`);
    assert.equal(on.sameDay.length, 1, state);
    {
      assert.equal(on.sameDay[0].conflictCount, 1, state);
      assert.deepEqual({...on.sameDay[0].conflicts[0]}, {eventClass: 'debut', sectionIndexes: [0, 6]}, state);
      assert.ok(!/Anthropic|today|tomorrow|trading/.test(JSON.stringify(on.sameDay)), state);
    }
  }
});

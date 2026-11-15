// Step 9L: the writer retry for an empty section, the per-run writer call cap, the time
// limit, and the guided whole-report retry (decision 3). Every case runs in PRE, REGULAR,
// POST, CLOSED, WEEKEND and HOLIDAY. No network, no key: the writer is a stand-in.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {REPORT_SECTION_NAMES} = require('../lib/claude-analysis-contract');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {retryEligibleEmptySections, WRITER_SECTION_RETRY_SECTIONS} = require('../lib/section-rules');
const {
  contractFailureCategories,
  sectionRetryVerdict,
  mergeSectionRetryTransport
} = require('../lib/writer-section-retry');
const {
  MARKET_STATE_CASES,
  ACTIVE_MARKET_STATES,
  providerTransport,
  marketStateCase,
  thinCompletedMarketStateCase
} = require('./fixtures/market-state-cases');

const OFF = {WRITER_SECTION_RETRY_ENABLED: 'off', WRITER_RETRY_GUIDANCE_ENABLED: 'off'};
const EMPTY_NOTE = 'Nothing confirmed for this section.';

function reply(transport) {
  return {ok: true, status: 200,
    async json() { return {content: [{type: 'text', text: JSON.stringify(transport)}]}; }};
}

function withEmpty(output, indexes) {
  const copy = structuredClone(output);
  for (const index of indexes) {
    copy.sections[index] = {...copy.sections[index], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: [EMPTY_NOTE]};
  }
  copy.status = 'DEGRADED';
  copy.evidenceGaps = [...copy.evidenceGaps, 'Some sections had too little evidence.'];
  return copy;
}

// Runs the writer with a list of stand-in replies (one per call); records each request body.
async function run(input, replies, {env = {}, monotonicNow} = {}) {
  const bodies = [];
  const diagnostics = [];
  const result = await invokeClaudeAnalysis({
    input, apiKey: 'test-key', env,
    ...(monotonicNow ? {monotonicNow} : {}),
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async (url, request) => {
      bodies.push(JSON.parse(request.body));
      const next = replies[Math.min(bodies.length - 1, replies.length - 1)];
      return typeof next === 'function' ? next() : reply(next);
    }
  });
  return {result, bodies, diagnostics, rounds: diagnostics.filter(value => value.stage === 'writerSectionRetry')};
}

function caseFor(marketState, generatedAt, overlayAsOf, currentPublishedAt) {
  return marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
}

function eligibleIndexes(marketState) {
  // A completed-day report with an empty Section 1 fails as a whole, so Section 1 is
  // only ever empty on active days.
  return WRITER_SECTION_RETRY_SECTIONS.filter(index => index !== 0 || ACTIVE_MARKET_STATES.has(marketState));
}

test('Step 9L: an empty section the writer left out is retried once and filled, in every state', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    const filled = providerTransport(output);
    const off = await run(input, [first], {env: OFF});
    assert.equal(off.result.ok, true, marketState);
    assert.equal(off.bodies.length, 1, marketState);
    assert.equal(off.result.output.sections[6].content, null, marketState);

    const on = await run(input, [first, filled]);
    assert.equal(on.result.ok, true, marketState);
    assert.equal(on.bodies.length, 2, marketState);
    assert.equal(on.result.output.sections[6].content, output.sections[6].content, marketState);
    for (let index = 0; index < 6; index++) {
      assert.deepEqual(on.result.output.sections[index], off.result.output.sections[index], `${marketState} ${index}`);
    }
    // Same package and checks; only the instruction is added.
    assert.equal(on.bodies[1].messages[0].content, on.bodies[0].messages[0].content, marketState);
    assert.equal(on.bodies[1].system.startsWith(on.bodies[0].system), true, marketState);
    assert.match(on.bodies[1].system, /SECTION RETRY, round 1 of 2/);
    assert.match(on.bodies[1].system, /WHAT TO WATCH FOR NEXT \(you left it empty\)/);
    assert.doesNotMatch(on.bodies[1].system, /MY STOCKS & WATCHLIST \(/);
    assert.equal(on.rounds.length, 1, marketState);
    assert.deepEqual(on.rounds[0].sections, [{sectionIndex: 6, sectionName: 'WHAT TO WATCH FOR NEXT',
      reasonCategories: ['WRITER_LEFT_EMPTY']}]);
    assert.equal(on.rounds[0].outcome, 'ACCEPTED');
    assert.deepEqual(on.rounds[0].filledSections, [6]);
    assert.equal(on.rounds[0].writerCallsUsed, 2);
    assert.equal(typeof on.rounds[0].elapsedMs, 'number');
    assert.equal(typeof on.rounds[0].usage, 'object');
    // No prose in the round log line.
    assert.equal(JSON.stringify(on.rounds).includes(output.sections[6].content), false);
  }
});

test('Step 9L: each eligible section (1, 2, 3, 5, 6, 7) is retried when empty, in every state', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    for (const index of eligibleIndexes(marketState)) {
      const on = await run(input, [providerTransport(withEmpty(output, [index])), providerTransport(output)]);
      assert.equal(on.result.ok, true, `${marketState} ${index}: ${on.result.message}`);
      assert.equal(on.bodies.length, 2, `${marketState} ${index}`);
      assert.equal(on.rounds[0].outcome, 'ACCEPTED', `${marketState} ${index}`);
      assert.deepEqual(on.rounds[0].filledSections, [index], `${marketState} ${index}`);
    }
  }
});

test('Step 9L: several empty sections share one writer call per round', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const on = await run(input, [providerTransport(withEmpty(output, [4, 5, 6])), providerTransport(output)]);
    assert.equal(on.bodies.length, 2, marketState);
    assert.deepEqual(on.rounds[0].sections.map(section => section.sectionIndex), [4, 5, 6]);
    assert.deepEqual(on.rounds[0].filledSections, [4, 5, 6]);
  }
});

test('Step 9L: Section 4 and Section 8 are never offered for retry, in every state', () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const allEmpty = {...output, sections: output.sections.map(section => ({...section, content: null}))};
    const eligible = retryEligibleEmptySections(allEmpty, input);
    assert.equal(eligible.includes(3), false, marketState);
    assert.equal(eligible.includes(7), false, marketState);
    assert.deepEqual(eligible, [0, 1, 2, 4, 5, 6], marketState);
  }
  assert.deepEqual(WRITER_SECTION_RETRY_SECTIONS, [0, 1, 2, 4, 5, 6]);
  assert.equal(Object.isFrozen(WRITER_SECTION_RETRY_SECTIONS), true);
});

test('Step 9L: a section the code blanks by design (no focus) is never retried', async () => {
  for (const [marketState, generatedAt] of MARKET_STATE_CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = thinCompletedMarketStateCase(marketState, generatedAt);
    const allEmpty = {...output, sections: output.sections.map(section => ({...section, content: null}))};
    assert.equal(retryEligibleEmptySections(allEmpty, input).includes(2), false, marketState);
    const on = await run(input, [providerTransport(output)]);
    assert.equal(on.result.ok, true, `${marketState}: ${on.result.message}`);
    assert.equal(on.result.output.sections[2].content, null, marketState);
    assert.equal(on.rounds.some(round => round.sections.some(section => section.sectionIndex === 2)), false);
  }
});

test('Step 9L: a retry that stays empty keeps the original report; round 2 is stricter', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    const off = await run(input, [first], {env: OFF});
    const on = await run(input, [first]);
    assert.equal(on.bodies.length, 3, marketState);
    assert.deepEqual(on.result, off.result, marketState);
    assert.deepEqual(on.rounds.map(round => round.outcome), ['REJECTED_NO_TEXT', 'REJECTED_NO_TEXT']);
    assert.match(on.bodies[2].system, /SECTION RETRY, round 2 of 2/);
    assert.match(on.bodies[2].system, /stricter round\. Use at most 4 sentences/);
    assert.doesNotMatch(on.bodies[1].system, /stricter round/);
  }
});

test('Step 9L: round 2 drops a retried section over the sentence limit', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    const long = providerTransport(output);
    long.s7 = {...long.s7, content: Array.from({length: 6}, (_, i) => `Item ${i + 1} is supported.`).join(' ')};
    const short = providerTransport(output);
    short.s7 = {...short.s7, content: 'Item one is supported. Item two is supported.'};
    const tooLong = await run(input, [first, first, long]);
    assert.equal(tooLong.result.output.sections[6].content, null, marketState);
    assert.deepEqual(tooLong.rounds.map(round => round.outcome), ['REJECTED_NO_TEXT', 'REJECTED_NO_TEXT']);
    const ok = await run(input, [first, first, short]);
    assert.equal(ok.result.output.sections[6].content, 'Item one is supported. Item two is supported.', marketState);
    assert.deepEqual(ok.rounds.map(round => round.outcome), ['REJECTED_NO_TEXT', 'ACCEPTED']);
  }
});

test('Step 9L: an error during a retry keeps the original report', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    const off = await run(input, [first], {env: OFF});
    const upstream = await run(input, [first, () => ({ok: false, status: 500, async json() { return {}; }})]);
    assert.deepEqual(upstream.result, off.result, marketState);
    assert.equal(upstream.rounds[0].outcome, 'FAILED');
    assert.equal(upstream.rounds[0].failureType, 'UPSTREAM_FAILURE');
    const thrown = await run(input, [first, () => { throw new Error('network down'); }]);
    assert.deepEqual(thrown.result, off.result, marketState);
    const broken = await run(input, [first, {not: 'a report'}]);
    assert.deepEqual(broken.result, off.result, marketState);
  }
});

test('Step 9L: a retried section that fails the checks stays blank (a blank beats a made-up section)', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    const leaking = providerTransport(output);
    leaking.s7 = {...leaking.s7, content: 'Watch evidenceContext.broadMarketFocus next.'};
    const off = await run(input, [first], {env: OFF});
    const on = await run(input, [first, leaking]);
    assert.deepEqual(on.result, off.result, marketState);
    assert.equal(on.rounds[0].outcome, 'REJECTED_NO_TEXT', marketState);
  }
});

test('Step 9L: the acceptance check rejects any change to a section that already survived', () => {
  const before = {sections: REPORT_SECTION_NAMES.map((name, index) => ({name, content: index === 6 || index === 7
    ? null : `Text ${index}.`, evidenceRefs: [], telemetryRefs: [], uncertainties: []}))};
  const after = structuredClone(before);
  after.sections[6].content = 'New text.';
  assert.deepEqual(sectionRetryVerdict(before, after, [6]), {accepted: true, outcome: 'ACCEPTED', filled: [6]});
  after.sections[2].content = 'Changed.';
  assert.equal(sectionRetryVerdict(before, after, [6]).outcome, 'REJECTED_CHANGED_SECTION');
  const unchanged = structuredClone(before);
  assert.equal(sectionRetryVerdict(before, unchanged, [6]).outcome, 'REJECTED_NO_TEXT');
  assert.throws(() => mergeSectionRetryTransport({s7: {}}, {s7: {content: null}}, [6]), /no usable section/);
});

test('Step 9L: the per-run writer call cap counts the first call, the whole-report retry and each round', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const broken = providerTransport(output);
    broken.s2 = {...broken.s2, evidenceRefs: 'e999|'};
    const empty = providerTransport(withEmpty(output, [6]));
    const filled = providerTransport(output);
    // Default cap 3: first call fails, the whole-report retry succeeds with Section 7
    // empty, so one round is left.
    const three = await run(input, [broken, empty, filled]);
    assert.equal(three.bodies.length, 3, marketState);
    assert.equal(three.result.output.sections[6].content, output.sections[6].content, marketState);
    // Cap 2: the round is skipped and logged.
    const two = await run(input, [broken, empty, filled], {env: {WRITER_CALLS_PER_RUN_MAX: '2'}});
    assert.equal(two.bodies.length, 2, marketState);
    assert.equal(two.result.output.sections[6].content, null, marketState);
    assert.equal(two.rounds[0].outcome, 'SKIPPED_CALL_CAP');
    // Cap 1: no retry of any kind.
    const one = await run(input, [broken, filled], {env: {WRITER_CALLS_PER_RUN_MAX: '1'}});
    assert.equal(one.bodies.length, 1, marketState);
    assert.equal(one.result.type, 'CONTRACT_FAILURE', marketState);
    // No whole-report retry: two rounds fit inside 3 calls; a third never runs.
    const rounds = await run(input, [empty, empty, empty, filled], {env: {WRITER_SECTION_RETRY_COUNT: '3'}});
    assert.equal(rounds.bodies.length, 3, marketState);
    assert.deepEqual(rounds.rounds.map(round => round.outcome), ['REJECTED_NO_TEXT', 'REJECTED_NO_TEXT', 'SKIPPED_CALL_CAP']);
  }
});

test('Step 9L: no new round starts after the time limit', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    let now = 0;
    const monotonicNow = () => { now += 100000; return now; };
    const on = await run(input, [providerTransport(withEmpty(output, [6])), providerTransport(output)], {monotonicNow});
    assert.equal(on.bodies.length, 1, marketState);
    assert.equal(on.rounds[0].outcome, 'SKIPPED_TIME_LIMIT');
    assert.equal(on.result.output.sections[6].content, null);
  }
});

test('Step 9L: retry count 0 or the switch off makes no section retry', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const first = providerTransport(withEmpty(output, [6]));
    for (const env of [{WRITER_SECTION_RETRY_COUNT: '0'}, {WRITER_SECTION_RETRY_ENABLED: 'off'}]) {
      const result = await run(input, [first, providerTransport(output)], {env});
      assert.equal(result.bodies.length, 1, marketState);
      assert.equal(result.rounds.length, 0, marketState);
    }
  }
});

test('Step 9L decision 3: the whole-report retry names the broken rule and logs section, field and category', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const leaking = providerTransport(output);
    leaking.s1 = {...leaking.s1, content: `${leaking.s1.content} See evidenceContext.broadMarketFocus.`};
    const on = await run(input, [leaking, providerTransport(output)]);
    assert.equal(on.result.ok, true, marketState);
    assert.equal(on.bodies.length, 2, marketState);
    // The added instruction carries rule categories only, never the reply's own text.
    const added = on.bodies[1].system.slice(on.bodies[0].system.length);
    assert.equal(added.includes('evidenceContext.broadMarketFocus'), false, marketState);
    assert.equal(added.includes('See '), false, marketState);
    assert.equal(on.bodies[1].messages[0].content, on.bodies[0].messages[0].content);
    if (ACTIVE_MARKET_STATES.has(marketState)) {
      // Active days blank a leaking Section 1 instead of failing the report, so the
      // section retry rewrites it, naming the same rule.
      assert.match(on.bodies[1].system, /EXECUTIVE MARKET SUMMARY \(it contained an internal field name/);
      assert.equal(on.rounds[0].outcome, 'ACCEPTED', marketState);
      assert.deepEqual(on.rounds[0].sections[0].reasonCategories, ['INTERNAL_IDENTIFIER_LEAK']);
      continue;
    }
    assert.match(on.bodies[1].system, /RETRY: your previous answer to this same request was rejected/);
    assert.match(on.bodies[1].system, /EXECUTIVE MARKET SUMMARY: it contained an internal field name/);
    const failure = on.diagnostics.find(value => value.stage === 'writerContractFailure');
    assert.deepEqual(failure.failures, [{sectionIndex: 0, sectionName: 'EXECUTIVE MARKET SUMMARY',
      field: 'content', category: 'INTERNAL_IDENTIFIER_LEAK'}], marketState);
    assert.equal(on.diagnostics.find(value => value.stage === 'contractRetry').guided, true);
    // Off: the identical retry of c3c7ee5.
    const off = await run(input, [leaking, providerTransport(output)], {env: {WRITER_RETRY_GUIDANCE_ENABLED: 'off'}});
    assert.equal(JSON.stringify(off.bodies[1]), JSON.stringify(off.bodies[0]), marketState);
    assert.equal(off.diagnostics.some(value => value.stage === 'writerContractFailure'), false);
    assert.equal('guided' in off.diagnostics.find(value => value.stage === 'contractRetry'), false);
  }
});

test('Step 9L: with both switches off, the writer makes the c3c7ee5 calls (same requests, same result)', async () => {
  for (const [marketState, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = caseFor(marketState, ...rest);
    const full = providerTransport(output);
    const off = await run(input, [full], {env: OFF});
    const on = await run(input, [full]);
    assert.deepEqual(on.result, off.result, marketState);
    assert.equal(JSON.stringify(on.bodies), JSON.stringify(off.bodies), marketState);
    assert.equal(on.rounds.length, 0);
  }
});

test('Step 9L: whole-report failure categories come only from our own fixed messages', () => {
  assert.deepEqual(contractFailureCategories(
    'Invalid Claude analysis output: sections[0]: internal identifier leak; sections[4]: internal identifier leak in uncertainties; evidence gaps contain an internal identifier leak; report exceeds maximum word allowance'),
  [
    {sectionIndex: 0, sectionName: 'EXECUTIVE MARKET SUMMARY', field: 'content', category: 'INTERNAL_IDENTIFIER_LEAK'},
    {sectionIndex: 4, sectionName: REPORT_SECTION_NAMES[4], field: 'uncertainties', category: 'INTERNAL_IDENTIFIER_LEAK'},
    {sectionIndex: null, sectionName: null, field: 'evidenceGaps', category: 'INTERNAL_IDENTIFIER_LEAK'},
    {sectionIndex: null, sectionName: null, field: 'content', category: 'REPORT_WORD_CAP'}
  ]);
  assert.equal(contractFailureCategories('Claude structured result was malformed')[0].category, 'MALFORMED_REPLY');
  assert.equal(contractFailureCategories(
    'Invalid Claude analysis output: sections[1]: key market drivers require a material event or principal catalyst')[0].category,
  'DRIVER_REFERENCE_REQUIRED');
  assert.equal(contractFailureCategories('Something new')[0].category, 'OTHER_CHECK');
  assert.deepEqual(contractFailureCategories(undefined), []);
});

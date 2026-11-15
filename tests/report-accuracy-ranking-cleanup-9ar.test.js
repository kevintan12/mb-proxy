'use strict';

// Step 9AR Build 4: the ranking-claim check connected to the live report cleanup
// (reportAccuracyRankingEnabled). A sentence with a false "weakest / strongest / worst day" claim about
// the four main US indexes is removed; a section is never emptied; comparisons are only counted.
// Made-up text, fake fetch, no network, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis, rankingClaimCleanup} = require('../lib/claude-analysis-invocation');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  createCompletedRegularSession, createCurrentSessionOverlay, createFiveSessionSnapshot
} = require('../lib/five-session-snapshot');
const {
  MARKET_STATE_CASES, ACTIVE_MARKET_STATES, marketStateCase, anthropicResponse, providerTransport
} = require('./fixtures/market-state-cases');

const ENV = 'REPORT_ACCURACY_RANKING_ENABLED';
const COVERED = [0, 1, 2, 4, 5, 6];
const NAMES = {'^IXIC': 'NASDAQ Composite', '^DJI': 'Dow Jones Industrial Average', '^RUT': 'Russell 2000'};

// Completed week (31 Aug to 4 Sep 2026), percent per day. The fixture's own S&P 500 is
// 1.01, 1.00, -1.98, 3.03, 2.94. Friday 4 Sep: Dow weakest, Nasdaq strongest. Every index has its
// worst day on Wednesday 2 Sep.
const COMPLETED = {
  '^IXIC': [1.2, 0.8, -2.5, 1.0, 3.5],
  '^DJI': [0.5, -0.5, -1.0, 2.0, 1.0],
  '^RUT': [0.3, 0.2, -1.5, 4.0, 2.0]
};
const COMPLETED_DATES = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
// Active days: 4 Sep (S&P 500 +4.00): Russell weakest, Dow strongest. Live (S&P 500 +1.92): Dow weakest.
const ACTIVE = {'^IXIC': [4.5, 2.5], '^DJI': [5.0, 1.0], '^RUT': [2.0, 3.0]};

function chainSessions(percents, dates) {
  let previous = 100;
  return percents.map((percent, index) => {
    const close = Math.round(previous * (1 + percent / 100) * 1e6) / 1e6;
    const session = createCompletedRegularSession({
      market: 'US', sessionDate: dates[index], open: close, high: Math.max(close, previous) + 1,
      low: Math.min(close, previous) - 1, close, previousClose: previous, volume: 1000 + index,
      asOf: `${dates[index]}T16:00:00-04:00`, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    });
    previous = close;
    return session;
  });
}

// The state's fixture with the Nasdaq, the Dow and the Russell 2000 added beside its S&P 500.
function fourIndexCase(state, generatedAt, overlayAsOf, currentPublishedAt) {
  const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, currentPublishedAt);
  const copy = structuredClone(input);
  const replyCopy = structuredClone(output);
  const telemetry = copy.marketPackages[0].telemetry;
  let reference = 0;
  for (const symbol of ['^IXIC', '^DJI', '^RUT']) {
    const active = ACTIVE_MARKET_STATES.has(state);
    const completedSessions = active
      ? chainSessions([ACTIVE[symbol][0]], ['2026-09-04']) : chainSessions(COMPLETED[symbol], COMPLETED_DATES);
    const close = completedSessions[completedSessions.length - 1].close;
    const currentOverlay = active ? createCurrentSessionOverlay({
      market: 'US', marketState: state, sessionDate: '2026-09-08', asOf: overlayAsOf,
      lastPrice: Math.round(close * (1 + ACTIVE[symbol][1] / 100) * 1e6) / 1e6, referenceClose: close,
      volume: 1200000, sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
    }) : null;
    telemetry.benchmarkSnapshots.push({reference: `new${reference++}`, snapshot: createFiveSessionSnapshot({
      market: 'US', symbol, instrumentName: NAMES[symbol], instrumentType: 'INDEX', currency: 'USD',
      marketState: state, completedSessions, currentOverlay
    })});
  }
  // References must run t1, t2, ... with the indexes first: renumber, and every place that cites them.
  const renumber = new Map();
  telemetry.benchmarkSnapshots.concat(telemetry.stockSnapshots).forEach((entry, index) => {
    renumber.set(entry.reference, `t${index + 1}`);
  });
  const walk = value => {
    if (Array.isArray(value)) return value.map(item => (typeof item === 'string' && renumber.has(item) ? renumber.get(item) : walk(item)));
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (key === 'reference' && renumber.has(value[key])) value[key] = renumber.get(value[key]);
        else value[key] = walk(value[key]);
      }
    }
    return value;
  };
  return {input: walk(structuredClone(copy)), output: walk(replyCopy)};
}

const CASES = MARKET_STATE_CASES.map(([state, ...rest]) => [state, () => fourIndexCase(state, ...rest)]);

// A false and a true ranking sentence for the state's own prices.
function planted(state) {
  return ACTIVE_MARKET_STATES.has(state)
    ? {bad: 'The Nasdaq was the weakest of the major indexes.', good: 'The Russell 2000 was the weakest of the major indexes.'}
    : {bad: 'The Nasdaq was the weakest of the major indexes.', good: 'The Dow was the weakest of the major indexes.'};
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try { return await fn(); } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

function reply(output) {
  return typeof output === 'function' ? output() : anthropicResponse(output);
}

async function invoke(vars, input, replies) {
  return withEnv(vars, async () => {
    const diagnostics = [];
    let calls = 0;
    const list = Array.isArray(replies) ? replies : [replies];
    const result = await invokeClaudeAnalysis({
      input, apiKey: 'test-key',
      fetchImpl: async () => reply(list[Math.min(calls++, list.length - 1)]),
      onDiagnostics: value => diagnostics.push(value)
    });
    return {result, diagnostics, calls,
      events: diagnostics.filter(value => value.violationCategory === 'RANKING_CLAIM_CHECK')};
  });
}

function plant(output, indexes, text) {
  const copy = structuredClone(output);
  for (const index of indexes) {
    copy.sections[index] = {...copy.sections[index], content: `${copy.sections[index].content} ${text}`};
  }
  return copy;
}

const EVENT_STRINGS = new Set(['claudeAnalysisSectionNormalization', 'RANKING_CLAIM_CHECK', 'TRIMMED']);
function assertCountsOnly(event) {
  const walk = value => {
    if (typeof value === 'string') assert.ok(EVENT_STRINGS.has(value), `text in event: ${value}`);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    else assert.ok(typeof value === 'number', `unexpected value ${value}`);
  };
  walk(event);
}

test('Step 9AR Build 4: the registry row (Admin boolean, on by default, env REPORT_ACCURACY_RANKING_ENABLED)', () => {
  const entry = SETTINGS_REGISTRY.reportAccuracyRankingEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('reportAccuracyRankingEnabled', {env: {}}), true);
  for (const value of ['off', 'false', '0']) {
    assert.equal(settingValue('reportAccuracyRankingEnabled', {env: {[ENV]: value}}), false);
  }
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('reportAccuracyRankingEnabled'), names.indexOf('reportAccuracyDirectionEnabled') + 1);
});

test('Step 9AR Build 4: the description is short plain English (the Step 9AD.1 rules)', () => {
  const text = SETTINGS_REGISTRY.reportAccuracyRankingEnabled.description;
  assert.ok(text.includes('When on') && text.includes('When off'));
  const sentences = text.replace(/"[^"]*"/g, 'QUOTED').split(/[.!?](?:\s+|$)/).filter(part => part.trim());
  assert.ok(sentences.length >= 1 && sentences.length <= 2, `${sentences.length} sentences`);
  assert.ok(!/[0-9a-f]{7,}/i.test(text));
  assert.ok(!/\bStep\b/i.test(text));
  assert.ok(!/\b9[A-Z]{1,2}(\.\d+)?\b/.test(text));
  assert.ok(text.length <= 450, `${text.length} characters`);
});

for (const model of ['haiku-4.5', 'haiku-5.5']) {
  test(`Step 9AR Build 4: ${model}, all six states: a false ranking sentence is removed from Sections 1 to 7, counts-only TRIMMED events`, async () => {
    for (const [state, build] of CASES) {
      const {input, output} = build();
      const {bad, good} = planted(state);
      const replyWith = plant(plant(output, COVERED, bad), COVERED, good);
      const vars = {CLAUDE_MODEL: model};
      const on = await invoke({...vars, [ENV]: undefined}, input, replyWith);
      const off = await invoke({...vars, [ENV]: 'off'}, input, replyWith);
      assert.equal(on.result.ok, true, `${state}: ${JSON.stringify(on.result).slice(0, 300)}`);
      assert.equal(on.result.output.status, off.result.output.status, `${state}: status must not change`);
      assert.equal(on.calls, off.calls, `${state}: no extra writer call`);
      for (const index of COVERED) {
        const text = on.result.output.sections[index].content;
        assert.ok(!text.includes(bad) && text.includes(good), `${state} section ${index + 1}: ${text}`);
        assert.equal(text, off.result.output.sections[index].content.replace(` ${bad}`, ''), `${state} ${index + 1}`);
      }
      assert.deepEqual(on.events.map(event => event.sectionIndex).sort(), COVERED, state);
      for (const event of on.events) {
        assertCountsOnly(event);
        assert.equal(event.action, 'TRIMMED');
        assert.equal(event.removedSentenceCount, 1);
        assert.equal(event.falseClaimCount, 1);
        assert.equal(event.removedClaimCount, 1);
        assert.equal(event.trueClaimCount, 1);
        assert.equal(event.formCounts.indexRank, 2);
        assert.equal(event.skippedClaimCount, 0);
      }
      assert.deepEqual(off.events, [], state);
      assert.deepEqual(on.result.output.sections[7], off.result.output.sections[7], `${state}: Further Readings`);
      assert.deepEqual(on.result.output.furtherReadings, off.result.output.furtherReadings, state);
    }
  });
}

test('Step 9AR Build 4: with no ranking wording, switch on equals switch off exactly (report and every log line)', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const on = await invoke({[ENV]: undefined}, input, output);
    const off = await invoke({[ENV]: 'off'}, input, output);
    assert.deepEqual(on.result, off.result, state);
    assert.deepEqual(on.diagnostics.filter(d => d.stage !== undefined || !d.usage),
      off.diagnostics.filter(d => d.stage !== undefined || !d.usage), state);
    assert.deepEqual(on.events, [], state);
  }
});

test('Step 9AR Build 4: true rankings and comparisons change nothing; only the counts-only event is added', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const text = `${planted(state).good} The Nasdaq fell more sharply than the S&P 500.`;
    const on = await invoke({[ENV]: undefined}, input, plant(output, [6], text));
    const off = await invoke({[ENV]: 'off'}, input, plant(output, [6], text));
    assert.deepEqual(on.result, off.result, state);
    assert.equal(on.events.length, 1, state);
    assert.deepEqual([on.events[0].removedSentenceCount, on.events[0].trueClaimCount, on.events[0].comparisonCount],
      [0, 1, 1], state);
    assert.deepEqual(on.diagnostics.filter(d => d.violationCategory !== 'RANKING_CLAIM_CHECK'
      && (d.stage !== undefined || !d.usage)), off.diagnostics.filter(d => d.stage !== undefined || !d.usage), state);
  }
});

test('Step 9AR Build 4: a removal that would empty a section is not made (wouldEmptySection)', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const {bad} = planted(state);
    const copy = structuredClone(output);
    copy.sections[6] = {...copy.sections[6], content: bad};
    const on = await invoke({[ENV]: undefined}, input, copy);
    assert.equal(on.result.ok, true, state);
    assert.equal(on.result.output.sections[6].content, bad, state);
    const event = on.events.find(item => item.sectionIndex === 6);
    assert.deepEqual([event.removedSentenceCount, event.skipReasons], [0, {wouldEmptySection: 1}], state);
  }
});

test('Step 9AR Build 4: a removal that would add a final-check error is not made (wouldTripFinalCheck)', async () => {
  for (const [state, build] of CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = build();
    // The only sentence naming a validated subject (Broadcom) also holds the false claim.
    const copy = structuredClone(output);
    copy.sections[2] = {...copy.sections[2],
      content: 'The Nasdaq was the weakest of the major indexes, as Broadcom led semiconductor shares. Stocks were calm.'};
    const on = await invoke({[ENV]: undefined}, input, copy);
    const off = await invoke({[ENV]: 'off'}, input, copy);
    assert.equal(on.result.ok, true, state);
    assert.deepEqual(on.result, off.result, state);
    assert.equal(on.calls, off.calls, state);
    const event = on.events.find(item => item.sectionIndex === 2);
    assert.deepEqual([event.removedSentenceCount, event.skipReasons], [0, {wouldTripFinalCheck: 1}], state);
  }
});

test('Step 9AR Build 4: the headless follow-on goes too on Haiku 5.5 (9AI), not on Haiku 4.5', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const {bad} = planted(state);
    const text = `${bad} It was a hard day for its biggest names. Markets ended calmly.`;
    const five = await invoke({[ENV]: undefined, CLAUDE_MODEL: 'haiku-5.5'}, input, plant(output, [4], text));
    const four = await invoke({[ENV]: undefined, CLAUDE_MODEL: 'haiku-4.5'}, input, plant(output, [4], text));
    const fiveText = five.result.output.sections[4].content;
    const fourText = four.result.output.sections[4].content;
    assert.ok(!fiveText.includes('hard day') && fiveText.endsWith('Markets ended calmly.'), `${state}: ${fiveText}`);
    assert.ok(fourText.includes('It was a hard day for its biggest names. Markets ended calmly.') && !fourText.includes(bad),
      `${state}: ${fourText}`);
    assert.equal(five.events.find(e => e.sectionIndex === 4).followOnRemovedCount, 1, state);
    assert.equal(four.events.find(e => e.sectionIndex === 4).followOnRemovedCount, undefined, state);
  }
});

test('Step 9AR Build 4: Build 3 corrects the word first, then Build 4 removes the sentence; both counted', async () => {
  for (const [state, build] of CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = build();
    const sentence = 'The Nasdaq fell 3.50% on Friday, the weakest of the major indexes.';
    const on = await invoke({[ENV]: undefined}, input, plant(output, [5], sentence));
    assert.ok(!on.result.output.sections[5].content.includes('3.50%'), state);
    const direction = on.diagnostics.find(d => d.violationCategory === 'DIRECTION_WORD_CORRECTED' && d.sectionIndex === 5);
    assert.equal(direction.correctedCount, 1, state);
    const ranking = on.events.find(e => e.sectionIndex === 5);
    assert.deepEqual([ranking.removedSentenceCount, ranking.alsoDirectionCorrectedCount], [1, 1], state);
    // With Build 3 off, Build 4 still removes it and counts no direction fix.
    const alone = await invoke({[ENV]: undefined, REPORT_ACCURACY_DIRECTION_ENABLED: 'off'}, input,
      plant(output, [5], sentence));
    assert.ok(!alone.result.output.sections[5].content.includes('3.50%'), state);
    assert.equal(alone.events.find(e => e.sectionIndex === 5).alsoDirectionCorrectedCount, 0, state);
  }
});

test('Step 9AR Build 4: the day-of-the-week form is removed when false for every index, kept when true', async () => {
  for (const [state, build] of CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = build();
    const on = await invoke({[ENV]: undefined}, input,
      plant(output, [0], 'Thursday was the worst day of the week. Wednesday was the worst day of the week.'));
    const text = on.result.output.sections[0].content;
    assert.ok(!text.includes('Thursday was') && text.includes('Wednesday was the worst day of the week.'), `${state}: ${text}`);
    assert.deepEqual([on.events[0].formCounts.dayOfWeek, on.events[0].removedSentenceCount], [2, 1], state);
  }
});

test('Step 9AR Build 4: the Section 4 price table and Further Readings are never changed', async () => {
  for (const [state, build] of CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = build();
    // A supported MSFT line keeps the writer's Section 4 (so the table is built), plus a false ranking.
    const replyWith = plant(output, [3], `MSFT rose 2.94%. ${planted(state).bad}`);
    const on = await invoke({[ENV]: undefined}, input, replyWith);
    const off = await invoke({[ENV]: 'off'}, input, replyWith);
    assert.ok(off.result.output.sections[3].content.includes(planted(state).bad), `${state}: off keeps it`);
    assert.ok(!on.result.output.sections[3].content.includes(planted(state).bad), `${state}: on removes it`);
    const rows = result => result.output.sections[3].content.split('\n').filter(line => line.includes('|'));
    assert.ok(rows(on.result).length >= 2, state);
    assert.deepEqual(rows(on.result), rows(off.result), state);
    assert.deepEqual(on.result.output.sections[7], off.result.output.sections[7], state);
    assert.ok(!on.events.some(event => event.sectionIndex === 7), state);
  }
  // Directly: a false sentence in the Further Readings slot is never read.
  const [, build] = CASES.find(([name]) => name === 'CLOSED');
  const {input, output} = build();
  const sections = structuredClone(output.sections);
  sections[7] = {...sections[6], name: sections[7].name, content: `Calm day. ${planted('CLOSED').bad}`};
  const events = rankingClaimCleanup(sections, input, {output, evidenceGaps: output.evidenceGaps});
  assert.equal(sections[7].content, `Calm day. ${planted('CLOSED').bad}`);
  assert.deepEqual(events, []);
});

test('Step 9AR Build 4: every other byte is kept: spaces and line breaks around a removed sentence', () => {
  const [, build] = CASES.find(([name]) => name === 'WEEKEND');
  const {input, output} = build();
  const {bad} = planted('WEEKEND');
  for (const [content, expected] of [
    [`First line.\n\n${bad}  Last line.`, 'First line.\n\nLast line.'],
    [`${bad}\nNext line.`, 'Next line.'],
    [`First line.  ${bad}`, 'First line.'],
    [`One.  ${bad} ${bad}\nTwo.`, 'One.  Two.']
  ]) {
    const sections = structuredClone(output.sections);
    sections[6] = {...sections[6], content};
    rankingClaimCleanup(sections, input, {output, evidenceGaps: output.evidenceGaps});
    assert.equal(sections[6].content, expected, JSON.stringify(content));
  }
});

test('Step 9AR Build 4: runs on the contract retry and on a section-retry round', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const {bad} = planted(state);
    const broken = () => ({ok: true, status: 200, async json() { return {content: [{type: 'text', text: '{not json'}]}; }});
    const retried = await invoke({[ENV]: undefined}, input, [broken, plant(output, [6], bad)]);
    assert.equal(retried.result.ok, true, state);
    assert.ok(!retried.result.output.sections[6].content.includes(bad), `${state} contract retry`);

    const empty = structuredClone(output);
    empty.sections[6] = {...empty.sections[6], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['Nothing confirmed for this section.']};
    empty.status = 'DEGRADED';
    empty.evidenceGaps = [...empty.evidenceGaps, 'Some sections had too little evidence.'];
    const filled = plant(output, [6], bad);
    const round = await withEnv({[ENV]: undefined}, async () => {
      let calls = 0;
      const replies = [providerTransport(empty), providerTransport(filled)];
      return invokeClaudeAnalysis({
        input, apiKey: 'test-key',
        fetchImpl: async () => ({ok: true, status: 200,
          async json() { return {content: [{type: 'text', text: JSON.stringify(replies[Math.min(calls++, 1)])}]}; }})
      });
    });
    assert.equal(round.ok, true, state);
    assert.ok(typeof round.output.sections[6].content === 'string', state);
    assert.ok(!round.output.sections[6].content.includes(bad), `${state} section retry: ${round.output.sections[6].content}`);
  }
});

test('Step 9AR Build 4: a removal never starts a writer retry (call counts equal on and off)', async () => {
  for (const [state, build] of CASES) {
    const {input, output} = build();
    const replyWith = plant(output, COVERED, planted(state).bad);
    const on = await invoke({[ENV]: undefined}, input, replyWith);
    const off = await invoke({[ENV]: 'off'}, input, replyWith);
    assert.equal(on.calls, 1, state);
    assert.equal(off.calls, 1, state);
    assert.ok(!on.diagnostics.some(d => d.stage === 'writerSectionRetry' || d.stage === 'writerContractFailure'), state);
  }
});

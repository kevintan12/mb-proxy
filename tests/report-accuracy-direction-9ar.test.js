'use strict';

// Step 9AR Build 3: the direction-word corrector connected to the live report cleanup
// (reportAccuracyDirectionEnabled). A wrong up or down word is corrected from the package's own price
// data, never removed. Made-up text, fake fetch, no network, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis, directionWordCleanup} = require('../lib/claude-analysis-invocation');
const {settingValue, SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {
  MARKET_STATE_CASES, ACTIVE_MARKET_STATES, marketStateCase, anthropicResponse, providerTransport
} = require('./fixtures/market-state-cases');

const ENV = 'REPORT_ACCURACY_DIRECTION_ENABLED';
const COVERED = [0, 1, 2, 4, 5, 6];

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

// replies: one writer output (every call) or a list (one per call).
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
      events: diagnostics.filter(value => /^DIRECTION_/.test(value.violationCategory || ''))};
  });
}

// A sentence whose word is wrong for the fixture's own price data, and its corrected form.
function planted(state) {
  return ACTIVE_MARKET_STATES.has(state)
    ? {bad: 'The S&P 500 fell 4.00%.', good: 'The S&P 500 rose 4.00%.'}
    : {bad: 'The S&P 500 rose 1.98%.', good: 'The S&P 500 dropped 1.98%.'};
}

function plant(output, indexes, text) {
  const copy = structuredClone(output);
  for (const index of indexes) {
    copy.sections[index] = {...copy.sections[index], content: `${copy.sections[index].content} ${text}`};
  }
  return copy;
}

test('Step 9AR Build 3: the registry row (Admin boolean, on by default, env REPORT_ACCURACY_DIRECTION_ENABLED)', () => {
  const entry = SETTINGS_REGISTRY.reportAccuracyDirectionEnabled;
  assert.deepEqual([entry.default, entry.admin, entry.envVar, entry.wired, entry.boolean],
    [true, 'Admin', ENV, true, true]);
  assert.equal(settingValue('reportAccuracyDirectionEnabled', {env: {}}), true);
  for (const value of ['off', 'false', '0']) {
    assert.equal(settingValue('reportAccuracyDirectionEnabled', {env: {[ENV]: value}}), false);
  }
  const names = Object.keys(SETTINGS_REGISTRY);
  assert.equal(names.indexOf('reportAccuracyDirectionEnabled'), names.indexOf('sectionThreeNoRepeatEnabled') + 1);
});

test('Step 9AR Build 3: the description is short plain English (the Step 9AD.1 rules)', () => {
  const text = SETTINGS_REGISTRY.reportAccuracyDirectionEnabled.description;
  assert.ok(text.includes('When on') && text.includes('When off'));
  const sentences = text.replace(/"[^"]*"/g, 'QUOTED').split(/[.!?](?:\s+|$)/).filter(part => part.trim());
  assert.ok(sentences.length >= 1 && sentences.length <= 2, `${sentences.length} sentences`);
  assert.ok(!/[0-9a-f]{7,}/i.test(text));
  assert.ok(!/\bStep\b/i.test(text));
  assert.ok(!/\b9[A-Z]{1,2}(\.\d+)?\b/.test(text));
  assert.ok(text.length <= 450, `${text.length} characters`);
});

for (const model of ['haiku-4.5', 'haiku-5.5']) {
  test(`Step 9AR Build 3: ${model}, all six states: wrong word corrected in Sections 1 to 7, TRIMMED counts-only events`, async () => {
    for (const [state, ...rest] of MARKET_STATE_CASES) {
      const {input, output} = marketStateCase(state, ...rest);
      const {bad, good} = planted(state);
      const covered = ACTIVE_MARKET_STATES.has(state) ? COVERED : [...COVERED, 3];
      let reply = plant(output, COVERED, bad);
      if (!ACTIVE_MARKET_STATES.has(state)) reply = plant(reply, [3], 'MSFT rose 1.98%.');
      // The price table is off here so the writer's own Section 4 line is kept (with the table on, this
      // fixture's unsupported explanation is replaced by the table; see the table test below).
      const vars = {CLAUDE_MODEL: model, SECTION_FOUR_TABLE_ENABLED: 'off'};
      const on = await invoke({...vars, [ENV]: undefined}, input, reply);
      const off = await invoke({...vars, [ENV]: 'off'}, input, reply);
      assert.equal(on.result.ok, true, state);
      assert.equal(on.result.output.status, off.result.output.status, `${state}: status must not change`);
      for (const index of COVERED) {
        const text = on.result.output.sections[index].content;
        assert.ok(text.includes(good) && !text.includes(bad), `${state} section ${index + 1}: ${text}`);
        assert.ok(off.result.output.sections[index].content.includes(bad), `${state} off, section ${index + 1}`);
      }
      if (!ACTIVE_MARKET_STATES.has(state)) {
        assert.ok(on.result.output.sections[3].content.includes('MSFT dropped 1.98%.'), state);
      }
      assert.deepEqual(on.events.map(event => event.sectionIndex).sort(), covered.slice().sort(), state);
      for (const event of on.events) {
        assert.equal(event.stage, 'claudeAnalysisSectionNormalization');
        assert.equal(event.violationCategory, 'DIRECTION_WORD_CORRECTED');
        assert.equal(event.action, 'TRIMMED');
        assert.equal(event.correctedCount, 1);
        assert.equal(event.skippedCount, 0);
        assert.equal(event.removedSentenceCount, 0);
        const json = JSON.stringify(event);
        assert.ok(!json.includes('S&P 500') && !json.includes(bad) && !json.includes(good), `text in event: ${json}`);
        assert.deepEqual(Object.keys(event.corrections[0]).sort(), ['newWord', 'oldWord', 'sessionDate', 'symbol']);
      }
      assert.deepEqual(off.events, [], state);
      // Only the planted words differ between on and off.
      for (let index = 0; index < 8; index++) {
        const a = off.result.output.sections[index].content;
        const b = on.result.output.sections[index].content;
        if (a === b) continue;
        assert.equal(b, a.split(bad).join(good).split('MSFT rose 1.98%.').join('MSFT dropped 1.98%.'), `${state} ${index}`);
      }
    }
  });
}

test('Step 9AR Build 3: with nothing wrong, switch on equals switch off exactly (report and every log line)', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, ...rest);
    const right = planted(state).good;
    const reply = plant(output, COVERED, right);
    const on = await invoke({[ENV]: undefined}, input, reply);
    const off = await invoke({[ENV]: 'off'}, input, reply);
    assert.deepEqual(on.result, off.result, state);
    assert.deepEqual(on.diagnostics.filter(d => d.stage !== undefined || !d.usage),
      off.diagnostics.filter(d => d.stage !== undefined || !d.usage), state);
    assert.deepEqual(on.events, [], state);
  }
});

test('Step 9AR Build 3: the Section 4 price table and Further Readings are never changed', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = marketStateCase(state, ...rest);
    // A wrong word in the writer's Section 4 and a move figure in Further Readings.
    const reply = plant(output, [3], 'MSFT rose 1.98%.');
    reply.sections[7] = {...reply.sections[7], content: 'The S&P 500 rose 1.98%.'};
    const on = await invoke({[ENV]: undefined}, input, reply);
    const off = await invoke({[ENV]: 'off'}, input, reply);
    const rows = result => result.output.sections[3].content.split('\n').filter(line => line.includes('|'));
    assert.ok(rows(on.result).length >= 2, state);
    assert.deepEqual(rows(on.result), rows(off.result), state);
    assert.ok(rows(on.result).some(line => line.includes('(2.94%)')), state);
    assert.deepEqual(on.result.output.sections[7], off.result.output.sections[7], state);
    assert.ok(!on.events.some(event => event.sectionIndex === 7), state);
  }
});

test('Step 9AR Build 3: a live or after-close sentence is left as written and counted (liveMoveRisk)', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, ...rest);
    const {bad} = planted(state);
    for (const phrase of ['In pre-market trading', 'In after-hours trading', 'Since the close', 'Overnight']) {
      const sentence = `${phrase}, ${bad[0].toLowerCase()}${bad.slice(1)}`;
      const on = await invoke({[ENV]: undefined}, input, plant(output, [6], sentence));
      assert.ok(on.result.output.sections[6].content.includes(sentence), `${state} ${phrase}`);
      assert.equal(on.events.length, 1, `${state} ${phrase}`);
      assert.deepEqual(on.events[0].skipReasons, {liveMoveRisk: 1});
      assert.equal(on.events[0].correctedCount, 0);
    }
  }
});

test('Step 9AR Build 3: a figure equal to the live move is left as written and counted (liveMoveRisk)', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES.filter(([state]) => ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = marketStateCase(state, ...rest);
    // The fixture's live move for the S&P 500 is +2 points (1.92%); 4.00% matches the completed session.
    // Move the live price so the live move is -4.00% (changes are derived from prices, as the input
    // check requires), so the written figure equals it.
    const live = structuredClone(input);
    const overlay = live.marketPackages[0].telemetry.benchmarkSnapshots[0].snapshot.currentOverlay;
    overlay.lastPrice = 99.84;
    overlay.absoluteChange = overlay.lastPrice - overlay.referenceClose;
    overlay.percentChange = overlay.absoluteChange / overlay.referenceClose * 100;
    const on = await invoke({[ENV]: undefined}, live, plant(output, [6], 'The S&P 500 fell 4.00%.'));
    assert.equal(on.result.ok, true, state);
    assert.ok(on.result.output.sections[6].content.includes('The S&P 500 fell 4.00%.'), state);
    assert.deepEqual(on.events[0].skipReasons, {liveMoveRisk: 1}, state);
    // The same sentence with the fixture's own live move (+1.92%) is corrected.
    const plain = await invoke({[ENV]: undefined}, input, plant(output, [6], 'The S&P 500 fell 4.00%.'));
    assert.ok(plain.result.output.sections[6].content.includes('The S&P 500 rose 4.00%.'), state);
  }
});

test('Step 9AR Build 3: a swap that would newly trip the market-cause check is not made (wouldTripCausalCheck)', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES.filter(([state]) => !ACTIVE_MARKET_STATES.has(state))) {
    const {input, output} = marketStateCase(state, ...rest);
    // "fell in the previous session, on" matches the cause check's "move ... on" pattern; "added" does not.
    const sentence = 'The S&P 500 added in the previous session, on Wednesday, 2.00 points.';
    const on = await invoke({[ENV]: undefined}, input, plant(output, [4], sentence));
    const off = await invoke({[ENV]: 'off'}, input, plant(output, [4], sentence));
    assert.equal(on.result.output.status, off.result.output.status, state);
    assert.ok(on.result.output.sections[4].content.includes(sentence), state);
    assert.deepEqual(on.events[0].skipReasons, {wouldTripCausalCheck: 1}, state);
    assert.equal(on.calls, off.calls, `${state}: no extra writer call`);
  }
});

test('Step 9AR Build 3: Build 2 skips are counted per reason and never change the text', async () => {
  const [state, ...rest] = MARKET_STATE_CASES.find(([name]) => name === 'CLOSED');
  const {input, output} = marketStateCase(state, ...rest);
  const sentence = 'The S&P 500 posted a gain of 1.98%.';
  const on = await invoke({[ENV]: undefined}, input, plant(output, [5], sentence));
  assert.ok(on.result.output.sections[5].content.includes(sentence));
  assert.deepEqual(on.events[0].skipReasons, {nounOrBaseForm: 1});
});

test('Step 9AR Build 3: a package with no usable price data changes nothing and is counted once', () => {
  // The input check refuses such a package before the cleanup, so the branch is checked directly.
  const [state, ...rest] = MARKET_STATE_CASES.find(([name]) => name === 'CLOSED');
  const {input, output} = marketStateCase(state, ...rest);
  const bare = structuredClone(input);
  for (const entry of [...bare.marketPackages[0].telemetry.benchmarkSnapshots,
    ...bare.marketPackages[0].telemetry.stockSnapshots]) entry.snapshot.completedSessions = [];
  const sections = plant(output, [6], planted(state).bad).sections;
  const before = structuredClone(sections);
  const events = directionWordCleanup(sections, bare);
  assert.deepEqual(sections, before);
  assert.deepEqual(events, [{stage: 'claudeAnalysisSectionNormalization',
    violationCategory: 'DIRECTION_CHECK_NO_PRICE_DATA', checkedSectionCount: 0, action: 'TRIMMED'}]);
  // With price data the same sections are corrected.
  const withData = directionWordCleanup(sections, input);
  assert.equal(withData.length, 1);
  assert.ok(sections[6].content.includes(planted(state).good));
});

test('Step 9AR Build 3: a wrong sentence in the Further Readings slot is never corrected or counted', () => {
  const [state, ...rest] = MARKET_STATE_CASES.find(([name]) => name === 'CLOSED');
  const {input, output} = marketStateCase(state, ...rest);
  const sections = structuredClone(output.sections);
  sections[7] = {...sections[6], name: sections[7].name, content: planted(state).bad};
  const events = directionWordCleanup(sections, input);
  assert.equal(sections[7].content, planted(state).bad);
  assert.deepEqual(events, []);
});

test('Step 9AR Build 3: runs on the contract retry and on a section-retry round', async () => {
  for (const [state, ...rest] of MARKET_STATE_CASES) {
    const {input, output} = marketStateCase(state, ...rest);
    const {bad, good} = planted(state);
    // Contract retry: the first reply is not valid JSON, the second carries the wrong word.
    const broken = () => ({ok: true, status: 200, async json() { return {content: [{type: 'text', text: '{not json'}]}; }});
    const retried = await invoke({[ENV]: undefined}, input, [broken, plant(output, [6], bad)]);
    assert.equal(retried.result.ok, true, state);
    assert.ok(retried.result.output.sections[6].content.includes(good), `${state} contract retry`);

    // Section retry: Section 7 comes back empty, the round fills it with the wrong word.
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
    assert.ok(round.output.sections[6].content.includes(good), `${state} section retry: ${round.output.sections[6].content}`);
    assert.ok(!round.output.sections[6].content.includes(bad), state);
  }
});

test('Step 9AR Build 3: the same wrong sentence twice in a section is corrected in both places', async () => {
  const [state, ...rest] = MARKET_STATE_CASES.find(([name]) => name === 'CLOSED');
  const {input, output} = marketStateCase(state, ...rest);
  const {bad, good} = planted(state);
  const on = await invoke({[ENV]: undefined}, input, plant(output, [5], `${bad} Then a pause. ${bad}`));
  assert.ok(on.result.output.sections[5].content.endsWith(`${good} Then a pause. ${good}`), on.result.output.sections[5].content);
  assert.equal(on.events[0].correctedCount, 2);
});

test('Step 9AR Build 3: spaces and line breaks around a corrected sentence are kept', async () => {
  const [state, ...rest] = MARKET_STATE_CASES.find(([name]) => name === 'WEEKEND');
  const {input, output} = marketStateCase(state, ...rest);
  const copy = structuredClone(output);
  copy.sections[6] = {...copy.sections[6], content: `${copy.sections[6].content}  The S&P 500 rose 1.98%.  It was busy.`};
  const on = await invoke({[ENV]: undefined}, input, copy);
  assert.ok(on.result.output.sections[6].content.endsWith('  The S&P 500 dropped 1.98%.  It was busy.'));
});

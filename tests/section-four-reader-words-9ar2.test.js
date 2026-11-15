// Step 9AR.2: with readerWordingEnabled on, the Haiku 5.5 Section 4 line gets one sentence telling the
// writer to name the source, to give the company news itself when an article gives no reason, and never
// to write "linked article" style words. Off, or any other model, or no Section 4 table: no change.
// Free tests only: no network, no paid call. The sentence is an independent copy (the code's constant
// is not imported).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {MARKET_STATE_CASES, marketStateCase} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED', 'SECTION_FOUR_BOTH_LISTS_ENABLED',
  'READER_WORDING_ENABLED', 'SECTION_FOUR_FOCUS_POINTER_ENABLED', 'SECTION_THREE_NO_REPEAT_ENABLED'];
const H55 = {CLAUDE_MODEL: 'haiku-5.5'};

const SENTENCE = 'Write Section 4 for a reader who cannot see the articles. Name the source in the '
  + 'sentence itself (for example "Yahoo Finance reported that Nvidia signed a new chip supply deal"). '
  + 'Where an article gives no reason for the move, write the company news itself and nothing about the '
  + 'move. Never write "linked article", "linked articles", "the article linked to it" or "company news '
  + 'that does not explain the move", and never say how the articles were chosen or matched to a stock.';
const LINE_START = 'Section 4: keep the text under the table short.';
const LINE_END = 'for Section 4.';
const NOT_NULL = 'Section 4 must not be null when';
const BANNED = ['"linked article"', '"linked articles"', '"the article linked to it"',
  '"company news that does not explain the move"'];

async function withEnvs(values, callback) {
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

function count(text, part) {
  return text.split(part).length - 1;
}

async function systemFor(input, env) {
  return (await withEnvs(env, () => buildClaudeAnalysisRequest(input))).system;
}

for (const [marketState, ...rest] of MARKET_STATE_CASES) {
  test(`Step 9AR.2: ${marketState} -- switch on (default), Haiku 5.5: the sentence appears once, inside the Section 4 line, just before its not-null rule`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const system = await systemFor(input, H55);
    assert.equal(count(system, SENTENCE), 1);
    assert.equal(count(system, `${SENTENCE} ${NOT_NULL}`), 1);
    const start = system.indexOf(LINE_START);
    const at = system.indexOf(SENTENCE);
    assert.ok(start >= 0 && start < at, 'after the Section 4 line start');
    assert.ok(at < system.indexOf(LINE_END, start), 'before the Section 4 line end');
    // Each banned phrase is named once, only inside the ban; the source example is there.
    for (const phrase of BANNED) assert.equal(count(system, phrase), 1, phrase);
    assert.equal(count(system, 'Yahoo Finance reported that'), 1);
  });

  test(`Step 9AR.2: ${marketState} -- switch off, Haiku 5.5: removing the sentence is the only difference`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const on = await systemFor(input, {...H55, READER_WORDING_ENABLED: 'on'});
    const off = await systemFor(input, {...H55, READER_WORDING_ENABLED: 'off'});
    assert.equal(count(off, SENTENCE), 0);
    assert.equal(count(off, NOT_NULL), 1);
    // Off also drops the 9AQ reader lines, so compare the Section 4 line only.
    const lineOf = text => text.slice(text.indexOf(LINE_START), text.indexOf(LINE_END, text.indexOf(LINE_START)));
    assert.equal(lineOf(on), lineOf(off).replace(NOT_NULL, () => `${SENTENCE} ${NOT_NULL}`));
  });

  test(`Step 9AR.2: ${marketState} -- other models, the block off, or no Section 4 table: no sentence and no change from the switch`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'}, {...H55, HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      {MODEL_CHOICE_ENABLED: 'off', CLAUDE_MODEL: 'haiku-5.5'}]) {
      const on = await systemFor(input, {...env, READER_WORDING_ENABLED: 'on'});
      const off = await systemFor(input, {...env, READER_WORDING_ENABLED: 'off'});
      assert.equal(count(on, SENTENCE), 0, JSON.stringify(env));
      assert.equal(on, off, JSON.stringify(env));
    }
    const noTable = await systemFor(input, {...H55, SECTION_FOUR_TABLE_ENABLED: 'off'});
    assert.equal(count(noTable, SENTENCE), 0);
  });

  test(`Step 9AR.2: ${marketState} -- an env passed to the request builder decides, not process.env`, async () => {
    const {input} = marketStateCase(marketState, ...rest);
    const viaArg = await withEnvs({READER_WORDING_ENABLED: 'on'},
      () => buildClaudeAnalysisRequest(input, {env: {...H55, READER_WORDING_ENABLED: 'off'}}));
    assert.equal(count(viaArg.system, SENTENCE), 0);
    const viaArgOn = await withEnvs({READER_WORDING_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input, {env: {...H55, READER_WORDING_ENABLED: 'on'}}));
    assert.equal(count(viaArgOn.system, SENTENCE), 1);
  });
}

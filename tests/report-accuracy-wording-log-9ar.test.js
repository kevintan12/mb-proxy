// Step 9AR Build 5: the counts-only wording log (Step 9AQ) also counts phrases that tell the reader how
// the report was built ("linked article", "not explained by any linked article", "newsStocks", ...).
// Counts only: no report text changes, no sentence text in the log, no new setting.
// Free tests only: made-up text, no network, no paid call. No existing test is edited.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {MARKET_STATE_CASES, marketStateCase, anthropicResponse} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'READER_WORDING_ENABLED'];
const H55 = {CLAUDE_MODEL: 'haiku-5.5'};

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

async function runWriter(input, reply, env = H55) {
  const diagnostics = [];
  const result = await withEnvs(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    onDiagnostics: value => diagnostics.push(value),
    fetchImpl: async () => anthropicResponse(reply)
  }));
  return {result, diagnostics,
    wordingEvents: diagnostics.filter(value => value.stage === 'readerWordingResidue')};
}

function closedCase() {
  const entry = MARKET_STATE_CASES.find(candidate => candidate[0] === 'CLOSED');
  return marketStateCase(...entry);
}

// Section 1 gets the sentence; returns the Section 1 count (0 when no line was written).
async function sectionOneCount(sentence, env = H55) {
  const {input, output} = closedCase();
  const planted = structuredClone(output);
  planted.sections[0].content += ` ${sentence}`;
  const run = await runWriter(input, planted, env);
  assert.equal(run.result.type, 'SUCCESS', run.result.message);
  assert.ok(run.result.output.sections[0].content.includes(sentence), 'the sentence is still in the report');
  const entry = run.wordingEvents.flatMap(event => event.sections).find(value => value.sectionIndex === 0);
  return {count: entry ? entry.readerWordCount : 0, run};
}

const NEW_PATTERN_SENTENCES = [
  ['linked article', 'Microsoft rose as its linked article covers the cloud results.'],
  ['linked articles', 'Several linked articles describe the rally.'],
  ['article linked to', 'The article linked to it describes the deal.'],
  ['articles linked to', 'Two articles linked to the stock describe the deal.'],
  ['the cited article', 'The cited article describes the deal.'],
  ['its supplied source', 'Its supplied source describes the deal.'],
  ['the linked reference', 'The linked reference describes the deal.'],
  ['not explained by any article', 'The move is not explained by any article.'],
  ['not explained by any linked article', 'The move is not explained by any linked article.'],
  ['company news that does not explain', 'There is company news that does not explain the move.'],
  ['newsStocks', 'The newsStocks list names Microsoft.'],
  ['focus reference', 'A focus reference names Apple.']
];

const NORMAL_PROSE = [
  'Oil prices linked to the Middle East war rose again.',
  'A linked pair of trades lifted volumes.',
  'The article said the deal could close this year.',
  'There is company news that explains the move.',
  'Shares are linked to the price of oil.',
  'The focus of the session was technology.'
];

// The three real 9 November Section 4 sentences (made-up shortened endings).
const REAL_SENTENCES = [
  "Apple's linked article covers the new product launch.",
  'The fall is not explained by any linked article about the company.',
  'There is little detail in the article linked to it.'
];

test('Step 9AR Build 5: each new pattern is counted once', async () => {
  for (const [name, sentence] of NEW_PATTERN_SENTENCES) {
    const {count} = await sectionOneCount(sentence);
    assert.equal(count, 1, `${name}: ${sentence}`);
  }
});

test('Step 9AR Build 5: the three real 9 November sentences are each counted once', async () => {
  for (const sentence of REAL_SENTENCES) {
    const {count} = await sectionOneCount(sentence);
    assert.equal(count, 1, sentence);
  }
});

test('Step 9AR Build 5: normal prose is not counted and writes no log line', async () => {
  for (const sentence of NORMAL_PROSE) {
    const {count, run} = await sectionOneCount(sentence);
    assert.equal(count, 0, sentence);
    assert.equal(run.wordingEvents.length, 0, sentence);
  }
});

test('Step 9AR Build 5: the report text is byte-identical, and the log holds counts only', async () => {
  const {input, output} = closedCase();
  const planted = structuredClone(output);
  planted.sections[0].content += ` ${REAL_SENTENCES.join(' ')} ${NEW_PATTERN_SENTENCES.map(entry => entry[1]).join(' ')}`;
  const on = await runWriter(input, planted);
  assert.equal(on.result.type, 'SUCCESS', on.result.message);
  assert.equal(on.wordingEvents.length, 1);
  assert.ok(on.wordingEvents[0].sections.find(value => value.sectionIndex === 0).readerWordCount >= 10);
  // The log carries only numbers: no sentence text.
  assert.doesNotMatch(JSON.stringify(on.wordingEvents[0]),
    /linked|article|newsStocks|focus reference|Apple|Microsoft|explain/i);
  for (const section of on.wordingEvents[0].sections) {
    assert.deepEqual(Object.keys(section).sort(),
      ['closingFillerCount', 'contradictionCount', 'readerWordCount', 'sectionIndex']);
  }
  // The same reply with the wording switch off gives the identical report and no wording line.
  const off = await runWriter(input, planted, {...H55, READER_WORDING_ENABLED: 'off'});
  assert.deepEqual(off.result.output, on.result.output);
  assert.equal(off.wordingEvents.length, 0);
  for (const sentence of REAL_SENTENCES) {
    assert.ok(on.result.output.sections[0].content.includes(sentence));
  }
});

test('Step 9AR Build 5: Haiku 4.5 logs nothing for the new phrases', async () => {
  const {count, run} = await sectionOneCount(REAL_SENTENCES[0], {CLAUDE_MODEL: 'haiku-4.5'});
  assert.equal(count, 0);
  assert.equal(run.wordingEvents.length, 0);
});

// Step 9AC Stage 1 follow-up: a raw model value (from CLAUDE_MODEL, the model query value
// or the ?claude=1 body) never appears in any log line. A unique marker is passed through
// each route and the captured output of every console method is searched for it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {emitModelCost, resolveModelChoice, runWithModelChoiceContext} = require('../lib/model-choice');
const handler = require('../api/quote');

const MARKER = 'zz-marker-9ac-7f3a1c';
const MODEL_ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'LEGACY_MODEL_GUARD_ENABLED',
  'USER_MODEL_CHOICE_ENABLED'];

async function withEnv(values, callback) {
  const saved = Object.fromEntries(MODEL_ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of MODEL_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of MODEL_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// Every console method, so a stray log, warn or error is caught as well as info.
async function captureAllLogs(callback) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map(name => [name, console[name]]));
  const lines = [];
  for (const name of methods) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try {
    const result = await callback();
    return {result, lines};
  } finally {
    for (const name of methods) console[name] = originals[name];
  }
}

function assertNoMarker(lines) {
  for (const line of lines) assert.equal(line.includes(MARKER), false, `marker found in log line: ${line}`);
}

function mockRes() {
  return {
    statusCode: null, headers: {}, chunks: [], ended: false, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    write(value) { this.chunks.push(value); },
    end() { this.ended = true; },
    json(value) { this.body = value; return this; }
  };
}

test('Step 9AC: a model marker (CLAUDE_MODEL, query value, ?claude=1 body) reaches no log line', async () => {
  // CLAUDE_MODEL marker: the fallback line and the cost line.
  const fromEnv = await captureAllLogs(() => withEnv({CLAUDE_MODEL: MARKER}, () => {
    const choice = resolveModelChoice({env: process.env});
    emitModelCost({call: 'writer', model: choice.apiModel, requestId: 'req_1',
      usage: {input_tokens: 1000, output_tokens: 100}, env: process.env});
    // A raw unknown name passed straight to the cost line writes nothing.
    emitModelCost({call: 'writer', model: MARKER, usage: {input_tokens: 1, output_tokens: 1}, env: process.env});
    return choice;
  }));
  assert.equal(fromEnv.result.id, 'haiku-4.5');
  assert.equal(fromEnv.lines.some(line => line.startsWith('[model-choice]')), true, 'fallback line written');
  assert.equal(fromEnv.lines.some(line => line.startsWith('[model-cost]')), true, 'cost line written');
  assertNoMarker(fromEnv.lines);

  // Query-value marker: the fallback line and the cost line.
  const fromQuery = await captureAllLogs(() => withEnv({USER_MODEL_CHOICE_ENABLED: 'on'}, () =>
    runWithModelChoiceContext({queryModel: MARKER}, () => {
      const choice = resolveModelChoice({env: process.env});
      emitModelCost({call: 'classifier', model: choice.apiModel, requestId: 'req_2',
        usage: {input_tokens: 500, output_tokens: 50}, env: process.env});
      return choice;
    })));
  assert.equal(fromQuery.result.id, 'haiku-4.5');
  assert.equal(fromQuery.lines.some(line => line.startsWith('[model-choice]')), true, 'fallback line written');
  assert.equal(fromQuery.lines.some(line => line.startsWith('[model-cost]')), true, 'cost line written');
  assertNoMarker(fromQuery.lines);

  // ?claude=1 body marker: the legacy-guard line.
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'legacy-key';
  global.fetch = async () => ({
    status: 200,
    headers: {get() { return 'text/event-stream'; }},
    body: {getReader() { return {async read() { return {done: true}; }}; }}
  });
  try {
    const legacy = await captureAllLogs(() => withEnv({}, () => handler({
      method: 'POST', query: {claude: '1'}, body: {model: MARKER, messages: []}
    }, mockRes())));
    assert.equal(legacy.lines.some(line => line.startsWith('[claude.legacy]')), true, 'guard line written');
    assertNoMarker(legacy.lines);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

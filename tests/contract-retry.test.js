const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACT_RETRY_MAX_ELAPSED_MS,
  markTruncatedFailure,
  retryOnContractFailure
} = require('../lib/contract-retry');

const contractFailure = () => ({ok: false, type: 'CONTRACT_FAILURE', message: 'bad', upstreamStatus: 200});

test('Step 8L: retries exactly once and reports the outcome', async () => {
  const results = [contractFailure(), {ok: true, type: 'SUCCESS'}];
  let calls = 0;
  const events = [];
  const result = await retryOnContractFailure(async () => results[calls++], {
    call: 'writer', onDiagnostics: value => events.push(value)
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'contractRetry');
  assert.equal(events[0].retryOutcome, 'SUCCESS');
});

test('Step 8L: does not retry other failure types, successes or truncated answers', async () => {
  for (const value of [
    {ok: true, type: 'SUCCESS'},
    {ok: false, type: 'UPSTREAM_FAILURE'},
    {ok: false, type: 'INPUT_FAILURE'},
    {ok: false, type: 'REQUEST_TOO_LARGE'},
    markTruncatedFailure(contractFailure(), {stop_reason: 'max_tokens'})
  ]) {
    let calls = 0;
    const events = [];
    const result = await retryOnContractFailure(async () => { calls++; return value; }, {
      call: 'writer', onDiagnostics: event => events.push(event)
    });
    assert.equal(result, value);
    assert.equal(calls, 1);
    assert.equal(events.length, 0);
  }
});

test('Step 8L: a non-truncated stop reason is still retried', async () => {
  let calls = 0;
  await retryOnContractFailure(async () => {
    calls++;
    return markTruncatedFailure(contractFailure(), {stop_reason: 'end_turn'});
  }, {call: 'writer'});
  assert.equal(calls, 2);
});

test('Step 8L: skips the retry once the elapsed-time guard is exceeded', async () => {
  assert.equal(CONTRACT_RETRY_MAX_ELAPSED_MS, 150000);
  const clock = [0, CONTRACT_RETRY_MAX_ELAPSED_MS + 1];
  let calls = 0;
  const result = await retryOnContractFailure(async () => { calls++; return contractFailure(); }, {
    call: 'classifier', monotonicNow: () => clock.shift() ?? 999999
  });
  assert.equal(result.type, 'CONTRACT_FAILURE');
  assert.equal(calls, 1);
});

test('Step 8L: a throwing diagnostics callback does not change the result', async () => {
  const results = [contractFailure(), {ok: true, type: 'SUCCESS'}];
  let calls = 0;
  const result = await retryOnContractFailure(async () => results[calls++], {
    call: 'writer', onDiagnostics() { throw new Error('boom'); }
  });
  assert.equal(result.ok, true);
});

// Step 9F.1d: table-driven checks for the shared download retry helper and the
// reading budget. Fake time only: the stand-in sleep just moves a fake clock.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DOWNLOAD_ATTEMPTS,
  DOWNLOAD_RETRY_PAUSES_MS,
  isTemporaryDownloadFailure,
  createReadingBudget,
  downloadWithRetries
} = require('../lib/reading-window');

const SUCCESS = Object.freeze({ok: true, type: 'SUCCESS', articleContent: {}});
const fail = (type, extra = {}) => Object.freeze({ok: false, type, articleContent: null, ...extra});

function fakeClock() {
  const clock = {now: 0, pauses: []};
  clock.read = () => clock.now;
  clock.sleep = async ms => { clock.pauses.push(ms); clock.now += ms; };
  return clock;
}

// A stand-in fetcher that returns each scripted result in turn, then SUCCESS.
function scripted(results, {costMs = 0, clock = null} = {}) {
  const fetcher = async () => {
    fetcher.calls++;
    if (clock) clock.now += costMs;
    const next = results[fetcher.calls - 1];
    if (next instanceof Error) throw next;
    return next || SUCCESS;
  };
  fetcher.calls = 0;
  return fetcher;
}

const ROWS = [
  {name: 'fails once then succeeds', script: [fail('TIMEOUT')], attempts: 2, ok: true, pauses: [250]},
  {name: 'fails twice then succeeds', script: [fail('RETRIEVAL_FAILURE'), fail('RESPONSE_READ_FAILURE')],
    attempts: 3, ok: true, pauses: [250, 750]},
  {name: 'fails three times (would succeed on a fourth)', script: [fail('TIMEOUT'), fail('TIMEOUT'), fail('TIMEOUT')],
    attempts: 3, ok: false, pauses: [250, 750]},
  {name: '429 server busy is retried', script: [fail('HTTP_FAILURE', {httpStatus: 429})], attempts: 2, ok: true, pauses: [250]},
  {name: '503 server error is retried', script: [fail('HTTP_FAILURE', {httpStatus: 503})], attempts: 2, ok: true, pauses: [250]},
  {name: '404 page not found: one attempt', script: [fail('HTTP_FAILURE', {httpStatus: 404})], attempts: 1, ok: false, pauses: []},
  {name: 'reply with no status: one attempt', script: [fail('HTTP_FAILURE')], attempts: 1, ok: false, pauses: []},
  {name: 'unreadable page: one attempt', script: [fail('NO_USABLE_ARTICLE', {extractionFailureType: 'NO_ARTICLE_BODY_CONTAINER_OR_TEXT'})],
    attempts: 1, ok: false, pauses: []},
  {name: 'wrong page identity: one attempt', script: [fail('IDENTITY_MISMATCH')], attempts: 1, ok: false, pauses: []},
  {name: 'not a web page: one attempt', script: [fail('INVALID_CONTENT_TYPE')], attempts: 1, ok: false, pauses: []},
  {name: 'page too large: one attempt', script: [fail('RESPONSE_TOO_LARGE')], attempts: 1, ok: false, pauses: []},
  {name: 'bad request: one attempt', script: [fail('INVALID_INPUT')], attempts: 1, ok: false, pauses: []},
  {name: 'success first time', script: [], attempts: 1, ok: true, pauses: []}
];

for (const row of ROWS) {
  test(`Step 9F.1d download retries: ${row.name}`, async () => {
    const clock = fakeClock();
    const fetcher = scripted(row.script);
    const outcome = await downloadWithRetries(fetcher, {sleep: clock.sleep});
    assert.equal(outcome.attempts, row.attempts);
    assert.equal(fetcher.calls, row.attempts);
    assert.equal(outcome.result.ok === true, row.ok);
    assert.deepEqual(clock.pauses, row.pauses);
    assert.equal(outcome.budgetStopped, false);
  });
}

test('Step 9F.1d download retries: the attempt count and pauses are fixed', () => {
  assert.equal(DOWNLOAD_ATTEMPTS, 3);
  assert.deepEqual([...DOWNLOAD_RETRY_PAUSES_MS], [250, 750]);
  assert.equal(Object.isFrozen(DOWNLOAD_RETRY_PAUSES_MS), true);
  assert.equal(isTemporaryDownloadFailure(SUCCESS), false);
  assert.equal(isTemporaryDownloadFailure(null), false);
});

test('Step 9F.1d download retries: a thrown error is returned after one attempt, not retried', async () => {
  const clock = fakeClock();
  const fetcher = scripted([new Error('network')]);
  const outcome = await downloadWithRetries(fetcher, {sleep: clock.sleep});
  assert.deepEqual([outcome.attempts, outcome.result, outcome.error.message], [1, null, 'network']);
  assert.equal(fetcher.calls, 1);
});

test('Step 9F.1d reading budget: no retry starts once too little budget is left for its pause', async () => {
  const rows = [
    // Budget, download cost, expected attempts, budget stopped.
    {budgetMs: 30000, costMs: 4000, attempts: 3, stopped: false},
    {budgetMs: 4200, costMs: 4000, attempts: 1, stopped: true},
    {budgetMs: 9000, costMs: 4000, attempts: 2, stopped: true},
    {budgetMs: 9001, costMs: 4000, attempts: 3, stopped: false}
  ];
  for (const row of rows) {
    const clock = fakeClock();
    const budget = createReadingBudget({budgetMs: row.budgetMs, now: clock.read});
    const fetcher = scripted([fail('TIMEOUT'), fail('TIMEOUT'), fail('TIMEOUT')], {costMs: row.costMs, clock});
    const outcome = await downloadWithRetries(fetcher, {budget, sleep: clock.sleep});
    assert.deepEqual([outcome.attempts, outcome.budgetStopped], [row.attempts, row.stopped], JSON.stringify(row));
    assert.equal(outcome.result.type, 'TIMEOUT');
  }
});

test('Step 9F.1d reading budget: spent once the clock reaches the budget', () => {
  const clock = fakeClock();
  const budget = createReadingBudget({budgetMs: 30000, now: clock.read});
  assert.equal(budget.spent(), false);
  clock.now = 29999;
  assert.deepEqual([budget.spent(), budget.remainingMs()], [false, 1]);
  clock.now = 30000;
  assert.equal(budget.spent(), true);
});

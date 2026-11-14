// Step 9AT Build 4: findings from the independent Group B re-run on 48b216c. The check covers writer text in
// Section 4 (it runs before the code-built table is composed), and an inline "reported at <time> ET that"
// with no comma is the form C that 78197c9 already removed. Free tests only: made-up text, fake fetch.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {findTimeClaims, checkTimeClaim, dropTimePhrase} = require('../lib/report-accuracy-time');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {anthropicResponse, marketStateCase, MARKET_STATE_CASES, ACTIVE_MARKET_STATES} = require('./fixtures/market-state-cases');

const ENV = 'TIME_MATCHES_ARTICLE_ENABLED';
const REUTERS = {reference: 'r1', publishedEt: 'Tue 8 Sep, 6:15 am ET', publisher: 'Reuters', title: 'Futures flat', summary: ''};

test('Step 9AT Build 4: "Reuters reported at 9:06 am ET that ..." is form C (as at 78197c9) and only the time goes', () => {
  const sentence = 'Reuters reported at 9:06 am ET that futures were flat.';
  const [claim] = findTimeClaims(sentence);
  assert.equal(claim.phrase.form, 'C');
  assert.deepEqual(checkTimeClaim(claim, [REUTERS]), {verdict: 'fail', reason: 'timeMismatch'});
  assert.equal(dropTimePhrase(sentence, claim).sentence, 'Reuters reported that futures were flat.');
});

// Active states only: in this fixture's completed states the earlier Section 4 stock-cause cut
// (UNSUPPORTED_STOCK_CAUSE) empties Section 4 before the time check runs, so there is no writer text left.
test('Step 9AT Build 4: the check covers writer sentences in Section 4 (switch on), and off changes nothing', async () => {
  const saved = process.env[ENV];
  try {
    const active = MARKET_STATE_CASES.filter(([state]) => ACTIVE_MARKET_STATES.has(state));
    assert.equal(active.length, 3);
    for (const [state, generatedAt, overlayAsOf, publishedAt] of active) {
      const {input, output} = marketStateCase(state, generatedAt, overlayAsOf, publishedAt);
      const planted = structuredClone(output);
      planted.sections[3].content += ' At 3:17 am ET, Reuters reported that Microsoft shares were steady.';
      const events = {};
      for (const env of ['on', 'off']) {
        process.env[ENV] = env;
        const diagnostics = [];
        const result = await invokeClaudeAnalysis({input, apiKey: 'test-key',
          fetchImpl: async () => anthropicResponse(planted), onDiagnostics: value => diagnostics.push(value)});
        assert.equal(result.ok, true, `${state} ${env}`);
        events[env] = diagnostics.filter(value => value.violationCategory === 'TIME_ARTICLE_MISMATCH');
      }
      const sectionFour = events.on.filter(event => event.sectionIndex === 3);
      assert.equal(sectionFour.length, 1, state);
      assert.equal(sectionFour[0].droppedTimeCount, 1, state);
      assert.equal(sectionFour[0].action, 'TRIMMED', state);
      assert.deepEqual(events.off, [], state);
    }
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  }
});

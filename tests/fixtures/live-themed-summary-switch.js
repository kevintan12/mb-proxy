// Step 9Z.1: tests written before liveThemedSummaryEnabled that check the exact b7a5bb1 live
// since-close lead (its Section 1 clauses and format example) or a hash of the whole live writer
// request run with the switch off, so they keep checking exactly what they were written for. The
// new behaviour has its own tests (tests/live-themed-summary.test.js). Every other test runs with
// the switch as set.
const {withEnv} = require('./step-8w-switches');

function liveThemedSummaryOffTests(test, names) {
  const pinned = new Set(names);
  const wrapped = (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withEnv('LIVE_THEMED_SUMMARY_ENABLED', 'off', () => fn(...args));
    }
    return test(name, ...rest);
  };
  // Keep test.beforeEach, test.afterEach and the rest.
  for (const key of Object.getOwnPropertyNames(test)) {
    if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) wrapped[key] = test[key];
  }
  return wrapped;
}

module.exports = {liveThemedSummaryOffTests};

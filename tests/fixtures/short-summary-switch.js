// Step 9Z: tests written before shortExecutiveSummaryEnabled that check the exact 43c8d3d
// Section 1 writer line, writer request size or log-line list run with the switch off, so they
// keep checking exactly what they were written for. The new behaviour has its own tests
// (tests/short-executive-summary.test.js). Every other test runs with the switch as set.
const {withEnv} = require('./step-8w-switches');

function shortSummaryOffTests(test, names) {
  const pinned = new Set(names);
  const wrapped = (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withEnv('SHORT_EXECUTIVE_SUMMARY_ENABLED', 'off', () => fn(...args));
    }
    return test(name, ...rest);
  };
  // Keep test.beforeEach, test.afterEach and the rest (tests/quote.test.js uses them).
  for (const key of Object.getOwnPropertyNames(test)) {
    if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) wrapped[key] = test[key];
  }
  return wrapped;
}

module.exports = {shortSummaryOffTests};

// Step 9AA Build 1: tests written before sectionFourTableEnabled that check the exact 5409b44
// Section 4 text, writer request or log-line list run with the switch off, so they keep checking
// exactly what they were written for. The table has its own tests
// (tests/section-four-table.test.js). Every other test runs with the switch as set.
const {withEnv} = require('./step-8w-switches');

const ENV_VAR = 'SECTION_FOUR_TABLE_ENABLED';

function withSectionFourTableSwitch(value, fn) {
  return withEnv(ENV_VAR, value, fn);
}

function sectionFourTableOffTests(test, names) {
  const pinned = new Set(names);
  const wrapped = (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withEnv(ENV_VAR, 'off', () => fn(...args));
    }
    return test(name, ...rest);
  };
  // Keep test.beforeEach, test.afterEach and the rest (tests/quote.test.js uses them).
  for (const key of Object.getOwnPropertyNames(test)) {
    if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) wrapped[key] = test[key];
  }
  return wrapped;
}

module.exports = {withSectionFourTableSwitch, sectionFourTableOffTests};

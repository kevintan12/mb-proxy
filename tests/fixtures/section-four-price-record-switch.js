// Step 9AA.2: tests written before sectionFourPriceRecordEnabled that check the exact 3722898
// package refs, closing line or note line run with the switch off, so they keep checking exactly
// what they were written for. The price records have their own tests
// (tests/section-four-price-record.test.js). Every other test runs with the switch as set.
const {withEnv} = require('./step-8w-switches');

const ENV_VAR = 'SECTION_FOUR_PRICE_RECORD_ENABLED';

function withSectionFourPriceRecordSwitch(value, fn) {
  return withEnv(ENV_VAR, value, fn);
}

function sectionFourPriceRecordOffTests(test, names) {
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

module.exports = {withSectionFourPriceRecordSwitch, sectionFourPriceRecordOffTests};

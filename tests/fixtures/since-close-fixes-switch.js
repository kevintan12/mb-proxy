// Step 9V.3: tests written before sinceCloseFixesEnabled that check the exact f5aa78b CNBC recap
// requests run with the switch off, so they keep checking exactly what they were written for. The
// new behaviour has its own tests (tests/since-close-fixes.test.js). Every other test runs with
// the switch as set.
const {withEnv} = require('./step-8w-switches');

function sinceCloseFixesOffTests(test, names) {
  const pinned = new Set(names);
  return (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withEnv('SINCE_CLOSE_FIXES_ENABLED', 'off', () => fn(...args));
    }
    return test(name, ...rest);
  };
}

module.exports = {sinceCloseFixesOffTests};

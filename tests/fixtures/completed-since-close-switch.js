// Step 9V: tests written before completedSinceCloseEnabled that check the exact 52552bc
// Closed, Weekend or Holiday Section 1 text or writer request run with the switch off, so they
// keep checking exactly what they were written for. The new behaviour has its own tests
// (tests/completed-since-close.test.js). Every other test runs with the switch as set.
const {withEnv} = require('./step-8w-switches');

function completedSinceCloseOffTests(test, names) {
  const pinned = new Set(names);
  return (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withEnv('COMPLETED_SINCE_CLOSE_ENABLED', 'off', () => fn(...args));
    }
    return test(name, ...rest);
  };
}

module.exports = {completedSinceCloseOffTests};

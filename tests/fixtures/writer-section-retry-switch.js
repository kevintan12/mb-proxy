// Step 9L: tests written before the section retry assert exactly one writer call (or an
// exact list of cleanup events) on a reply that leaves Section 1, 2, 3, 5, 6 or 7 empty on
// purpose. With the section retry on, that empty section is retried, so these tests run with
// writerSectionRetryEnabled off and keep checking the cleanup behaviour they were written
// for. The section retry has its own tests (tests/writer-section-retry.test.js). Every other
// test runs with the switch as set.
const ENV_VAR = 'WRITER_SECTION_RETRY_ENABLED';

async function withSectionRetrySwitch(value, fn) {
  const saved = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  }
}

function sectionRetryOffTests(test, names) {
  const pinned = new Set(names);
  return (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withSectionRetrySwitch('off', () => fn(...args));
    }
    return test(name, ...rest);
  };
}

module.exports = {withSectionRetrySwitch, sectionRetryOffTests};

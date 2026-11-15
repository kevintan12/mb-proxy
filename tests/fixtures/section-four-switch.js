// Step 21D.2: tests written for the old rule (Section 4 covers only the list that started the
// brief) run with sectionFourBothListsEnabled off, so they keep checking the behaviour the switch
// restores. Their fixtures pin it: a second list with a stock that has no article, prose about
// "the list", or the old writer text and request size. The both-lists behaviour has its own tests
// (tests/section-four-both-lists.test.js). Every other test runs with the switch as set.
const ENV_VAR = 'SECTION_FOUR_BOTH_LISTS_ENABLED';

async function withSectionFourSwitch(value, fn) {
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

function startingListTests(test, names) {
  const pinned = new Set(names);
  return (name, ...rest) => {
    const index = rest.length - 1;
    if (pinned.has(name) && typeof rest[index] === 'function') {
      const fn = rest[index];
      rest[index] = (...args) => withSectionFourSwitch('off', () => fn(...args));
    }
    return test(name, ...rest);
  };
}

module.exports = {withSectionFourSwitch, startingListTests};

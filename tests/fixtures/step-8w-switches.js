// Step 9F.4c + 8W: tests written before these switches that check the old identical
// labelling retry or the old writer request run with the matching switch off, so they keep
// checking exactly what they were written for. The new behaviour has its own tests
// (tests/date-accuracy-classifier-retry.test.js). Every other test runs with the switches as set.
async function withEnv(envVar, value, fn) {
  const saved = process.env[envVar];
  if (value === undefined) delete process.env[envVar];
  else process.env[envVar] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
  }
}

function switchOffTests(envVar) {
  return (test, names) => {
    const pinned = new Set(names);
    return (name, ...rest) => {
      const index = rest.length - 1;
      if (pinned.has(name) && typeof rest[index] === 'function') {
        const fn = rest[index];
        rest[index] = (...args) => withEnv(envVar, 'off', () => fn(...args));
      }
      return test(name, ...rest);
    };
  };
}

module.exports = {
  withEnv,
  classifierGuidanceOffTests: switchOffTests('CLASSIFIER_RETRY_GUIDANCE_ENABLED'),
  dateAccuracyOffTests: switchOffTests('DATE_ACCURACY_ENABLED')
};

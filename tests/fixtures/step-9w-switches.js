// Step 9W Build A: a test written before companySpotlightEnabled that checks the
// exact 70b8da6 reading or package can run with the switch off through this
// wrapper (none needed it at the time of the build: the existing fakes lack the
// spotlight methods, so the spotlight stays out by itself). The new behaviour
// has its own tests (tests/company-spotlight.test.js).
const {withEnv, switchOffTests} = (() => {
  const {withEnv: run} = require('./step-8w-switches');
  const wrap = envVar => (test, names) => {
    const pinned = new Set(names);
    return (name, ...rest) => {
      const index = rest.length - 1;
      if (pinned.has(name) && typeof rest[index] === 'function') {
        const fn = rest[index];
        rest[index] = (...args) => run(envVar, 'off', () => fn(...args));
      }
      return test(name, ...rest);
    };
  };
  return {withEnv: run, switchOffTests: wrap};
})();

module.exports = {
  withEnv,
  companySpotlightOffTests: switchOffTests('COMPANY_SPOTLIGHT_ENABLED')
};

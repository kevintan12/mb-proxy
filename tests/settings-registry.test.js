// Step 9F.2a: table-driven checks for the shared settings registry -- the one
// table of defaults/ranges/Admin-or-Fixed tags, and the one reader function.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETTINGS_REGISTRY,
  settingValue,
  clampSetting,
  clampBooleanSetting,
  checkArticleBudgetFits
} = require('../lib/settings-registry');

const KB = 1024;

// Every wired, Admin, numeric setting: default, below range, above range,
// not-a-number, numeric-as-string, a valid override in range.
const NUMERIC_ADMIN_NAMES = Object.keys(SETTINGS_REGISTRY).filter(name => {
  const entry = SETTINGS_REGISTRY[name];
  return entry.admin === 'Admin' && entry.envVar && typeof entry.default === 'number'
    && entry.min !== undefined && entry.max !== undefined;
});

for (const name of NUMERIC_ADMIN_NAMES) {
  const entry = SETTINGS_REGISTRY[name];
  test(`Step 9F.2a settings registry: ${name} default/clamp/override`, () => {
    assert.equal(settingValue(name, {env: {}}), entry.default);
    assert.equal(settingValue(name, {env: {[entry.envVar]: String(entry.min - 1)}}), entry.min);
    assert.equal(settingValue(name, {env: {[entry.envVar]: String(entry.max + 1)}}), entry.max);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'not-a-number'}}), entry.default);
    assert.equal(settingValue(name, {env: {[entry.envVar]: String(entry.min)}}), entry.min);
    const mid = Math.round((entry.min + entry.max) / 2);
    if (mid !== entry.default) {
      assert.equal(settingValue(name, {env: {[entry.envVar]: String(mid)}}), mid);
    }
  });
}

// Every boolean (on/off) Admin setting.
const BOOLEAN_ADMIN_NAMES = Object.keys(SETTINGS_REGISTRY).filter(name =>
  SETTINGS_REGISTRY[name].boolean && SETTINGS_REGISTRY[name].admin === 'Admin');

for (const name of BOOLEAN_ADMIN_NAMES) {
  const entry = SETTINGS_REGISTRY[name];
  test(`Step 9F.2a settings registry: ${name} on/off override`, () => {
    assert.equal(settingValue(name, {env: {}}), entry.default);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'true'}}), true);
    assert.equal(settingValue(name, {env: {[entry.envVar]: '1'}}), true);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'on'}}), true);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'false'}}), false);
    assert.equal(settingValue(name, {env: {[entry.envVar]: '0'}}), false);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'off'}}), false);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'garbage'}}), entry.default);
  });
}

// Fixed settings ignore any environment variable, even one matching a
// plausible name, and non-numeric/reference entries always return the default.
test('Step 9F.2a settings registry: Fixed and reference entries ignore the environment', () => {
  const fixedOrReference = Object.keys(SETTINGS_REGISTRY).filter(name =>
    SETTINGS_REGISTRY[name].admin === 'Fixed' || SETTINGS_REGISTRY[name].reference);
  assert.ok(fixedOrReference.length > 0);
  for (const name of fixedOrReference) {
    const entry = SETTINGS_REGISTRY[name];
    const noisyEnv = {
      [name.toUpperCase()]: '999999',
      DOWNLOAD_ATTEMPTS: '999', READING_BUDGET_SECONDS: '999', ARTICLE_KB: '999'
    };
    assert.deepEqual(settingValue(name, {env: noisyEnv}), entry.default);
    assert.deepEqual(settingValue(name, {env: {}}), entry.default);
  }
});

test('Step 9F.2a settings registry: unknown setting name throws', () => {
  assert.throws(() => settingValue('notARealSetting'), TypeError);
});

test('Step 9F.2a settings registry: clampSetting and clampBooleanSetting (shared helpers)', () => {
  assert.equal(clampSetting(5, {default: 10, min: 0, max: 20}), 5);
  assert.equal(clampSetting(-5, {default: 10, min: 0, max: 20}), 0);
  assert.equal(clampSetting(50, {default: 10, min: 0, max: 20}), 20);
  assert.equal(clampSetting('silly', {default: 10, min: 0, max: 20}), 10);
  assert.equal(clampSetting(undefined, {default: 10, min: 0, max: 20}), 10);
  assert.equal(clampBooleanSetting('true', false), true);
  assert.equal(clampBooleanSetting('off', true), false);
  assert.equal(clampBooleanSetting('garbage', true), true);
  assert.equal(clampBooleanSetting(undefined, false), false);
});

// Every setting that is wired into today's pipeline must still equal today's
// literal value -- the free-comparison check this step's task describes
// depends on this holding, and it is the cheapest way to prove it in CI.
const WIRED_TODAY_VALUES = {
  readingExtensionHours: 24,
  articleKb: 16,
  yahooReadingBudgetSeconds: 30,
  recapReadingBudgetSeconds: 30,
  downloadAttempts: 3,
  recapMaxCandidates: 3,
  yahooMaxArticleAttempts: 12,
  yahooMaxAdmittedArticles: 6,
  yahooStaleLabelToleranceHours: 4,
  pageTimeoutMs: 4000,
  usListingTimeoutMs: 6000,
  nonUsListingMaxResponseBytes: 1024 * KB,
  nonUsListingMaxCandidates: 30,
  usListingMaxResponseBytes: 2048 * KB,
  usListingMaxCandidates: 60,
  mergedListingMaxCandidates: 90,
  mostActiveMaxResponseBytes: 256 * KB,
  mostActiveMaxCandidates: 10,
  writerRequestLimitBytes: 500 * KB,
  classifierRequestLimitBytes: 300 * KB,
  yahooRecapPageTimeoutMs: 4000,
  yahooRecapMaxResponseBytes: 1572864
};

for (const [name, expected] of Object.entries(WIRED_TODAY_VALUES)) {
  test(`Step 9F.2a settings registry: ${name} is wired and still equals today's value`, () => {
    const entry = SETTINGS_REGISTRY[name];
    assert.ok(entry, `missing registry entry for ${name}`);
    assert.equal(entry.wired, true);
    assert.equal(entry.default, expected);
  });
}

// Every new, planned setting is registered but explicitly not wired.
test('Step 9F.2a settings registry: new settings are registered but not wired', () => {
  const unwired = Object.keys(SETTINGS_REGISTRY).filter(name => SETTINGS_REGISTRY[name].wired === false);
  // Slots/spillover/switches, planned budgets, ranking points, recency, headline
  // list pointers and CNBC reference values -- at least this many categories.
  assert.ok(unwired.length >= 30, `expected at least 30 unwired settings, found ${unwired.length}`);
  for (const name of unwired) {
    assert.equal(SETTINGS_REGISTRY[name].wired, false);
  }
});

// The cross-check for the planned article budget vs. the planned writer limit
// (not wired into any pipeline code; unit-tested only, per the task).
test('Step 9F.2a settings registry: checkArticleBudgetFits', () => {
  const fits = checkArticleBudgetFits({
    articleTextBudgetBytes: 100 * KB, nonArticleOverheadBytes: 20 * KB, writerRequestLimitBytes: 500 * KB
  });
  assert.deepEqual(fits, {fits: true, budgetBytes: 100 * KB, warning: null});

  const overBudget = checkArticleBudgetFits({
    articleTextBudgetBytes: 150 * KB, nonArticleOverheadBytes: 100 * KB, writerRequestLimitBytes: 192 * KB
  });
  assert.equal(overBudget.fits, false);
  assert.equal(overBudget.budgetBytes, 92 * KB);
  assert.match(overBudget.warning, /lowered to/);

  const exact = checkArticleBudgetFits({
    articleTextBudgetBytes: 80 * KB, nonArticleOverheadBytes: 20 * KB, writerRequestLimitBytes: 100 * KB
  });
  assert.deepEqual(exact, {fits: true, budgetBytes: 80 * KB, warning: null});
});

// Step 9F.2b: the planned article budget (150 KB) plus the planned overhead
// (100 KB) against the now-live writer limit (500 KB) -- still fits with room
// to spare, so neither planned default needs changing for this step.
test("Step 9F.2b: checkArticleBudgetFits still fits at today's live writer limit", () => {
  const fits = checkArticleBudgetFits({
    articleTextBudgetBytes: 150 * KB, nonArticleOverheadBytes: 100 * KB,
    writerRequestLimitBytes: SETTINGS_REGISTRY.writerRequestLimitBytes.default
  });
  assert.deepEqual(fits, {fits: true, budgetBytes: 150 * KB, warning: null});
});

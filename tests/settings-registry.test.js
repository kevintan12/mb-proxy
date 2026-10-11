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
  checkArticleBudgetFits,
  checkRecencyNeverOverridesMacro
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
  yahooRecapMaxResponseBytes: 1572864,
  yahooInitialCandidateAttempts: 5,
  auditMaxCandidatesPerEvent: 10,
  auditMaxEventBytes: 3400
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

// Step 9F.6a.1: the audit text limits keep today's literal values, and the
// classifier item cap row points at the real constant with the same value.
test('Step 9F.6a.1 settings registry: audit field limits and classifier item cap', () => {
  assert.equal(SETTINGS_REGISTRY.auditFieldLimits.admin, 'Fixed');
  assert.deepEqual(settingValue('auditFieldLimits', {env: {}}), {
    headlineCharacters: 80, headlineBytes: 120,
    publisherCharacters: 24, publisherBytes: 48,
    slugCharacters: 48, slugBytes: 48,
    ageLabelCharacters: 12, ageLabelBytes: 16,
    failureTypeCharacters: 48, failureTypeBytes: 48,
    listingOutcomeCharacters: 32, listingOutcomeBytes: 32,
    // Step 9F.2e.1: the shadow score's points summary.
    scorePartsCharacters: 64, scorePartsBytes: 64
  });
  const {MAX_CLASSIFICATION_EVIDENCE_ITEMS} = require('../lib/claude-evidence-role-classification');
  assert.equal(SETTINGS_REGISTRY.maxClassificationEvidenceItems.default, MAX_CLASSIFICATION_EVIDENCE_ITEMS);
  assert.equal(SETTINGS_REGISTRY.maxClassificationEvidenceItems.reference, true);
});

// Step 9F.6a.1: Further Readings numbers for Step 9F.2h, Admin, not wired.
test('Step 9F.6a.1 settings registry: Further Readings numbers registered, not wired', () => {
  const expected = {
    furtherReadingMaxLinks: [15, 5, 30],
    furtherReadingExtrasBudgetSeconds: [10, 5, 30],
    furtherReadingExtrasMinScore: [12, 0, 58]
  };
  for (const [name, [value, min, max]] of Object.entries(expected)) {
    const entry = SETTINGS_REGISTRY[name];
    assert.equal(entry.admin, 'Admin', name);
    assert.equal(entry.wired, false, name);
    assert.deepEqual([entry.default, entry.min, entry.max], [value, min, max], name);
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

// Step 9F.2c.2 safety check: none of the three recency bonuses may ever reach
// or exceed the US macro points (not wired into any pipeline code; unit-tested
// only, per the task).
test('Step 9F.2c.2 settings registry: checkRecencyNeverOverridesMacro is safe at defaults', () => {
  const result = checkRecencyNeverOverridesMacro({env: {}});
  assert.equal(result.safe, true);
  assert.equal(result.warning, null);
  assert.deepEqual(result.values, {
    recencyBonusUnder6h: SETTINGS_REGISTRY.recencyBonusUnder6h.default,
    recencyBonus6to24h: SETTINGS_REGISTRY.recencyBonus6to24h.default,
    recencyBonusOver24h: SETTINGS_REGISTRY.recencyBonusOver24h.default
  });
});

// Each recency bonus's own safe range (0-8) sits well below the macro points'
// default (20), so the breach has to come from lowering rankingPointsUsMacro
// (its own safe range is 0-40, so this is itself a legal Admin override), not
// from raising a recency bonus past its own ceiling. The other two recency
// bonuses are pinned to 0 in each case so the clamp under test is isolated.
const RECENCY_BONUS_NAMES_LIST = ['recencyBonusUnder6h', 'recencyBonus6to24h', 'recencyBonusOver24h'];
const MACRO_ENV_VAR = SETTINGS_REGISTRY.rankingPointsUsMacro.envVar;

for (const name of RECENCY_BONUS_NAMES_LIST) {
  const envVar = SETTINGS_REGISTRY[name].envVar;
  const maxBonus = SETTINGS_REGISTRY[name].max;

  test(`Step 9F.2c.2 settings registry: checkRecencyNeverOverridesMacro clamps ${name} at the macro points`, () => {
    const env = {[MACRO_ENV_VAR]: String(maxBonus), [envVar]: String(maxBonus)};
    for (const other of RECENCY_BONUS_NAMES_LIST) {
      if (other !== name) env[SETTINGS_REGISTRY[other].envVar] = '0';
    }
    const result = checkRecencyNeverOverridesMacro({env});
    assert.equal(result.safe, false);
    assert.match(result.warning, new RegExp(`${name} \\(${maxBonus}\\)`));
    assert.equal(result.values[name], maxBonus - 1);
    for (const other of RECENCY_BONUS_NAMES_LIST) {
      if (other !== name) assert.equal(result.values[other], 0);
    }
  });

  test(`Step 9F.2c.2 settings registry: checkRecencyNeverOverridesMacro clamps ${name} when it exceeds the macro points`, () => {
    const lowMacroPoints = Math.max(0, maxBonus - 3);
    const env = {[MACRO_ENV_VAR]: String(lowMacroPoints), [envVar]: String(maxBonus)};
    for (const other of RECENCY_BONUS_NAMES_LIST) {
      if (other !== name) env[SETTINGS_REGISTRY[other].envVar] = '0';
    }
    const result = checkRecencyNeverOverridesMacro({env});
    assert.equal(result.safe, false);
    assert.equal(result.values[name], lowMacroPoints - 1);
  });
}

// Step 9F.2d.1: the planned attempt cap (not live), the portfolio first-pass
// limit (Fixed, not wired) and the "how to" list pointer. The live attempt cap
// keeps today's 12 and its 6-20 range.
test('Step 9F.2d.1 settings registry: planned attempt cap, portfolio first pass, how-to list', () => {
  const planned = SETTINGS_REGISTRY.yahooMaxArticleAttemptsPlanned;
  assert.deepEqual([planned.default, planned.min, planned.max, planned.admin, planned.wired],
    [18, 6, 24, 'Admin', false]);
  assert.equal(planned.envVar, 'YAHOO_MAX_ARTICLE_ATTEMPTS_PLANNED');
  const live = SETTINGS_REGISTRY.yahooMaxArticleAttempts;
  assert.deepEqual([live.default, live.min, live.max, live.wired], [12, 6, 20, true]);
  const firstPass = SETTINGS_REGISTRY.portfolioFirstPassPerCompany;
  assert.deepEqual([firstPass.default, firstPass.admin, firstPass.wired], [1, 'Fixed', false]);
  const howTo = SETTINGS_REGISTRY.headlineListHowToPatterns;
  assert.equal(howTo.reference, true);
  assert.match(howTo.default, /HOW_TO_DROP_PREFIXES/);
});

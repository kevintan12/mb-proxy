// Step 9AC: generated checks for every choice (fixed list of strings) setting in the
// shared settings registry, plus the Step 9AC entries themselves.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');

const CHOICE_NAMES = Object.keys(SETTINGS_REGISTRY).filter(name => SETTINGS_REGISTRY[name].choice);

test('Step 9AC settings registry: at least one choice setting exists', () => {
  assert.ok(CHOICE_NAMES.includes('claudeModel'));
});

for (const name of CHOICE_NAMES) {
  const entry = SETTINGS_REGISTRY[name];
  test(`Step 9AC settings registry: ${name} default/each choice/rejects anything else`, () => {
    assert.equal(entry.admin, 'Admin');
    assert.equal(typeof entry.envVar, 'string');
    assert.ok(entry.choices.includes(entry.default));
    assert.equal(Object.isFrozen(entry.choices), true);
    assert.equal(settingValue(name, {env: {}}), entry.default);
    for (const choice of entry.choices) {
      assert.equal(settingValue(name, {env: {[entry.envVar]: choice}}), choice);
      assert.equal(settingValue(name, {env: {[entry.envVar]: choice.toUpperCase()}}), entry.default);
      assert.equal(settingValue(name, {env: {[entry.envVar]: ` ${choice}`}}), entry.default);
      assert.equal(settingValue(name, {env: {[entry.envVar]: `${choice} `}}), entry.default);
    }
    assert.equal(settingValue(name, {env: {[entry.envVar]: ''}}), entry.default);
    assert.equal(settingValue(name, {env: {[entry.envVar]: 'garbage'}}), entry.default);
  });
}

test('Step 9AC settings registry: the model settings and their defaults', () => {
  const expected = {
    modelChoiceEnabled: [true, 'MODEL_CHOICE_ENABLED'],
    legacyModelGuardEnabled: [true, 'LEGACY_MODEL_GUARD_ENABLED'],
    userModelChoiceEnabled: [false, 'USER_MODEL_CHOICE_ENABLED'],
    claudeModel: ['haiku-4.5', 'CLAUDE_MODEL']
  };
  for (const [name, [value, envVar]] of Object.entries(expected)) {
    assert.equal(SETTINGS_REGISTRY[name].default, value, name);
    assert.equal(SETTINGS_REGISTRY[name].envVar, envVar, name);
    assert.equal(SETTINGS_REGISTRY[name].admin, 'Admin', name);
    assert.equal(SETTINGS_REGISTRY[name].wired, true, name);
  }
  assert.deepEqual([...SETTINGS_REGISTRY.claudeModel.choices], ['haiku-4.5', 'haiku-5.5']);
  for (const name of ['claudeModelReplyLimits', 'claudeModelPrices', 'webSearchUsdPerSearch']) {
    assert.equal(SETTINGS_REGISTRY[name].admin, 'Fixed', name);
  }
  assert.equal(SETTINGS_REGISTRY.webSearchUsdPerSearch.default, 0.01);
  assert.equal(SETTINGS_REGISTRY.claudeModelPrices.default['haiku-5.5'].longPromptTokens, 100000);
  assert.equal(SETTINGS_REGISTRY.claudeModelPrices.default['haiku-4.5'].longPromptTokens, null);
});

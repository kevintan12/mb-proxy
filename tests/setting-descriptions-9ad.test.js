'use strict';

// Step 9AD: every one of the settings carries a short plain-English description (the rule behind
// the Admin page, 9 Nov 2026). Made-up checks on the registry text only: no network, no paid call.
// The sentence counter is a copy of the one in tests/setting-descriptions-9ad1.test.js (that file
// exports nothing and stays untouched).

const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_REGISTRY } = require('../lib/settings-registry');

// Counts sentences, ignoring the dots in "a.m." / "p.m." and anything inside double quotes.
function sentenceCount(text) {
  const masked = text
    .replace(/"[^"]*"/g, 'QUOTED')
    .replace(/\b([ap])\.m\./gi, '$1m');
  return masked.split(/[.!?](?:\s+|$)/).filter((part) => part.trim().length > 0).length;
}

const NAMES = Object.keys(SETTINGS_REGISTRY);

test('Step 9AD: the sentence counter ignores a.m., p.m. and a quoted line', () => {
  assert.equal(sentenceCount('One. Two.'), 2);
  assert.equal(sentenceCount('Closes at 1:00 p.m. New York time. Next.'), 2);
  assert.equal(sentenceCount('Opens 9:30 a.m. today. Gets "see Focus." as text. Done.'), 3);
  assert.equal(sentenceCount('Just one sentence'), 1);
});

test('Step 9AD: the registry has 141 settings, all covered below', () => {
  assert.equal(NAMES.length, 141);
});

for (const name of NAMES) {
  test(`Step 9AD: ${name} has a short plain-English description`, () => {
    const entry = SETTINGS_REGISTRY[name];
    const text = entry.description;
    assert.equal(typeof text, 'string', `${name}: description missing`);
    assert.ok(text.trim().length > 0, `${name}: description empty`);
    const count = sentenceCount(text);
    assert.ok(count >= 1 && count <= 2, `${name}: ${count} sentences (max 2)`);
    assert.ok(text.length <= 450, `${name}: ${text.length} characters (max 450)`);
    assert.ok(!/[0-9a-f]{7,}/i.test(text), `${name}: looks like it holds a commit hash`);
    assert.ok(!/\bStep\b/i.test(text), `${name}: mentions "Step"`);
    assert.ok(!/\b9[A-Z]{1,2}(\.\d+)?\b/.test(text), `${name}: looks like a step number`);
    if (entry.boolean) {
      assert.ok(text.includes('When on'), `${name}: a switch must say "When on"`);
      assert.ok(text.includes('When off'), `${name}: a switch must say "When off"`);
    }
  });
}

const LOCKED = [
  'maxClassificationEvidenceItems', 'spotlightAnchorSymbols', 'cnbcMaxCandidates', 'cnbcPageTimeoutMs',
  'cnbcMaxResponseBytes', 'cnbcMaxArticleTextBytes', 'cnbcMaxEvidenceTextBytes',
  'cnbcMaterialityRequestLimitBytes'
];

test('Step 9AD: the 8 locked settings are tagged Fixed and are still reference rows', () => {
  for (const name of LOCKED) {
    const entry = SETTINGS_REGISTRY[name];
    assert.ok(entry, name);
    assert.equal(entry.admin, 'Fixed', name);
    assert.equal(entry.reference, true, name);
    assert.equal(entry.envVar, undefined, `${name}: a locked setting has no env var`);
    assert.match(entry.description, /locked|reference only/i, `${name}: description must say it is locked`);
  }
});

test('Step 9AD: the three planned source switches say nothing reads them yet', () => {
  for (const name of ['yahooSourceEnabled', 'cnbcSourceEnabled', 'portfolioSourceEnabled']) {
    const entry = SETTINGS_REGISTRY[name];
    assert.equal(entry.wired, false, name);
    assert.match(entry.description, /not read by any code yet/, name);
  }
});

test('Step 9AD: the headline-list pointers stay Admin and say they are not editable yet', () => {
  const lists = NAMES.filter((name) => name.startsWith('headlineList'));
  assert.equal(lists.length, 8);
  for (const name of lists) {
    assert.equal(SETTINGS_REGISTRY[name].admin, 'Admin', name);
    assert.ok(SETTINGS_REGISTRY[name].description.includes('Not editable yet'), name);
  }
});

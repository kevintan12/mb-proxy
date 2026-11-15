'use strict';

// Step 9AD.1: the eight newest settings carry a short plain-English description.
// Made-up checks on the registry text only: no network, no paid call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_REGISTRY } = require('../lib/settings-registry');

const EIGHT = [
  'classifierSubjectSoftDropEnabled',
  'liveThemedSummaryEnabled',
  'dateAccuracyTighterEnabled',
  'weekdayDateAgreeEnabled',
  'readerWordingEnabled',
  'sectionFourFocusPointerEnabled',
  'sectionThreeNoRepeatEnabled',
  'earlyCloseDaysEnabled'
];

// Counts sentences, ignoring the dots in "a.m." / "p.m." and anything inside double quotes
// (the fixed pointer line "[Name]: see Stocks & Sectors in Focus." ends in a full stop).
function sentenceCount(text) {
  const masked = text
    .replace(/"[^"]*"/g, 'QUOTED')
    .replace(/\b([ap])\.m\./gi, '$1m');
  return masked.split(/[.!?](?:\s+|$)/).filter((part) => part.trim().length > 0).length;
}

test('Step 9AD.1: the sentence counter ignores a.m., p.m. and a quoted line', () => {
  assert.equal(sentenceCount('One. Two.'), 2);
  assert.equal(sentenceCount('Closes at 1:00 p.m. New York time. Next.'), 2);
  assert.equal(sentenceCount('Opens 9:30 a.m. today. Gets "see Focus." as text. Done.'), 3);
  assert.equal(sentenceCount('Just one sentence'), 1);
});

test('Step 9AD.1: the eight settings are all in the registry', () => {
  for (const name of EIGHT) assert.ok(SETTINGS_REGISTRY[name], name);
});

for (const name of EIGHT) {
  test(`Step 9AD.1: ${name} has a short plain-English description`, () => {
    const entry = SETTINGS_REGISTRY[name];
    const text = entry.description;
    assert.equal(typeof text, 'string', `${name}: description missing`);
    assert.ok(text.trim().length > 0, `${name}: description empty`);
    assert.ok(text.includes('When on'), `${name}: must say "When on"`);
    assert.ok(text.includes('When off'), `${name}: must say "When off"`);
    const count = sentenceCount(text);
    assert.ok(count >= 1 && count <= 2, `${name}: ${count} sentences (max 2)`);
    assert.ok(!/[0-9a-f]{7,}/i.test(text), `${name}: looks like it holds a commit hash`);
    assert.ok(!/\bStep\b/i.test(text), `${name}: mentions "Step"`);
    assert.ok(!/\b9[A-Z]{1,2}(\.\d+)?\b/.test(text), `${name}: looks like a step number`);
    assert.ok(text.length <= 450, `${name}: ${text.length} characters (max 450)`);
  });
}

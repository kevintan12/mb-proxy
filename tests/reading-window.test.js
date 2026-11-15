// Step 9F.1a: table-driven checks for the reading window and its setting clamps.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {readingWindow, clampSetting, readingSettings, DOWNLOAD_ATTEMPTS} = require('../lib/reading-window');
const {marketSettings} = require('../lib/section-rules');

const ROWS = [
  // Window rows: UTC trigger -> expected last close; start = close - 24h (default extension).
  {kind: 'window', name: 'PRE', trigger: '2026-10-08T12:00:00Z', close: '2026-10-07T20:00:00Z', start: '2026-10-06T20:00:00Z'},
  {kind: 'window', name: 'REGULAR', trigger: '2026-10-08T15:00:00Z', close: '2026-10-07T20:00:00Z', start: '2026-10-06T20:00:00Z'},
  {kind: 'window', name: 'POST', trigger: '2026-10-08T21:00:00Z', close: '2026-10-08T20:00:00Z', start: '2026-10-07T20:00:00Z'},
  {kind: 'window', name: 'CLOSED night', trigger: '2026-10-09T02:00:00Z', close: '2026-10-08T20:00:00Z', start: '2026-10-07T20:00:00Z'},
  {kind: 'window', name: 'CLOSED pre-dawn', trigger: '2026-10-08T07:30:00Z', close: '2026-10-07T20:00:00Z', start: '2026-10-06T20:00:00Z'},
  {kind: 'window', name: 'WEEKEND', trigger: '2026-10-10T08:00:00Z', close: '2026-10-09T20:00:00Z', start: '2026-10-08T20:00:00Z'},
  {kind: 'window', name: 'HOLIDAY (Thanksgiving)', trigger: '2026-11-26T15:00:00Z', close: '2026-11-25T21:00:00Z', start: '2026-11-24T21:00:00Z'},
  // Extension rows (same trigger as REGULAR, last close 2026-10-07 20:00 UTC).
  {kind: 'extension', name: 'extension 0', value: 0, hours: 0},
  {kind: 'extension', name: 'extension 72', value: 72, hours: 72},
  {kind: 'extension', name: 'extension -5 clamps to 0', value: -5, hours: 0},
  {kind: 'extension', name: 'extension 100 clamps to 72', value: 100, hours: 72},
  {kind: 'extension', name: 'extension NaN uses default', value: NaN, hours: 24},
  {kind: 'extension', name: "extension '24' text is read", value: '24', hours: 24},
  {kind: 'extension', name: "extension 'abc' uses default", value: 'abc', hours: 24},
  // Article size rows.
  {kind: 'article', name: 'article size 1 clamps to 2', value: 1, kb: 2},
  {kind: 'article', name: 'article size 2', value: 2, kb: 2},
  {kind: 'article', name: 'article size 32', value: 32, kb: 32},
  {kind: 'article', name: 'article size 40 clamps to 32', value: 40, kb: 32},
  {kind: 'article', name: 'article size missing uses default', value: undefined, kb: 16},
  {kind: 'article', name: "article size 'x' uses default", value: 'x', kb: 16}
];

const REGULAR_TRIGGER = '2026-10-08T15:00:00Z';
const REGULAR_CLOSE = Date.parse('2026-10-07T20:00:00Z');
const HOUR = 3600 * 1000;

for (const row of ROWS) {
  test(`Step 9F.1a reading window: ${row.name}`, () => {
    if (row.kind === 'window') {
      const result = readingWindow({market: 'US', triggerAt: new Date(row.trigger), extensionHours: 24});
      assert.equal(result.lastClose, new Date(row.close).toISOString());
      assert.equal(result.startsAt, new Date(row.start).toISOString());
      assert.equal(result.endsAt, new Date(row.trigger).toISOString());
    } else if (row.kind === 'extension') {
      const result = readingWindow({market: 'US', triggerAt: new Date(REGULAR_TRIGGER), extensionHours: row.value});
      assert.equal(result.extensionHours, row.hours);
      assert.equal(Date.parse(result.startsAt), REGULAR_CLOSE - row.hours * HOUR);
      assert.equal(result.endsAt, new Date(REGULAR_TRIGGER).toISOString());
    } else {
      assert.equal(clampSetting(row.value, marketSettings('US').articleKb), row.kb);
      assert.equal(readingSettings({env: {ARTICLE_KB: row.value}}).articleKb, row.kb);
    }
  });
}

test('Step 9F.1a reading window: environment variables override defaults, bad ones are made safe', () => {
  assert.deepEqual({...readingSettings({env: {}})},
    {readingExtensionHours: 24, articleKb: 16, downloadAttempts: 3, readingBudgetSeconds: 30});
  assert.equal(readingSettings({env: {READING_EXTENSION_HOURS: '48'}}).readingExtensionHours, 48);
  assert.equal(readingSettings({env: {READING_EXTENSION_HOURS: '9999'}}).readingExtensionHours, 72);
  assert.equal(readingSettings({env: {READING_EXTENSION_HOURS: 'silly'}}).readingExtensionHours, 24);
  assert.equal(readingSettings({env: {ARTICLE_KB: ''}}).articleKb, 16);
  assert.equal(DOWNLOAD_ATTEMPTS, 3);
});

// Step 9F.2a: Kevin's 10 Oct 2026 rule makes every budget, window and retry
// count an Admin setting, superseding Step 9F.1d/9F.1e's "Fixed, no
// environment override" rule for the reading budget and download attempts.
test('Step 9F.2a reading window: the reading budget and download attempts are now honoured and clamped', () => {
  assert.equal(readingSettings({env: {READING_BUDGET_SECONDS: '45'}}).readingBudgetSeconds, 45);
  assert.equal(readingSettings({env: {READING_BUDGET_SECONDS: '5'}}).readingBudgetSeconds, 10);
  assert.equal(readingSettings({env: {READING_BUDGET_SECONDS: '300'}}).readingBudgetSeconds, 60);
  assert.equal(readingSettings({env: {READING_BUDGET_SECONDS: 'silly'}}).readingBudgetSeconds, 30);
  assert.equal(readingSettings({env: {DOWNLOAD_ATTEMPTS: '4'}}).downloadAttempts, 4);
  assert.equal(readingSettings({env: {DOWNLOAD_ATTEMPTS: '0'}}).downloadAttempts, 1);
  assert.equal(readingSettings({env: {DOWNLOAD_ATTEMPTS: '9'}}).downloadAttempts, 5);
  assert.equal(readingSettings({env: {DOWNLOAD_ATTEMPTS: 'silly'}}).downloadAttempts, 3);
});

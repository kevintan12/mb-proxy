const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  POST_CLOSE_SESSION_RELEVANCE_WINDOW_MS,
  createPostCloseSessionAssociation
} = require('../lib/post-close-session-relevance');

function input(overrides = {}) {
  return {
    evidenceRef: 'e17',
    sessionDate: '2026-09-11',
    exchangeTimezone: 'America/New_York',
    canonicalCloseAt: '2026-09-11T20:00:00.000Z',
    publishedAt: '2026-09-11T20:00:00.001Z',
    ...overrides
  };
}

test('uses the exact absolute two-hour post-close boundary', () => {
  assert.equal(POST_CLOSE_SESSION_RELEVANCE_WINDOW_MS, 7200000);
  assert.equal(createPostCloseSessionAssociation(input({
    publishedAt: '2026-09-11T20:00:00.000Z'
  })), null);
  assert.deepEqual(createPostCloseSessionAssociation(input()), {
    evidenceRef: 'e17', sessionDate: '2026-09-11'
  });
  assert.deepEqual(createPostCloseSessionAssociation(input({
    publishedAt: '2026-09-11T22:00:00.000Z'
  })), {evidenceRef: 'e17', sessionDate: '2026-09-11'});
  assert.equal(createPostCloseSessionAssociation(input({
    publishedAt: '2026-09-11T22:00:00.001Z'
  })), null);
});

test('returns null for valid timestamps well before or well after the window', () => {
  assert.equal(createPostCloseSessionAssociation(input({
    publishedAt: '2026-09-11T18:00:00.000Z'
  })), null);
  assert.equal(createPostCloseSessionAssociation(input({
    publishedAt: '2026-09-12T02:00:00.000Z'
  })), null);
});

test('rejects malformed or contradictory canonical inputs deterministically', () => {
  const cases = [
    [input({publishedAt: 'not-a-timestamp'}), /Invalid publication timestamp/],
    [input({canonicalCloseAt: '2026-09-11'}), /Invalid canonical close timestamp/],
    [input({sessionDate: '2026-02-30'}), /Invalid canonical session date/],
    [input({evidenceRef: 'c1'}), /Invalid canonical evidence reference/],
    [input({evidenceRef: 'e0'}), /Invalid canonical evidence reference/],
    [input({exchangeTimezone: 'Not/A_Timezone'}), /Invalid canonical exchange timezone/],
    [input({sessionDate: '2026-09-10'}), /Canonical close does not match the session date/]
  ];
  for (const [value, message] of cases) {
    assert.throws(() => createPostCloseSessionAssociation(value), {
      name: 'TypeError', message
    });
  }
});

test('rejects unexpected keys including updatedAt and requires exact key order', () => {
  assert.throws(() => createPostCloseSessionAssociation({...input(), updatedAt: null}), {
    name: 'TypeError', message: /Invalid post-close session association input shape or order/
  });
  const reordered = {
    sessionDate: '2026-09-11',
    evidenceRef: 'e17',
    exchangeTimezone: 'America/New_York',
    canonicalCloseAt: '2026-09-11T20:00:00.000Z',
    publishedAt: '2026-09-11T20:00:00.001Z'
  };
  assert.throws(() => createPostCloseSessionAssociation(reordered), {
    name: 'TypeError', message: /Invalid post-close session association input shape or order/
  });
});

test('returns an immutable canonical association without mutating input', () => {
  const source = input();
  const before = structuredClone(source);
  const association = createPostCloseSessionAssociation(source);
  assert.deepEqual(source, before);
  assert.deepEqual(association, {evidenceRef: 'e17', sessionDate: '2026-09-11'});
  assert.equal(Object.isFrozen(association), true);
  assert.throws(() => {
    (function mutate() {'use strict'; association.sessionDate = '2026-09-12';}());
  }, TypeError);
});

test('uses exact elapsed time across a DST-era New York session', () => {
  const dstInput = input({
    sessionDate: '2026-03-09',
    canonicalCloseAt: '2026-03-09T16:00:00-04:00',
    publishedAt: '2026-03-09T18:00:00-04:00'
  });
  assert.deepEqual(createPostCloseSessionAssociation(dstInput), {
    evidenceRef: 'e17', sessionDate: '2026-03-09'
  });
  assert.equal(createPostCloseSessionAssociation({
    ...dstInput,
    publishedAt: '2026-03-09T18:00:00.001-04:00'
  }), null);
});

test('contains no provider-specific behavior or provider-derived inputs', () => {
  const implementation = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'post-close-session-relevance.js'),
    'utf8'
  );
  assert.doesNotMatch(implementation, /yahoo|cnbc|sourceId|provider|https?:|canonicalUrl|headline|title|articleText/i);
});

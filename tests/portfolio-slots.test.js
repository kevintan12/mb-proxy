// Step 9F.2d.2: the portfolio-slot picker. Pure and not wired into the
// pipeline -- these tests call lib/portfolio-slots.js directly.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {pickPortfolioArticles} = require('../lib/portfolio-slots');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');

const NVDA = Object.freeze({symbol: 'NVDA', shortName: 'NVIDIA Corporation', longName: 'NVIDIA Corporation'});
const MSFT = Object.freeze({symbol: 'MSFT', shortName: 'Microsoft Corporation', longName: 'Microsoft Corporation'});
const AAPL = Object.freeze({symbol: 'AAPL', shortName: 'Apple Inc.', longName: 'Apple Inc.'});
const STARTING_LIST = Object.freeze([NVDA, MSFT]);

function article(key, headline, score, ageHours = 5, extra = {}) {
  return {key, headline, score, ageHours, ...extra};
}

test('Step 9F.2d.2: defaults come from the settings table (2 slots, 1 per company first)', () => {
  assert.equal(SETTINGS_REGISTRY.portfolioSlots.default, 2);
  assert.equal(SETTINGS_REGISTRY.portfolioFirstPassPerCompany.default, 1);
  const result = pickPortfolioArticles({
    articles: [
      article('a', 'Nvidia unveils a new chip', 28),
      article('b', 'Nvidia supplier expands', 20),
      article('c', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST
  });
  assert.equal(result.picks.length, 2);
});

test('Step 9F.2d.2: two companies get one article each before any second article', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('n1', 'Nvidia unveils a new chip', 28),
      article('n2', 'Nvidia supplier expands', 20),
      article('m1', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => [pick.key, pick.pass, [...pick.symbols]]), [
    ['n1', 'FIRST_PASS', ['NVDA']],
    ['m1', 'FIRST_PASS', ['MSFT']]
  ]);
  assert.deepEqual(result.passedOver, [{key: 'n2', reason: 'SLOTS_FULL'}]);
});

test('Step 9F.2d.2: one company with three articles fills the second slot in the second pass', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('n1', 'Nvidia supplier expands', 20),
      article('n2', 'Nvidia unveils a new chip', 28),
      article('n3', 'NVDA options activity jumps', 12)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => [pick.key, pick.pass]), [
    ['n2', 'FIRST_PASS'],
    ['n1', 'SECOND_PASS']
  ]);
  assert.deepEqual(result.passedOver, [{key: 'n3', reason: 'SLOTS_FULL'}]);
});

test('Step 9F.2d.2: an article naming two companies covers both', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('both', 'Nvidia and Microsoft sign an AI deal', 36),
      article('n', 'Nvidia supplier expands', 20),
      article('m', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => [pick.key, pick.pass, [...pick.symbols]]), [
    ['both', 'FIRST_PASS', ['NVDA', 'MSFT']],
    ['n', 'SECOND_PASS', ['NVDA']]
  ]);
});

test('Step 9F.2d.2: articles already holding a general slot are skipped', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('n1', 'Nvidia unveils a new chip', 28),
      article('n2', 'Nvidia supplier expands', 20),
      article('m1', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1, alreadyChosen: new Set(['n1'])
  });
  assert.deepEqual(result.picks.map(pick => pick.key), ['n2', 'm1']);
  assert.deepEqual(result.passedOver, [{key: 'n1', reason: 'ALREADY_CHOSEN'}]);
});

test('Step 9F.2d.2: recaps are never picked (and never counted as dropped by the slots)', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('recap', 'Stock market today: Nvidia leads the Nasdaq higher', 40, 1, {isRecap: true}),
      article('m1', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => pick.key), ['m1']);
  assert.deepEqual(result.passedOver, [{key: 'recap', reason: 'RECAP'}]);
});

test('Step 9F.2d.2: companies outside the starting list are ignored', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('apple', 'Apple supplier warns on iPhone demand', 30),
      article('m1', 'Microsoft raises its dividend', 8)
    ],
    portfolioSlotList: STARTING_LIST, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => pick.key), ['m1']);
  assert.deepEqual(result.passedOver, [{key: 'apple', reason: 'NO_PORTFOLIO_COMPANY'}]);
  // The same article is eligible when Step 21D passes a list that includes Apple.
  const widened = pickPortfolioArticles({
    articles: [article('apple', 'Apple supplier warns on iPhone demand', 30)],
    portfolioSlotList: [...STARTING_LIST, AAPL], slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(widened.picks.map(pick => pick.key), ['apple']);
});

test('Step 9F.2d.2: zero slots picks nothing', () => {
  const result = pickPortfolioArticles({
    articles: [article('n1', 'Nvidia unveils a new chip', 28)],
    portfolioSlotList: STARTING_LIST, slots: 0, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks, []);
  assert.deepEqual(result.passedOver, [{key: 'n1', reason: 'SLOTS_FULL'}]);
});

test('Step 9F.2d.2: ties go to the newer article, then to listing order', () => {
  const result = pickPortfolioArticles({
    articles: [
      article('older', 'Nvidia supplier expands', 20, 9),
      article('newer', 'Nvidia unveils a new chip', 20, 2),
      article('m-first', 'Microsoft raises its dividend', 8, 5),
      article('m-second', 'Microsoft opens a new office', 8, 5)
    ],
    portfolioSlotList: STARTING_LIST, slots: 3, firstPassPerCompany: 1
  });
  assert.deepEqual(result.picks.map(pick => [pick.key, pick.pass]), [
    ['newer', 'FIRST_PASS'],
    ['m-first', 'FIRST_PASS'],
    ['older', 'SECOND_PASS']
  ]);
});

test('Step 9F.2d.2: bad inputs are rejected', () => {
  assert.throws(() => pickPortfolioArticles({articles: null, portfolioSlotList: []}), TypeError);
  assert.throws(() => pickPortfolioArticles({articles: [], portfolioSlotList: null}), TypeError);
  assert.throws(() => pickPortfolioArticles({articles: [], portfolioSlotList: [], slots: -1}), TypeError);
  assert.throws(() => pickPortfolioArticles({articles: [], portfolioSlotList: [], slots: 1.5}), TypeError);
  assert.throws(() => pickPortfolioArticles({articles: [], portfolioSlotList: [], firstPassPerCompany: 0}), TypeError);
});

test('Step 9F.2e.2: a company already covered by a general slot waits for the second pass', () => {
  const articles = [
    article('n2', 'Nvidia supplier expands', 28),
    article('m1', 'Microsoft raises its dividend', 8)
  ];
  const covered = pickPortfolioArticles({
    articles, portfolioSlotList: STARTING_LIST, slots: 1, firstPassPerCompany: 1, coveredSymbols: ['NVDA']
  });
  assert.deepEqual(covered.picks.map(pick => [pick.key, pick.pass]), [['m1', 'FIRST_PASS']]);
  const notCovered = pickPortfolioArticles({articles, portfolioSlotList: STARTING_LIST, slots: 1, firstPassPerCompany: 1});
  assert.deepEqual(notCovered.picks.map(pick => [pick.key, pick.pass]), [['n2', 'FIRST_PASS']]);
  assert.throws(() => pickPortfolioArticles({articles, portfolioSlotList: STARTING_LIST, coveredSymbols: 'NVDA'}),
    /coveredSymbols must be an array/);
});

// Step 9F.2d.3: the shared slot rules the reader uses one decision at a time.
test('Step 9F.2d.3: the slot tracker names companies once, counts general coverage, fills and stops', () => {
  const {createPortfolioSlotTracker} = require('../lib/portfolio-slots');
  const tracker = createPortfolioSlotTracker({portfolioSlotList: [NVDA, AAPL, NVDA], slots: 2, firstPassPerCompany: 1});
  assert.deepEqual(tracker.symbolsNamed('Nvidia and Apple strike a deal'), ['NVDA', 'AAPL']);
  assert.deepEqual(tracker.symbolsNamed('Gold edges higher'), []);
  assert.equal(tracker.firstPassWants([]), false);
  tracker.noteCovered(['NVDA']);
  assert.equal(tracker.firstPassWants(['NVDA']), false);
  assert.equal(tracker.firstPassWants(['NVDA', 'AAPL']), true);
  tracker.take(['AAPL']);
  assert.deepEqual([tracker.filled(), tracker.full(), tracker.coveredSymbols()], [1, false, ['NVDA', 'AAPL']]);
  tracker.take(['NVDA']);
  assert.equal(tracker.full(), true);
  assert.throws(() => createPortfolioSlotTracker({portfolioSlotList: [], slots: 1.5, firstPassPerCompany: 1}), TypeError);
  assert.throws(() => createPortfolioSlotTracker({portfolioSlotList: [], slots: 1, firstPassPerCompany: 0}), TypeError);
});

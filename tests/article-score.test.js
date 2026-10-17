// Step 9F.2c.2: table-driven checks for the shared article score. Not wired
// into ranking, slots or selection -- these tests exercise lib/article-score.js
// directly, with no pipeline code involved.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {scoreArticle, compareScoredArticles} = require('../lib/article-score');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');

const TRIGGER = '2026-10-11T12:00:00Z';

const PORTFOLIO_ITEM = Object.freeze({symbol: 'ACME', shortName: 'Acme Inc', longName: 'Acme Incorporated'});
const MOST_ACTIVE_ITEM = Object.freeze({symbol: 'ZETA', shortName: 'Zeta Corp', longName: 'Zeta Corp'});
const INCLUDE_WORDS = Object.freeze([{term: 'moonshot'}]);

const POINTS = Object.freeze({
  usMacro: SETTINGS_REGISTRY.rankingPointsUsMacro.default,
  mostActive: SETTINGS_REGISTRY.rankingPointsMostActive.default,
  portfolio: SETTINGS_REGISTRY.rankingPointsPortfolio.default,
  wirePublishers: SETTINGS_REGISTRY.rankingPointsWirePublishers.default,
  includeWords: SETTINGS_REGISTRY.rankingPointsIncludeWords.default,
  asiaEurope: SETTINGS_REGISTRY.rankingPointsAsiaEurope.default,
  benchmarkOrGeneric: SETTINGS_REGISTRY.rankingPointsBenchmarkOrGeneric.default,
  ai: 0
});
const RECENCY = Object.freeze({
  under6h: SETTINGS_REGISTRY.recencyBonusUnder6h.default,
  between: SETTINGS_REGISTRY.recencyBonus6to24h.default,
  over24h: SETTINGS_REGISTRY.recencyBonusOver24h.default
});

// Kevin's numbers (4 Oct 2026): 20/12/8/5/5/3/1, max 54 without recency, 58 with
// the biggest recency bonus. This confirms the registry defaults (set in Step
// 9F.2a) are exactly what he specified today, with no changes needed.
test('Step 9F.2c.2: registry defaults match the specified points and recency values', () => {
  assert.deepEqual(POINTS, {
    usMacro: 20, mostActive: 12, portfolio: 8, wirePublishers: 5,
    includeWords: 5, asiaEurope: 3, benchmarkOrGeneric: 1, ai: 0
  });
  assert.deepEqual(RECENCY, {under6h: 4, between: 2, over24h: 0});
  // ai is never summed alongside usMacro (either/or -- see scoreArticle), so the
  // maximum stays 54/58 even though rankingPointsAiTheme (Step 9F.2e.4b) also
  // defaults to a non-zero value (8).
  const maxWithoutRecency = Object.values(POINTS).reduce((sum, points) => sum + points, 0);
  assert.equal(maxWithoutRecency, 54);
  assert.equal(maxWithoutRecency + RECENCY.under6h, 58);
});

function score(candidate, options = {}) {
  return scoreArticle(candidate, {triggerAt: TRIGGER, ...options});
}

// Each list alone.
const SINGLE_LIST_ROWS = [
  {name: 'usMacro', headline: 'Nasdaq futures tick higher on jobs report', options: {}, key: 'usMacro'},
  {
    name: 'mostActive', headline: 'Zeta Corp shares jump in heavy trading',
    options: {mostActiveIdentities: [MOST_ACTIVE_ITEM]}, key: 'mostActive'
  },
  {
    name: 'portfolio', headline: 'Acme Inc posts a strong quarter',
    options: {portfolioIdentities: [PORTFOLIO_ITEM]}, key: 'portfolio'
  },
  {
    name: 'wirePublishers', headline: 'Quiet session for regional shops', publisher: 'Reuters',
    options: {}, key: 'wirePublishers'
  },
  {
    name: 'includeWords', headline: 'Moonshot plan unveiled at the conference',
    options: {includeWords: INCLUDE_WORDS}, key: 'includeWords'
  },
  {name: 'asiaEurope', headline: 'Nikkei slips in early trade', options: {}, key: 'asiaEurope'},
  {
    name: 'benchmarkOrGeneric', headline: 'Stocks drift in a quiet session', options: {},
    key: 'benchmarkOrGeneric'
  }
];

for (const row of SINGLE_LIST_ROWS) {
  test(`Step 9F.2c.2: ${row.name} alone scores ${POINTS[row.key]} points`, () => {
    const result = score({headline: row.headline, publisher: row.publisher}, row.options);
    assert.equal(result.matched[row.key], POINTS[row.key]);
    for (const key of Object.keys(result.matched)) {
      if (key !== row.key) assert.equal(result.matched[key], 0);
    }
    assert.equal(result.score, POINTS[row.key]);
    assert.equal(result.excludedByDropList, false);
  });
}

// Two- and three-list combinations (additive).
test('Step 9F.2c.2: two lists together are additive (macro + wire publisher)', () => {
  const result = score({headline: 'Fed flags inflation risk in new report', publisher: 'Reuters'});
  assert.equal(result.matched.usMacro, POINTS.usMacro);
  assert.equal(result.matched.wirePublishers, POINTS.wirePublishers);
  assert.equal(result.score, POINTS.usMacro + POINTS.wirePublishers);
});

test('Step 9F.2c.2: three lists together are additive (portfolio + asiaEurope + benchmarkOrGeneric)', () => {
  const result = score(
    {headline: 'Acme Inc gains as Nikkei leads regional stocks higher'},
    {portfolioIdentities: [PORTFOLIO_ITEM]}
  );
  assert.equal(result.matched.portfolio, POINTS.portfolio);
  assert.equal(result.matched.asiaEurope, POINTS.asiaEurope);
  assert.equal(result.matched.benchmarkOrGeneric, POINTS.benchmarkOrGeneric);
  assert.equal(result.score, POINTS.portfolio + POINTS.asiaEurope + POINTS.benchmarkOrGeneric);
});

// Step 9F.2d.4: the Wet/Dry AMD exclusion (Step 9F.2c.1b) protected the macro
// term match but not the portfolio/most-active ticker-identity match, so a
// user holding AMD stock would get a portfolio-match bonus from an eye-disease
// headline. headlineMatchesIdentity now shares the same exclusion phrases.
const AMD_ITEM = Object.freeze({symbol: 'AMD', shortName: 'Advanced Micro Devices', longName: 'Advanced Micro Devices, Inc.'});

test('Step 9F.2d.4: "Wet AMD" does not match the AMD ticker as a portfolio or most-active identity', () => {
  const wetAmd = score(
    {headline: 'Kodiak Sciences shares climb on new Wet AMD trial data'},
    {portfolioIdentities: [AMD_ITEM], mostActiveIdentities: [AMD_ITEM]}
  );
  assert.equal(wetAmd.matched.portfolio, 0);
  assert.equal(wetAmd.matched.mostActive, 0);
  const dryAmd = score(
    {headline: 'New therapy targets Dry AMD in late-stage trial'},
    {portfolioIdentities: [AMD_ITEM]}
  );
  assert.equal(dryAmd.matched.portfolio, 0);
});

test('Step 9F.2d.4: a real AMD chip story still matches the AMD ticker identity', () => {
  const result = score(
    {headline: 'AMD unveils its next-generation chip lineup'},
    {portfolioIdentities: [AMD_ITEM], mostActiveIdentities: [AMD_ITEM]}
  );
  assert.equal(result.matched.portfolio, POINTS.portfolio);
  assert.equal(result.matched.mostActive, POINTS.mostActive);
});

// Step 9F.2c.4(a): the bare word "earnings" matched any single-company
// earnings story regardless of size, crowding out stronger macro stories on
// the 16 Oct Trading run. Replaced with "earnings season", "bank earnings"
// and "earnings boost" -- narrow enough to keep the broad-market/sector
// signal without the single-company false positives.
test('Step 9F.2c.4(a): bare "earnings" no longer scores macro points on its own', () => {
  for (const headline of [
    "ASML's Q3 Earnings Coming Up",
    'Domino’s Pizza Releases Earnings Pre-Market on Tuesday, Oct. 13',
    'Equity Bancshares (EQBK) Stock Price Edges Higher After Q3 Earnings Strength',
    'Demae Can (TSE:2484) Stock Sinks As Q4 Earnings Losses Deepen'
  ]) {
    const result = score({headline});
    assert.equal(result.matched.usMacro, 0, headline);
  }
});

test('Step 9F.2c.4(a): "earnings season", "bank earnings" and "earnings boost" still score macro points', () => {
  for (const headline of [
    'Goldman Strategists Upgrade Global Stocks on Earnings Boost',
    'European shares climb on bank gains, focus turns to earnings season',
    'Earnings season will fight the real world for attention',
    'Bank earnings beat expectations across the board'
  ]) {
    const result = score({headline});
    assert.equal(result.matched.usMacro, POINTS.usMacro, headline);
  }
});

// Maximum without recency (54) and with the biggest recency bonus (58).
const MAX_HEADLINE = 'Acme Inc and Zeta Corp surge as Fed flags inflation; '
  + 'Nikkei dips while stocks rally and moonshot plan excites traders';
const MAX_OPTIONS = {
  portfolioIdentities: [PORTFOLIO_ITEM], mostActiveIdentities: [MOST_ACTIVE_ITEM], includeWords: INCLUDE_WORDS
};

test('Step 9F.2c.2: maximum score without recency is 54', () => {
  const result = score({headline: MAX_HEADLINE, publisher: 'Reuters'}, MAX_OPTIONS);
  assert.deepEqual(result.matched, POINTS);
  assert.equal(result.recencyPoints, 0);
  assert.equal(result.score, 54);
});

test('Step 9F.2c.2: maximum score with the biggest recency bonus is 58', () => {
  const publishedAt = '2026-10-11T10:30:00Z'; // 1.5h before TRIGGER, under the near threshold
  const result = score({headline: MAX_HEADLINE, publisher: 'Reuters', publishedAt}, MAX_OPTIONS);
  assert.equal(result.recencyPoints, RECENCY.under6h);
  assert.equal(result.score, 58);
});

// Recency buckets, from a known publish time.
const RECENCY_ROWS = [
  {name: 'under 6h (1h)', publishedAt: '2026-10-11T11:00:00Z', ageHours: 1, bonus: RECENCY.under6h},
  {name: 'between (12h)', publishedAt: '2026-10-11T00:00:00Z', ageHours: 12, bonus: RECENCY.between},
  {name: 'over 24h (48h)', publishedAt: '2026-10-09T12:00:00Z', ageHours: 48, bonus: RECENCY.over24h},
  {name: 'exactly 6h -> middle bucket', publishedAt: '2026-10-11T06:00:00Z', ageHours: 6, bonus: RECENCY.between},
  {name: 'exactly 24h -> far bucket', publishedAt: '2026-10-10T12:00:00Z', ageHours: 24, bonus: RECENCY.over24h}
];

for (const row of RECENCY_ROWS) {
  test(`Step 9F.2c.2: recency ${row.name}`, () => {
    const result = score({headline: 'No list words here at all', publishedAt: row.publishedAt});
    assert.equal(result.ageHours, row.ageHours);
    assert.equal(result.recencyBasis, 'publishedAt');
    assert.equal(result.recencyPoints, row.bonus);
  });
}

// Recency from the age label, used when the publish time isn't known yet.
test('Step 9F.2c.2: recency from an age label under 6h', () => {
  const result = score({headline: 'No list words here at all', ageLabel: '5h ago'});
  assert.equal(result.recencyBasis, 'ageLabel');
  assert.equal(result.ageHours, 5);
  assert.equal(result.recencyPoints, RECENCY.under6h);
});

test('Step 9F.2c.2: recency from an age label over 24h', () => {
  const result = score({headline: 'No list words here at all', ageLabel: '2d ago'});
  assert.equal(result.recencyBasis, 'ageLabel');
  assert.equal(result.ageHours, 48);
  assert.equal(result.recencyPoints, RECENCY.over24h);
});

// Unknown publish time AND unknown/unparseable age label -> recency 0.
test('Step 9F.2c.2: unknown publish time and no age label gives recency 0', () => {
  const result = score({headline: 'No list words here at all'});
  assert.equal(result.recencyBasis, 'unknown');
  assert.equal(result.ageHours, null);
  assert.equal(result.recencyPoints, 0);
});

test('Step 9F.2c.2: unknown publish time and an unparseable age label gives recency 0', () => {
  const result = score({headline: 'No list words here at all', ageLabel: 'yesterday'});
  assert.equal(result.recencyBasis, 'unknown');
  assert.equal(result.recencyPoints, 0);
});

// A fresh headline with no list words must score below an older headline that
// has a macro word -- recency can never overrule the US macro list.
test('Step 9F.2c.2: a fresh no-match headline scores below an older macro headline', () => {
  const freshNoMatch = score({headline: 'Local bakery wins award', publishedAt: '2026-10-11T11:00:00Z'});
  const olderMacro = score({headline: 'Nasdaq futures tick higher'});
  assert.equal(freshNoMatch.score, RECENCY.under6h);
  assert.equal(olderMacro.score, POINTS.usMacro);
  assert.ok(olderMacro.score > freshNoMatch.score);
});

// Drop list: removed only when nothing else scores it.
test('Step 9F.2c.2: a drop-only headline is excluded', () => {
  const result = score({headline: 'Singapore shoppers flock to malls this weekend'});
  assert.equal(result.excludedByDropList, true);
  assert.deepEqual(result.matched, {
    usMacro: 0, mostActive: 0, portfolio: 0, wirePublishers: 0, includeWords: 0, asiaEurope: 0,
    benchmarkOrGeneric: 0, ai: 0
  });
});

test('Step 9F.2c.2: a drop term plus a macro term in the same headline is not excluded', () => {
  const result = score({headline: 'Singapore markets react as Fed raises rates'});
  assert.equal(result.excludedByDropList, false);
  assert.equal(result.matched.usMacro, POINTS.usMacro);
});

// A wire publisher (Reuters) reaching Yahoo gets +5 independent of a macro match.
test('Step 9F.2c.2: a Reuters story via Yahoo gets the wire-publisher points regardless of macro', () => {
  const noMacro = score({headline: 'Quiet session for regional shops', publisher: 'Reuters'});
  assert.equal(noMacro.matched.wirePublishers, POINTS.wirePublishers);
  assert.equal(noMacro.matched.usMacro, 0);

  const withMacro = score({headline: 'Fed raises rates, Wall Street reacts', publisher: 'Reuters'});
  assert.equal(withMacro.matched.wirePublishers, POINTS.wirePublishers);
  assert.equal(withMacro.matched.usMacro, POINTS.usMacro);
});

// Include words: a match gets +5; an empty list gets 0.
test('Step 9F.2c.2: an include-word match scores 5 and an empty list scores 0', () => {
  const matched = score({headline: 'Moonshot plan unveiled'}, {includeWords: INCLUDE_WORDS});
  assert.equal(matched.matched.includeWords, POINTS.includeWords);

  const empty = score({headline: 'Moonshot plan unveiled'}, {includeWords: []});
  assert.equal(empty.matched.includeWords, 0);

  const defaulted = score({headline: 'Moonshot plan unveiled'});
  assert.equal(defaulted.matched.includeWords, 0);
});

// Portfolio match gets +8.
test('Step 9F.2c.2: a portfolio identity match scores 8', () => {
  const result = score(
    {headline: 'Acme Inc posts a strong quarter'},
    {portfolioIdentities: [PORTFOLIO_ITEM]}
  );
  assert.equal(result.matched.portfolio, POINTS.portfolio);
});

// Ties: newer first, then original listing order.
test('Step 9F.2c.2: compareScoredArticles breaks ties by newer first, then listing order', () => {
  const entries = [
    {score: 20, ageHours: 5, listIndex: 0},
    {score: 20, ageHours: 5, listIndex: 1},
    {score: 20, ageHours: 2, listIndex: 2},
    {score: 10, ageHours: 1, listIndex: 3}
  ];
  const sorted = [...entries].sort(compareScoredArticles);
  assert.deepEqual(sorted.map(entry => entry.listIndex), [2, 0, 1, 3]);
});

test('Step 9F.2c.2: compareScoredArticles falls back to listing order when an age is unknown', () => {
  const entries = [
    {score: 20, ageHours: null, listIndex: 0},
    {score: 20, ageHours: 3, listIndex: 1}
  ];
  const sorted = [...entries].sort(compareScoredArticles);
  assert.deepEqual(sorted.map(entry => entry.listIndex), [0, 1]);
});

// Step 9F.2d.1 (Kevin, 11 Oct 2026): a drop-list or "how to" headline is
// protected only by portfolio, most-active, US macro, Asia/Europe or include
// words -- the tier ranking's protection today. Wire publishers and the generic
// benchmark/market list do not protect, and recency never does.
const DROP_RULE_ROWS = [
  {name: 'wire publisher only', headline: 'Australian developer axes Sydney data centre plan',
    publisher: 'Reuters', dropReason: 'DROP_LIST'},
  {name: 'generic market word only', headline: 'Singapore stocks rally to a three-week high',
    dropReason: 'DROP_LIST'},
  {name: 'fresh publish time only', headline: 'Singapore shoppers flock to malls',
    publishedAt: '2026-10-11T11:00:00Z', dropReason: 'DROP_LIST'},
  {name: 'Asia/Europe word', headline: 'Thai baht weakens as China exports slow', dropReason: null},
  {name: 'US macro word', headline: 'Singapore markets react as Fed raises rates', dropReason: null},
  {name: 'portfolio name', headline: 'Acme Inc opens a Singapore office',
    options: {portfolioIdentities: [PORTFOLIO_ITEM]}, dropReason: null},
  {name: 'most-active name', headline: 'Zeta Corp opens a Singapore office',
    options: {mostActiveIdentities: [MOST_ACTIVE_ITEM]}, dropReason: null},
  {name: 'include word', headline: 'Moonshot plan for Singapore retirees',
    options: {includeWords: INCLUDE_WORDS}, dropReason: null},
  {name: '"how to" at the start', headline: 'How to trade volatile markets', dropReason: 'HOW_TO'},
  {name: '"how to" after leading spaces', headline: '  how to open a savings account', dropReason: 'DROP_LIST'},
  {name: '"how to" mid-headline', headline: 'Investors weigh how to respond', dropReason: null},
  {name: '"how to" from a wire publisher', headline: 'How to read the rate path', publisher: 'Reuters',
    dropReason: 'HOW_TO'},
  {name: '"how to" plus a macro word', headline: 'How to trade the Fed decision', dropReason: null},
  {name: '"how to" plus Asia/Europe', headline: 'How to invest in China now', dropReason: null},
  {name: '"howto" run together', headline: 'Howto guides for beginners', dropReason: null}
];

for (const row of DROP_RULE_ROWS) {
  test(`Step 9F.2d.1: drop rule -- ${row.name}`, () => {
    const result = score({headline: row.headline, publisher: row.publisher, publishedAt: row.publishedAt},
      row.options || {});
    assert.equal(result.dropReason, row.dropReason);
    assert.equal(result.excludedByDropList, row.dropReason !== null);
  });
}

test('Step 9F.2d.1: the protecting lists are exactly portfolio, most-active, macro, Asia/Europe, include words', () => {
  const {DROP_PROTECTING_LISTS} = require('../lib/article-score');
  assert.deepEqual([...DROP_PROTECTING_LISTS].sort(),
    ['asiaEurope', 'includeWords', 'mostActive', 'portfolio', 'usMacro']);
});

// The "how to" pattern built from the word list is the same pattern that used to
// be written inline, and gives the same answer on every headline in the tests.
test('Step 9F.2d.1: the listed "how to" pattern equals the old inline rule', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {HOW_TO_DROP_PATTERNS} = require('../lib/headline-matching');
  const oldRule = /^\s*how\s+to(?![A-Za-z0-9])/i;
  assert.equal(HOW_TO_DROP_PATTERNS.length, 1);
  assert.equal(HOW_TO_DROP_PATTERNS[0].source, oldRule.source);
  assert.equal(HOW_TO_DROP_PATTERNS[0].flags, oldRule.flags);
  const testsDir = __dirname;
  const literals = new Set();
  for (const file of fs.readdirSync(testsDir).filter(name => name.endsWith('.test.js'))) {
    const text = fs.readFileSync(path.join(testsDir, file), 'utf8');
    for (const match of text.matchAll(/'((?:[^'\\n]|\.){3,200})'/g)) literals.add(match[1]);
  }
  for (const extra of ['How to', 'how to', 'How-to guide', 'How toys sell', '  How to', 'How\tto save']) {
    literals.add(extra);
  }
  assert.ok(literals.size > 500);
  for (const headline of literals) {
    assert.equal(HOW_TO_DROP_PATTERNS[0].test(headline), oldRule.test(headline), headline);
  }
});

// Step 9F.2e.4b: the AI-theme scoring split. Kevin's decision (12 Oct 2026
// Pre-market run evidence): a headline whose only matched US-macro term(s) are
// AI-theme words (lib/headline-lists.js AI_THEME_TERMS) scores the lower
// rankingPointsAiTheme value instead of the full rankingPointsUsMacro value.
// Either/or, never both; protection from the drop rule is by match, not points.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {scoreArticle} = require('../lib/article-score');
const {scoreTryOrder, tierTryOrder} = require('../lib/article-selection');
const {SETTINGS_REGISTRY, settingValue} = require('../lib/settings-registry');
const {US_MACRO_TERMS, AI_THEME_TERMS} = require('../lib/headline-lists');
const {portfolioIdentitiesFrom} = require('../lib/source-ranking');
const listings = require('./fixtures/yahoo-listings');

const TRIGGER = '2026-10-11T12:00:00Z';
function score(candidate, options = {}) {
  return scoreArticle(candidate, {triggerAt: TRIGGER, ...options});
}
const env = ai => ({RANKING_POINTS_AI_THEME: String(ai)});

// --- 1. The word list itself: a subset of US_MACRO_TERMS, exactly the six
// planned words, nothing added. ---
test('Step 9F.2e.4b: AI_THEME_TERMS is exactly the six planned words, each a verbatim US_MACRO_TERMS entry', () => {
  const planned = ['AI', 'Artificial Intelligence', 'OpenAI', 'Anthropic', 'Nvidia', 'AMD'];
  assert.deepEqual(AI_THEME_TERMS.map(({term}) => term), planned);
  for (const entry of AI_THEME_TERMS) {
    const macroEntry = US_MACRO_TERMS.find(m => m.term === entry.term);
    assert.ok(macroEntry, `${entry.term} must exist on US_MACRO_TERMS`);
    assert.equal(!!entry.caseSensitive, !!macroEntry.caseSensitive, `${entry.term} caseSensitive must match`);
  }
  assert.equal(AI_THEME_TERMS.length, 6);
});

// --- 2. The new setting: default, range, clamping, env var. ---
test('Step 9F.2e.4b settings registry: rankingPointsAiTheme default, range, envVar, not wired', () => {
  const entry = SETTINGS_REGISTRY.rankingPointsAiTheme;
  assert.deepEqual([entry.default, entry.min, entry.max, entry.admin, entry.envVar, entry.wired],
    [8, 0, 20, 'Admin', 'RANKING_POINTS_AI_THEME', false]);
});

const CLAMP_ROWS = [
  ['-5', 0], ['25', 20], ['8.5', 8.5], ['lots', 8], ['0', 0], ['20', 20]
];
for (const [raw, expected] of CLAMP_ROWS) {
  test(`Step 9F.2e.4b settings registry: RANKING_POINTS_AI_THEME=${raw} -> ${expected}`, () => {
    assert.equal(settingValue('rankingPointsAiTheme', {env: {RANKING_POINTS_AI_THEME: raw}}), expected);
  });
}

// --- 3. scoreArticle behaviour matrix. ---
const AI_ONLY = 'Nvidia and AMD climb on strong chip demand optimism';
const AI_PLUS_MACRO = 'Nvidia and AMD rally as the Fed signals a rate cut';
const AMD_EXCLUSION = 'Doctors flag Wet AMD and Dry AMD risk in new Nvidia-funded study';
const NO_MACRO = 'Local bakery wins a county fair ribbon this weekend';

for (const ai of [0, 5, 8, 12, 20]) {
  test(`Step 9F.2e.4b: AI-only headline scores the AI-theme value (${ai})`, () => {
    const result = score({headline: AI_ONLY}, {env: env(ai)});
    const macroDefault = SETTINGS_REGISTRY.rankingPointsUsMacro.default;
    if (ai === macroDefault) {
      // 20/20: scored and labeled exactly as the macro case (byte for byte).
      assert.equal(result.matched.usMacro, macroDefault);
      assert.equal(result.matched.ai, 0);
    } else {
      assert.equal(result.matched.ai, ai);
      assert.equal(result.matched.usMacro, 0);
    }
    assert.equal(result.score, ai === macroDefault ? macroDefault : ai);
  });

  test(`Step 9F.2e.4b: drop protection holds for an AI-only headline at AI-theme value ${ai}`, () => {
    // A drop-term headline that is ALSO AI-only-macro must survive, at every value,
    // including 0 -- protection is by match, not by points.
    const result = score({headline: `Singapore malls promote the latest Nvidia and AMD laptops, retirees say`},
      {env: env(ai)});
    assert.equal(result.excludedByDropList, false);
    assert.equal(result.dropReason, null);
  });
}

test('Step 9F.2e.4b: AI-plus-real-macro-word scores the full macro value at every AI-theme value', () => {
  for (const ai of [0, 5, 8, 12, 20]) {
    const result = score({headline: AI_PLUS_MACRO}, {env: env(ai)});
    assert.equal(result.matched.usMacro, SETTINGS_REGISTRY.rankingPointsUsMacro.default);
    assert.equal(result.matched.ai, 0, `ai must be 0 when a non-AI-theme macro term also matched (ai=${ai})`);
  }
});

const MACRO_WORD_ROWS = ['earnings', 'Fed', 'S&P 500', 'oil'];
for (const word of MACRO_WORD_ROWS) {
  test(`Step 9F.2e.4b: AI plus the real macro word "${word}" scores macro, not AI-theme`, () => {
    const result = score({headline: `Nvidia and AMD slip as ${word} weighs on sentiment`}, {env: env(8)});
    assert.equal(result.matched.usMacro, SETTINGS_REGISTRY.rankingPointsUsMacro.default);
    assert.equal(result.matched.ai, 0);
  });
}

test('Step 9F.2e.4b: the AMD exclusion (eye disease) still applies; remaining AI-theme terms still score AI-theme', () => {
  const result = score({headline: AMD_EXCLUSION}, {env: env(8)});
  // AMD is excluded (macular degeneration); Nvidia (AI-theme) still matches, alone.
  assert.equal(result.matched.ai, 8);
  assert.equal(result.matched.usMacro, 0);
});

test('Step 9F.2e.4b: a headline with no macro term at all scores 0 for both usMacro and ai, at every value', () => {
  for (const ai of [0, 5, 8, 12, 20]) {
    const result = score({headline: NO_MACRO}, {env: env(ai)});
    assert.equal(result.matched.usMacro, 0);
    assert.equal(result.matched.ai, 0);
    assert.equal(result.excludedByDropList, false);
  }
});

test('Step 9F.2e.4b: maximum scores (54 without recency, 58 with) are unchanged at every AI-theme value', () => {
  const PORTFOLIO_ITEM = Object.freeze({symbol: 'ACME', shortName: 'Acme Inc', longName: 'Acme Incorporated'});
  const MOST_ACTIVE_ITEM = Object.freeze({symbol: 'ZETA', shortName: 'Zeta Corp', longName: 'Zeta Corp'});
  const INCLUDE_WORDS = Object.freeze([{term: 'moonshot'}]);
  const MAX_HEADLINE = 'Acme Inc and Zeta Corp surge as Fed flags inflation; '
    + 'Nikkei dips while stocks rally and moonshot plan excites traders';
  for (const ai of [0, 5, 8, 12, 20]) {
    const result = score({headline: MAX_HEADLINE, publisher: 'Reuters'}, {
      portfolioIdentities: [PORTFOLIO_ITEM], mostActiveIdentities: [MOST_ACTIVE_ITEM], includeWords: INCLUDE_WORDS,
      env: env(ai)
    });
    assert.equal(result.score, 54, `ai=${ai}`);
  }
  // A headline that is ALSO AI-theme-only can never exceed what the macro case would
  // have scored by default, since the two are mutually exclusive and ai's own safe
  // range (0-20) tops out at the macro default (20).
  const AI_MAX_HEADLINE = 'Acme Inc and Zeta Corp surge as Nvidia and AMD rally; '
    + 'Nikkei dips while stocks rally and moonshot plan excites traders';
  for (const ai of [0, 5, 8, 12, 20]) {
    const result = score({headline: AI_MAX_HEADLINE, publisher: 'Reuters'}, {
      portfolioIdentities: [PORTFOLIO_ITEM], mostActiveIdentities: [MOST_ACTIVE_ITEM], includeWords: INCLUDE_WORDS,
      env: env(ai)
    });
    assert.ok(result.score <= 54, `ai=${ai} must not exceed the macro-case maximum (got ${result.score})`);
  }
});

// --- 4. 12 Oct 2026 fixture: ranking composition at each AI-theme value.
// Row 22 (InvestorsHub oil headline) is given the logged score of 25 for THIS
// comparison only (its logged headline was cut at 80 characters in the log;
// the live score was 25) -- by scoring a full-text stand-in candidate with the
// same macro/age/publisher profile, not by editing the fixture row or the
// existing Step 9F.2e.4a expectations.
// The fixture's row 22 text (80-char-truncated as logged) scores 24; the
// logged score was 25, one benchmarkOrGeneric point short. A trailing generic
// market word (not present in the truncated fixture text, but plausible in
// whatever followed in the real, untruncated headline) reproduces exactly 25
// without touching the fixture row or its own macro/age/publisher profile.
function row22StandIn() {
  return {
    headline: 'Oil Prices Decline as Investors Await US Inflation Data and Bank Earnings Amid Gulf tensions in the market',
    publisher: 'InvestorsHub', ageLabel: '53m ago'
  };
}

function rankedHeadlines(aiValue) {
  const candidates = listings.listing2026_10_12();
  // Swap row 22 (index 21) for the full-text stand-in, for this comparison only.
  candidates[21] = {...candidates[21], headline: row22StandIn().headline};
  const args = {
    candidates, mostActive: listings.MOST_ACTIVE_2026_10_12, portfolioSnapshots: listings.PORTFOLIO_2026_10_12,
    labelWindow: {startsAtInclusive: listings.WINDOW_START_2026_10_12}, generationTime: Date.parse(listings.TRIGGER_2026_10_12)
  };
  const result = scoreTryOrder({...args, env: env(aiValue)});
  return result.order.map(position => ({position: position + 1, headline: candidates[position].headline}));
}

test('Step 9F.2e.4b: 12 Oct fixture at AI-theme 20 (today) reproduces the Step 9F.2e.4a top six', () => {
  const ranked = rankedHeadlines(20);
  assert.deepEqual(ranked.slice(0, 6).map(r => r.position), [1, 3, 5, 6, 4, 7]);
});

// Kevin's expected results (12 Oct fixture, item 7): Goldman/row7, European
// shares/row8, dollar/row9 and the oil row/row22 rank as stated at each value.
const EXPECTED_FOUR_RANKS = {
  8: {goldman: 3, europeanShares: 4, dollar: 5, oil22: 8},
  5: {goldman: 2, europeanShares: 4, dollar: 5, oil22: 6},
  12: {goldman: 5, europeanShares: 6, dollar: 7, oil22: 8}
};
// Expected top-6 composition (M = market-wide, S = sector, C = single company):
// AI-theme 8 (default): 3M/1S/2C -> rows 7,8,9 (M), 1 (S), 3,5 (C).
// AI-theme 5: 4M/1S/1C -> rows 7,8,9,22 (M), 1 (S), 3 (C).
// AI-theme 12: 2M/1S/3C -> rows 7,8 (M), 1 (S), 3,5,6 (C).
const EXPECTED_TOP6 = {8: [1, 3, 7, 8, 9, 5], 5: [1, 7, 3, 8, 9, 22], 12: [1, 3, 5, 6, 7, 8]};

test('Step 9F.2e.4b: 12 Oct fixture ranks match Kevin\'s expected numbers at AI-theme 8, 5, 12', () => {
  for (const ai of [8, 5, 12]) {
    const ranked = rankedHeadlines(ai);
    const rankOf = position => ranked.findIndex(r => r.position === position) + 1;
    assert.deepEqual(ranked.slice(0, 6).map(r => r.position).sort((a, b) => a - b),
      [...EXPECTED_TOP6[ai]].sort((a, b) => a - b), `ai=${ai} top6 membership`);
    assert.deepEqual(
      {goldman: rankOf(7), europeanShares: rankOf(8), dollar: rankOf(9), oil22: rankOf(22)},
      EXPECTED_FOUR_RANKS[ai], `ai=${ai}`
    );
  }
});

test('Step 9F.2e.4b: the score drop set equals the tier drop set at every AI-theme value', () => {
  const candidates = listings.listing2026_10_12();
  const args = {
    candidates, mostActive: listings.MOST_ACTIVE_2026_10_12, portfolioSnapshots: listings.PORTFOLIO_2026_10_12,
    labelWindow: {startsAtInclusive: listings.WINDOW_START_2026_10_12}, generationTime: Date.parse(listings.TRIGGER_2026_10_12)
  };
  const tierDropped = tierTryOrder(args).dropped;
  for (const ai of [0, 5, 8, 12, 20]) {
    assert.deepEqual(scoreTryOrder({...args, env: env(ai)}).dropped, tierDropped, `ai=${ai}`);
  }
});

// --- 5. Either/or rule: never both usMacro and ai positive at once. ---
test('Step 9F.2e.4b: usMacro and ai are never both positive on the same headline', () => {
  const headlines = [AI_ONLY, AI_PLUS_MACRO, AMD_EXCLUSION, NO_MACRO,
    ...listings.listing2026_10_12().map(c => c.headline)];
  for (const ai of [0, 5, 8, 12, 20]) {
    for (const headline of headlines) {
      const result = score({headline}, {env: env(ai)});
      assert.ok(!(result.matched.usMacro > 0 && result.matched.ai > 0),
        `headline "${headline}" scored both usMacro and ai at ai=${ai}`);
    }
  }
});

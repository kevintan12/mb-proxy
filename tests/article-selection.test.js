// Step 9F.2e.2: the one article-selection step. Pure; these tests call
// lib/article-selection.js directly (Step 9F.2e.3.2 wires checkListOrderFit into
// the hand-offs; Step 9F.2e.3.4b wires the today's-mode pieces into the reader).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SLOT,
  selectionSettings,
  scoreCandidates,
  fillGeneralSlots,
  mergedPortfolioList,
  pickPortfolioSlots,
  applyWriterBudget,
  checkClassifierFit,
  selectArticles,
  selectionSummary,
  checkListOrderFit,
  tierTryOrder,
  createReaderStopRule,
  scoreTryOrder
} = require('../lib/article-selection');
const {SETTINGS_REGISTRY} = require('../lib/settings-registry');
const {createReadingBudget} = require('../lib/reading-window');

const KB = 1024;
const YAHOO = 'us.yahoo-finance';
const CNBC = 'us.cnbc';
const TRIGGER = '2026-10-12T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const hoursAgo = hours => new Date(Date.parse(TRIGGER) - hours * HOUR).toISOString();

const AAPL = Object.freeze({symbol: 'AAPL', shortName: 'Apple Inc.', longName: 'Apple Inc.'});
const VEEV = Object.freeze({symbol: 'VEEV', shortName: 'Veeva Systems Inc.', longName: 'Veeva Systems Inc.'});
const UNH = Object.freeze({symbol: 'UNH', shortName: 'UnitedHealth Group Incorporated',
  longName: 'UnitedHealth Group Incorporated'});

function candidate(key, sourceId, headline, ageHours = 2, extra = {}) {
  return {key, sourceId, headline, publisher: 'Yahoo Finance', publishedAt: hoursAgo(ageHours), ...extra};
}

// Synthetic, already-ordered entries for the slot-filling rows.
function orderedPool(yahooCount, cnbcCount) {
  const entries = [];
  for (let i = 0; i < Math.max(yahooCount, cnbcCount); i++) {
    if (i < yahooCount) entries.push({key: `y${i + 1}`, sourceId: YAHOO, score: 40 - i});
    if (i < cnbcCount) entries.push({key: `c${i + 1}`, sourceId: CNBC, score: 40 - i});
  }
  return entries.sort((a, b) => b.score - a.score);
}

function count(picks, sourceId, slot) {
  return picks.filter(pick => pick.sourceId === sourceId && pick.slot === slot).length;
}

test('Step 9F.2e.2: every number comes from the settings table at Kevin\'s values', () => {
  const settings = selectionSettings({env: {}});
  assert.deepEqual({...settings, slotsBySource: {...settings.slotsBySource}}, {
    slotsBySource: {[YAHOO]: 7, [CNBC]: 3},
    spilloverEnabled: true,
    sparePerSource: 3,
    portfolioSlots: 2,
    firstPassPerCompany: 1,
    textBudgetBytes: 150 * KB,
    classifierMaxItems: 50,
    classifierMaxBytes: 300 * KB
  });
  for (const name of ['yahooSlots', 'cnbcSlots', 'portfolioSlots', 'spareAdmits', 'slotSpilloverEnabled',
    'articleTextBudgetBytesPlanned', 'portfolioFirstPassPerCompany']) {
    assert.equal(SETTINGS_REGISTRY[name].wired, false, name);
    assert.match(SETTINGS_REGISTRY[name].location, /switched on in Step 9F\.2[de]\.\d/, name);
  }
});

// Safe-range clamping for every Admin setting the selection reads.
const CLAMP_ROWS = [
  ['YAHOO_SLOTS', '-3', s => s.slotsBySource[YAHOO], 0],
  ['YAHOO_SLOTS', '99', s => s.slotsBySource[YAHOO], 10],
  ['YAHOO_SLOTS', '7.6', s => s.slotsBySource[YAHOO], 7],
  ['YAHOO_SLOTS', 'lots', s => s.slotsBySource[YAHOO], 7],
  ['CNBC_SLOTS', '-1', s => s.slotsBySource[CNBC], 0],
  ['CNBC_SLOTS', '9', s => s.slotsBySource[CNBC], 6],
  ['PORTFOLIO_SLOTS', '-1', s => s.portfolioSlots, 0],
  ['PORTFOLIO_SLOTS', '12', s => s.portfolioSlots, 4],
  ['SPARE_ADMITS', '-2', s => s.sparePerSource, 0],
  ['SPARE_ADMITS', '50', s => s.sparePerSource, 5],
  ['SLOT_SPILLOVER_ENABLED', 'off', s => s.spilloverEnabled, false],
  ['SLOT_SPILLOVER_ENABLED', 'maybe', s => s.spilloverEnabled, true],
  ['ARTICLE_TEXT_BUDGET_BYTES_PLANNED', '1000', s => s.textBudgetBytes, 32 * KB],
  ['ARTICLE_TEXT_BUDGET_BYTES_PLANNED', String(900 * KB), s => s.textBudgetBytes, 200 * KB],
  ['CLASSIFIER_REQUEST_LIMIT_BYTES', '10', s => s.classifierMaxBytes, 64 * KB],
  ['CLASSIFIER_REQUEST_LIMIT_BYTES', String(999 * KB), s => s.classifierMaxBytes, 400 * KB]
];
for (const [envVar, raw, read, expected] of CLAMP_ROWS) {
  test(`Step 9F.2e.2 clamping: ${envVar}=${raw} -> ${expected}`, () => {
    assert.equal(read(selectionSettings({env: {[envVar]: raw}})), expected);
  });
}

// General slots: 7 Yahoo : 3 CNBC, spare slots passed on, up to 3 per source.
const FILL_ROWS = [
  {name: 'both sources have plenty', yahoo: 12, cnbc: 5, expect: [7, 0, 3, 0]},
  {name: 'Yahoo short of 7, CNBC has more: CNBC takes the spare', yahoo: 4, cnbc: 8, expect: [4, 0, 3, 3]},
  {name: 'Yahoo far short: CNBC takes at most 3 spare', yahoo: 2, cnbc: 9, expect: [2, 0, 3, 3]},
  {name: 'CNBC returns zero: Yahoo takes the 3 spare', yahoo: 12, cnbc: 0, expect: [7, 3, 0, 0]},
  {name: 'CNBC returns zero, Yahoo has only 8', yahoo: 8, cnbc: 0, expect: [7, 1, 0, 0]},
  {name: 'both short: nothing to pass on', yahoo: 3, cnbc: 1, expect: [3, 0, 1, 0]},
  {name: 'switch off: unused slots stay unused', yahoo: 12, cnbc: 0, spillover: false, expect: [7, 0, 0, 0]},
  {name: 'spare limit 1', yahoo: 12, cnbc: 0, spare: 1, expect: [7, 1, 0, 0]}
];
for (const row of FILL_ROWS) {
  test(`Step 9F.2e.2 general slots: ${row.name}`, () => {
    const result = fillGeneralSlots({
      ordered: orderedPool(row.yahoo, row.cnbc),
      slotsBySource: {[YAHOO]: 7, [CNBC]: 3},
      spilloverEnabled: row.spillover ?? true,
      sparePerSource: row.spare ?? 3
    });
    assert.deepEqual([
      count(result.picks, YAHOO, SLOT.GENERAL), count(result.picks, YAHOO, SLOT.SPARE),
      count(result.picks, CNBC, SLOT.GENERAL), count(result.picks, CNBC, SLOT.SPARE)
    ], row.expect);
    const [yg, ys, cg, cs] = row.expect;
    assert.equal(result.bySource[YAHOO].spareGiven, cs);
    assert.equal(result.bySource[CNBC].spareGiven, ys);
    assert.equal(result.picks.length + result.notChosen.length, row.yahoo + row.cnbc);
    for (const pick of result.picks.filter(p => p.slot === SLOT.SPARE)) {
      assert.notEqual(pick.fromSource, pick.sourceId);
    }
    assert.equal(yg + ys + cg + cs, result.picks.length);
  });
}

test('Step 9F.2e.2 general slots: spare goes to the best remaining article, and the reasons say why', () => {
  const result = fillGeneralSlots({
    ordered: orderedPool(2, 9), slotsBySource: {[YAHOO]: 7, [CNBC]: 3},
    spilloverEnabled: true, sparePerSource: 3
  });
  assert.deepEqual(result.picks.filter(p => p.slot === SLOT.SPARE).map(p => p.key), ['c4', 'c5', 'c6']);
  assert.deepEqual(result.notChosen.map(e => [e.key, e.reason]),
    [['c7', 'SPARE_LIMIT_REACHED'], ['c8', 'SPARE_LIMIT_REACHED'], ['c9', 'SPARE_LIMIT_REACHED']]);
  const off = fillGeneralSlots({
    ordered: orderedPool(9, 4), slotsBySource: {[YAHOO]: 7, [CNBC]: 3},
    spilloverEnabled: true, sparePerSource: 3
  });
  assert.deepEqual(off.notChosen.map(e => e.reason), ['NO_SPARE_SLOT', 'NO_SPARE_SLOT', 'NO_SPARE_SLOT']);
});

test('Step 9F.2e.2 ordering: equal scores go to the newer article, then listing order', () => {
  const scored = scoreCandidates({
    triggerAt: TRIGGER,
    candidates: [
      candidate('old', YAHOO, 'Treasury yields climb', 3),
      candidate('newer', CNBC, 'Fed holds rates steady', 1),
      candidate('sameAgeFirst', YAHOO, 'Fed speakers line up', 2),
      candidate('sameAgeSecond', CNBC, 'Treasury yields slip', 2)
    ]
  });
  assert.deepEqual(scored.ordered.map(entry => entry.score), [24, 24, 24, 24]);
  assert.deepEqual(scored.ordered.map(entry => entry.key), ['newer', 'sameAgeFirst', 'sameAgeSecond', 'old']);
});

test('Step 9F.2e.2 ordering: no publisher penalty, drop rule applied, recaps unscored and kept', () => {
  const result = selectArticles({
    triggerAt: TRIGGER,
    env: {},
    candidates: [
      candidate('blog', YAHOO, 'Fed holds rates steady', 2, {publisher: 'Motley Fool'}),
      candidate('wire', YAHOO, 'Fed holds rates steady again', 2, {publisher: 'Reuters'}),
      candidate('drop', YAHOO, 'Singapore retirement savings tips', 1),
      candidate('recap', YAHOO, 'Singapore retirement savings tips recap', 30, {isRecap: true})
    ]
  });
  assert.equal(result.scored.ordered.find(e => e.key === 'blog').score, 24);
  assert.equal(result.scored.ordered.find(e => e.key === 'wire').score, 29);
  assert.deepEqual(result.scored.dropped.map(e => [e.key, e.dropReason]), [['drop', 'DROP_LIST']]);
  const recap = result.selected.find(entry => entry.key === 'recap');
  assert.equal(recap.slot, SLOT.RECAP);
  assert.equal(recap.score, null);
});

test('Step 9F.2e.2: a candidate from a source without general slots is rejected', () => {
  assert.throws(() => scoreCandidates({triggerAt: TRIGGER, candidates: [candidate('x', 'us.other', 'Fed')]}),
    /no general slots are defined for source: us\.other/);
  assert.throws(() => scoreCandidates({triggerAt: TRIGGER, candidates: [
    candidate('x', YAHOO, 'Fed'), candidate('x', YAHOO, 'Fed again')]}), /duplicate candidate key/);
});

// Portfolio slots over both lists. One general slot (Yahoo), no spillover, so
// the company articles compete for the portfolio slots.
const ONE_GENERAL = Object.freeze({
  ...selectionSettings({env: {}}),
  slotsBySource: Object.freeze({[YAHOO]: 1, [CNBC]: 0}),
  spilloverEnabled: false
});
const PORTFOLIO_POOL = [
  candidate('macro', YAHOO, 'Fed holds rates steady', 1),
  candidate('apple', YAHOO, 'Apple supplier warns on demand', 2),
  candidate('veeva', CNBC, 'Veeva Systems wins a new contract', 3),
  candidate('other', YAHOO, 'Retailer names a new chief executive', 1)
];
const PORTFOLIO_ROWS = [
  {name: 'My Stocks only', lists: {myStocks: [AAPL]}, picks: [['apple', ['MY_STOCKS']]]},
  {name: 'Watchlist only', lists: {watchlist: [VEEV]}, picks: [['veeva', ['WATCHLIST']]]},
  {name: 'both lists', lists: {myStocks: [AAPL], watchlist: [VEEV]},
    picks: [['apple', ['MY_STOCKS']], ['veeva', ['WATCHLIST']]]},
  {name: 'a company on both lists', lists: {myStocks: [AAPL], watchlist: [AAPL, VEEV]},
    picks: [['apple', ['MY_STOCKS', 'WATCHLIST']], ['veeva', ['WATCHLIST']]]},
  {name: 'no portfolio article exists: slots stay empty', lists: {myStocks: [UNH]}, picks: []}
];
for (const row of PORTFOLIO_ROWS) {
  test(`Step 9F.2e.2 portfolio slots: ${row.name}`, () => {
    const result = selectArticles({
      triggerAt: TRIGGER, env: {}, settings: ONE_GENERAL, candidates: PORTFOLIO_POOL, portfolioLists: row.lists
    });
    assert.deepEqual(result.general.picks.map(p => p.key), ['macro']);
    assert.deepEqual(result.portfolio.picks.map(p => [p.key, [...p.lists]]), row.picks);
    assert.ok(result.selected.every(entry => PORTFOLIO_POOL.some(c => c.key === entry.key)));
  });
}

test('Step 9F.2e.2 portfolio slots: a general-slot article naming a company counts as covering it', () => {
  const pool = [
    candidate('fedApple', YAHOO, 'Fed and Apple lift stocks', 1),
    candidate('apple2', YAHOO, 'Apple supplier warns on demand', 2),
    candidate('veeva', CNBC, 'Veeva Systems wins a new contract', 9)
  ];
  const lists = {myStocks: [AAPL], watchlist: [VEEV]};
  const result = selectArticles({triggerAt: TRIGGER, env: {}, settings: ONE_GENERAL, candidates: pool,
    portfolioLists: lists});
  assert.deepEqual(result.general.picks.map(p => p.key), ['fedApple']);
  assert.deepEqual([...result.portfolio.coveredByGeneral], ['AAPL']);
  // Apple scores higher, but Veeva is the only company not yet covered.
  assert.deepEqual(result.portfolio.picks.map(p => [p.key, p.pass]),
    [['veeva', 'FIRST_PASS'], ['apple2', 'SECOND_PASS']]);
  const oneSlot = selectArticles({triggerAt: TRIGGER, env: {}, candidates: pool, portfolioLists: lists,
    settings: {...ONE_GENERAL, portfolioSlots: 1}});
  assert.deepEqual(oneSlot.portfolio.picks.map(p => p.key), ['veeva']);
});

test('Step 9F.2e.2 portfolio slots: the merged list keeps first appearance and both list names', () => {
  const merged = mergedPortfolioList({myStocks: [AAPL, VEEV], watchlist: [VEEV, UNH]});
  assert.deepEqual(merged.map(entry => [entry.identity.symbol, entry.lists]),
    [['AAPL', ['MY_STOCKS']], ['VEEV', ['MY_STOCKS', 'WATCHLIST']], ['UNH', ['WATCHLIST']]]);
  const direct = pickPortfolioSlots({
    ordered: [{key: 'a', sourceId: YAHOO, headline: 'Apple supplier warns', score: 12, ageHours: 1}],
    generalPicks: [], portfolioLists: {}, slots: 2, firstPassPerCompany: 1
  });
  assert.deepEqual(direct.picks, []);
});

// Writer budget over an already-downloaded list.
function downloaded(key, slot, score, textKb, ageHours = 2, listIndex = 0) {
  return {key, sourceId: YAHOO, headline: key, slot, score, ageHours, listIndex, textBytes: textKb * KB};
}
const BUDGET_LIST = Object.freeze([
  downloaded('g1', SLOT.GENERAL, 30, 40, 2, 0),
  downloaded('g2', SLOT.GENERAL, 20, 40, 2, 1),
  downloaded('s1', SLOT.SPARE, 22, 20, 2, 2),
  downloaded('p1', SLOT.PORTFOLIO, 12, 30, 2, 3),
  downloaded('p2', SLOT.PORTFOLIO, 8, 30, 2, 4),
  downloaded('r1', SLOT.RECAP, null, 30, 20, 5)
]);
const BUDGET_ROWS = [
  {name: 'under budget: nothing dropped', budgetKb: 190, dropped: [], over: false},
  {name: 'just over: the lowest general goes first', budgetKb: 160, dropped: ['g2'], over: false},
  {name: 'general before portfolio, even when the portfolio scores lower', budgetKb: 100,
    dropped: ['g2', 's1', 'g1'], over: false},
  {name: 'then portfolio, lowest first', budgetKb: 45, dropped: ['g2', 's1', 'g1', 'p2', 'p1'], over: false},
  {name: 'recaps alone over budget: kept and reported, not cut', budgetKb: 20,
    dropped: ['g2', 's1', 'g1', 'p2', 'p1'], over: true}
];
for (const row of BUDGET_ROWS) {
  test(`Step 9F.2e.2 writer budget: ${row.name}`, () => {
    const result = applyWriterBudget({articles: BUDGET_LIST, budgetBytes: row.budgetKb * KB});
    assert.deepEqual(result.dropped.map(entry => entry.key), row.dropped);
    assert.ok(result.dropped.every(entry => entry.reason === 'OVER_TEXT_BUDGET'));
    assert.equal(result.overBudget, row.over);
    assert.equal(result.overBudgetReason, row.over ? 'NEVER_DROPPED_ITEMS_EXCEED_BUDGET' : null);
    assert.ok(result.kept.some(entry => entry.key === 'r1'), 'recap kept');
    assert.equal(result.totalBytesBefore, 190 * KB);
    assert.equal(result.totalBytesAfter, result.kept.reduce((sum, entry) => sum + entry.textBytes, 0));
    // Nothing is shortened: the kept articles are the same, untouched objects.
    for (const entry of result.kept) assert.equal(entry, BUDGET_LIST.find(item => item.key === entry.key));
  });
}

test('Step 9F.2e.2 writer budget: the default is 150 KB and article text is never changed', () => {
  const text = 'x'.repeat(100 * KB);
  const articles = [
    {...downloaded('a', SLOT.GENERAL, 30, 0), text, textBytes: 100 * KB},
    {...downloaded('b', SLOT.GENERAL, 10, 0, 2, 1), text, textBytes: 100 * KB}
  ];
  const result = applyWriterBudget({articles});
  assert.equal(result.budgetBytes, 150 * KB);
  assert.deepEqual(result.dropped.map(entry => entry.key), ['b']);
  assert.equal(result.kept[0].text, text);
  assert.equal(result.kept[0].textBytes, 100 * KB);
  assert.throws(() => applyWriterBudget({articles: [{key: 'z', slot: SLOT.GENERAL}]}), /textBytes/);
  assert.throws(() => applyWriterBudget({articles: [{key: 'z', slot: 'OTHER', textBytes: 1}]}), /unknown slot/);
});

// Classifier fit: 50 items and 300 KB.
function classifierItems({protectedCount, generalCount, portfolioCount, bytesEach = KB, protectedBytes = KB}) {
  const items = [];
  for (let i = 0; i < protectedCount; i++) items.push({key: `t${i}`, slot: SLOT.PROTECTED, bytes: protectedBytes});
  items.push({key: 'recap', slot: SLOT.RECAP, bytes: protectedBytes});
  for (let i = 0; i < generalCount; i++) {
    items.push({key: `g${i}`, slot: SLOT.GENERAL, bytes: bytesEach, score: 40 - i, listIndex: i});
  }
  for (let i = 0; i < portfolioCount; i++) {
    items.push({key: `p${i}`, slot: SLOT.PORTFOLIO, bytes: bytesEach, score: 8, listIndex: 100 + i});
  }
  return items;
}
const CLASSIFIER_ROWS = [
  {name: 'fits: nothing left out', items: classifierItems({protectedCount: 30, generalCount: 10, portfolioCount: 2}),
    leftOut: [], fits: true},
  {name: '52 items: the two lowest general items are left out', items: classifierItems({protectedCount: 39,
    generalCount: 10, portfolioCount: 2}), leftOut: [['g9', 'OVER_ITEM_LIMIT'], ['g8', 'OVER_ITEM_LIMIT']], fits: true},
  {name: 'over 300 KB: lowest general first, then portfolio', items: classifierItems({protectedCount: 20,
    generalCount: 2, portfolioCount: 2, bytesEach: 100 * KB, protectedBytes: 7 * KB}),
  leftOut: [['g1', 'OVER_BYTE_LIMIT'], ['g0', 'OVER_BYTE_LIMIT'], ['p1', 'OVER_BYTE_LIMIT']], fits: true},
  {name: 'protected items alone over the limit: they stay, reported', items: classifierItems({protectedCount: 60,
    generalCount: 1, portfolioCount: 0}), leftOut: [['g0', 'OVER_ITEM_LIMIT']], fits: false}
];
for (const row of CLASSIFIER_ROWS) {
  test(`Step 9F.2e.2 classifier fit: ${row.name}`, () => {
    const result = checkClassifierFit({items: row.items});
    assert.equal(result.maxItems, 50);
    assert.equal(result.maxBytes, 300 * KB);
    assert.deepEqual(result.leftOut.map(entry => [entry.key, entry.reason]), row.leftOut);
    assert.equal(result.fits, row.fits);
    for (const item of row.items.filter(i => i.slot === SLOT.PROTECTED || i.slot === SLOT.RECAP)) {
      assert.ok(result.kept.includes(item.key), `${item.key} kept`);
    }
  });
}

test('Step 9F.2e.2 classifier fit: the rest of the request counts toward the byte limit', () => {
  const items = classifierItems({protectedCount: 1, generalCount: 2, portfolioCount: 0, bytesEach: 10 * KB});
  assert.equal(checkClassifierFit({items, overheadBytes: 270 * KB}).leftOut.length, 0);
  assert.deepEqual(checkClassifierFit({items, overheadBytes: 285 * KB}).leftOut.map(e => e.key), ['g1']);
});

test('Step 9F.2e.2 summary: every decision listed, short headlines only, no article text', () => {
  const secret = 'BODY-TEXT-MUST-NOT-APPEAR '.repeat(50);
  const longHeadline = `Fed holds rates steady ${'and markets wait for the next data release '.repeat(4)}`;
  const candidates = [
    candidate('macro', YAHOO, longHeadline, 1, {text: secret}),
    candidate('apple', YAHOO, 'Apple supplier warns on demand', 2, {text: secret}),
    candidate('other', YAHOO, 'Retailer names a new chief executive', 1, {text: secret}),
    candidate('drop', YAHOO, 'Singapore retirement savings tips', 1, {text: secret}),
    candidate('cnbc', CNBC, 'Treasury yields climb', 3, {text: secret}),
    candidate('recap', YAHOO, 'Stock market today: Dow rises', 20, {isRecap: true, text: secret})
  ];
  const selection = selectArticles({
    triggerAt: TRIGGER, env: {}, candidates, portfolioLists: {watchlist: [AAPL]},
    settings: {...ONE_GENERAL, slotsBySource: {[YAHOO]: 1, [CNBC]: 1}}
  });
  assert.deepEqual(selection.selected.map(entry => [entry.key, entry.slot]),
    [['recap', 'RECAP'], ['macro', 'GENERAL'], ['cnbc', 'GENERAL'], ['apple', 'PORTFOLIO']]);
  // The classifier check first, then the writer budget on what the classifier kept.
  const classifierFit = checkClassifierFit({
    items: selection.selected.map(entry => ({...entry, bytes: 1000})), maxItems: 3
  });
  const writerBudget = applyWriterBudget({
    articles: selection.selected.filter(entry => classifierFit.kept.includes(entry.key)),
    budgetBytes: 2 * secret.length
  });
  const summary = selectionSummary({selection, writerBudget, classifierFit});
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('BODY-TEXT-MUST-NOT-APPEAR'));
  assert.deepEqual(summary.decisions.map(d => [d.key, d.decision, d.reason]), [
    ['macro', 'DROPPED', 'OVER_TEXT_BUDGET'],
    ['apple', 'KEPT', 'PORTFOLIO_FIRST_PASS'],
    ['other', 'NOT_CHOSEN', 'SOURCE_SLOTS_FULL'],
    ['drop', 'DROPPED', 'DROP_LIST'],
    ['cnbc', 'LEFT_OUT_OF_CLASSIFIER', 'OVER_ITEM_LIMIT'],
    ['recap', 'KEPT', 'RECAP_ALWAYS_KEPT']
  ]);
  assert.equal(summary.decisions[0].headline.length, 80);
  assert.equal(summary.decisions.find(d => d.key === 'other').portfolioReason, 'NO_PORTFOLIO_COMPANY');
  assert.equal(summary.portfolio.filled, 1);
  assert.equal(summary.writerBudget.droppedCount, 1);
  assert.equal(summary.classifierFit.leftOutCount, 1);
});

// Step 9F.2e.3.4b (supersedes the Step 9F.2e.3.2 "only the orchestration"
// test): only the orchestration (checkListOrderFit) and the reader
// (tierTryOrder, createReaderStopRule, checkListOrderFit; Step 9F.2e.4a adds
// scoreTryOrder) import the selection step; nothing under api/ does.
test('Step 9F.2e.3.4b: only the orchestration and the reader import the selection step, each only its pieces', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  for (const dir of ['api', 'lib', path.join('lib', 'sources')]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (name.endsWith('.js')) files.push(path.join(dir, name));
    }
  }
  const imports = /require\([^)]*article-selection/;
  const sources = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const importers = files.filter(file => file !== path.join('lib', 'article-selection.js')
    && imports.test(sources.get(file)));
  assert.deepEqual(importers.sort(), [
    path.join('lib', 'source-reader.js'),
    path.join('lib', 'us-analysis-package-orchestration.js')
  ]);
  assert.ok(importers.every(file => !file.startsWith(`api${path.sep}`)));
  const importLines = file => sources.get(file).split(/\r?\n/).filter(line => imports.test(line));
  assert.deepEqual(importLines(path.join('lib', 'us-analysis-package-orchestration.js')),
    ["const {checkListOrderFit} = require('./article-selection');"]);
  assert.deepEqual(importLines(path.join('lib', 'source-reader.js')),
    ["const {tierTryOrder, scoreTryOrder, createReaderStopRule, checkListOrderFit} = require('./article-selection');"]);
});

// Step 9F.2e.3.1: today's-mode pieces. Every position array must cover every
// item exactly once, in range, and in original-list order.
function assertPositions(items, result) {
  const all = result.kept.concat(result.dropped);
  assert.equal(all.length, items.length, 'every item accounted for exactly once');
  assert.deepEqual([...all].sort((a, b) => a - b), [...items.keys()], 'no position missing or repeated');
  assert.deepEqual(result.kept, [...result.kept].sort((a, b) => a - b), 'kept stays in original order');
  assert.deepEqual(result.dropped, [...result.dropped].sort((a, b) => a - b), 'dropped stays in original order');
}

test('Step 9F.2e.3.1 list-order fit: STOP drops the first misfit and everything after it; SKIP only skips it', () => {
  const items = [{big: false}, {big: false}, {big: true}, {big: false}, {big: false}];
  const measure = trial => (trial[trial.length - 1]?.big ? 1000 : 1);
  const stop = checkListOrderFit({items, mode: 'STOP', maxItems: 10, maxBytes: 500, measure});
  assert.deepEqual(stop, {kept: [0, 1], dropped: [2, 3, 4]});
  assertPositions(items, stop);
  const skip = checkListOrderFit({items, mode: 'SKIP', maxItems: 10, maxBytes: 500, measure});
  assert.deepEqual(skip, {kept: [0, 1, 3, 4], dropped: [2]});
  assertPositions(items, skip);
});

test('Step 9F.2e.3.1 list-order fit: the item-count test trips exactly one over the limit, in either mode', () => {
  const items = Array.from({length: 51}, () => ({}));
  const atLimit = checkListOrderFit({items: items.slice(0, 50), mode: 'STOP', maxItems: 50});
  assert.deepEqual(atLimit.dropped, []);
  for (const mode of ['STOP', 'SKIP']) {
    const result = checkListOrderFit({items, mode, maxItems: 50});
    assert.deepEqual(result.kept, [...Array(50).keys()]);
    assert.deepEqual(result.dropped, [50]);
    assertPositions(items, result);
  }
});

test('Step 9F.2e.3.1 list-order fit: baseCount counts toward the item limit too', () => {
  const items = [{}, {}];
  const result = checkListOrderFit({items, mode: 'STOP', maxItems: 2, baseCount: 1});
  assert.deepEqual(result, {kept: [0], dropped: [1]});
});

test('Step 9F.2e.3.1 list-order fit: the byte test trips exactly one byte over the limit', () => {
  const items = [{size: 150}, {size: 150}, {size: 1}];
  const measure = trial => trial.reduce((sum, item) => sum + item.size, 0);
  const atLimit = checkListOrderFit({items: items.slice(0, 2), mode: 'STOP', maxItems: 10, maxBytes: 300, measure});
  assert.deepEqual(atLimit.dropped, []);
  const oneOver = checkListOrderFit({items, mode: 'STOP', maxItems: 10, maxBytes: 300, measure});
  assert.deepEqual(oneOver, {kept: [0, 1], dropped: [2]});
  assertPositions(items, oneOver);
});

test('Step 9F.2e.3.1 list-order fit: with no measuring function, only the item-count test runs', () => {
  const items = [{size: 10 ** 9}, {size: 10 ** 9}, {size: 10 ** 9}, {size: 10 ** 9}];
  const result = checkListOrderFit({items, mode: 'STOP', maxItems: 3});
  assert.deepEqual(result, {kept: [0, 1, 2], dropped: [3]});
});

test('Step 9F.2e.3.1 list-order fit: a noHorizon item is a misfit up front, before any measuring', () => {
  const items = [{}, {noHorizon: true}, {}];
  assert.deepEqual(checkListOrderFit({items, mode: 'STOP', maxItems: 10}), {kept: [0], dropped: [1, 2]});
  assert.deepEqual(checkListOrderFit({items, mode: 'SKIP', maxItems: 10}), {kept: [0, 2], dropped: [1]});
});

test('Step 9F.2e.3.1 list-order fit: a throwing measuring function is caught and treated as a misfit, never rethrown', () => {
  const items = [{}, {poison: true}, {}];
  const measure = trial => {
    if (trial[trial.length - 1]?.poison) throw new Error('boom');
    return 1;
  };
  assert.deepEqual(checkListOrderFit({items, mode: 'STOP', maxItems: 10, maxBytes: 100, measure}),
    {kept: [0], dropped: [1, 2]});
  assert.deepEqual(checkListOrderFit({items, mode: 'SKIP', maxItems: 10, maxBytes: 100, measure}),
    {kept: [0, 2], dropped: [1]});
});

test('Step 9F.2e.3.1 list-order fit: an empty list keeps and drops nothing', () => {
  for (const mode of ['STOP', 'SKIP']) {
    assert.deepEqual(checkListOrderFit({items: [], mode, maxItems: 5}), {kept: [], dropped: []});
  }
});

test('Step 9F.2e.3.1 list-order fit: rejects a bad mode, limit or byte cap', () => {
  assert.throws(() => checkListOrderFit({items: [], mode: 'OTHER', maxItems: 1}), /mode/);
  assert.throws(() => checkListOrderFit({items: [], mode: 'STOP', maxItems: -1}), /maxItems/);
  assert.throws(() => checkListOrderFit({items: [], mode: 'STOP', maxItems: 1, measure: () => 1}), /maxBytes/);
});

test('Step 9F.2e.3.1 TIER order: non-stale tries first, stale-labelled tries last, tier ranking still drops tier 4a', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: TRIGGER};
  const candidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '100h ago'}, // 3b, stale -> tryLast
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'}, // 3b, fresh -> tryFirst
    {headline: 'Singapore retirement savings guide', ageLabel: '1m ago'}, // 4a -> dropped
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'} // 3b, fresh -> tryFirst
  ];
  const result = tierTryOrder({candidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime});
  assert.deepEqual(result.dropped, [2]);
  assert.deepEqual(result.order, [1, 3, 0]);
  assert.deepEqual([...result.order].sort((a, b) => a - b).concat(result.dropped).sort((a, b) => a - b),
    [...candidates.keys()], 'every candidate accounted for exactly once');
  assert.deepEqual(result.tiers[0], {tier: 5, subTier: '3b'});
  assert.deepEqual(result.tiers[1], {tier: 5, subTier: '3b'});
  assert.deepEqual(result.tiers[3], {tier: 5, subTier: '3b'});
});

test('Step 9F.2e.3.1 TIER order: an identity match still ranks and tries before a generic headline', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: TRIGGER};
  const candidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'},
    {headline: 'AAPL unveils a new product line', ageLabel: '1m ago'}
  ];
  const result = tierTryOrder({
    candidates, mostActive: [], portfolioSnapshots: [{symbol: 'AAPL', instrumentName: 'Apple Inc.'}],
    labelWindow, generationTime
  });
  assert.deepEqual(result.order, [1, 0]);
  assert.deepEqual(result.tiers[1], {tier: 1, subTier: '1a'});
});

test('Step 9F.2e.3.1 reader stop rule: trips on the attempts cap, the admitted cap, or the budget, using the caller\'s clock', () => {
  let clock = 0;
  const stopRule = createReaderStopRule({maxAttempts: 3, maxAdmitted: 2, budgetMs: 1000, now: () => clock});
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: false, reason: null});
  assert.deepEqual(stopRule({attemptsMade: 3, admittedCount: 0}), {stop: true, reason: 'MAX_ATTEMPTS_REACHED'});
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 2}), {stop: true, reason: 'MAX_ADMITTED_REACHED'});
  clock = 999;
  assert.equal(stopRule({attemptsMade: 0, admittedCount: 0}).stop, false);
  clock = 1000;
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: true, reason: 'READING_BUDGET_SPENT'});
});

test('Step 9F.2e.3.1 reader stop rule: rejects a bad cap or a missing clock', () => {
  assert.throws(() => createReaderStopRule({maxAttempts: -1, maxAdmitted: 1, budgetMs: 1, now: () => 0}), /maxAttempts/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: -1, budgetMs: 1, now: () => 0}), /maxAdmitted/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: 1, budgetMs: 1}), /now/);
});

// Step 9F.2e.3.4a: three additions so the reader can connect safely later
// (Step 9F.2e.3.4b) -- a shared stopwatch, the old-label positions on
// tierTryOrder, and decimal caps on createReaderStopRule. Nothing here is
// connected; every existing assertion above stays unchanged.
function countingClock(start = 0) {
  let value = start;
  let reads = 0;
  return {
    now: () => { reads++; return value; },
    set: next => { value = next; },
    reads: () => reads
  };
}

test('Step 9F.2e.3.4a reader stop rule: a supplied budget is reused as is, with no second stopwatch', () => {
  const clock = countingClock(0);
  const sharedBudget = createReadingBudget({budgetMs: 1000, now: clock.now});
  const readsAfterBudget = clock.reads();
  const stopRule = createReaderStopRule({maxAttempts: 3, maxAdmitted: 2, budget: sharedBudget});
  assert.equal(clock.reads(), readsAfterBudget, 'making the stop rule from a supplied budget reads the clock no extra time');
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: false, reason: null});
  assert.equal(clock.reads(), readsAfterBudget + 1, 'one clock read per call, via the shared budget only');
  clock.set(1000);
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: true, reason: 'READING_BUDGET_SPENT'});
});

test('Step 9F.2e.3.4a reader stop rule: supplying a budget reads the clock the same number of times as making one', () => {
  const selfMade = countingClock(0);
  createReaderStopRule({maxAttempts: 3, maxAdmitted: 2, budgetMs: 1000, now: selfMade.now});
  const selfMadeConstructReads = selfMade.reads();

  const shared = countingClock(0);
  const budget = createReadingBudget({budgetMs: 1000, now: shared.now});
  const sharedConstructReads = shared.reads();
  createReaderStopRule({maxAttempts: 3, maxAdmitted: 2, budget});
  assert.equal(shared.reads(), sharedConstructReads, 'no extra read when a budget is supplied');
  assert.equal(sharedConstructReads, selfMadeConstructReads, 'constructing reads the clock the same number of times either way');
});

test('Step 9F.2e.3.4a reader stop rule: without a supplied budget, behaviour is unchanged from Step 9F.2e.3.1', () => {
  let clock = 0;
  const stopRule = createReaderStopRule({maxAttempts: 3, maxAdmitted: 2, budgetMs: 1000, now: () => clock});
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: false, reason: null});
  assert.deepEqual(stopRule({attemptsMade: 3, admittedCount: 0}), {stop: true, reason: 'MAX_ATTEMPTS_REACHED'});
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 2}), {stop: true, reason: 'MAX_ADMITTED_REACHED'});
  clock = 999;
  assert.equal(stopRule({attemptsMade: 0, admittedCount: 0}).stop, false);
  clock = 1000;
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 0}), {stop: true, reason: 'READING_BUDGET_SPENT'});
});

test('Step 9F.2e.3.4a reader stop rule: caps are checked before the clock is ever read, attempts then admitted then budget', () => {
  const clock = countingClock(0);
  const stopRule = createReaderStopRule({maxAttempts: 2, maxAdmitted: 2, budgetMs: 1000, now: clock.now});
  const afterConstruct = clock.reads();
  assert.deepEqual(stopRule({attemptsMade: 2, admittedCount: 2}), {stop: true, reason: 'MAX_ATTEMPTS_REACHED'});
  assert.equal(clock.reads(), afterConstruct, 'the attempts cap trips before the clock is read');
  assert.deepEqual(stopRule({attemptsMade: 0, admittedCount: 2}), {stop: true, reason: 'MAX_ADMITTED_REACHED'});
  assert.equal(clock.reads(), afterConstruct, 'the admitted cap trips before the clock is read');
  stopRule({attemptsMade: 0, admittedCount: 0});
  assert.equal(clock.reads(), afterConstruct + 1, 'the budget is checked, and the clock read, only once neither cap trips');
});

// Decimal caps: an Admin value like 12.5 is accepted and compared raw (>=),
// exactly like today's reader loop header -- not rounded, not rejected.
const DECIMAL_CAP_ROWS = [
  {name: 'decimal attempts cap 12.5: 12 does not stop, 13 does',
    maxAttempts: 12.5, maxAdmitted: 1e6, attemptsMade: 12, admittedCount: 0, stop: false, reason: null},
  {name: 'decimal attempts cap 12.5: 13 stops',
    maxAttempts: 12.5, maxAdmitted: 1e6, attemptsMade: 13, admittedCount: 0, stop: true, reason: 'MAX_ATTEMPTS_REACHED'},
  {name: 'decimal admitted cap 6.5: 6 does not stop, 7 does',
    maxAttempts: 1e6, maxAdmitted: 6.5, attemptsMade: 0, admittedCount: 6, stop: false, reason: null},
  {name: 'decimal admitted cap 6.5: 7 stops',
    maxAttempts: 1e6, maxAdmitted: 6.5, attemptsMade: 0, admittedCount: 7, stop: true, reason: 'MAX_ADMITTED_REACHED'},
  {name: 'a zero attempts cap stops immediately',
    maxAttempts: 0, maxAdmitted: 1e6, attemptsMade: 0, admittedCount: 0, stop: true, reason: 'MAX_ATTEMPTS_REACHED'},
  {name: 'a zero admitted cap stops immediately',
    maxAttempts: 1e6, maxAdmitted: 0, attemptsMade: 0, admittedCount: 0, stop: true, reason: 'MAX_ADMITTED_REACHED'},
  {name: 'huge caps do not stop a modest count',
    maxAttempts: 1e9, maxAdmitted: 1e9, attemptsMade: 999999, admittedCount: 999999, stop: false, reason: null}
];
for (const row of DECIMAL_CAP_ROWS) {
  test(`Step 9F.2e.3.4a reader stop rule: ${row.name}`, () => {
    const stopRule = createReaderStopRule({
      maxAttempts: row.maxAttempts, maxAdmitted: row.maxAdmitted, budgetMs: 1e9, now: () => 0
    });
    assert.deepEqual(stopRule({attemptsMade: row.attemptsMade, admittedCount: row.admittedCount}),
      {stop: row.stop, reason: row.reason});
  });
}

test('Step 9F.2e.3.4a reader stop rule: non-finite, non-numeric or missing caps are rejected like negative caps are', () => {
  assert.throws(() => createReaderStopRule({maxAttempts: NaN, maxAdmitted: 1, budgetMs: 1, now: () => 0}), /maxAttempts/);
  assert.throws(() => createReaderStopRule({maxAttempts: Infinity, maxAdmitted: 1, budgetMs: 1, now: () => 0}), /maxAttempts/);
  assert.throws(() => createReaderStopRule({maxAttempts: 'lots', maxAdmitted: 1, budgetMs: 1, now: () => 0}), /maxAttempts/);
  assert.throws(() => createReaderStopRule({maxAdmitted: 1, budgetMs: 1, now: () => 0}), /maxAttempts/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: NaN, budgetMs: 1, now: () => 0}), /maxAdmitted/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: Infinity, budgetMs: 1, now: () => 0}), /maxAdmitted/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: 'lots', budgetMs: 1, now: () => 0}), /maxAdmitted/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, budgetMs: 1, now: () => 0}), /maxAdmitted/);
});

test('Step 9F.2e.3.4a reader stop rule: a supplied budget without a spent() method is rejected', () => {
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: 1, budget: {}}), /spent/);
  assert.throws(() => createReaderStopRule({maxAttempts: 1, maxAdmitted: 1, budget: {spent: 'nope'}}), /spent/);
});

test('Step 9F.2e.3.4a TIER order: oldLabelPositions is exactly the try-last subset, same order, never a dropped position', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: TRIGGER};
  const candidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '100h ago'}, // stale -> tryLast
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'}, // fresh -> tryFirst
    {headline: 'Singapore retirement savings guide', ageLabel: '1m ago'}, // 4a -> dropped
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'} // fresh -> tryFirst
  ];
  const result = tierTryOrder({candidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime});
  // Unchanged from the Step 9F.2e.3.1 assertions.
  assert.deepEqual(result.dropped, [2]);
  assert.deepEqual(result.order, [1, 3, 0]);
  assert.deepEqual(result.tiers[0], {tier: 5, subTier: '3b'});
  // New field only.
  assert.deepEqual(result.oldLabelPositions, [0]);
  assert.deepEqual(result.order.slice(result.order.length - result.oldLabelPositions.length), result.oldLabelPositions,
    'old-label positions are exactly the tail of order, in the same order order placed them');
  for (const position of result.oldLabelPositions) assert.ok(!result.dropped.includes(position), 'never a dropped position');
});

test('Step 9F.2e.3.4a TIER order: oldLabelPositions is empty when none are stale, and covers every kept position when all are', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: TRIGGER};
  const freshCandidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '1m ago'},
    {headline: 'Quarterly gardening tips for autumn', ageLabel: '2m ago'}
  ];
  const noneOld = tierTryOrder({candidates: freshCandidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime});
  assert.deepEqual(noneOld.oldLabelPositions, []);

  const staleCandidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '100h ago'},
    {headline: 'Quarterly gardening tips for autumn', ageLabel: '200h ago'}
  ];
  const allOld = tierTryOrder({candidates: staleCandidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime});
  assert.deepEqual([...allOld.oldLabelPositions].sort((a, b) => a - b), [...allOld.order].sort((a, b) => a - b));
});

test('Step 9F.2e.3.4a TIER order: oldLabelPositions are valid indices into the original candidates array', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: TRIGGER};
  const candidates = [
    {headline: 'Quarterly gardening tips for spring', ageLabel: '100h ago'},
    {headline: 'AAPL unveils a new product line', ageLabel: '1m ago'}
  ];
  const result = tierTryOrder({
    candidates, mostActive: [], portfolioSnapshots: [{symbol: 'AAPL', instrumentName: 'Apple Inc.'}],
    labelWindow, generationTime
  });
  for (const position of result.oldLabelPositions) {
    assert.ok(Number.isInteger(position) && position >= 0 && position < candidates.length, 'in range');
  }
});

// Step 9F.2e.3.4b: the reader translates the try order's positions back to its
// ranked rows through each candidate object, so the same object listed twice
// breaks the mapping. Impossible for Yahoo today (one fresh object per listing
// row, de-duplicated by link); this documents the limit.
test('Step 9F.2e.3.4b: a candidate object listed twice breaks the position mapping (documented limit)', () => {
  const a = {headline: 'Fake a', url: 'https://x.test/a.html', publisher: 'P'};
  const b = {headline: 'Fake b', url: 'https://x.test/b.html', publisher: 'P'};
  const result = tierTryOrder({candidates: [a, b, a], mostActive: [], portfolioSnapshots: [],
    labelWindow: null, generationTime: NaN});
  // Both copies map to the last position: position 2 is tried twice, position 0 never.
  assert.deepEqual(result.order, [2, 1, 2]);
  assert.equal(result.order.includes(0), false);
  // With distinct objects every position appears exactly once.
  const distinct = tierTryOrder({candidates: [a, b, {...a}], mostActive: [], portfolioSnapshots: [],
    labelWindow: null, generationTime: NaN});
  assert.deepEqual([...distinct.order].sort(), [0, 1, 2]);
});

// Step 9F.2e.4a: the score try order. Same inputs and return shape as the tier
// order; same dropped set; old-label rows still last; inside each group: score,
// then the newer article (age label), then listing position, with no readable
// label counting as the oldest within its score.
const listings = require('./fixtures/yahoo-listings');
const {scoreArticle, compareScoredArticles} = require('../lib/article-score');
const {rankCandidates, portfolioIdentitiesFrom} = require('../lib/source-ranking');

function orderArgs2026_10_12(candidates = listings.listing2026_10_12()) {
  return {
    candidates,
    mostActive: listings.MOST_ACTIVE_2026_10_12,
    portfolioSnapshots: listings.PORTFOLIO_2026_10_12,
    labelWindow: {startsAtInclusive: listings.WINDOW_START_2026_10_12},
    generationTime: Date.parse(listings.TRIGGER_2026_10_12)
  };
}

function realHeadlinesArgs() {
  return {
    candidates: listings.realHeadlinesListing(), mostActive: listings.REAL_HEADLINES_MOST_ACTIVE,
    portfolioSnapshots: listings.NO_MATERIAL_PORTFOLIO, labelWindow: {startsAtInclusive: '2026-10-11T00:00:00.000Z'},
    generationTime: Date.parse('2026-10-12T16:00:00.000Z')
  };
}

// The score's own drop rule, per listing position.
function scoreDropPositions({candidates, mostActive, portfolioSnapshots, generationTime}) {
  const portfolioIdentities = portfolioIdentitiesFrom(portfolioSnapshots);
  return candidates.map((candidateItem, position) => [position, scoreArticle(
    {headline: candidateItem.headline, publisher: candidateItem.publisher, ageLabel: candidateItem.ageLabel},
    {triggerAt: generationTime, portfolioIdentities, mostActiveIdentities: mostActive})])
    .filter(([, scored]) => scored.excludedByDropList).map(([position]) => position);
}

test('Step 9F.2e.4a SCORE order: same shape as the tier order, every candidate accounted for once', () => {
  const args = orderArgs2026_10_12();
  const score = scoreTryOrder(args);
  const tier = tierTryOrder(args);
  assert.deepEqual(Object.keys(score), Object.keys(tier));
  assert.ok(Object.isFrozen(score) && Object.isFrozen(score.order) && Object.isFrozen(score.oldLabelPositions));
  assert.equal(args.candidates.length, 74);
  assert.deepEqual([...score.order, ...score.dropped].sort((a, b) => a - b), [...args.candidates.keys()]);
  // Same dropped positions, same tiers and the same try-last set as the tier order.
  assert.deepEqual(score.dropped, tier.dropped);
  assert.deepEqual(score.tiers, tier.tiers);
  assert.deepEqual([...score.oldLabelPositions].sort((a, b) => a - b),
    [...tier.oldLabelPositions].sort((a, b) => a - b));
  assert.equal(score.oldLabelPositions.length, 4);
  assert.deepEqual(score.order.slice(-score.oldLabelPositions.length), score.oldLabelPositions);
  assert.throws(() => scoreTryOrder({...args, candidates: null}), TypeError);
});

// Step 9F.2e.4b: this fixture predates the AI-theme split (Step 9F.2e.4b); it
// asserts the Step 9F.2e.4a AI-at-20 result, so it sets the AI-theme value to
// 20 explicitly (either/or with the macro value, so 20/20 reproduces this
// exactly, byte for byte -- see lib/article-score.js scoreArticle).
const AI_THEME_AT_MACRO_ENV = Object.freeze({RANKING_POINTS_AI_THEME: '20'});

test('Step 9F.2e.4a SCORE order: the 12 Oct 2026 Pre-market listing', () => {
  const args = orderArgs2026_10_12();
  const row = position => position + 1;
  const result = scoreTryOrder({...args, env: AI_THEME_AT_MACRO_ENV});
  const scoreOrder = result.order.map(row);
  // Today (tier order): rows 1-6, all single-company chip stories.
  assert.deepEqual(tierTryOrder(args).order.map(row).slice(0, 6), [1, 2, 3, 4, 5, 6]);
  // Score order: the Goldman market-wide story (row 7) is sixth. Rows 5 and 6
  // tie on score and age, so listing order decides; rows 7 and 2 tie on 30 and
  // row 7 (2h) is newer than row 2 (12h).
  assert.deepEqual(scoreOrder.slice(0, 6), [1, 3, 5, 6, 4, 7]);
  assert.deepEqual(scoreOrder.slice(0, 10), [1, 3, 5, 6, 4, 7, 2, 8, 9, 33]);
  assert.equal(scoreOrder.indexOf(25) + 1, 11);
  // Every logged score is reproduced except row 22: as listed it has no
  // generic word, so it scores 24, not the logged 25.
  const portfolioIdentities = portfolioIdentitiesFrom(listings.PORTFOLIO_2026_10_12);
  const mismatches = listings.LOGGED_ROWS_2026_10_12.map(([logged], index) => [index + 1, logged,
    scoreArticle(args.candidates[index], {triggerAt: args.generationTime, portfolioIdentities,
      mostActiveIdentities: listings.MOST_ACTIVE_2026_10_12, env: AI_THEME_AT_MACRO_ENV}).score])
    .filter(([, logged, mine]) => logged !== mine);
  assert.deepEqual(mismatches, [[22, 25, 24]]);
  // The three drop-rule headlines are never tried; old-label fillers go last.
  assert.deepEqual(result.dropped.map(row), [38, 39, 40]);
  for (const position of result.oldLabelPositions) assert.equal(args.candidates[position].ageLabel, '5d ago');
});

test("Step 9F.2e.4a SCORE order: the score's drop rule and the tier drop rule give the same set", () => {
  const cases = {
    '12 Oct listing': orderArgs2026_10_12(),
    'REAL HEADLINES': realHeadlinesArgs(),
    'no-material package': {
      candidates: listings.noMaterialListing(), mostActive: [], portfolioSnapshots: listings.NO_MATERIAL_PORTFOLIO,
      labelWindow: {startsAtInclusive: '2026-09-25T20:00:00.000Z'}, generationTime: Date.parse('2026-09-28T10:00:57.798Z')
    }
  };
  for (const [name, args] of Object.entries(cases)) {
    const tierDropped = rankCandidates(args.mostActive, args.candidates, args.portfolioSnapshots)
      .filter(entry => entry.dropped).map(entry => args.candidates.indexOf(entry.candidate));
    assert.ok(tierDropped.length > 0, `${name}: something is dropped`);
    assert.deepEqual(scoreDropPositions(args), tierDropped, name);
    assert.deepEqual(scoreTryOrder(args).dropped, tierDropped, name);
  }
});

test('Step 9F.2e.4a SCORE order: the REAL HEADLINES top six', () => {
  const args = realHeadlinesArgs();
  const result = scoreTryOrder({...args, env: AI_THEME_AT_MACRO_ENV});
  assert.deepEqual(result.order.slice(0, 6).map(position => args.candidates[position].headline), [
    'Nvidia, Broadcom, and AMD Investors Need to Have Oct. 15 Circled on Their Calendars',
    'Microsoft’s Trillion-Dollar Quarter Shows AI Trade Won’t Quit',
    'Dollar steadies near two-month high as US-Iran stalemate lifts oil, Fed rate hike bets',
    'Singapore markets react as Fed raises rates',
    'Morning Bid: Inflation relief gives bonds little reprieve',
    'Stocks fall as Middle East stalemate boosts oil'
  ]);
  // The "2d ago" Russell story is old-labelled for this window: tried last.
  assert.equal(args.candidates[result.order.at(-1)].headline, 'Russell rebounds after a volatile trading day');
});

test('Step 9F.2e.4a SCORE order: ties go to the newer article, then listing position; no label is oldest', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: hoursAgo(100)};
  const plain = (name, ageLabel) => ({headline: `Quarterly gardening tips ${name}`, publisher: 'P',
    ...(ageLabel === null ? {} : {ageLabel})});
  const candidates = [
    plain('a', null), // no label: oldest within its score
    plain('b', 'yesterday'), // unreadable label: oldest within its score
    plain('c', '1d ago'), // exactly 24 h: 0 recency points
    plain('d', '30h ago'),
    plain('e', '23h ago'), // 2 recency points
    plain('f', '53m ago'), // 4 recency points
    plain('g', '1h ago'),
    plain('h', '1h ago')
  ];
  const result = scoreTryOrder({candidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime});
  // 4 points: f (53 m), then g and h (1 h, listing order); 2 points: e; 0 points:
  // c (24 h), d (30 h), then a and b (no readable label) in listing order.
  assert.deepEqual(result.order.map(position => 'abcdefgh'[position]).join(''), 'fghecdab');
});

test('Step 9F.2e.4a SCORE order: a full tie goes by listing position, never by tier rank', () => {
  const generationTime = Date.parse(TRIGGER);
  // Both score 20 with no age label: a plain macro headline (tier 2) listed
  // first, then a name on both lists (tier 1a, 8 + 12).
  const candidates = [
    {headline: 'Fed minutes due this week', publisher: 'P'},
    {headline: 'Zeta Corp names a new chief', publisher: 'P'}
  ];
  const args = {
    candidates, mostActive: [{symbol: 'ZETA', shortName: 'Zeta Corp', longName: 'Zeta Corp'}],
    portfolioSnapshots: [{symbol: 'ZETA', instrumentName: 'Zeta Corp'}], labelWindow: null, generationTime
  };
  assert.deepEqual(tierTryOrder(args).order, [1, 0]);
  assert.deepEqual(scoreTryOrder(args).order, [0, 1]);
});

test('Step 9F.2e.4a SCORE order: old-label rows go last, in score order inside that group', () => {
  const generationTime = Date.parse(TRIGGER);
  const labelWindow = {startsAtInclusive: hoursAgo(30)};
  const candidates = [
    {headline: 'Quarterly gardening tips', publisher: 'P', ageLabel: '3d ago'}, // old, 0 points
    {headline: 'Garden centre opens a new branch', publisher: 'P', ageLabel: '2h ago'}, // fresh, 4 points
    {headline: 'Fed minutes due this week', publisher: 'P', ageLabel: '5d ago'}, // old, 20 points
    {headline: 'Fed holds rates steady', publisher: 'Reuters', ageLabel: '4d ago'} // old, 25 points
  ];
  const args = {candidates, mostActive: [], portfolioSnapshots: [], labelWindow, generationTime};
  const score = scoreTryOrder(args);
  assert.deepEqual(score.order, [1, 3, 2, 0]);
  assert.deepEqual(score.oldLabelPositions, [3, 2, 0]);
  // The tier order's try-last group keeps its own order (2w, 2, 3b).
  assert.deepEqual(tierTryOrder(args).oldLabelPositions, [3, 2, 0]);
});

test('Step 9F.2e.4a: compareScoredArticles keeps its own tie rule (an unknown age falls to listing order)', () => {
  const rows = [{score: 5, ageHours: null, listIndex: 0}, {score: 5, ageHours: 3, listIndex: 1}];
  assert.deepEqual([...rows].sort(compareScoredArticles).map(row => row.listIndex), [0, 1]);
});

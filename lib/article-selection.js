// Step 9F.2e.2: the one article-selection step every source shares. Pure and
// NOT wired into the pipeline -- nothing under api/ or the orchestration
// imports it (Step 9F.2e.3 merges today's three loops onto it; Steps 9F.2e.4 to
// 9F.2e.6 switch the behaviour on).
//
// Kevin's rules (11 Oct 2026):
// - Every candidate, from any source, is scored with the shared score
//   (lib/article-score.js). Ties go to the newer article, then listing order.
//   No publisher penalty. Recaps are not scored and are always kept.
// - General slots per source (7 Yahoo : 3 CNBC). Unused general slots pass to
//   the best remaining articles of other sources (Admin switch), at most
//   `spareAdmits` extra per receiving source.
// - Two portfolio slots over BOTH My Stocks and the Watchlist (Step 21D), via
//   lib/portfolio-slots.js. A general-slot article naming a company counts as
//   that company's first-pass article.
// - Writer budget: the total article text of the downloaded list must fit the
//   planned 150 KB. Over it, the lowest scores go first -- general articles,
//   then portfolio articles. Recaps are never dropped and nothing is shortened.
// - Classifier fit: at most 50 items and the classifier request limit; over
//   either, the same order says which items would be left out. Recaps and
//   protected items are never left out.
//
// Each piece runs on its own: the writer budget and the classifier fit take an
// already-downloaded list, so the duplicate-coverage step (9F.4a) can run
// between download and the budget.
'use strict';

const {settingValue, SETTINGS_REGISTRY} = require('./settings-registry');
const {scoreArticle, compareScoredArticles} = require('./article-score');
const {pickPortfolioArticles} = require('./portfolio-slots');
const {headlineMatchesIdentity} = require('./headline-matching');
const {truncatedText} = require('./source-audit');

// The general-slot setting for each source. A source not listed here has no
// general slots; giving one to a new source is one row here plus one in the
// settings table.
const SOURCE_SLOT_SETTINGS = Object.freeze({
  'us.yahoo-finance': 'yahooSlots',
  'us.cnbc': 'cnbcSlots'
});

const SLOT = Object.freeze({
  GENERAL: 'GENERAL',
  SPARE: 'SPARE',
  PORTFOLIO: 'PORTFOLIO',
  RECAP: 'RECAP',
  PROTECTED: 'PROTECTED'
});

function wholeSetting(name, env) {
  return Math.floor(settingValue(name, {env}));
}

// Every number the selection reads, from the settings table (clamped to its
// safe range). Slot counts are whole numbers.
function selectionSettings({env = process.env} = {}) {
  const slotsBySource = {};
  for (const [sourceId, name] of Object.entries(SOURCE_SLOT_SETTINGS)) {
    slotsBySource[sourceId] = wholeSetting(name, env);
  }
  return Object.freeze({
    slotsBySource: Object.freeze(slotsBySource),
    spilloverEnabled: settingValue('slotSpilloverEnabled', {env}),
    sparePerSource: wholeSetting('spareAdmits', env),
    portfolioSlots: wholeSetting('portfolioSlots', env),
    firstPassPerCompany: wholeSetting('portfolioFirstPassPerCompany', env),
    textBudgetBytes: wholeSetting('articleTextBudgetBytesPlanned', env),
    classifierMaxItems: wholeSetting('maxClassificationEvidenceItems', env),
    classifierMaxBytes: wholeSetting('classifierRequestLimitBytes', env)
  });
}

function textBytesOf(candidate) {
  if (Number.isFinite(candidate?.textBytes)) return candidate.textBytes;
  if (typeof candidate?.text === 'string') return Buffer.byteLength(candidate.text, 'utf8');
  return null;
}

// a. Scores every candidate once and orders them all together. `candidates`:
// [{key, sourceId, headline, publisher, publishedAt, ageLabel, isRecap?,
// text?|textBytes?}] in listing order (the order is the last tie-break).
// Returns {ordered, recaps, dropped}: `ordered` is every scored, not-dropped
// article, best first; recaps are set aside unscored; `dropped` holds the
// articles the score's drop rule removes, with the rule's reason.
function scoreCandidates({
  candidates,
  triggerAt,
  portfolioIdentities = [],
  mostActiveIdentities = [],
  includeWords = [],
  env = process.env
}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const keys = new Set();
  const ordered = [];
  const recaps = [];
  const dropped = [];
  candidates.forEach((candidate, listIndex) => {
    const key = candidate?.key;
    if (typeof key !== 'string' || key === '') throw new TypeError('every candidate needs a key');
    if (keys.has(key)) throw new TypeError(`duplicate candidate key: ${key}`);
    keys.add(key);
    const sourceId = candidate.sourceId;
    if (candidate.isRecap !== true && !Object.hasOwn(SOURCE_SLOT_SETTINGS, sourceId)) {
      throw new TypeError(`no general slots are defined for source: ${sourceId}`);
    }
    const base = {
      key,
      sourceId,
      headline: typeof candidate.headline === 'string' ? candidate.headline : '',
      listIndex,
      textBytes: textBytesOf(candidate)
    };
    if (candidate.isRecap === true) {
      recaps.push(Object.freeze({...base, isRecap: true, score: null, ageHours: null}));
      return;
    }
    const result = scoreArticle(candidate, {triggerAt, portfolioIdentities, mostActiveIdentities, includeWords, env});
    const entry = Object.freeze({
      ...base,
      isRecap: false,
      score: result.score,
      ageHours: result.ageHours,
      dropReason: result.dropReason
    });
    if (result.excludedByDropList) dropped.push(entry);
    else ordered.push(entry);
  });
  ordered.sort(compareScoredArticles);
  return Object.freeze({
    ordered: Object.freeze(ordered),
    recaps: Object.freeze(recaps),
    dropped: Object.freeze(dropped)
  });
}

// b. Fills each source's general slots with its best articles, then (when the
// switch is on) passes unused slots to the best remaining articles of other
// sources, at most `sparePerSource` per receiving source. `ordered` must be
// best first (scoreCandidates' order). Returns {picks, notChosen, bySource}:
// picks in rank order, each {key, sourceId, slot: GENERAL|SPARE, fromSource?}.
function fillGeneralSlots({ordered, slotsBySource, spilloverEnabled, sparePerSource}) {
  if (!Array.isArray(ordered)) throw new TypeError('ordered must be an array');
  for (const [sourceId, slots] of Object.entries(slotsBySource || {})) {
    if (!Number.isInteger(slots) || slots < 0) throw new TypeError(`slots for ${sourceId} must be a whole number >= 0`);
  }
  if (!Number.isInteger(sparePerSource) || sparePerSource < 0) {
    throw new TypeError('sparePerSource must be a whole number >= 0');
  }
  const sources = Object.keys(slotsBySource);
  const bySource = Object.fromEntries(sources.map(sourceId => [sourceId, {
    slots: slotsBySource[sourceId], filled: 0, unused: 0, spareGiven: 0, spareReceived: 0
  }]));
  const rankOf = new Map(ordered.map((entry, rank) => [entry.key, rank]));
  const picks = [];
  const rest = [];
  for (const entry of ordered) {
    const stats = bySource[entry.sourceId];
    if (stats && stats.filled < stats.slots) {
      stats.filled++;
      picks.push({key: entry.key, sourceId: entry.sourceId, slot: SLOT.GENERAL});
    } else {
      rest.push(entry);
    }
  }
  for (const sourceId of sources) bySource[sourceId].unused = bySource[sourceId].slots - bySource[sourceId].filled;

  const notChosen = [];
  for (const entry of rest) {
    const receiver = bySource[entry.sourceId];
    if (!spilloverEnabled) {
      notChosen.push({key: entry.key, sourceId: entry.sourceId, reason: 'SOURCE_SLOTS_FULL'});
      continue;
    }
    if (receiver.spareReceived >= sparePerSource) {
      notChosen.push({key: entry.key, sourceId: entry.sourceId, reason: 'SPARE_LIMIT_REACHED'});
      continue;
    }
    const donor = sources.find(sourceId => sourceId !== entry.sourceId
      && bySource[sourceId].unused - bySource[sourceId].spareGiven > 0);
    if (!donor) {
      notChosen.push({key: entry.key, sourceId: entry.sourceId, reason: 'NO_SPARE_SLOT'});
      continue;
    }
    bySource[donor].spareGiven++;
    receiver.spareReceived++;
    picks.push({key: entry.key, sourceId: entry.sourceId, slot: SLOT.SPARE, fromSource: donor});
  }
  picks.sort((a, b) => rankOf.get(a.key) - rankOf.get(b.key));
  return Object.freeze({
    picks: Object.freeze(picks.map(pick => Object.freeze(pick))),
    notChosen: Object.freeze(notChosen.map(entry => Object.freeze(entry))),
    bySource: Object.freeze(Object.fromEntries(Object.entries(bySource)
      .map(([sourceId, stats]) => [sourceId, Object.freeze(stats)])))
  });
}

// One list of company identities from My Stocks and the Watchlist, first
// appearance wins, each remembering which list(s) it is on.
function mergedPortfolioList({myStocks = [], watchlist = []} = {}) {
  if (!Array.isArray(myStocks) || !Array.isArray(watchlist)) {
    throw new TypeError('myStocks and watchlist must be arrays');
  }
  const bySymbol = new Map();
  for (const [listName, list] of [['MY_STOCKS', myStocks], ['WATCHLIST', watchlist]]) {
    for (const item of list) {
      if (typeof item?.symbol !== 'string' || item.symbol === '') continue;
      const existing = bySymbol.get(item.symbol);
      if (existing) {
        if (!existing.lists.includes(listName)) existing.lists.push(listName);
      } else {
        bySymbol.set(item.symbol, {identity: item, lists: [listName]});
      }
    }
  }
  return [...bySymbol.values()];
}

// c. The portfolio slots over both lists. `ordered`: scoreCandidates' order;
// `generalPicks`: fillGeneralSlots' picks. Returns {picks, passedOver}, each
// pick {key, sourceId, slot: PORTFOLIO, symbols, lists, pass}. Nothing is
// invented: with no eligible article the slots stay empty.
function pickPortfolioSlots({ordered, generalPicks, portfolioLists, slots, firstPassPerCompany}) {
  const merged = mergedPortfolioList(portfolioLists);
  const identities = merged.map(entry => entry.identity);
  const listsOf = new Map(merged.map(entry => [entry.identity.symbol, entry.lists]));
  const byKey = new Map(ordered.map(entry => [entry.key, entry]));
  const generalKeys = new Set(generalPicks.map(pick => pick.key));
  const coveredSymbols = [];
  for (const pick of generalPicks) {
    const headline = byKey.get(pick.key)?.headline || '';
    for (const item of identities) {
      if (headlineMatchesIdentity(headline, item)) coveredSymbols.push(item.symbol);
    }
  }
  const result = pickPortfolioArticles({
    articles: ordered.map(entry => ({
      key: entry.key, headline: entry.headline, score: entry.score, ageHours: entry.ageHours
    })),
    portfolioSlotList: identities,
    slots,
    firstPassPerCompany,
    alreadyChosen: generalKeys,
    coveredSymbols
  });
  const picks = result.picks.map(pick => Object.freeze({
    key: pick.key,
    sourceId: byKey.get(pick.key).sourceId,
    slot: SLOT.PORTFOLIO,
    symbols: pick.symbols,
    lists: Object.freeze([...new Set(pick.symbols.flatMap(symbol => listsOf.get(symbol) || []))]),
    pass: pick.pass
  }));
  const passedOver = result.passedOver
    .filter(entry => entry.reason !== 'ALREADY_CHOSEN')
    .map(entry => Object.freeze({key: entry.key, reason: entry.reason}));
  return Object.freeze({
    picks: Object.freeze(picks),
    passedOver: Object.freeze(passedOver),
    coveredByGeneral: Object.freeze([...new Set(coveredSymbols)])
  });
}

// The order items are given up in, worst first: general (and spare) articles
// from the lowest score up, then portfolio articles the same way. Recaps and
// protected items never appear. Ties use the score's tie rule, reversed.
function giveUpOrder(items) {
  const withIndex = items.map((item, index) => ({
    item,
    score: Number.isFinite(item.score) ? item.score : 0,
    ageHours: Number.isFinite(item.ageHours) ? item.ageHours : null,
    listIndex: Number.isFinite(item.listIndex) ? item.listIndex : index
  }));
  const worstFirst = slots => withIndex
    .filter(entry => slots.includes(entry.item.slot))
    .sort(compareScoredArticles)
    .reverse()
    .map(entry => entry.item);
  return [...worstFirst([SLOT.GENERAL, SLOT.SPARE]), ...worstFirst([SLOT.PORTFOLIO])];
}

function checkSlots(items, label) {
  if (!Array.isArray(items)) throw new TypeError(`${label} must be an array`);
  for (const item of items) {
    if (!Object.values(SLOT).includes(item?.slot)) throw new TypeError(`unknown slot for ${item?.key}: ${item?.slot}`);
  }
}

// d. The writer budget over an already-downloaded list. `articles`: [{key,
// sourceId, headline, slot, score, ageHours, listIndex, textBytes}]. Returns
// the kept articles unchanged (same objects, same order -- nothing is
// shortened), what was dropped and why, and whether the list is still over
// budget (only possible when recaps alone exceed it; reported, never cut).
function applyWriterBudget({articles, budgetBytes = settingValue('articleTextBudgetBytesPlanned')}) {
  checkSlots(articles, 'articles');
  for (const article of articles) {
    if (!Number.isFinite(article.textBytes) || article.textBytes < 0) {
      throw new TypeError(`textBytes must be a number >= 0 for ${article.key}`);
    }
  }
  const totalBytesBefore = articles.reduce((sum, article) => sum + article.textBytes, 0);
  let total = totalBytesBefore;
  const droppedKeys = new Set();
  const dropped = [];
  for (const article of giveUpOrder(articles)) {
    if (total <= budgetBytes) break;
    total -= article.textBytes;
    droppedKeys.add(article.key);
    dropped.push(Object.freeze({
      key: article.key, slot: article.slot, textBytes: article.textBytes, reason: 'OVER_TEXT_BUDGET'
    }));
  }
  const overBudget = total > budgetBytes;
  return Object.freeze({
    kept: Object.freeze(articles.filter(article => !droppedKeys.has(article.key))),
    dropped: Object.freeze(dropped),
    budgetBytes,
    totalBytesBefore,
    totalBytesAfter: total,
    overBudget,
    overBudgetReason: overBudget ? 'NEVER_DROPPED_ITEMS_EXCEED_BUDGET' : null
  });
}

// e. The classifier fit check. `items`: everything the classifier would read,
// [{key, slot, bytes, score?, ageHours?, listIndex?}] -- RECAP and PROTECTED
// items (telemetry, quote pages, the Fed, recaps) are never left out.
// `overheadBytes` is the rest of the request. Returns which items would be
// left out, in the give-up order, and whether it still does not fit.
function checkClassifierFit({
  items,
  maxItems = Math.floor(settingValue('maxClassificationEvidenceItems')),
  maxBytes = settingValue('classifierRequestLimitBytes'),
  overheadBytes = 0
}) {
  checkSlots(items, 'items');
  for (const item of items) {
    if (!Number.isFinite(item.bytes) || item.bytes < 0) throw new TypeError(`bytes must be a number >= 0 for ${item.key}`);
  }
  const bytesBefore = items.reduce((sum, item) => sum + item.bytes, overheadBytes);
  let count = items.length;
  let bytes = bytesBefore;
  const leftOut = [];
  const leftOutKeys = new Set();
  for (const item of giveUpOrder(items)) {
    const overItems = count > maxItems;
    if (!overItems && bytes <= maxBytes) break;
    count--;
    bytes -= item.bytes;
    leftOutKeys.add(item.key);
    leftOut.push(Object.freeze({
      key: item.key, slot: item.slot, bytes: item.bytes,
      reason: overItems ? 'OVER_ITEM_LIMIT' : 'OVER_BYTE_LIMIT'
    }));
  }
  const fits = count <= maxItems && bytes <= maxBytes;
  return Object.freeze({
    fits,
    maxItems,
    maxBytes,
    itemsBefore: items.length,
    itemsAfter: count,
    bytesBefore,
    bytesAfter: bytes,
    kept: Object.freeze(items.filter(item => !leftOutKeys.has(item.key)).map(item => item.key)),
    leftOut: Object.freeze(leftOut),
    stillOverReason: fits ? null : 'NEVER_LEFT_OUT_ITEMS_EXCEED_LIMIT'
  });
}

// a + b + c together. `portfolioLists`: {myStocks, watchlist} identities
// ({symbol, shortName, longName}); they also feed the score's portfolio points
// unless `portfolioIdentities` is given. `settings` defaults to
// selectionSettings({env}). Returns the selected list (recaps, then general
// and spare picks, then portfolio picks, each with its slot) and every
// intermediate result.
function selectArticles({
  candidates,
  triggerAt,
  portfolioLists = {},
  portfolioIdentities = null,
  mostActiveIdentities = [],
  includeWords = [],
  env = process.env,
  settings = selectionSettings({env})
}) {
  const scoringIdentities = portfolioIdentities
    || mergedPortfolioList(portfolioLists).map(entry => entry.identity);
  const scored = scoreCandidates({
    candidates, triggerAt, portfolioIdentities: scoringIdentities, mostActiveIdentities, includeWords, env
  });
  const general = fillGeneralSlots({
    ordered: scored.ordered,
    slotsBySource: settings.slotsBySource,
    spilloverEnabled: settings.spilloverEnabled,
    sparePerSource: settings.sparePerSource
  });
  const portfolio = pickPortfolioSlots({
    ordered: scored.ordered,
    generalPicks: general.picks,
    portfolioLists,
    slots: settings.portfolioSlots,
    firstPassPerCompany: settings.firstPassPerCompany
  });
  const byKey = new Map(scored.ordered.concat(scored.recaps).map(entry => [entry.key, entry]));
  const selected = [
    ...scored.recaps.map(entry => ({...entry, slot: SLOT.RECAP})),
    ...general.picks.map(pick => ({...byKey.get(pick.key), ...pick})),
    ...portfolio.picks.map(pick => ({...byKey.get(pick.key), ...pick}))
  ].map(entry => Object.freeze(entry));
  return Object.freeze({settings, scored, general, portfolio, selected: Object.freeze(selected)});
}

const AUDIT_FIELD_LIMITS = SETTINGS_REGISTRY.auditFieldLimits.default;

function shortHeadline(headline) {
  return truncatedText(headline, AUDIT_FIELD_LIMITS.headlineCharacters, AUDIT_FIELD_LIMITS.headlineBytes);
}

// f. One summary of every decision, safe to log: keys, sources, short
// headlines, scores, slots and reasons -- never article text. `writerBudget`
// and `classifierFit` are optional (they run later, on the downloaded list).
function selectionSummary({selection, writerBudget = null, classifierFit = null}) {
  const {scored, general, portfolio} = selection;
  const decisions = new Map();
  const entries = new Map(scored.ordered.concat(scored.recaps, scored.dropped).map(entry => [entry.key, entry]));
  const record = (key, fields) => {
    const entry = entries.get(key);
    decisions.set(key, {
      key,
      sourceId: entry?.sourceId ?? null,
      headline: shortHeadline(entry?.headline),
      score: entry?.score ?? null,
      ...decisions.get(key),
      ...fields
    });
  };
  for (const entry of scored.recaps) record(entry.key, {decision: 'KEPT', slot: SLOT.RECAP, reason: 'RECAP_ALWAYS_KEPT'});
  for (const pick of general.picks) {
    record(pick.key, {decision: 'KEPT', slot: pick.slot, reason: pick.slot === SLOT.SPARE ? 'SPARE_SLOT' : 'GENERAL_SLOT',
      ...(pick.fromSource ? {fromSource: pick.fromSource} : {})});
  }
  // Not chosen for a general slot first; a portfolio pick then replaces that.
  const portfolioReason = new Map(portfolio.passedOver.map(entry => [entry.key, entry.reason]));
  for (const entry of general.notChosen) {
    record(entry.key, {decision: 'NOT_CHOSEN', slot: null, reason: entry.reason,
      portfolioReason: portfolioReason.get(entry.key) ?? null});
  }
  for (const pick of portfolio.picks) {
    record(pick.key, {decision: 'KEPT', slot: SLOT.PORTFOLIO, reason: `PORTFOLIO_${pick.pass}`,
      portfolioReason: null, symbols: pick.symbols, lists: pick.lists});
  }
  for (const entry of scored.dropped) record(entry.key, {decision: 'DROPPED', slot: null, reason: entry.dropReason});
  for (const entry of writerBudget?.dropped || []) {
    record(entry.key, {decision: 'DROPPED', reason: entry.reason, textBytes: entry.textBytes});
  }
  for (const entry of classifierFit?.leftOut || []) {
    record(entry.key, {decision: 'LEFT_OUT_OF_CLASSIFIER', reason: entry.reason});
  }
  const ordered = [...decisions.values()].sort((a, b) =>
    (entries.get(a.key)?.listIndex ?? Infinity) - (entries.get(b.key)?.listIndex ?? Infinity));
  return Object.freeze({
    settings: selection.settings,
    generalBySource: general.bySource,
    portfolio: Object.freeze({
      slots: selection.settings.portfolioSlots,
      filled: portfolio.picks.length,
      coveredByGeneral: portfolio.coveredByGeneral
    }),
    writerBudget: writerBudget && Object.freeze({
      budgetBytes: writerBudget.budgetBytes,
      totalBytesBefore: writerBudget.totalBytesBefore,
      totalBytesAfter: writerBudget.totalBytesAfter,
      droppedCount: writerBudget.dropped.length,
      overBudget: writerBudget.overBudget,
      overBudgetReason: writerBudget.overBudgetReason
    }),
    classifierFit: classifierFit && Object.freeze({
      fits: classifierFit.fits,
      itemsBefore: classifierFit.itemsBefore,
      itemsAfter: classifierFit.itemsAfter,
      bytesBefore: classifierFit.bytesBefore,
      bytesAfter: classifierFit.bytesAfter,
      leftOutCount: classifierFit.leftOut.length,
      stillOverReason: classifierFit.stillOverReason
    }),
    decisions: Object.freeze(ordered.map(decision => Object.freeze(decision)))
  });
}

module.exports = {
  SOURCE_SLOT_SETTINGS,
  SLOT,
  selectionSettings,
  scoreCandidates,
  fillGeneralSlots,
  mergedPortfolioList,
  pickPortfolioSlots,
  applyWriterBudget,
  checkClassifierFit,
  selectArticles,
  selectionSummary
};

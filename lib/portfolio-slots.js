// Step 9F.2d.2: the portfolio-slot picker. Pure.
// Step 9F.2d.3: the rules live in one place, createPortfolioSlotTracker, which
// both the picker below and the shared source reader (lib/source-reader.js,
// while portfolioSlotsEnabled is on) use, so no copy of them exists anywhere.
//
// Portfolio slots sit on top of the general article slots. Only articles that
// name a company in `portfolioSlotList` are eligible. Step 9F.2e.2 (Kevin, 11
// Oct 2026): the slots cover BOTH My Stocks and the Watchlist (Step 21D), so
// lib/article-selection.js passes both lists merged; this picker is
// list-neutral either way. Recaps are never eligible and are never dropped by
// the slots.
//
// First pass: in score order, each company not yet covered gets its best
// article (up to `firstPassPerCompany` per company). Second pass: only if a
// slot is still empty, the next best article, even for a company already
// covered. An article naming two companies covers both. `coveredSymbols`
// (Step 9F.2e.2) lists one entry per company named by a general-slot article:
// each counts as one first-pass article for that company.
//
// Step 9W Build A: createPortfolioSlotTracker is list-neutral, so the shared
// reader also uses a second tracker for the company spotlight slots (the
// spotlight list in place of the portfolio list, first pass only). The rules
// here are unchanged.
'use strict';

const {settingValue} = require('./settings-registry');
const {headlineMatchesIdentity} = require('./headline-matching');
const {compareScoredArticles} = require('./article-score');

const PASS = Object.freeze({FIRST: 'FIRST_PASS', SECOND: 'SECOND_PASS'});

function checkSlotInputs({portfolioSlotList, slots, firstPassPerCompany, coveredSymbols}) {
  if (!Array.isArray(portfolioSlotList)) throw new TypeError('portfolioSlotList must be an array');
  if (!Number.isInteger(slots) || slots < 0) throw new TypeError('slots must be a whole number >= 0');
  if (!Number.isInteger(firstPassPerCompany) || firstPassPerCompany < 1) {
    throw new TypeError('firstPassPerCompany must be a whole number >= 1');
  }
  if (!Array.isArray(coveredSymbols)) throw new TypeError('coveredSymbols must be an array');
}

// Step 9F.2d.3: the slot rules, one decision at a time. `symbolsNamed` lists
// the companies a headline names (list order, each once). `noteCovered` counts
// an article that already holds a general slot. `firstPassWants` says whether
// an article still has a company under its first-pass share; `take` fills a
// slot for it. `full` is true once every slot is taken.
function createPortfolioSlotTracker({
  portfolioSlotList,
  slots,
  firstPassPerCompany,
  coveredSymbols = []
}) {
  checkSlotInputs({portfolioSlotList, slots, firstPassPerCompany, coveredSymbols});
  const perCompany = new Map();
  const covered = [];
  let filled = 0;
  const count = symbol => perCompany.get(symbol) || 0;
  const noteCovered = symbols => {
    for (const symbol of symbols) {
      if (!perCompany.has(symbol)) covered.push(symbol);
      perCompany.set(symbol, count(symbol) + 1);
    }
  };
  noteCovered(coveredSymbols);
  return Object.freeze({
    symbolsNamed(headline) {
      const symbols = [];
      for (const item of portfolioSlotList) {
        if (!symbols.includes(item.symbol) && headlineMatchesIdentity(headline, item)) {
          symbols.push(item.symbol);
        }
      }
      return symbols;
    },
    noteCovered,
    firstPassWants: symbols => symbols.some(symbol => count(symbol) < firstPassPerCompany),
    full: () => filled >= slots,
    take(symbols) {
      filled++;
      noteCovered(symbols);
    },
    filled: () => filled,
    coveredSymbols: () => covered.slice()
  });
}

// `articles`: [{key, headline, score, ageHours, isRecap?}] in listing order
// (the order supplies the final tie-break). `portfolioSlotList`: [{symbol,
// shortName, longName}]. `alreadyChosen`: keys already holding a general slot.
// Returns {picks: [{key, symbols, pass}], passedOver: [{key, reason}]} with
// picks in the order they were taken.
function pickPortfolioArticles({
  articles,
  portfolioSlotList,
  slots = settingValue('portfolioSlots'),
  firstPassPerCompany = settingValue('portfolioFirstPassPerCompany'),
  alreadyChosen = new Set(),
  coveredSymbols = []
}) {
  if (!Array.isArray(articles)) throw new TypeError('articles must be an array');
  const tracker = createPortfolioSlotTracker({portfolioSlotList, slots, firstPassPerCompany, coveredSymbols});
  const chosen = alreadyChosen instanceof Set ? alreadyChosen : new Set(alreadyChosen);

  const passedOver = [];
  const eligible = [];
  articles.forEach((article, listIndex) => {
    if (article?.isRecap === true) {
      passedOver.push({key: article.key, reason: 'RECAP'});
      return;
    }
    if (chosen.has(article.key)) {
      passedOver.push({key: article.key, reason: 'ALREADY_CHOSEN'});
      return;
    }
    const symbols = tracker.symbolsNamed(article.headline);
    if (symbols.length === 0) {
      passedOver.push({key: article.key, reason: 'NO_PORTFOLIO_COMPANY'});
      return;
    }
    eligible.push({
      key: article.key,
      symbols,
      score: article.score,
      ageHours: Number.isFinite(article.ageHours) ? article.ageHours : null,
      listIndex
    });
  });
  eligible.sort(compareScoredArticles);

  const picks = [];
  const taken = new Set();
  for (const entry of eligible) {
    if (tracker.full()) break;
    if (!tracker.firstPassWants(entry.symbols)) continue;
    picks.push({key: entry.key, symbols: entry.symbols, pass: PASS.FIRST});
    taken.add(entry.key);
    tracker.take(entry.symbols);
  }
  for (const entry of eligible) {
    if (tracker.full()) break;
    if (taken.has(entry.key)) continue;
    picks.push({key: entry.key, symbols: entry.symbols, pass: PASS.SECOND});
    taken.add(entry.key);
    tracker.take(entry.symbols);
  }
  for (const entry of eligible) {
    if (!taken.has(entry.key)) passedOver.push({key: entry.key, reason: 'SLOTS_FULL'});
  }
  return Object.freeze({
    picks: Object.freeze(picks.map(pick => Object.freeze({...pick, symbols: Object.freeze(pick.symbols)}))),
    passedOver: Object.freeze(passedOver.map(entry => Object.freeze(entry)))
  });
}

module.exports = {
  PASS,
  createPortfolioSlotTracker,
  pickPortfolioArticles
};
